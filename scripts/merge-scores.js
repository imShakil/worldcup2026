const fs = require('fs');
const path = require('path');

const gamesPath = path.join(__dirname, '../data/games.json');
const matchesPath = path.join(__dirname, '../data/football.matches.json');

const games = JSON.parse(fs.readFileSync(gamesPath, 'utf8')).games;
const matches = JSON.parse(fs.readFileSync(matchesPath, 'utf8'));

// Build a map from games.json keyed by id
const gamesById = {};
for (const g of games) {
  gamesById[g.id] = g;
}

let updated = 0;
for (const m of matches) {
  const g = gamesById[m.id];
  if (!g) continue;
  if (g.finished === 'TRUE') {
    let changed = false;
    if (m.home_score !== g.home_score) { m.home_score = g.home_score; changed = true; }
    if (m.away_score !== g.away_score) { m.away_score = g.away_score; changed = true; }
    if (m.home_scorers !== g.home_scorers) { m.home_scorers = g.home_scorers; changed = true; }
    if (m.away_scorers !== g.away_scorers) { m.away_scorers = g.away_scorers; changed = true; }
    if (m.finished !== 'TRUE') { m.finished = 'TRUE'; changed = true; }
    if (m.time_elapsed !== 'finished') { m.time_elapsed = 'finished'; changed = true; }
    if (changed) updated++;
  }
}

fs.writeFileSync(matchesPath, JSON.stringify(matches, null, 2) + '\n', 'utf8');
console.log(`Updated ${updated} matches.`);
