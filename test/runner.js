// test/runner.js
//
// Test runner entry point.
//
// Enforces the database safety rules before any test file is loaded:
//   1. TEST_DATABASE_URL must be set.
//   2. The database name must end in _test.
//   3. The database must not be on the PROTECTED_DATABASES list.
//
// Then runs all test files matched by the glob passed on the command line,
// or defaults to test/**/*.test.js.
//
// Usage:
//   node --test test/runner.js
//   node --test test/runner.js test/loyalty/**/*.test.js

import { assertDbAllowed, assertNotProtected } from '../web/lib/db-guard.js';

// ---------------------------------------------------------------------------
// Guard: must run BEFORE any test file imports prisma.js / opens a connection
// ---------------------------------------------------------------------------
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  console.error(
    '[runner] TEST_DATABASE_URL is not set.\n' +
      'Set it to a database whose name ends in _test, e.g.:\n' +
      '  TEST_DATABASE_URL=postgresql://...@smarthawker-devdb.../reward_points_dev_test?schema=public'
  );
  process.exit(1);
}

// requireTestSuffix=true: the database name MUST end in _test
assertDbAllowed(testUrl, { requireTestSuffix: true });
assertNotProtected(testUrl);

// Override DATABASE_URL so that any module importing prisma.js picks up the
// test database, not the development one.
process.env.DATABASE_URL = testUrl;

// Node's built-in test runner discovers files via --test flag automatically
// when this file is the entry point.  Individual test files use node:test
// and node:assert.
console.log(`[runner] Test database: ${new URL(testUrl).pathname.slice(1)}`);
