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
