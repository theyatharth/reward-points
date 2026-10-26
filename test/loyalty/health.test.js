// test/loyalty/health.test.js: /healthz answers 200 when the database does and 503 when it does not, and says nothing else.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../web/lib/prisma.js';
import { createHealthRouter } from '../../web/routes/health.js';

async function serve(router, mountAt = '/') {
  const app = express();
  app.use(mountAt, router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('/healthz', () => {
  after(async () => { await prisma.$disconnect(); });

  test('200 {"ok":true} with the real database, no cookie and no caching', async () => {
    const s = await serve(createHealthRouter());
    try {
      const r = await fetch(`${s.url}/healthz`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('set-cookie'), null);
    } finally { await s.close(); }
  });

  test('503 {"ok":false} when the database errors, and the error text is not in the answer', async () => {
    const lines = [];
    const origError = console.error;
    console.error = (...a) => lines.push(a.join(' '));
    const s = await serve(createHealthRouter({ check: async () => { throw new Error('password authentication failed for user "secretuser"'); } }));
    try {
      const r = await fetch(`${s.url}/healthz`);
      const text = await r.text();
      assert.equal(r.status, 503);
      assert.deepEqual(JSON.parse(text), { ok: false });
      assert.ok(!text.includes('secretuser'));
    } finally { console.error = origError; await s.close(); }
  });

  test('503 when the database does not answer within the limit', async () => {
    const origError = console.error;
    console.error = () => {};
    const s = await serve(createHealthRouter({ check: () => new Promise(() => {}), timeoutMs: 50 }));
    try {
      const started = Date.now();
      const r = await fetch(`${s.url}/healthz`);
      assert.equal(r.status, 503);
      assert.ok(Date.now() - started < 2000);
    } finally { console.error = origError; await s.close(); }
  });

  test('only GET; mounted under a prefix it answers there too', async () => {
    const s = await serve(createHealthRouter(), '/reward-points-app');
    try {
      assert.equal((await fetch(`${s.url}/reward-points-app/healthz`)).status, 200);
      assert.equal((await fetch(`${s.url}/healthz`)).status, 404);
      assert.equal((await fetch(`${s.url}/reward-points-app/healthz`, { method: 'POST' })).status, 404);
    } finally { await s.close(); }
  });
});
