// PM2 process definition for running this app alongside your other
// Shopify app on the same EC2 instance.
//
// Usage (from the repo root, on the EC2 box):
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save
//
// Pick a PORT that isn't already used by your other app — check with:
//   pm2 list
//   sudo lsof -i -P -n | grep LISTEN
module.exports = {
  apps: [
    {
      name: 'reward-points', // must be distinct from your other app's PM2 process name
      cwd: __dirname + '/../web',
      script: 'index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: 3001, // change if this port is already taken on the box
      },
    },
    {
      // Background worker for the DEV app: processes stored webhook events every
      // 30 seconds. Start it explicitly, never with the whole file:
      //   pm2 start deploy/ecosystem.config.cjs --only reward-points-dev-worker
      // It loads <repo root>/.env itself (like the dev app), so run it from the
      // DEV_DIR checkout. The database guard refuses the production database, so
      // from a production checkout it exits at start instead of running.
      // Start PM2 from a shell where Node 22 is first on PATH (engines >= 22).
      name: 'reward-points-dev-worker',
      cwd: __dirname + '/../web',
      script: 'worker.js',
      interpreter: 'node',
      autorestart: true,
      kill_timeout: 15000, // SIGTERM lets the current tick finish before PM2 gives up
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
