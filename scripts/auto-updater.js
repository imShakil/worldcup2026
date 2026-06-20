/**
 * World Cup 2026 — Auto Live Updater
 * 
 * Automatically fetches live match data from Varzesh3 API and updates MongoDB.
 * Replaces manual score entry with real-time automated updates.
 * 
 * Features:
 * - Live scores updated every 3 seconds
 * - Goal scorers with English names (from player database)
 * - Penalty goals detected (eventType 3)
 * - Group standings auto-calculated after each match
 * - Persian → English player name translation via player-names.json
 * 
 * Usage:
 *   node scripts/auto-updater.js
 * 
 * Requirements:
 *   - MongoDB running with the worldcup2026 database seeded
 *   - data/player-names.json (player ID → English name mapping)
 *   - data/team-name-map.json (Persian → English team names)
 */

// Load env first (sets process.env.MONGODB_URL, PORT, etc. from .env.${NODE_ENV})
const { loadEnvConfig } = require('../config/env');
loadEnvConfig();

const fs = require("fs");
const path = require("path");
const mongoose = require('../database');
const Game = require('../models/game');
const Team = require('../models/team');
const Group = require('../models/group');

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000");
const MAX_MATCH_ID = parseInt(process.env.MAX_MATCH_ID || "104");
const SYNC_DAYS_BACK = parseInt(process.env.SYNC_DAYS_BACK || "10");// Per-request timeout for upstream HTTP calls. Default 20s — enough headroom for
// slow DNS/TLS on the prod server while still failing fast on a hung socket.
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "20000");
// Retry transient failures (timeouts, connection resets) up to N times with a
// short delay. Keeps a single bad packet from blowing the whole poll.
const FETCH_RETRIES = parseInt(process.env.FETCH_RETRIES || "2");
const isProd = process.env.NODE_ENV === 'production';
console.log(`🔌 Connecting to MongoDB (${isProd ? 'Production' : 'Development'})...`);

mongoose.connection.once('open', () => {
    console.log("✅ Successful connection with MongoDB");
});
mongoose.connection.on('error', (err) => {
    console.log('❌ Error: Connection to MongoDB not successful', err.message);
    process.exit(1);
});

// Load mappings
const TEAM_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/team-name-map.json"), "utf8"));
// player-names.json is editable at runtime — we re-read it on demand so manual
// entries (English name overrides) take effect on the next goal, no restart
// needed. See AUTO_UPDATER.md.
const PLAYER_DB_PATH = path.join(__dirname, "../data/player-names.json");
let playerDb = {};
let playerDbMtime = 0;
function loadPlayerDb() {
  try {
    const stat = fs.statSync(PLAYER_DB_PATH);
    // Cheap hot path: only re-parse when the file actually changed on disk.
    if (stat.mtimeMs !== playerDbMtime) {
      playerDb = JSON.parse(fs.readFileSync(PLAYER_DB_PATH, "utf8"));
      playerDbMtime = stat.mtimeMs;
    }
  } catch {
    // File missing or unreadable — keep whatever's already in memory.
  }
  return playerDb;
}

function getPlayerName(id, faName) {
  const sid = String(id);
  const db = loadPlayerDb();
  if (db[sid]) return db[sid];
  // Save unknown player for later manual mapping. Always re-check the freshly
  // loaded db (not the stale module-level reference) so a user-added English
  // name isn't clobbered by a Persian placeholder.
  if (sid && faName) {
    db[sid] = faName; // Store Persian name as placeholder
    try {
      fs.writeFileSync(PLAYER_DB_PATH, JSON.stringify(db, null, 2));
      playerDbMtime = fs.statSync(PLAYER_DB_PATH).mtimeMs;
    } catch {}
  }
  return faName;
}

function mapStatus(status, liveTime, isLive) {
  if (isLive) return liveTime || "Live";
  if (status === 7) return "finished";
  return "notstarted";
}

async function fetchVarzesh3(dayOffset) {
  const url = dayOffset === 0
    ? "https://web-api.varzesh3.com/v2.0/livescore/today"
    : `https://web-api.varzesh3.com/v2.0/livescore/${dayOffset}`;
  // Retry only on TRANSIENT failures (timeout, connection reset, 5xx). The
  // Varzesh3 API returns HTTP 200 with an empty body for historical offsets
  // outside the World Cup window — retrying won't help and produces the
  // "Unexpected end of JSON input" spam seen on the VM. See git history.
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      // 4xx/5xx are not transient — bail immediately, don't burn retries.
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      // Empty body means "no fixtures for this date" — treat as empty result,
      // not an error. Varzesh3 returns 200 + '' for out-of-range day offsets.
      if (!text.trim()) return [];
      const data = JSON.parse(text);
      const matches = [];
      for (const league of data) {
        if (league.id !== 28) continue; // World Cup league ID on Varzesh3
        for (const dg of league.dates || []) {
          for (const m of dg.matches || []) matches.push(m);
        }
      }
      return matches;
    } catch (err) {
      lastErr = err;
      const transient = err.name === 'TimeoutError'
        || err.name === 'AbortError'
        || err.code === 'ECONNRESET'
        || err.code === 'ECONNREFUSED'
        || /^HTTP 5\d\d/.test(err.message);
      if (!transient || attempt >= FETCH_RETRIES) throw err;
      // Brief backoff between retries; jitter-free for predictable logs.
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

async function fetchEvents(matchId) {
  try {
    const res = await fetch(
      `https://web-api.varzesh3.com/v2.0/livescore/football/matches/${matchId}/events`,
      { signal: AbortSignal.timeout(5000) }
    );
    const events = await res.json();
    const homeGoals = [], awayGoals = [];
    for (const e of events) {
      if (e.eventType === 1 || e.eventType === 3) { // Goals + Penalties
        const id = e.strikerId || e.kickerId || "";
        const name = getPlayerName(id, e.strikerName || e.kickerName || "Goal");
        const time = e.time || "";
        const pen = e.eventType === 3 ? "(p)" : "";
        homeGoals.push(...(e.side === 0 ? [`"${name} ${time}'${pen}"`] : []));
        awayGoals.push(...(e.side === 1 ? [`"${name} ${time}'${pen}"`] : []));
      }
    }
    return {
      home_scorers: homeGoals.length ? `{${homeGoals.join(",")}}` : "null",
      away_scorers: awayGoals.length ? `{${awayGoals.join(",")}}` : "null",
    };
  } catch { return null; }
}

async function syncMatches(v3Matches) {
  const teams = await Team.find({}).lean();
  const teamByFa = {};
  for (const t of teams) teamByFa[t.name_fa] = t.id;
  for (const [fa, en] of Object.entries(TEAM_MAP)) {
    const team = teams.find(t => t.name_en === en);
    if (team) teamByFa[fa] = team.id;
  }

  let updated = 0;

  for (const m of v3Matches) {
    const homeTeamId = teamByFa[m.host?.name];
    const awayTeamId = teamByFa[m.guest?.name];
    if (!homeTeamId || !awayTeamId) continue;

    const match = await Game.findOne({ home_team_id: homeTeamId, away_team_id: awayTeamId });
    if (!match) continue;

    // Only sync the first N matches (defaults to 17) — skip everything else
    if (parseInt(match.id) > MAX_MATCH_ID) continue;

    const newData = {
      home_score: String(m.goals?.host ?? match.home_score),
      away_score: String(m.goals?.guest ?? match.away_score),
      time_elapsed: mapStatus(m.status, m.liveTime, m.isLive),
      finished: m.status === 7 ? "TRUE" : match.finished,
    };

    if (m.isLive || m.status === 7) {
      const scorers = await fetchEvents(m.id);
      if (scorers) {
        newData.home_scorers = scorers.home_scorers;
        newData.away_scorers = scorers.away_scorers;
      }
    }

    if (match.home_score !== newData.home_score || match.away_score !== newData.away_score ||
        match.time_elapsed !== newData.time_elapsed || match.finished !== newData.finished ||
        match.home_scorers !== newData.home_scorers) {
      await Game.updateOne({ _id: match._id }, { $set: newData });
      updated++;
    }
  }
  return updated;
}

async function updateStandings() {
  const matches = await Game.find({ finished: "TRUE", type: "group" }).lean();
  const teams = await Team.find({}).lean();

  const stats = {};
  for (const t of teams) {
    stats[t.id] = { team_id: t.id, mp: 0, w: 0, d: 0, l: 0, pts: 0, gf: 0, ga: 0, gd: 0 };
  }

  for (const m of matches) {
    const h = parseInt(m.home_score) || 0;
    const a = parseInt(m.away_score) || 0;
    const home = stats[m.home_team_id];
    const away = stats[m.away_team_id];
    if (!home || !away) continue;

    home.mp++; away.mp++;
    home.gf += h; home.ga += a;
    away.gf += a; away.ga += h;

    if (h > a) { home.w++; home.pts += 3; away.l++; }
    else if (h < a) { away.w++; away.pts += 3; home.l++; }
    else { home.d++; away.d++; home.pts++; away.pts++; }

    home.gd = home.gf - home.ga;
    away.gd = away.gf - away.ga;
  }

  const groups = await Group.find({}).lean();
  for (const g of groups) {
    const updatedTeams = g.teams.map(t => {
      const s = stats[t.team_id];
      if (!s) return t;
      return { team_id: t.team_id, mp: String(s.mp), w: String(s.w), d: String(s.d), l: String(s.l), pts: String(s.pts), gf: String(s.gf), ga: String(s.ga), gd: String(s.gd) };
    });
    updatedTeams.sort((a, b) => (parseInt(b.pts) - parseInt(a.pts)) || (parseInt(b.gd) - parseInt(a.gd)) || (parseInt(b.gf) - parseInt(a.gf)));
    await Group.updateOne({ _id: g._id }, { $set: { teams: updatedTeams } });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function waitForConnection() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connection.asPromise();
}

async function fullSync() {
  console.log("[auto-updater] Full sync starting...");
  await waitForConnection();
  const allMatches = [];
  // Sweep [-SYNC_DAYS_BACK .. +1] so older matches still get back-filled on startup.
  const offsets = [];
  for (let d = -SYNC_DAYS_BACK; d <= 1; d++) offsets.push(d);
  let offsetFailures = 0;
  for (const d of offsets) {
    try {
      allMatches.push(...await fetchVarzesh3(d));
    } catch (err) {
      offsetFailures++;
      // Don't swallow — surface per-offset failures so a full outage is visible.
      console.error(`[auto-updater] Full sync offset ${d} failed: ${err.message}`);
    }
  }
  if (offsetFailures === offsets.length) {
    // Every single offset failed — bail loud rather than pretending success.
    throw new Error(`Full sync: all ${offsets.length} offset(s) failed to fetch`);
  }
  const updated = await syncMatches(allMatches);
  await updateStandings();
  console.log(`[auto-updater] Full sync done: ${updated} matches updated, standings recalculated (${offsetFailures}/${offsets.length} offset(s) failed)`);
}

let lastFinishedCount = 0;
// Exponential backoff state: when the upstream API is unreachable, we don't
// want to retry every POLL_INTERVAL forever — back off to MAX_BACKOFF and reset
// on the next successful poll. See Poll error spam issue.
const MAX_BACKOFF = 5 * 60 * 1000; // 5 minutes
let currentBackoff = POLL_INTERVAL;
let consecutiveFailures = 0;

async function poll() {
  try {
    await waitForConnection();
    const todayMatches = await fetchVarzesh3(0);
    await syncMatches(todayMatches);

    // Recalculate standings if a match just finished
    const count = await Game.countDocuments({ finished: "TRUE" });
    if (count !== lastFinishedCount) {
      lastFinishedCount = count;
      await updateStandings();
      console.log(`[auto-updater] Standings updated (${count} finished matches)`);
    }

    // Success: reset backoff
    if (consecutiveFailures > 0) {
      console.log(`[auto-updater] Recovered after ${consecutiveFailures} failed poll(s)`);
    }
    consecutiveFailures = 0;
    currentBackoff = POLL_INTERVAL;
  } catch (err) {
    consecutiveFailures++;
    currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF);
    console.error(`[auto-updater] Poll error (${consecutiveFailures}): ${err.message} — next retry in ${Math.round(currentBackoff / 1000)}s`);
  }
}

// Self-rescheduling loop: ensures the next poll() is only scheduled AFTER the
// current one finishes. setInterval() fires on a fixed cadence regardless of
// whether the previous poll is still running, so a slow/hanging request causes
// calls to stack up and hammer the upstream API. See Poll error spam issue.
let isPolling = false;
async function pollLoop() {
  if (isPolling) {
    // Previous poll still in flight (e.g. upstream timeout exceeded interval).
    // Skip this tick to prevent pile-up.
    return setTimeout(pollLoop, currentBackoff);
  }
  isPolling = true;
  try {
    await poll();
  } finally {
    isPolling = false;
    setTimeout(pollLoop, currentBackoff);
  }
}

console.log(`[auto-updater] Starting — polling every ${POLL_INTERVAL}ms`);
fullSync()
  .then(() => {
    pollLoop();
  })
  .catch((err) => {
    console.error("[auto-updater] Fatal startup error:", err.message);
    process.exit(1);
  });
