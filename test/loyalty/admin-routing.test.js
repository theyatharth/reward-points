// test/loyalty/admin-routing.test.js
//
// The console's URLs over real HTTP, in the three ways a request can reach it:
//   1. through a stand-in for nginx that STRIPS the public base path (the live setup),
//   2. straight to the app WITHOUT the prefix (curl on the server),
//   3. straight to the app WITH the prefix still on it (if nginx ever stops stripping).
// Behind the console sits a stand-in for the Shopify catch-all that answers "No shop provided", so a request that
// falls through is visible. Regression: "/admin/" used to redirect to the relative "admin/" (= /admin/admin/).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mountAdminConsole } from '../../web/admin/router.js';

const BASE = '/reward-points-dev';
const SHOPIFY_MARK = 'No shop provided';

/** What a browser does: follow redirects (at most `max` hops), resolving Location against the current URL. */
async function browse(startUrl, { max = 3 } = {}) {
  const hops = [];
  let url = startUrl;
  for (let i = 0; i <= max; i += 1) {
    const res = await fetch(url, { redirect: 'manual' });
    const body = await res.text();
    const out = { url, status: res.status, body, headers: res.headers };
    hops.push(out);
    if (res.status < 300 || res.status > 399) return { final: out, hops };
    url = new URL(res.headers.get('location'), url).toString();
  }
  throw new Error(`redirect loop: ${hops.map((h) => `${h.status} ${h.url}`).join(' -> ')}`);
}

describe('admin console URLs', () => {
  let appServer;
  let proxyServer;
  let direct;
  let viaNginx;

  before(async () => {
    const app = express();
    mountAdminConsole(app, { basePath: BASE });
    app.use((_req, res) => res.status(400).send(SHOPIFY_MARK)); // the Shopify catch-all
    appServer = http.createServer(app);
    await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
    const appPort = appServer.address().port;
    direct = `http://127.0.0.1:${appPort}`;

    // nginx: strips the base path, forwards the rest, relays the response unchanged.
    proxyServer = http.createServer((req, res) => {
      const stripped = req.url.startsWith(BASE) ? req.url.slice(BASE.length) || '/' : req.url;
      const up = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: stripped, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      req.pipe(up);
    });
    await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r));
    viaNginx = `http://127.0.0.1:${proxyServer.address().port}`;
  });

  after(async () => {
    await new Promise((r) => proxyServer.close(r));
    await new Promise((r) => appServer.close(r));
  });

  const isLoginPage = (hop) => hop.status === 200 && /<title>/.test(hop.body) && !hop.body.includes(SHOPIFY_MARK) && /static\/app\.js/.test(hop.body);

  const ways = () => [
    ['through nginx (prefix stripped)', () => `${viaNginx}${BASE}`],
    ['direct, without the prefix', () => direct],
    ['direct, with the prefix', () => `${direct}${BASE}`],
  ];

  for (const [name, root] of ways()) {
    describe(name, () => {
      test('/admin redirects once, to an absolute path ending in /admin/, and lands on the console', async () => {
        const { hops, final } = await browse(`${root()}/admin`);
        assert.equal(hops[0].status, 308);
        const location = hops[0].headers.get('location');
        assert.ok(location.startsWith('/'), `Location must be an absolute path, got ${location}`);
        assert.ok(location.endsWith('/admin/'), location);
        assert.ok(hops.length <= 2, 'one redirect then the page');
        assert.ok(isLoginPage(final), `expected the console, got ${final.status} ${final.body.slice(0, 80)}`);
      });

      test('/admin/ serves the console with no redirect', async () => {
        const { hops, final } = await browse(`${root()}/admin/`);
        assert.equal(hops.length, 1);
        assert.ok(isLoginPage(final));
        assert.match(final.headers.get('content-security-policy'), /default-src 'none'/);
        assert.equal(final.headers.get('x-frame-options'), 'DENY');
      });

      test('the query string survives the redirect', async () => {
        const { hops } = await browse(`${root()}/admin?next=1`);
        assert.equal(hops[0].headers.get('location').split('?')[1], 'next=1');
      });

      test('unknown paths under /admin are a 404, never the Shopify catch-all', async () => {
        for (const p of ['/admin/anything-unknown', '/admin/index', '/admin/admin/', '/admin/static/nope.js', '/admin/api/nope']) {
          const { final } = await browse(`${root()}${p}`);
          assert.ok(final.status === 404 || final.status === 401, `${p}: ${final.status}`);
          assert.ok(!final.body.includes(SHOPIFY_MARK), `${p} fell through to the Shopify catch-all`);
        }
      });

      test('static files are served', async () => {
        const css = await browse(`${root()}/admin/static/admin.css`);
        assert.equal(css.final.status, 200);
        assert.match(css.final.headers.get('content-type'), /css/);
        const js = await browse(`${root()}/admin/static/app.js`);
        assert.equal(js.final.status, 200);
        assert.match(js.final.headers.get('content-type'), /javascript/);
      });

      test('the API answers JSON from the console (401 without a session), not the Shopify catch-all', async () => {
        const { final } = await browse(`${root()}/admin/api/session`);
        assert.equal(final.status, 401);
        assert.doesNotThrow(() => JSON.parse(final.body));
      });
    });
  }

  test('the console\'s relative URLs resolve to real files from the page URL the browser ends on', async () => {
    const { final } = await browse(`${viaNginx}${BASE}/admin`);
    for (const rel of ['static/admin.css', 'static/app.js']) {
      const res = await fetch(new URL(rel, final.url));
      assert.equal(res.status, 200, rel);
    }
    const api = await fetch(new URL('api/session', final.url));
    assert.equal(api.status, 401);
  });
});
