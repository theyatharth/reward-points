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
  ],
};
