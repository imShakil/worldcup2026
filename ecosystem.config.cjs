/**
 * PM2 ecosystem for World Cup 2026 API
 *
 * Manages two long-running processes:
 *   1. api            - the Express API server (index.js)
 *   2. auto-updater   - the live data updater that polls Varzesh3 and writes to MongoDB
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

      // Env (use --env production to switch)
      env: {
        NODE_ENV: 'development',
        PORT: 3050
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3050
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

      // Auto-updater env. MONGODB_URL is the single source of truth for the
      // connection string AND the database name (matches the API server).
      // POLL_INTERVAL controls how often we hit Varzesh3.
      env: {
        NODE_ENV: 'development',
        MONGODB_URL: 'mongodb://127.0.0.1:27017/worldcup2026',
        POLL_INTERVAL: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        MONGODB_URL: 'mongodb://127.0.0.1:27017/worldcup2026',
        POLL_INTERVAL: 3000
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
      repo: 'git@github.com:imShakil/worldcup2026.git',
      path: '/home/imshakil/worldcup2026',
      'pre-deploy-local': '',
      'post-deploy':
        'npm ci --omit=dev && ' +
        'pm2 delete ecosystem.config.cjs || true && ' +
        'pm2 start ecosystem.config.cjs --env production && ' +
        'pm2 save',
      'pre-setup': ''
    }
  }
};
