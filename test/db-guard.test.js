// test/db-guard.test.js
//
// Tests for web/lib/db-guard.js
// Verifies that each denied host and database name is refused, and that a
// correct development or test database URL is allowed through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDbAllowed, assertNotProtected } from '../web/lib/db-guard.js';

const DEV_URL = 'postgresql://postgres:password@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/reward_points_dev?schema=public';
const TEST_URL = 'postgresql://postgres:password@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/reward_points_dev_test?schema=public';
const CI_TEST_URL = 'postgresql://postgres:postgres@localhost:5432/reward_points_ci_test?schema=public';

// ---------------------------------------------------------------------------
// Allowed connections
// ---------------------------------------------------------------------------

test('allows reward_points_dev', () => {
  assert.doesNotThrow(() => assertDbAllowed(DEV_URL));
});

test('allows reward_points_dev_test', () => {
  assert.doesNotThrow(() => assertDbAllowed(TEST_URL));
});

test('allows CI test database (localhost)', () => {
  assert.doesNotThrow(() => assertDbAllowed(CI_TEST_URL, { requireTestSuffix: true }));
});

// ---------------------------------------------------------------------------
// Denied: proluma-db-instance host
// ---------------------------------------------------------------------------

test('refuses proluma-db-instance host', () => {
  const url = 'postgresql://postgres:pw@proluma-db-instance.us-east-1.rds.amazonaws.com:5432/reward_points_dev?schema=public';
  assert.throws(() => assertDbAllowed(url), /proluma-db-instance/);
});

// ---------------------------------------------------------------------------
// Denied: production database name
// ---------------------------------------------------------------------------

test('refuses reward_points (production database)', () => {
  const url = 'postgresql://postgres:pw@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/reward_points?schema=public';
  assert.throws(() => assertDbAllowed(url), /reward_points/);
});

// ---------------------------------------------------------------------------
// Denied: other product databases
// ---------------------------------------------------------------------------

test('refuses PlantCare database', () => {
  const url = 'postgresql://postgres:pw@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/PlantCare?schema=public';
  assert.throws(() => assertDbAllowed(url), /PlantCare/);
});

test('refuses adgenius database', () => {
  const url = 'postgresql://postgres:pw@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/adgenius?schema=public';
  assert.throws(() => assertDbAllowed(url), /adgenius/);
});

test('refuses attendix database', () => {
  const url = 'postgresql://postgres:pw@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/attendix?schema=public';
  assert.throws(() => assertDbAllowed(url), /attendix/);
});

test('refuses hawkerdb database', () => {
  const url = 'postgresql://postgres:pw@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/hawkerdb?schema=public';
  assert.throws(() => assertDbAllowed(url), /hawkerdb/);
});

// ---------------------------------------------------------------------------
// Denied: Postgres system databases
// ---------------------------------------------------------------------------

test('refuses postgres system database', () => {
  const url = 'postgresql://postgres:pw@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/postgres?schema=public';
  assert.throws(() => assertDbAllowed(url), /postgres/);
});

test('refuses template0 system database', () => {
  const url = 'postgresql://postgres:pw@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/template0?schema=public';
  assert.throws(() => assertDbAllowed(url), /template0/);
});

test('refuses rdsadmin system database', () => {
  const url = 'postgresql://postgres:pw@smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com:5432/rdsadmin?schema=public';
  assert.throws(() => assertDbAllowed(url), /rdsadmin/);
});

// ---------------------------------------------------------------------------
// requireTestSuffix: test runner mode
// ---------------------------------------------------------------------------

test('requireTestSuffix refuses a dev database from the test runner', () => {
  assert.throws(
    () => assertDbAllowed(DEV_URL, { requireTestSuffix: true }),
    /_test/
  );
});

test('requireTestSuffix allows a _test database', () => {
  assert.doesNotThrow(() => assertDbAllowed(TEST_URL, { requireTestSuffix: true }));
});

// ---------------------------------------------------------------------------
// assertNotProtected
// ---------------------------------------------------------------------------

test('assertNotProtected blocks a database listed in PROTECTED_DATABASES', () => {
  process.env.PROTECTED_DATABASES = 'reward_points,some_other_prod';
  try {
    assert.throws(
      () => assertNotProtected('postgresql://u:p@host:5432/reward_points?schema=public'),
      /PROTECTED_DATABASES/
    );
  } finally {
    delete process.env.PROTECTED_DATABASES;
  }
});

test('assertNotProtected allows a database not in PROTECTED_DATABASES', () => {
  process.env.PROTECTED_DATABASES = 'reward_points';
  try {
    assert.doesNotThrow(() =>
      assertNotProtected('postgresql://u:p@host:5432/reward_points_dev?schema=public')
    );
  } finally {
    delete process.env.PROTECTED_DATABASES;
  }
});

test('assertNotProtected is a no-op when PROTECTED_DATABASES is unset', () => {
  delete process.env.PROTECTED_DATABASES;
  assert.doesNotThrow(() =>
    assertNotProtected('postgresql://u:p@host:5432/reward_points?schema=public')
  );
});

// ---------------------------------------------------------------------------
// The public app's live database: LIVE_DATABASE_NAME, only with APP_ENV=production, and nothing else then.
// ---------------------------------------------------------------------------

const HOST = 'smarthawker-devdb.cry8skcsql30.ap-south-1.rds.amazonaws.com';
const urlFor = (db, host = HOST) => `postgresql://postgres:pw@${host}:5432/${db}?schema=public`;

/** Runs fn with APP_ENV / LIVE_DATABASE_NAME set (undefined = unset), then puts them back. */
function withEnv(env, fn) {
  const saved = { APP_ENV: process.env.APP_ENV, LIVE_DATABASE_NAME: process.env.LIVE_DATABASE_NAME };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('production: exactly the database named in LIVE_DATABASE_NAME is allowed', () => {
  withEnv({ APP_ENV: 'production', LIVE_DATABASE_NAME: 'reward_points_app' }, () => {
    assert.doesNotThrow(() => assertDbAllowed(urlFor('reward_points_app')));
  });
});

test('production: every other database is refused, even an otherwise allowed one', () => {
  withEnv({ APP_ENV: 'production', LIVE_DATABASE_NAME: 'reward_points_app' }, () => {
    for (const db of ['reward_points_dev', 'reward_points_dev_test', 'reward_points_app_2', 'reward_points_app_test', 'something_else']) {
      assert.throws(() => assertDbAllowed(urlFor(db)), /only to the database named in LIVE_DATABASE_NAME/, db);
    }
  });
});

test('production still refuses reward_points, the other products, the system databases and the shared host', () => {
  withEnv({ APP_ENV: 'production', LIVE_DATABASE_NAME: 'reward_points_app' }, () => {
    for (const db of ['reward_points', 'PlantCare', 'adgenius', 'attendix', 'hawkerdb', 'postgres', 'template0', 'template1', 'rdsadmin']) {
      assert.throws(() => assertDbAllowed(urlFor(db)), undefined, db);
    }
    assert.throws(() => assertDbAllowed(urlFor('reward_points_app', 'proluma-db-instance.us-east-1.rds.amazonaws.com')), /proluma-db-instance/);
  });
});

test('LIVE_DATABASE_NAME cannot be used to unlock a refused database, and must be one plain name', () => {
  for (const name of ['reward_points', 'postgres', 'template1', 'rdsadmin', 'hawkerdb']) {
    withEnv({ APP_ENV: 'production', LIVE_DATABASE_NAME: name }, () => {
      assert.throws(() => assertDbAllowed(urlFor(name)), /refused/, name);
    });
  }
  for (const name of ['a,b', 'reward_points_app reward_points_dev', 'x;y', '../x', 'a'.repeat(64)]) {
    withEnv({ APP_ENV: 'production', LIVE_DATABASE_NAME: name }, () => {
      assert.throws(() => assertDbAllowed(urlFor('reward_points_app')), /exactly one plain database name/, name);
    });
  }
});

test('production without LIVE_DATABASE_NAME refuses to start', () => {
  withEnv({ APP_ENV: 'production', LIVE_DATABASE_NAME: undefined }, () => {
    assert.throws(() => assertDbAllowed(urlFor('reward_points_app')), /needs LIVE_DATABASE_NAME/);
    assert.throws(() => assertDbAllowed(urlFor('reward_points_dev')), /needs LIVE_DATABASE_NAME/);
  });
});

test('outside production the live database is refused, and nothing else changes', () => {
  for (const appEnv of [undefined, '', 'development', 'test', 'staging']) {
    withEnv({ APP_ENV: appEnv, LIVE_DATABASE_NAME: 'reward_points_app' }, () => {
      assert.throws(() => assertDbAllowed(urlFor('reward_points_app')), /only when APP_ENV=production/, String(appEnv));
      assert.doesNotThrow(() => assertDbAllowed(urlFor('reward_points_dev')));
      assert.doesNotThrow(() => assertDbAllowed(urlFor('reward_points_dev_test'), { requireTestSuffix: true }));
      assert.throws(() => assertDbAllowed(urlFor('reward_points')), /reward_points/);
    });
  }
  withEnv({ APP_ENV: 'Production', LIVE_DATABASE_NAME: 'reward_points_app' }, () => {
    assert.throws(() => assertDbAllowed(urlFor('reward_points_app')), /only when APP_ENV=production/);
  });
});

test('the guard is unchanged when neither variable is set (dev, CI, the test runner)', () => {
  withEnv({ APP_ENV: undefined, LIVE_DATABASE_NAME: undefined }, () => {
    assert.doesNotThrow(() => assertDbAllowed(urlFor('reward_points_app')));
    assert.doesNotThrow(() => assertDbAllowed(CI_TEST_URL, { requireTestSuffix: true }));
  });
});

test('the test runner refuses to run in production', () => {
  withEnv({ APP_ENV: 'production', LIVE_DATABASE_NAME: 'reward_points_app_test' }, () => {
    assert.throws(() => assertDbAllowed(urlFor('reward_points_app_test'), { requireTestSuffix: true }), /test runner refuses/);
  });
});
