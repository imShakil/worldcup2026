/**
 * World Cup 2026 — Games JSON Importer
 *
 * One-shot script: reads data/games.json and upserts each entry into the
 * Game collection, matched by `id`. Useful for seeding the actual results
 * of already-played matches (the auto-updater only handles live/recent ones).
 *
 * Fields that exist in the Game model are written; extra fields in the JSON
 * (home_team_name_en, home_team_name_fa, away_team_name_en, away_team_name_fa)
 * are written too since the running API has been returning them on reads.
 *
 * Usage:
 *   node scripts/import-games.js
 *
 * Requires:
 *   - MongoDB reachable via MONGODB_URL
 *   - data/games.json present (104 entries, wrapped in { "games": [...] })
 */

const { loadEnvConfig } = require('../config/env');
loadEnvConfig();

// dotenv can prompt interactively when both .env and the resolved env file
// are present. We've already loaded the right env file above, so make sure
// process.env.MONGODB_URL is defined before mongoose connects.
if (!process.env.MONGODB_URL) {
    console.error('❌ MONGODB_URL is not set. Check your .env.production or .env.development file.');
    process.exit(1);
}

const fs = require('fs');
const path = require('path');
const mongoose = require('../database');
const Game = require('../models/game');

const JSON_PATH = path.join(__dirname, '../data/games.json');

async function main() {
    console.log('Connecting to MongoDB...');
    await mongoose.connection.asPromise();
    console.log('✅ Connected\n');

    if (!fs.existsSync(JSON_PATH)) {
        throw new Error(`File not found: ${JSON_PATH}`);
    }

    const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    const games = raw.games || raw; // support both wrapped and bare array
    console.log(`Found ${games.length} games in games.json\n`);

    // Allowed fields (Game model + the team-name denormalized fields the API returns)
    const ALLOWED = new Set([
        'id', 'home_team_id', 'away_team_id',
        'home_score', 'away_score',
        'home_scorers', 'away_scorers',
        'group', 'matchday', 'local_date', 'persian_date',
        'stadium_id', 'finished', 'time_elapsed', 'type',
        'home_team_label', 'away_team_label',
        'home_team_name_en', 'home_team_name_fa',
        'away_team_name_en', 'away_team_name_fa',
    ]);

    let updated = 0;
    let inserted = 0;
    let skipped = 0;

    for (const g of games) {
        if (!g.id) {
            console.warn(`⚠️  Skipping entry with no id: ${JSON.stringify(g).slice(0, 80)}...`);
            skipped++;
            continue;
        }

        const $set = {};
        for (const [k, v] of Object.entries(g)) {
            if (k === '_id') continue;        // don't touch Mongo's _id
            if (ALLOWED.has(k)) $set[k] = v; // only write known fields
        }

        const result = await Game.updateOne(
            { id: String(g.id) },
            { $set },
            { upsert: true }
        );

        if (result.upsertedCount > 0) inserted++;
        else if (result.modifiedCount > 0) updated++;
        else skipped++; // already matched the DB
    }

    console.log('\n──── Summary ────');
    console.log(`Inserted: ${inserted}`);
    console.log(`Updated : ${updated}`);
    console.log(`Skipped : ${skipped} (already in sync)`);
    console.log(`Total   : ${games.length}`);

    // Verify counts by finished state
    const finishedCount = await Game.countDocuments({ finished: 'TRUE' });
    const totalCount = await Game.countDocuments({});
    console.log(`\nDB now has ${finishedCount}/${totalCount} matches marked finished`);

    await mongoose.disconnect();
    console.log('\n✅ Done');
    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Import failed:', err);
    process.exit(1);
});
