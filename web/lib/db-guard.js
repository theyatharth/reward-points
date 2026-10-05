// web/lib/db-guard.js
//
// Database connection guard for Phase 1.
//
// Enforces that scripts and tests only connect to the explicit allow-list of
// database names and hosts.  Call assertDbAllowed(url) before opening any
// database connection.  The function throws a clear error if the target
// database is on the deny list.
//
// Denied hosts (outright, in Phase 1):
//   proluma-db-instance  — the company's shared production instance; Phase 1
//                          never touches it.
//
// Denied database names (on any host):
//   PlantCare, adgenius, attendix, hawkerdb — unrelated products on the
//   same instance; a script touching them could damage production data.
//   postgres, template0, template1, rdsadmin — Postgres system databases.
//   reward_points — current production database (moved to a new DB at M5).
//
// Additionally, the test runner refuses any database whose name does not end
// in _test, so a test run can never wipe a development or production database.

const DENIED_HOSTS = ['proluma-db-instance'];

const DENIED_DB_NAMES = new Set([
  'PlantCare',
  'plantcare',
  'adgenius',
  'attendix',
  'hawkerdb',
  'postgres',
  'template0',
  'template1',
  'rdsadmin',
  'reward_points', // production database — refused until M5 cutover
]);

/**
 * Parses a PostgreSQL connection URL and returns { host, dbName }.
 * Throws if the URL cannot be parsed.
 *
 * @param {string} url
 * @returns {{ host: string, dbName: string }}
 */
function parseUrl(url) {
  if (!url) throw new Error('[db-guard] No database URL provided.');
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    // pathname is like /database_name — strip the leading slash.
    const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    if (!dbName) throw new Error('[db-guard] Database name is missing from URL.');
    return { host, dbName };
  } catch (err) {
    throw new Error(`[db-guard] Could not parse database URL: ${err.message}`);
  }
}

/**
 * Asserts that the given database URL is on the allowed list.
 * Throws a descriptive Error if the connection should be refused.
 *
 * @param {string} url  - PostgreSQL connection URL.
 * @param {{ requireTestSuffix?: boolean }} [options]
 *   requireTestSuffix: if true (used by the test runner), the database name
 *   MUST end in _test, regardless of the other checks.
 */
export function assertDbAllowed(url, { requireTestSuffix = false } = {}) {
  const { host, dbName } = parseUrl(url);

  // 1. Denied host check.
  for (const deniedHost of DENIED_HOSTS) {
    if (host.includes(deniedHost)) {
      throw new Error(
        `[db-guard] Connection to host "${host}" is refused in Phase 1. ` +
          `proluma-db-instance hosts other production databases (PlantCare, adgenius, attendix, hawkerdb). ` +
          `Phase 1 only uses smarthawker-devdb.`
      );
    }
  }

  // 2. Denied database name check.
  if (DENIED_DB_NAMES.has(dbName)) {
    throw new Error(
      `[db-guard] Connection to database "${dbName}" is refused. ` +
        `This is either a production database, an unrelated product database, or a Postgres system database. ` +
        `Allowed databases in Phase 1: reward_points_dev and reward_points_dev_test.`
    );
  }

  // 3. Test-suffix check (for the test runner).
  if (requireTestSuffix && !dbName.endsWith('_test')) {
    throw new Error(
      `[db-guard] The test runner refuses to connect to "${dbName}". ` +
        `The database name must end in _test so a test run can never wipe a development or production database. ` +
        `Set TEST_DATABASE_URL to a database whose name ends in _test (e.g. reward_points_dev_test).`
    );
  }
}

/**
 * Asserts that PROTECTED_DATABASES (comma-separated env var) does not
 * include the database name in the given URL.  Used by seed and reset scripts.
 *
 * @param {string} url
 */
export function assertNotProtected(url) {
  const protected_ = (process.env.PROTECTED_DATABASES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (protected_.length === 0) return;

  const { dbName } = parseUrl(url);
  if (protected_.includes(dbName)) {
    throw new Error(
      `[db-guard] Database "${dbName}" is listed in PROTECTED_DATABASES and cannot be modified by this script. ` +
        `Remove it from PROTECTED_DATABASES only after confirming you intend to write to it.`
    );
  }
}
