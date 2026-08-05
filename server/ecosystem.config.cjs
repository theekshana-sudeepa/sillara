/**
 * PM2 config for the Sillara platform API.
 *
 * instances: 1 — the API is stateless and could run clustered, but a single
 * process on a small VPS handles thousands of shops (the sell screen never
 * calls it during a sale). Scale to cluster mode only after profiling shows
 * CPU saturation, and move MySQL off-box first.
 */
module.exports = {
  apps: [
    {
      name: 'sillara-api',
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      time: true,
      kill_timeout: 16000,
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
