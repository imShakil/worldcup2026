/**
 * PM2 ecosystem for World Cup 2026 API
 *
 * Manages two long-running processes:
 *   1. api            - the Express API server (index.js)
 *   2. auto-updater   - the live data updater that polls football-data.org and writes to MongoDB
 *
 * Usage:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save                 # persist process list across reboots
 *   pm2 startup              # generate systemd unit so it starts on boot
 *   pm2 logs                 # tail both logs
 *   pm2 restart all          # restart after deploys
 *   pm2 stop all             # stop everything
 */

module.exports = {
  apps: [
    // ─────────────────────────────────────────────────────────────────────
    // 1) Express API
    // ─────────────────────────────────────────────────────────────────────
    {
      name: 'wc-api',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,
      min_uptime: '30s',
      kill_timeout: 8000,
      wait_ready: false,

      // Logs
      log_file: './logs/api-combined.log',
      out_file: './logs/api-out.log',
      error_file: './logs/api-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Env defaults to production so a bare `pm2 start ecosystem.config.cjs`
      // (no --env flag) does the right thing on the prod VM. `config/env.js`
      // already loads `.env.${NODE_ENV}` via dotenv, so we intentionally do
      // NOT pin MONGODB_URL / PORT / secrets here — only NODE_ENV, otherwise
      // pm2-start's env_ map would override the .env file and real changes
      // to MONGODB_URL in .env.production would silently do nothing.
      //
      // Switch to development with:  pm2 start ecosystem.config.cjs --env development
      env: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      }
    },

    // ─────────────────────────────────────────────────────────────────────
    // 2) Live data auto-updater
    // ─────────────────────────────────────────────────────────────────────
    {
      name: 'wc-updater',
      script: 'scripts/auto-updater.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      min_uptime: '10s',
      kill_timeout: 5000,
      wait_ready: false,

      // Lower memory cap and CPU weighting — updater is just a poller
      node_args: ['--max-old-space-size=256'],

      // Logs
      log_file: './logs/updater-combined.log',
      out_file: './logs/updater-out.log',
      error_file: './logs/updater-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Same rationale as wc-api above: do NOT pin MONGODB_URL / POLL_INTERVAL
      // here. They come from .env.development / .env.production, so the API
      // and the updater read from a single source of truth and can never
      // drift onto different databases.
      env: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      }
    }
  ],

  // ───────────────────────────────────────────────────────────────────────
  // Deploy block — example for a remote server
  // ───────────────────────────────────────────────────────────────────────
  deploy: {
    production: {
      user: 'imshakil',
      host: ['34.87.84.134'],
      ref: 'origin/main',
      repo: 'https://github.com/imShakil/worldcup2026.git',
      path: '/home/imshakil/worldcup2026',
      'pre-deploy-local': '',
      'post-deploy':
        'npm install && ' +
        'pm2 delete ecosystem.config.cjs || true && ' +
        'pm2 start ecosystem.config.cjs --env production && ' +
        'pm2 save',
      'pre-setup': ''
    }
  }
};
