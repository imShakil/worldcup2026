# Auto Live Updater for World Cup 2026

Automatically fetches **real-time match data** from [football-data.org](https://www.football-data.org) (v4 API) and updates the MongoDB database. No more manual score entry — scores, scorers, and standings update automatically during live matches.

## Features

- ⚡ **Real-time scores** — updates every 90 seconds during live matches
- ⚽ **Goal scorers** with English names (sourced from football-data)
- 🟡 **Penalty goals** detected and marked with `(p)`
- 🟥 **Own goals** detected and marked with `(OG)`
- ⏱ **Live minute** surfaced in the `time_elapsed` field (e.g. `67'`)
- 📊 **Group standings** auto-calculated after each match finishes
- 🚦 **Rate-limit aware** — respects `Retry-After` headers from the free tier
- 🔁 **Exponential backoff** on upstream failures (capped at 5 min)

## How It Works

```
football-data.org v4  (competitions/WC/matches?dateFrom=…&dateTo=…)
       ↓ every 90 seconds, X-Auth-Token header
auto-updater.js
       ↓ matches teams by 3-letter FIFA code (TLA) → team_id
       ↓ parses inline match.goals[] for scorers + (p)/(OG) markers
MongoDB (your worldcup2026 database)
       ↓ recalculates standings when match finishes
Your API serves updated data
```

The free tier of football-data.org is **10 requests/minute**, so a 90-second polling cadence (≈ 0.67 req/min) leaves plenty of headroom for ad-hoc dashboard refreshes and other consumers.

## Setup

1. Register for a free API token at [football-data.org/client/register](https://www.football-data.org/client/register).

2. Add the token to your environment file (`.env.production` / `.env.development`):

```bash
FOOTBALL_DATA_TOKEN=your_token_here
```

3. Make sure MongoDB is running and the database is seeded (see main README).

4. Install dependencies (no new ones needed — uses Node 18+ native `fetch`):

```bash
npm install
```

5. Start the updater:

```bash
node scripts/auto-updater.js
```

Or with PM2:

```bash
pm2 start ecosystem.config.cjs
```

The `wc-updater` process defined in `ecosystem.config.cjs` is what you want.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FOOTBALL_DATA_TOKEN` | — (required) | API token from football-data.org |
| `FOOTBALL_DATA_BASE_URL` | `https://api.football-data.org/v4` | Override the API base URL |
| `FOOTBALL_DATA_COMPETITION` | `WC` | Competition code (leave as `WC` for the World Cup) |
| `MONGO_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection string |
| `DB_NAME` | `football` | Database name |
| `POLL_INTERVAL` | `90000` | Polling interval in ms (free tier = 10 req/min) |
| `SYNC_DAYS_BACK` | `10` | How many days of past fixtures to include per request |
| `MAX_MATCH_ID` | `104` | Cap on `Game.id` considered (104 = final) |
| `FETCH_TIMEOUT_MS` | `20000` | Per-request HTTP timeout |
| `FETCH_RETRIES` | `2` | Retry count for transient failures |

## Match Identification

football-data returns its own numeric `id` (e.g. `537404`) which does **not** line up with our local string `id` (`"1"`–`"104"`). The updater joins upstream matches to local `Game` documents using:

1. **Home team TLA** → `Team.fifa_code` (e.g. `MEX`, `ARG`, `KOR`)
2. **Away team TLA** → `Team.fifa_code`
3. **Kickoff timestamp** as a tiebreaker (must be within 24h of the local `local_date`)

Knockout-stage matches with TBD opponents are skipped — the upstream match has no `homeTeam.tla` until teams are determined.

## Scorer Format

Goal events are parsed from the inline `match.goals[]` array (no separate `/events` request is needed). The output format matches what the frontend already expects:

```json
{"Lionel Messi 51'(p)","Julián Álvarez 67'"}
```

Penalties get `(p)`, own goals get `(OG)`, regular goals have no suffix.

## Standings

After every successful poll the updater recalculates standings only if the count of finished matches changed since the last tick. This avoids redundant work — group standings only change when a match flips from unfinished to finished.

## Data Source

[football-data.org](https://www.football-data.org) is a popular open football data provider. The v4 API provides:

- Live match scores, status, and minute (for in-play matches)
- Match events (goals with scorer, minute, and type) inline in the match payload
- Standardized 3-letter team codes (TLA) for reliable joining
- A 10 req/min free tier — plenty for our 90-second polling cadence

A registered token is required; calls without one return HTTP 401 and the updater will refuse to start.

## Troubleshooting

- **`❌ FOOTBALL_DATA_TOKEN is not set`** — add the token to `.env.production` (or `.env.development`) and restart the process.
- **`HTTP 403`** — your token doesn't have access to the `WC` competition. Confirm you registered at football-data.org and the competition code is correct.
- **`HTTP 429 Rate limited`** — the updater will sleep for the `Retry-After` duration and retry automatically. If you see this often, raise `POLL_INTERVAL`.
- **Scores not updating** — confirm `Team.fifa_code` is populated in your `teams` collection (the importer seeds this). Without a matching TLA, upstream matches are silently skipped.
- **Empty `home_scorers` after a goal** — football-data sometimes reports a goal a few minutes after the event. The next poll will pick it up.

## Credits

- Original project: [rezarahiminia/worldcup2026](https://github.com/rezarahiminia/worldcup2026)
- Live data source: [football-data.org](https://www.football-data.org)
- Auto-updater by: [Nexu Team](https://app.nexuhub.net)
