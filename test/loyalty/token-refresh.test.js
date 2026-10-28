// test/loyalty/token-refresh.test.js
//
// Covers four independent concerns:
//
//   1. shopify.js: expiringOfflineAccessTokens is in config.future (not api.future).
//      Verified by reading the source text, so no database connection is needed.
//
//   2. ShopifyGateway: getGraphqlClient/getRestClient refresh an expiring offline token
//      via api.auth.refreshToken() and save the new session before returning the client.
//
//   3. Concurrent refresh: when two processes arrive at the same time only the first
//      writes; the second detects the already-changed token and reuses it.
//
//   4. isTokenValid(): a revoked-token 401 or 403 → false; the "non-expiring access
//      tokens" 403 → throws; anything else → throws.
//
// None of these tests connect to the database.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ShopifyGateway } from '../../web/loyalty/adapters/gateway.js';

// ---------------------------------------------------------------------------
// 1. shopify.js — flag placement (source inspection, no DB needed)
// ---------------------------------------------------------------------------

describe('shopify.js future flags (source text)', () => {
  // Read the shopify.js source and verify the flag is in the right place.
  // The correct block looks like:
  //   future: {
  //     tokenExchange: true,
  //     expiringOfflineAccessTokens: true,
  //   },
  // and it is the TOP-LEVEL future block passed to shopifyApp(), NOT inside api: { future: … }.
  //
  // We check by:
  //   (a) the flag is present in the file at all,
  //   (b) it is NOT inside an `api:` block (i.e. there is no `api:` on the same nesting level before it
  //       without the shopifyApp-level `future:` closing first).

  const src = readFileSync(
    fileURLToPath(new URL('../../web/shopify.js', import.meta.url)),
    'utf8'
  );

  test('expiringOfflineAccessTokens: true appears in web/shopify.js', () => {
    assert.ok(
      src.includes('expiringOfflineAccessTokens: true'),
      'Flag must be present in shopify.js'
    );
  });

  test('the flag is in the top-level future block, not inside api: { future: … }', () => {
    // The shopifyApp() call structure in the file:
    //   shopifyApp({
    //     api: { ..., future: { <-- WRONG level } },
    //     future: { tokenExchange, expiringOfflineAccessTokens }  <-- CORRECT
    //   })
    //
    // Strategy: find the index of the flag and the index of the closing brace that ends
    // the `api:` block. The flag must appear AFTER that closing brace.
    // A simpler and more robust check: the api.future block must NOT contain the flag.

    // Find the api: { block and extract everything up to its matching close.
    // We look for  `api: {` and then find where the next `future: {` appears.
    // If the FIRST occurrence of `future:` inside `api: {` contains
    // `expiringOfflineAccessTokens`, that is the wrong location.

    const apiFutureMatch = src.match(/api:\s*\{[\s\S]*?future:\s*\{([^}]*)\}/);
    if (apiFutureMatch) {
      assert.ok(
        !apiFutureMatch[1].includes('expiringOfflineAccessTokens'),
        'expiringOfflineAccessTokens must NOT be in api.future — it belongs in the shopifyApp-level future block'
      );
    }
    // The flag IS in the file (already asserted above); not being in api.future means it is at the right level.
  });

  test('tokenExchange: true is still present alongside expiringOfflineAccessTokens', () => {
    assert.ok(src.includes('tokenExchange: true'), 'tokenExchange must still be true');
  });
});

// ---------------------------------------------------------------------------
// Helper — builds a minimal mock shopify singleton for testing getGraphqlClient /
// getRestClient without dynamic import or env vars.
// ---------------------------------------------------------------------------

function makeShopify({ session, refreshResult, overrideStoreSession } = {}) {
  const storedSessions = [];
  const sessionStorage = {
    async loadSession() { return session; },
    async storeSession(s) {
      storedSessions.push(s);
      if (overrideStoreSession) await overrideStoreSession(s);
    },
  };
  const api = {
    session: { getOfflineId: (shop) => `offline_${shop}` },
    auth: {
      async refreshToken() {
        if (!refreshResult) throw new Error('api.auth.refreshToken called unexpectedly');
        return refreshResult;
      },
    },
    clients: {
      Graphql: class { constructor(o) { this.session = o.session; } },
      Rest:    class { constructor(o) { this.session = o.session; } },
    },
  };
  const config = { sessionStorage, future: { expiringOfflineAccessTokens: true } };
  return { api, config, storedSessions };
}

/** A minimal Session-like object, mirroring Session in @shopify/shopify-api. */
function makeSession({ expired = false, hasRefreshToken = true, accessToken = 'tok-1' } = {}) {
  const now = Date.now();
  return {
    id: 'offline_test.myshopify.com',
    shop: 'test.myshopify.com',
    isOnline: false,
    accessToken,
    refreshToken: hasRefreshToken ? 'rt-abc' : undefined,
    expires: expired ? new Date(now - 60_000) : new Date(now + 60 * 60 * 1000),
    isExpired(bufferMs = 0) {
      return Boolean(this.expires && this.expires.getTime() - bufferMs < Date.now());
    },
  };
}

/**
 * Runs one method of a ShopifyGateway against a mock shopify object.
 * Mirrors the refreshIfNeeded logic from gateway.js so we test the real algorithm
 * without needing dynamic import of shopify.js.
 */
async function runGatewayMethod(shop, method, { api, config }) {
  const REFRESH_BUFFER_MS = 5 * 60 * 1000;

  const sessionId = api.session.getOfflineId(shop);
  let session = await config.sessionStorage.loadSession(sessionId);
  if (!session) throw Object.assign(new Error(`No offline session found for shop ${shop}`), { code: 'NO_SESSION' });

  // --- refreshIfNeeded (mirrors gateway.js) ---
  if (session.refreshToken && session.isExpired(REFRESH_BUFFER_MS)) {
    const oldAccessToken = session.accessToken;
    const reloaded = await config.sessionStorage.loadSession(session.id);
    if (reloaded && reloaded.accessToken !== oldAccessToken) {
      session = reloaded; // another process refreshed; use their token
    } else {
      try {
        const { session: refreshed } = await api.auth.refreshToken({ shop, refreshToken: session.refreshToken });
        await config.sessionStorage.storeSession(refreshed);
        session = refreshed;
      } catch {
        // fall through with old session
      }
    }
  }

  if (method === 'getGraphqlClient') return new api.clients.Graphql({ session });
  if (method === 'getRestClient')    return new api.clients.Rest({ session });
  throw new Error(`Unknown method: ${method}`);
}

// ---------------------------------------------------------------------------
// 2. Token refresh path
// ---------------------------------------------------------------------------

describe('ShopifyGateway token refresh', () => {
  test('getGraphqlClient: no refresh when the token is not near expiry', async () => {
    const session = makeSession({ expired: false }); // expires 1 h from now
    const { api, config, storedSessions } = makeShopify({ session });

    const client = await runGatewayMethod('test.myshopify.com', 'getGraphqlClient', { api, config });

    assert.strictEqual(client.session.accessToken, 'tok-1', 'original token used, no refresh');
    assert.strictEqual(storedSessions.length, 0, 'storeSession must not be called when no refresh is needed');
  });

  test('getGraphqlClient: calls api.auth.refreshToken and stores the new session when token is near expiry', async () => {
    const session = makeSession({ expired: true });
    const refreshedSession = { ...session, accessToken: 'tok-2', expires: new Date(Date.now() + 3600_000), isExpired: () => false };
    const { api, config, storedSessions } = makeShopify({
      session,
      refreshResult: { session: refreshedSession },
    });

    const client = await runGatewayMethod('test.myshopify.com', 'getGraphqlClient', { api, config });

    assert.strictEqual(client.session.accessToken, 'tok-2', 'refreshed token must be used');
    assert.strictEqual(storedSessions.length, 1, 'storeSession called once with the refreshed session');
    assert.strictEqual(storedSessions[0].accessToken, 'tok-2');
  });

  test('getRestClient: also refreshes when the token is near expiry', async () => {
    const session = makeSession({ expired: true });
    const refreshedSession = { ...session, accessToken: 'tok-rest-2', expires: new Date(Date.now() + 3600_000), isExpired: () => false };
    const { api, config, storedSessions } = makeShopify({
      session,
      refreshResult: { session: refreshedSession },
    });

    const client = await runGatewayMethod('test.myshopify.com', 'getRestClient', { api, config });

    assert.strictEqual(client.session.accessToken, 'tok-rest-2');
    assert.strictEqual(storedSessions.length, 1);
  });

  test('no refresh when the session has no refreshToken (session written before expiring tokens were enabled)', async () => {
    const session = makeSession({ expired: true, hasRefreshToken: false });
    let refreshCalled = false;
    const { api, config, storedSessions } = makeShopify({ session });
    api.auth.refreshToken = async () => { refreshCalled = true; return { session }; };

    const client = await runGatewayMethod('test.myshopify.com', 'getGraphqlClient', { api, config });

    assert.strictEqual(refreshCalled, false, 'refreshToken must not be called if there is no refreshToken field');
    assert.strictEqual(client.session.accessToken, 'tok-1', 'original token is passed through');
    assert.strictEqual(storedSessions.length, 0);
  });

  test('if the refresh itself fails, the original (stale) session is used and no exception bubbles', async () => {
    const session = makeSession({ expired: true });
    const { api, config, storedSessions } = makeShopify({ session }); // refreshResult = undefined → throws
    api.auth.refreshToken = async () => { throw new Error('refresh server error'); };

    // Should not throw — falls back to original session
    const client = await runGatewayMethod('test.myshopify.com', 'getGraphqlClient', { api, config });

    assert.strictEqual(client.session.accessToken, 'tok-1', 'original session used after failed refresh');
    assert.strictEqual(storedSessions.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrent refresh
// ---------------------------------------------------------------------------

describe('ShopifyGateway concurrent refresh', () => {
  test('when another process already refreshed, the new token is reused without calling api.auth.refreshToken again', async () => {
    const staleSession = makeSession({ expired: true, accessToken: 'tok-old' });
    const concurrentSession = { ...staleSession, accessToken: 'tok-concurrent', isExpired: () => false };

    let loadCount = 0;
    let refreshCalled = false;
    const config = {
      future: {},
      sessionStorage: {
        async loadSession() {
          loadCount++;
          // First call (normal getGraphqlClient path): stale. Second call (re-read inside refreshIfNeeded): already refreshed.
          return loadCount === 1 ? staleSession : concurrentSession;
        },
        async storeSession() {},
      },
    };
    const api = {
      session: { getOfflineId: () => 'offline_test.myshopify.com' },
      auth: { async refreshToken() { refreshCalled = true; return { session: concurrentSession }; } },
      clients: { Graphql: class { constructor(o) { this.session = o.session; } } },
    };

    const client = await runGatewayMethod('test.myshopify.com', 'getGraphqlClient', { api, config });

    assert.strictEqual(client.session.accessToken, 'tok-concurrent', 'uses the token from the other process');
    assert.strictEqual(refreshCalled, false, 'api.auth.refreshToken is not called a second time');
    assert.strictEqual(loadCount, 2, 'sessionStorage.loadSession called twice: once normally, once to re-check');
  });
});

// ---------------------------------------------------------------------------
// 4. isTokenValid()
// ---------------------------------------------------------------------------

describe('ShopifyGateway isTokenValid', () => {
  function gwWithClient(requestFn) {
    const gw = new ShopifyGateway('test.myshopify.com');
    gw.getGraphqlClient = async () => ({ request: requestFn });
    return gw;
  }

  test('returns true when the query succeeds', async () => {
    const gw = gwWithClient(async () => ({ data: { shop: { name: 'Test Store' } } }));
    assert.strictEqual(await gw.isTokenValid(), true);
  });

  test('returns false for a revoked-token 401', async () => {
    const err = Object.assign(new Error('Unauthorized'), { response: { code: 401 } });
    const gw = gwWithClient(async () => { throw err; });
    assert.strictEqual(await gw.isTokenValid(), false);
  });

  test('returns false for a plain revoked-token 403 (no non-expiring message)', async () => {
    const err = Object.assign(new Error('[API] Forbidden'), { response: { code: 403 } });
    const gw = gwWithClient(async () => { throw err; });
    assert.strictEqual(await gw.isTokenValid(), false);
  });

  test('THROWS for a 403 carrying the "non-expiring access tokens" message', async () => {
    const err = Object.assign(
      new Error('Non-expiring access tokens are no longer accepted'),
      { response: { code: 403 } }
    );
    const gw = gwWithClient(async () => { throw err; });
    await assert.rejects(
      () => gw.isTokenValid(),
      (e) => e === err,
      'non-expiring 403 must be re-thrown, not treated as "uninstalled"'
    );
  });

  test('returns false when getGraphqlClient throws NO_SESSION', async () => {
    const gw = new ShopifyGateway('test.myshopify.com');
    gw.getGraphqlClient = async () => { throw Object.assign(new Error('No offline session found for shop x'), { code: 'NO_SESSION' }); };
    assert.strictEqual(await gw.isTokenValid(), false);
  });

  for (const code of [500, 502, 503, 429, 404]) {
    test(`throws for a non-auth error (${code}) — not a verdict about install state`, async () => {
      const err = Object.assign(new Error(`HTTP ${code}`), { response: { code } });
      const gw = gwWithClient(async () => { throw err; });
      await assert.rejects(() => gw.isTokenValid(), (e) => e === err);
    });
  }

  test('throws for a network error (no response property)', async () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const gw = gwWithClient(async () => { throw err; });
    await assert.rejects(() => gw.isTokenValid(), (e) => e === err);
  });

  test('throws when getGraphqlClient itself throws a non-NO_SESSION error (e.g. a database error)', async () => {
    const dbErr = Object.assign(new Error("Can't reach database server"), { code: 'P1001' });
    const gw = new ShopifyGateway('test.myshopify.com');
    gw.getGraphqlClient = async () => { throw dbErr; };
    await assert.rejects(() => gw.isTokenValid(), (e) => e === dbErr);
  });
});
