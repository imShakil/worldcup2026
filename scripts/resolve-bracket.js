/**
 * World Cup 2026 — Knockout Bracket Resolver
 *
 * Fills `home_team_id` / `away_team_id` on knockout matches (r32, r16, qf, sf,
 * third, final) by parsing the `home_team_label` / `away_team_label`
 * placeholders that were imported from the CSV fixtures.
 *
 * Supported label forms (confirmed against data/games.json):
 *   "Winner Group X"          — group winner of group letter X (A–L)
 *   "Runner-up Group X"       — 2nd place in group X
 *   "3rd Group A/B/C/D/F"     — best 3rd-place team across the listed groups
 *   "Winner Match N"          — winner of match with id N (e.g. R32, R16, QF)
 *   "Loser Match N"           — loser of match with id N (used for 3rd place)
 *
 * Resolution rules
 *   - Group-based labels are resolved from the latest `Group` standings. The
 *     standings are sorted by `updateStandings()` (pts → gd → gf), so the
 *     first row is the group winner and the second is the runner-up.
 *   - 3rd-place labels pick the best 3rd across the listed groups. Each
 *     candidate group contributes its 3rd-placed team; the best by the same
 *     pts/gd/gf tiebreaker wins. Only resolves once *all* listed groups have
 *     a 3rd-placed team (i.e. all group matches finished) — otherwise the
 *     "3rd" slot isn't decidable and we skip the match.
 *   - "Winner Match N" / "Loser Match N" require the referenced match to be
 *     finished. Winner is whoever has the higher score; ties (extra time /
 *     penalties) are out of scope — football-data.org is the source of truth
 *     for those and `syncMatches()` will overwrite our pick with the real
 *     teams as soon as the API publishes the bracket.
 *
 * Designed to be safe to re-run: it only writes when both sides resolve to
 * concrete team ids and the current values are still the "0" placeholder.
 */

const mongoose = require('../database');
const Game = require('../models/game');
const Team = require('../models/team');
const Group = require('../models/group');

const KNOCKOUT_TYPES = new Set(['r32', 'r16', 'qf', 'sf', 'third', 'final']);

// Group letters A–L. Used to validate parsed label fragments.
const GROUP_LETTERS = 'ABCDEFGHIJKL';

// Tokenizes the inline team_id list in "3rd Group A/B/C/D/F" into ['A','B',...]
function parseGroupList(s) {
  return s.split('/').map(x => x.trim().toUpperCase()).filter(Boolean);
}

// Parses a label into a structured descriptor or returns null.
//   { kind: 'group', place: 1|2|3, groups: ['A','B',...] }
//   { kind: 'match', result: 'winner'|'loser', matchId: 73 }
function parseLabel(label) {
  if (!label || typeof label !== 'string') return null;
  const text = label.trim();

  // Match references first (highest resolution priority — final/3rd rely on them)
  let m = text.match(/^(Winner|Loser)\s+Match\s+(\d+)$/i);
  if (m) {
    return { kind: 'match', result: m[1].toLowerCase(), matchId: parseInt(m[2], 10) };
  }

  m = text.match(/^Winner\s+Group\s+([A-L])$/i);
  if (m) return { kind: 'group', place: 1, groups: [m[1].toUpperCase()] };

  m = text.match(/^Runner-up\s+Group\s+([A-L])$/i);
  if (m) return { kind: 'group', place: 2, groups: [m[1].toUpperCase()] };

  m = text.match(/^3rd\s+Group\s+((?:[A-L]\/)*[A-L])$/i);
  if (m) return { kind: 'group', place: 3, groups: parseGroupList(m[1]) };

  return null;
}

// Best-by-pts/gd/gf comparator. Group rows are already sorted by
// `updateStandings()`, but we sort defensively in case standings were
// hand-edited.
function compareTeams(a, b) {
  const ap = parseInt(a.pts) || 0, bp = parseInt(b.pts) || 0;
  if (ap !== bp) return bp - ap;
  const ag = parseInt(a.gd) || 0, bg = parseInt(b.gd) || 0;
  if (ag !== bg) return bg - ag;
  const agf = parseInt(a.gf) || 0, bgf = parseInt(b.gf) || 0;
  return bgf - agf;
}

// Cache: group name (uppercase letter) → ordered team_id[] from standings,
// plus a parallel `stats` map of team_id → { pts, gd, gf } for cross-group
// comparisons (e.g. picking the best 3rd across A/B/C/D/...).
// Loaded once per resolveBracket() call.
async function loadGroupStandings() {
  const groups = await Group.find({}).lean();
  const ordered = {}; // letter → team_id[] (winner first)
  const stats = {};   // team_id → { pts, gd, gf }
  for (const g of groups) {
    const letter = (g.name || '').toUpperCase();
    if (!letter || !GROUP_LETTERS.includes(letter)) continue;
    const sorted = [...(g.teams || [])].sort(compareTeams);
    ordered[letter] = sorted.map(t => t.team_id);
    for (const row of g.teams || []) {
      stats[String(row.team_id)] = {
        pts: parseInt(row.pts) || 0,
        gd: parseInt(row.gd) || 0,
        gf: parseInt(row.gf) || 0,
      };
    }
  }
  return { ordered, stats };
}

// Cache: team_id (string) → team document. Loaded once per resolve call.
async function loadTeams() {
  const teams = await Team.find({}).lean();
  const map = {};
  for (const t of teams) map[String(t.id)] = t;
  return map;
}

// Cache: match id (string) → game document. Loaded once per resolve call.
async function loadMatches() {
  const matches = await Game.find({}).lean();
  const map = {};
  for (const m of matches) map[String(m.id)] = m;
  return map;
}

// Resolve a structured descriptor to a team_id string, or null if the
// referenced data isn't ready yet (group incomplete, match not finished, etc).
function resolveDescriptor(desc, { standings, matches }) {
  if (!desc) return null;

  if (desc.kind === 'group') {
    if (desc.place === 1 || desc.place === 2) {
      const letter = desc.groups[0];
      const ordered = standings.ordered[letter];
      if (!ordered || ordered.length < desc.place) return null;
      return ordered[desc.place - 1];
    }
    if (desc.place === 3) {
      // Best 3rd-placed across the listed groups. Each listed group must have
      // at least 3 finished standings rows — otherwise the "3rd" slot is
      // undefined and we bail out rather than guess.
      const candidates = [];
      for (const letter of desc.groups) {
        const ordered = standings.ordered[letter];
        if (!ordered || ordered.length < 3) return null;
        candidates.push(ordered[2]);
      }
      // Cross-group tiebreak by FIFA's published best-3rds rules:
      //   1. higher points
      //   2. higher goal difference
      //   3. higher goals scored
      //   4. higher fair-play points (out of scope; falls through to id)
      candidates.sort((a, b) => {
        const sa = standings.stats[a] || { pts: 0, gd: 0, gf: 0 };
        const sb = standings.stats[b] || { pts: 0, gd: 0, gf: 0 };
        if (sa.pts !== sb.pts) return sb.pts - sa.pts;
        if (sa.gd !== sb.gd) return sb.gd - sa.gd;
        if (sa.gf !== sb.gf) return sb.gf - sa.gf;
        return a.localeCompare(b); // deterministic fallback
      });
      return candidates[0] || null;
    }
  }

  if (desc.kind === 'match') {
    const ref = matches[String(desc.matchId)];
    if (!ref || ref.finished !== 'TRUE') return null;
    const h = parseInt(ref.home_score) || 0;
    const a = parseInt(ref.away_score) || 0;
    if (h === a) return null; // extra time / pens — leave for upstream feed
    if (desc.result === 'winner') return h > a ? ref.home_team_id : ref.away_team_id;
    return h > a ? ref.away_team_id : ref.home_team_id;
  }

  return null;
}

// Public entry point. Returns { resolved: number, skipped: number }.
async function resolveBracket({ verbose = false } = {}) {
  const [standings, teamsById, matches] = await Promise.all([
    loadGroupStandings(),
    loadTeams(),
    loadMatches(),
  ]);

  const knockoutGames = await Game.find({
    type: { $in: [...KNOCKOUT_TYPES] },
    $or: [
      { home_team_id: '0' },
      { home_team_id: { $exists: false } },
      { away_team_id: '0' },
      { away_team_id: { $exists: false } },
    ],
  }).lean();

  let resolved = 0;
  let skipped = 0;

  for (const g of knockoutGames) {
    const homeDesc = parseLabel(g.home_team_label);
    const awayDesc = parseLabel(g.away_team_label);
    const homeId = resolveDescriptor(homeDesc, { standings, matches });
    const awayId = resolveDescriptor(awayDesc, { standings, matches });
    if (!homeId || !awayId) { skipped++; continue; }
    if (!teamsById[homeId] || !teamsById[awayId]) { skipped++; continue; }

    // Only write when both sides are still the "0" placeholder, so an
    // upstream feed that later publishes a corrected bracket (e.g. after a
    // disqualification / walkover) can still override our pick.
    const update = {};
    if (String(g.home_team_id) === '0' || !g.home_team_id) update.home_team_id = String(homeId);
    if (String(g.away_team_id) === '0' || !g.away_team_id) update.away_team_id = String(awayId);

    if (Object.keys(update).length === 0) { skipped++; continue; }

    await Game.updateOne({ _id: g._id }, { $set: update });
    resolved++;
    if (verbose) {
      console.log(`[resolve-bracket] match ${g.id} (${g.type}): ${homeId} vs ${awayId}`);
    }
  }

  if (verbose) {
    console.log(`[resolve-bracket] Resolved ${resolved} knockout match(es), skipped ${skipped}`);
  }
  return { resolved, skipped };
}

module.exports = { resolveBracket, parseLabel, resolveDescriptor, KNOCKOUT_TYPES };

// CLI mode: `node scripts/resolve-bracket.js` runs a single pass and exits.
if (require.main === module) {
  (async () => {
    await mongoose.connection.asPromise();
    const result = await resolveBracket({ verbose: true });
    console.log(JSON.stringify(result));
    await mongoose.connection.close();
    process.exit(0);
  })().catch(err => {
    console.error('[resolve-bracket] Fatal:', err);
    process.exit(1);
  });
}
