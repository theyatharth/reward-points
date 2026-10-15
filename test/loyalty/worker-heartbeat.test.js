// test/loyalty/worker-heartbeat.test.js
//
// "Last worker tick" on the admin Overview: the worker upserts one WorkerHeartbeat row at the end of EVERY tick
// (quiet ones too, which write no JobRun); the Overview shows its age and warns after 5 minutes.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { runTick } from '../../web/loyalty/service/worker.js';
import { workerStatus, WORKER_HEARTBEAT, WORKER_STALE_SECONDS } from '../../web/admin/data/overview.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { startConsole, adminBrowser, allKeys } from '../helpers/admin-http.js';
import { workerBanner } from '../../web/admin/public/pages/overview.js';
import { ago } from '../../web/admin/public/format.js';

describe('Worker heartbeat', () => {
  let site;
  let savedShop;

  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    savedShop = process.env.ADMIN_SHOP;
    site = await startConsole();
  });
  after(async () => {
    await site.close();
    restoreClock();
    if (savedShop === undefined) delete process.env.ADMIN_SHOP; else process.env.ADMIN_SHOP = savedShop;
    await prisma.$disconnect();
  });
  beforeEach(() => restoreClock());

  const uniqueType = () => `hb_test_${crypto.randomUUID()}`;
  const beatOf = (name) => prisma.workerHeartbeat.findUnique({ where: { name } });
  const noopWork = async () => ({ picked: 0, processed: 0, failed: 0 });

  describe('the worker writes it', () => {
    test('a QUIET tick writes the heartbeat and no JobRun; later ticks update the same row', async () => {
      const type = uniqueType();
      const lockKey = 7284149000 + Math.floor(Math.random() * 1e6);
      setFixedTime(new Date('2026-10-15T10:00:00Z'));
      await runTick({ work: noopWork, jobType: type, lockKey });
      let row = await beatOf(type);
      assert.strictEqual(row.lastTickAt.toISOString(), '2026-10-15T10:00:00.000Z');
      assert.deepStrictEqual([row.lastTickRan, row.lastTickFailed], [true, false]);
      assert.strictEqual(await prisma.jobRun.count({ where: { jobType: type } }), 0, 'quiet ticks write no JobRun');

      setFixedTime(new Date('2026-10-15T10:00:30Z'));
      await runTick({ work: noopWork, jobType: type, lockKey });
      row = await beatOf(type);
      assert.strictEqual(row.lastTickAt.toISOString(), '2026-10-15T10:00:30.000Z');
      assert.strictEqual(await prisma.workerHeartbeat.count({ where: { name: type } }), 1);
    });

    test('a tick that did work beats too, and still writes its JobRun', async () => {
      const type = uniqueType();
      setFixedTime(new Date('2026-10-15T11:00:00Z'));
      await runTick({ work: async () => ({ picked: 2, processed: 2, failed: 0 }), jobType: type, lockKey: 7284149000 + Math.floor(Math.random() * 1e6) });
      assert.strictEqual((await beatOf(type)).lastTickFailed, false);
      assert.strictEqual(await prisma.jobRun.count({ where: { jobType: type, status: 'completed' } }), 1);
    });

    test('a tick that throws beats with lastTickFailed = true (and the JobRun records the failure)', async () => {
      const type = uniqueType();
      const quiet = console.error;
      console.error = () => {};
      try {
        await runTick({ work: async () => { throw new Error('boom'); }, jobType: type, lockKey: 7284149000 + Math.floor(Math.random() * 1e6) });
      } finally {
        console.error = quiet;
      }
      const row = await beatOf(type);
      assert.strictEqual(row.lastTickFailed, true);
      assert.strictEqual(await prisma.jobRun.count({ where: { jobType: type, status: 'failed' } }), 1);
    });

    test('a tick that finds another worker holding the lock still shows the process is alive (ran = false)', async () => {
      const type = uniqueType();
      const lockKey = 7284149000 + Math.floor(Math.random() * 1e6);
      let release;
      const held = new Promise((r) => { release = r; });
      let locked;
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(${String(lockKey)}::bigint)) AS t`;
        locked();
        await held;
      }, { timeout: 30_000 });
      await new Promise((r) => { locked = r; });
      try {
        const out = await runTick({ work: noopWork, jobType: type, lockKey });
        assert.strictEqual(out.ran, false);
      } finally {
        release();
        await holder;
      }
      const row = await beatOf(type);
      assert.deepStrictEqual([row.lastTickRan, row.lastTickFailed], [false, false]);
    });
  });

  describe('workerStatus: the Overview warns after 5 minutes', () => {
    const NOW = Date.parse('2026-10-15T12:00:00Z');
    const setBeat = (secondsAgo, failed = false) => prisma.workerHeartbeat.upsert({
      where: { name: WORKER_HEARTBEAT },
      create: { name: WORKER_HEARTBEAT, lastTickAt: new Date(NOW - secondsAgo * 1000), lastTickFailed: failed },
      update: { lastTickAt: new Date(NOW - secondsAgo * 1000), lastTickFailed: failed },
    });

    test('no row: "never"', async () => {
      await prisma.workerHeartbeat.deleteMany({ where: { name: WORKER_HEARTBEAT } });
      assert.deepStrictEqual(await workerStatus(NOW), { state: 'never', lastTickAt: null, ageSeconds: null, lastTickFailed: false, staleAfterSeconds: 300 });
    });

    test('ok up to and including 5 minutes, stale after', async () => {
      assert.strictEqual(WORKER_STALE_SECONDS, 300);
      for (const [age, state] of [[0, 'ok'], [10, 'ok'], [299, 'ok'], [300, 'ok'], [301, 'stale'], [3600, 'stale']]) {
        await setBeat(age);
        const s = await workerStatus(NOW);
        assert.strictEqual(s.state, state, `${age}s`);
        assert.strictEqual(s.ageSeconds, age);
      }
    });

    test('a tick stamped in the future (clock skew) is age 0, not negative', async () => {
      await setBeat(-30);
      const s = await workerStatus(NOW);
      assert.deepStrictEqual([s.state, s.ageSeconds], ['ok', 0]);
    });

    test('whether the last tick failed is passed on', async () => {
      await setBeat(5, true);
      assert.strictEqual((await workerStatus(NOW)).lastTickFailed, true);
    });
  });

  describe('the Overview API and page', () => {
    let shop;
    let admin;
    beforeEach(async () => {
      shop = `hb-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
      process.env.ADMIN_SHOP = shop;
      await prisma.loyaltyConfig.create({ data: { shop, currency: 'INR' } });
      admin = await adminBrowser(site.url, shop);
    });

    test('GET /overview carries the worker status; no error text, no process details', async () => {
      await prisma.workerHeartbeat.upsert({ where: { name: WORKER_HEARTBEAT }, create: { name: WORKER_HEARTBEAT, lastTickAt: new Date(Date.now() - 20_000) }, update: { lastTickAt: new Date(Date.now() - 20_000), lastTickFailed: false } });
      const r = await admin.get('overview');
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.worker.state, 'ok');
      assert.ok(r.json.worker.ageSeconds >= 19 && r.json.worker.ageSeconds <= 60);
      assert.deepStrictEqual(Object.keys(r.json.worker).sort(), ['ageSeconds', 'lastTickAt', 'lastTickFailed', 'staleAfterSeconds', 'state']);
      const keys = allKeys(r.json.worker);
      for (const bad of ['error', 'pid', 'name', 'lastTickRan']) assert.ok(!keys.has(bad), bad);
    });

    test('an old heartbeat is reported stale by the API', async () => {
      await prisma.workerHeartbeat.upsert({ where: { name: WORKER_HEARTBEAT }, create: { name: WORKER_HEARTBEAT, lastTickAt: new Date(Date.now() - 600_000) }, update: { lastTickAt: new Date(Date.now() - 600_000) } });
      assert.strictEqual((await admin.get('overview')).json.worker.state, 'stale');
    });
  });

  describe('the banner', () => {
    const w = (state, ageSeconds, over = {}) => ({ state, lastTickAt: '2026-10-15T12:00:00.000Z', ageSeconds, lastTickFailed: false, staleAfterSeconds: 300, ...over });

    test('green while recent, with the age', () => {
      const html = String(workerBanner(w('ok', 12)));
      assert.match(html, /class="hb ok"/);
      assert.match(html, /12 s ago/);
      assert.ok(!html.includes('role="alert"'));
    });

    test('a warning colour and an alert after 5 minutes, with the age', () => {
      const html = String(workerBanner(w('stale', 7 * 60)));
      assert.match(html, /class="hb warn"/);
      assert.match(html, /role="alert"/);
      assert.match(html, /7 min ago/);
      assert.match(html, /after 5 minutes/);
    });

    test('red when it never ticked', () => {
      assert.match(String(workerBanner(w('never', null, { lastTickAt: null }))), /class="hb bad"/);
      assert.match(String(workerBanner(undefined)), /class="hb bad"/);
    });

    test('a failed last tick is said, but the banner stays green while ticks are recent', () => {
      const html = String(workerBanner(w('ok', 5, { lastTickFailed: true })));
      assert.match(html, /class="hb ok"/);
      assert.match(html, /last tick failed/);
    });
  });

  test('ago(): seconds, minutes, hours, days', () => {
    assert.deepStrictEqual([0, 5, 59, 60, 119, 3599, 3600, 7500, 86399, 86400, 172800].map(ago),
      ['0 s ago', '5 s ago', '59 s ago', '1 min ago', '1 min ago', '59 min ago', '1 h ago', '2 h 5 min ago', '23 h 59 min ago', '1 day ago', '2 days ago']);
    assert.strictEqual(ago(undefined), '—');
    assert.strictEqual(ago(-5), '0 s ago');
  });
});
