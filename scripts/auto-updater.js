/**
 * World Cup 2026 — Auto Live Updater
 *
 * Automatically fetches live match data from football-data.org v4 and updates
 * MongoDB. Replaces manual score entry with real-time automated updates.
 *
 * Features:
 * - Live scores, status, and minute updated each poll
 * - Goal scorers with English names + penalty / own-goal markers
 * - Group standings auto-calculated after each match
 * - Single endpoint per poll (free tier: 10 req/min → 90s cadence)
 *
 * Usage:
 *   node scripts/auto-updater.js
 *
 * Requirements:
 *   - MongoDB running with the worldcup2026 database seeded
 *   - FOOTBALL_DATA_TOKEN set in .env.production / .env.development
 *     (register for free at https://www.football-data.org/client/register)
 */

// Load env first (sets process.env.MONGODB_URL, PORT, etc. from .env.${NODE_ENV})
const { loadEnvConfig } = require('../config/env');
loadEnvConfig();

const mongoose = require('../database');
const Game = require('../models/game');
const Team = require('../models/team');
const Group = require('../models/group');
const { config } = require('../config/env');

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "15000");
const MAX_MATCH_ID = parseInt(process.env.MAX_MATCH_ID || "104");
// Per-request timeout for upstream HTTP calls. Default 20s — enough headroom for
// slow DNS/TLS on the prod server while still failing fast on a hung socket.
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "20000");
// Retry transient failures (timeouts, connection resets) up to N times with a
// short delay. Keeps a single bad packet from blowing the whole poll.
const FETCH_RETRIES = parseInt(process.env.FETCH_RETRIES || "2");
const FOOTBALL_DATA_TOKEN = config.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_TOKEN;
const FOOTBALL_DATA_BASE_URL = config.FOOTBALL_DATA_BASE_URL || 'https://api.football-data.org/v4';
const COMPETITION_CODE = process.env.FOOTBALL_DATA_COMPETITION || 'WC';
// Backwards compat: kept so the env var still works in case it's set elsewhere.
const SYNC_DAYS_BACK = parseInt(process.env.SYNC_DAYS_BACK || "10");
const isProd = process.env.NODE_ENV === 'production';
console.log(`🔌 Connecting to MongoDB (${isProd ? 'Production' : 'Development'})...`);

if (!FOOTBALL_DATA_TOKEN) {
  console.error('❌ FOOTBALL_DATA_TOKEN is not set. Register at https://www.football-data.org/client/register and add it to your .env file.');
  process.exit(1);
}

mongoose.connection.once('open', () => {
    console.log("✅ Successful connection with MongoDB");
});
mongoose.connection.on('error', (err) => {
    console.log('❌ Error: Connection to MongoDB not successful', err.message);
    process.exit(1);
});

// football-data.org v4 status enum → our time_elapsed string format.
//
// We keep the same string vocabulary the frontend already expects so
// consumers don't need to change. football-data's `minute` field is only
// populated while a match is in play; we surface it as "67'" so the UI can
// render it as a live minute badge.
function mapStatus(status, minute) {
  switch (status) {
    case 'IN_PLAY':
    case 'LIVE':
    case 'PAUSED':
      // `minute` is null on PAUSED — fall back to a generic Live token.
      return minute != null ? `${minute}'` : 'Live';
    case 'FINISHED':
      return 'finished';
    case 'POSTPONED':
    case 'SUSPENDED':
    case 'CANCELLED':
      return status.toLowerCase();
    case 'TIMED':
    case 'SCHEDULED':
    default:
      return 'notstarted';
  }
}

// football-data v4 stage enum → our type field. Group stage uses the
// `group` field on each match for the letter (A–L); knockout stages have
// null `group` and a structured `stage` we map to your existing vocabulary.
function mapStage(match) {
  const stage = match.stage || '';
  if (stage === 'GROUP_STAGE') return 'group';
  if (stage === 'ROUND_OF_32') return 'r32';
  if (stage === 'ROUND_OF_16') return 'r16';
  if (stage === 'QUARTER_FINALS') return 'qf';
  if (stage === 'SEMI_FINALS') return 'sf';
  if (stage === 'THIRD_PLACE') return 'third';
  if (stage === 'FINAL') return 'final';
  return 'group';
}

// Build the per-poll URL. dateFrom/dateTo let us backfill the start of the
// season on the first run and stay in sync as the tournament progresses. Both
// are inclusive on football-data's side.
function buildMatchesUrl({ dateFrom, dateTo } = {}) {
  const url = new URL(`${FOOTBALL_DATA_BASE_URL}/competitions/${COMPETITION_CODE}/matches`);
  if (dateFrom) url.searchParams.set('dateFrom', dateFrom);
  if (dateTo) url.searchParams.set('dateTo', dateTo);
  return url.toString();
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Single endpoint, auth header, date range, retries. Respect Retry-After on
// 429 — the free tier rate-limits at 10 req/min and tells us exactly when to
// come back.
async function fetchFootballData({ dateFrom, dateTo, signal } = {}) {
  const url = buildMatchesUrl({ dateFrom, dateTo });
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN },
        signal: signal || AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429) {
        // Rate limited — wait the server's suggested duration (cap at 60s so
        // a single bad response can't stall the loop for minutes).
        const retryAfter = parseFloat(res.headers.get('Retry-After') || '60');
        const waitMs = Math.min(Math.max(retryAfter, 1), 60) * 1000;
        console.warn(`[auto-updater] Rate limited (429). Sleeping ${Math.round(waitMs / 1000)}s before retry.`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        // Non-2xx that's not 429: usually 401 (bad token) or 403 (out of
        // scope for the free plan) — don't retry, just surface the error.
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
      }
      const data = await res.json();
      return Array.isArray(data.matches) ? data.matches : [];
    } catch (err) {
      lastErr = err;
      const transient = err.name === 'TimeoutError'
        || err.name === 'AbortError'
        || err.code === 'ECONNRESET'
        || err.code === 'ECONNREFUSED'
        || /^HTTP 5\d\d/.test(err.message);
      if (!transient || attempt >= FETCH_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

// football-data ships goal events inline in `match.goals[]`, so we don't need
// a separate /events call. We aggregate them into the same string format the
// frontend already expects: {"Player Name 51'","Other Player 67'(p)"} with
// "(p)" for penalties and "(OG)" for own goals.
function buildScorers(goals, side) {
  if (!Array.isArray(goals) || !goals.length) return "null";
  const entries = [];
  for (const g of goals) {
    if ((g.team?.id ?? g.team) !== side) continue; // team is {id,name} or just an id
    const scorer = g.scorer?.name || g.scorer || 'Unknown';
    const minute = g.minute ?? '';
    let suffix = '';
    if (g.type === 'PENALTY') suffix = '(p)';
    else if (g.type === 'OWN_GOAL') suffix = '(OG)';
    entries.push(`"${scorer} ${minute}'${suffix}"`);
  }
  return entries.length ? `{${entries.join(',')}}` : "null";
}

// Match an upstream football-data match back to our local Game document.
// football-data's `id` is a numeric global id (e.g. 537404) that doesn't line
// up with our string `id` ("1"–"104"). The reliable join keys are the
// 3-letter FIFA code (TLA) — both teams — and the kickoff timestamp.
async function findLocalMatch(upstream) {
  const homeTla = upstream.homeTeam?.tla;
  const awayTla = upstream.awayTeam?.tla;
  if (!homeTla || !awayTla || !upstream.utcDate) return null;
  const teams = await Team.find({}).lean();
  const home = teams.find(t => (t.fifa_code || '').toUpperCase() === homeTla.toUpperCase());
  const away = teams.find(t => (t.fifa_code || '').toUpperCase() === awayTla.toUpperCase());
  if (!home || !away) return null;
  // Narrow by kickoff timestamp: football-data may return both legs of a
  // rematched fixture in pathological cases, so the exact kickoff is the
  // tiebreaker.
  const match = await Game.findOne({
    home_team_id: String(home.id),
    away_team_id: String(away.id),
    local_date: { $exists: true },
  }).lean();
  if (!match) return null;
  // Best-effort kickoff sanity check. local_date is "MM/DD/YYYY HH:mm" — we
  // only need to ensure we're not pairing a totally different fixture.
  if (match.local_date) {
    const [datePart, timePart] = match.local_date.split(' ');
    const [mm, dd, yyyy] = datePart.split('/');
    const matchLocal = new Date(`${yyyy}-${mm}-${dd}T${timePart}`);
    const upstreamDate = new Date(upstream.utcDate);
    if (!isNaN(matchLocal.getTime()) && Math.abs(matchLocal - upstreamDate) > 24 * 60 * 60 * 1000) {
      return null;
    }
  }
  return match;
}

async function syncMatches(matches) {
  let updated = 0;
  for (const m of matches) {
    const match = await findLocalMatch(m);
    if (!match) continue;
    if (parseInt(match.id) > MAX_MATCH_ID) continue;

    // football-data v4 uses team ids we don't store locally, so we keep the
    // existing "0 means TBD" convention and use our mapped ids for the
    // side filter in buildScorers.
    const homeId = m.homeTeam?.id ?? 0;
    const awayId = m.awayTeam?.id ?? 0;

    const fullTime = m.score?.fullTime || {};
    const homeScore = fullTime.home != null ? fullTime.home : (match.home_score ?? '0');
    const awayScore = fullTime.away != null ? fullTime.away : (match.away_score ?? '0');

    const newData = {
      home_score: String(homeScore),
      away_score: String(awayScore),
      time_elapsed: mapStatus(m.status, m.minute),
      finished: m.status === 'FINISHED' ? 'TRUE' : match.finished,
    };

    // Only refresh scorers while the match is actually live or just finished;
    // for scheduled games there's no event data to pull and we don't want to
    // clobber whatever's there with an empty list.
    const shouldRefreshScorers = ['IN_PLAY', 'LIVE', 'PAUSED', 'FINISHED'].includes(m.status);
    if (shouldRefreshScorers) {
      newData.home_scorers = buildScorers(m.goals, homeId);
      newData.away_scorers = buildScorers(m.goals, awayId);
    }

    if (match.home_score !== newData.home_score
        || match.away_score !== newData.away_score
        || match.time_elapsed !== newData.time_elapsed
        || match.finished !== newData.finished
        || (newData.home_scorers && match.home_scorers !== newData.home_scorers)
        || (newData.away_scorers && match.away_scorers !== newData.away_scorers)) {
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
  // One call covers the whole season window. Pull from SYNC_DAYS_BACK ago
  // through tomorrow so back-fills and tomorrow's openers are both included
  // in a single request — stays well under the 10 req/min free-tier cap.
  const dateTo = isoDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const dateFrom = isoDate(new Date(Date.now() - SYNC_DAYS_BACK * 24 * 60 * 60 * 1000));
  let matches;
  try {
    matches = await fetchFootballData({ dateFrom, dateTo });
  } catch (err) {
    throw new Error(`Full sync: initial fetch failed — ${err.message}`);
  }
  const updated = await syncMatches(matches);
  await updateStandings();
  console.log(`[auto-updater] Full sync done: ${updated} matches updated, standings recalculated (${matches.length} matches in window ${dateFrom} → ${dateTo})`);
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
    // Single daily window — same as fullSync, so back-fills and live matches
    // are picked up on every tick without extra requests.
    const dateTo = isoDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const dateFrom = isoDate(new Date(Date.now() - SYNC_DAYS_BACK * 24 * 60 * 60 * 1000));
    const matches = await fetchFootballData({ dateFrom, dateTo });
    const updatedCount = await syncMatches(matches);

    // Recalculate standings if a match just finished
    const count = await Game.countDocuments({ finished: "TRUE" });
    let standingsUpdated = false;
    if (count !== lastFinishedCount) {
      lastFinishedCount = count;
      await updateStandings();
      standingsUpdated = true;
      console.log(`[auto-updater] Standings updated (${count} finished matches)`);
    }

    // Heartbeat: log every successful poll so `pm2 logs wc-updater` shows
    // steady activity even when nothing changed — that's how you verify the
    // 15s cadence is actually running. Without this line, a healthy quiet
    // day looks identical to a hung process.
    console.log(`[auto-updater] Poll tick — fetched ${matches.length} match(es), updated ${updatedCount}${standingsUpdated ? ', standings recalculated' : ''}`);

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
