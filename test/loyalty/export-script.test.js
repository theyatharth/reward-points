// test/loyalty/export-script.test.js
//
// scripts/export-webhook-payloads.mjs: its guards and its read-only nature.
// No database is contacted: every case exits before the first query (the Prisma
// client connects lazily).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'export-webhook-payloads.mjs');
const DEV_URL = 'postgresql://u:p@localhost:5999/reward_points_dev?schema=public';

function run(args, databaseUrl = DEV_URL) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('refuses an output directory outside the repository', () => {
  for (const out of ['..', '../elsewhere', '/tmp/rp-export', '.']) {
    const r = run(['--out', out]);
    assert.notStrictEqual(r.code, 0, `--out ${out}`);
    assert.match(r.out, /--out must be a directory inside the repository/, `--out ${out}`);
  }
});

test('refuses a missing, zero, fractional or oversized --limit', () => {
  for (const limit of ['0', '-3', '1.5', '51', 'abc']) {
    const r = run(['--limit', limit]);
    assert.notStrictEqual(r.code, 0, `--limit ${limit}`);
    assert.match(r.out, /--limit must be an integer from 1 to 50/, `--limit ${limit}`);
  }
});

test('refuses the production database name before doing anything (db-guard)', () => {
  const r = run(['--topic', 'orders/paid'], 'postgresql://u:p@localhost:5999/reward_points?schema=public');
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /db-guard/);
});

test('the script only reads: no database write call appears in its source', () => {
  const src = readFileSync(SCRIPT, 'utf8').replace(/\/\/.*$/gm, '');
  for (const forbidden of [/\.create\(/, /\.createMany\(/, /\.update\(/, /\.updateMany\(/, /\.upsert\(/, /\.delete\(/, /\.deleteMany\(/, /\$executeRaw/, /\$queryRawUnsafe/, /\$transaction/]) {
    assert.ok(!forbidden.test(src), `must not contain ${forbidden}`);
  }
  assert.match(src, /findMany\(/);
});

test('raw payloads are never written: the only write goes through redactPayload', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.equal((src.match(/writeFileSync\(/g) || []).length, 1, 'exactly one file write');
  assert.match(src, /redactPayload\(ev\.payload\)/);
  assert.ok(!/JSON\.stringify\(ev\.payload/.test(src), 'ev.payload is never serialised directly');
  assert.ok(!/console\.log\([^)]*ev\.payload/.test(src), 'ev.payload is never printed');
});
