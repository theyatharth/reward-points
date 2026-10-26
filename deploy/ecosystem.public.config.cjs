// PM2 process definition for the PUBLIC app ("Reward Points", shopify.app.production.toml), on the same EC2 instance as the dev app.
// Own checkout, own PM2 names, own port, own database: nothing here is shared with reward-points-dev.
//
//   pm2 start deploy/ecosystem.public.config.cjs           (both processes)
//   pm2 start deploy/ecosystem.public.config.cjs --only reward-points-app-worker
//   pm2 save
//
// The checkout is /home/ubuntu/reward-points-app (APP_DIR below); index.js and worker.js live in its web/ folder, so that is the
// working directory. Secrets and the database URL are NOT in this file: both processes read <APP_DIR>/.env themselves (see
// docs/PUBLIC-APP.md for the variable names). What is set here is only what must be right for this app and cannot be left to a .env
// that was copied from the dev app: APP_ENV=production (the database guard then accepts ONLY the database named in
// LIVE_DATABASE_NAME), the port, the base path nginx strips, and the embedded-admin auth mode.
// Start PM2 from a shell where Node 22 is first on PATH (engines >= 22).
const APP_DIR = '/home/ubuntu/reward-points-app';

module.exports = {
  apps: [
    {
      name: 'reward-points-app',
      cwd: APP_DIR + '/web',
      script: 'index.js',
      interpreter: 'node',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        APP_ENV: 'production',
        PORT: 3004, // nginx proxies /reward-points-app/ to 127.0.0.1:3004 (deploy/nginx-reward-points-app.conf.example)
        APP_BASE_PATH: '/reward-points-app',
        ADMIN_AUTH: 'shopify',
      },
    },
    {
      // Processes stored webhook events and runs the background jobs (activation, sync, expiry, purge, reconciliation).
      name: 'reward-points-app-worker',
      cwd: APP_DIR + '/web',
      script: 'worker.js',
      interpreter: 'node',
      autorestart: true,
      kill_timeout: 15000, // SIGTERM lets the current tick finish before PM2 gives up
      env: {
        NODE_ENV: 'production',
        APP_ENV: 'production',
      },
    },
  ],
};
