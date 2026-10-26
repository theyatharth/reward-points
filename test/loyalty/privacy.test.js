// test/loyalty/privacy.test.js
//
// Shopify's mandatory privacy webhooks, sent the way the Shopify CLI sends them (`shopify app webhook trigger`): signed with the app
// secret, the documented payload shapes (test/fixtures/shopify/privacy/), through the real shopify.processWebhooks route and handlers.
//   * a bad or missing signature is a 401 and changes nothing;
//   * customers/data_request is stored once and shown on the console's Data requests screen;
//   * customers/redact anonymises the account and clears notes and stored payloads, and leaves everyone else alone;
//   * shop/redact erases the shop through the controlled path, and ledger/audit stay immutable everywhere else.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { syncDirtyAccounts } from '../../web/loyalty/service/metafield-sync.js';
import { adjustPoints } from '../../web/loyalty/service/adjustment.js';
import { redactCustomer, eraseShop } from '../../web/loyalty/service/privacy.js';
import { startWebhookServer, startEmbeddedConsole, sessionToken, installShop } from '../helpers/shopify-embedded.js';
import { uniqueId } from '../helpers/ids.js';
import { PAGES } from '../../web/admin/public/pages/index.js';

const fixture = (name, shop, customer, orders) => {
  const text = readFileSync(new URL(`../fixtures/shopify/privacy/${name}.json`, import.meta.url), 'utf8').replace('REPLACE_SHOP', shop);
  const o = JSON.parse(text);
  if (o.customer) o.customer.id = customer;
  if (o.orders_requested) o.orders_requested = orders;
  if (o.orders_to_redact) o.orders_to_redact = orders;
  return o;
};
const newShop = (tag = 'priv') => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
let customerSeq = 0;
const newCustomerId = () => Number(`${Date.now()}${String(customerSeq++ % 1000).padStart(3, '0')}`);
const CONFIG = { spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') };

/** Every table's rows for the shop (and the shop's accounts' children), as text, so a test can search them for a value. */
async function dumpShop(shop) {
  const tables = await prisma.$queryRaw`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'shop' ORDER BY 1`;
  const out = [];
  for (const { table_name: t } of tables) out.push(...(await prisma.$queryRawUnsafe(`SELECT x::text AS t FROM "${t}" x WHERE shop = $1`, shop)).map((r) => r.t));
  for (const t of ['LedgerEntry', 'PointLot']) {
    out.push(...(await prisma.$queryRawUnsafe(`SELECT x::text AS t FROM "${t}" x WHERE "accountId" IN (SELECT id FROM "LoyaltyAccount" WHERE shop = $1)`, shop)).map((r) => r.t));
  }
  return out;
}

describe('Privacy webhooks', () => {
  let hook;
  let shop;
  let gw;
  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    hook = await startWebhookServer();
  });
  after(async () => {
    await hook.close();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    shop = newShop();
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({ data: { shop, ...CONFIG } });
  });

  const earn = async (customer, amount = 300, orderId = uniqueId()) => {
    await storeWebhook({ shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: orderId, customer: { id: customer }, processed_at: new Date().toISOString(), line_items: [{ id: 1, quantity: 1, price: String(amount), title: 'x' }] } });
    await processPendingWebhooks({ shop });
    return orderId;
  };
  const account = (customer) => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: String(customer) } } });

  // ======================= signature =======================

  test('a bad or missing signature is a 401 on all three topics, and nothing changes', async () => {
    const customer = newCustomerId();
    await earn(customer);
    const before = await dumpShop(shop);
    for (const [topic, name] of [['customers/data_request', 'customers-data_request'], ['customers/redact', 'customers-redact'], ['shop/redact', 'shop-redact']]) {
      const body = fixture(name, shop, customer, []);
      for (const opts of [{ secret: 'not-the-app-secret-not-the-app-secret' }, { hmac: null }, { hmac: 'AAAA' }, { hmac: '' }]) {
        const r = await hook.send(topic, shop, body, opts);
        assert.strictEqual(r.status, 401, `${topic} ${JSON.stringify(opts).slice(0, 40)}`);
      }
      // A body changed after signing.
      const signed = JSON.stringify(body);
      const tampered = signed.replace('"shop_id":954889', '"shop_id":954888');
      assert.strictEqual((await hook.send(topic, shop, null, { body: tampered, hmac: crypto.createHmac('sha256', 'x'.repeat(40)).update(signed).digest('base64') })).status, 401);
    }
    assert.deepStrictEqual(await dumpShop(shop), before);
    assert.strictEqual(await prisma.dataRequest.count({ where: { shop } }), 0);
  });

  // ======================= customers/data_request =======================

  test('data request: stored once however often it is delivered; the e-mail and phone are not kept', async () => {
    const customer = newCustomerId();
    const orderId = await earn(customer);
    const body = fixture('customers-data_request', shop, customer, [orderId]);
    const first = await hook.send('customers/data_request', shop, body);
    const again = await hook.send('customers/data_request', shop, body, { webhookId: crypto.randomUUID() });
    assert.deepStrictEqual([first.status, again.status], [200, 200]);
    const rows = await prisma.dataRequest.findMany({ where: { shop } });
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual([rows[0].shopifyRequestId, rows[0].shopifyCustomerId, rows[0].status], ['9999', String(customer), 'open']);
    assert.strictEqual(rows[0].accountId, (await account(customer)).id);
    assert.deepStrictEqual(rows[0].ordersRequested, [String(orderId)]);
    const everything = (await dumpShop(shop)).join('\n');
    assert.ok(!everything.includes('john@example.com') && !everything.includes('555-625-1199'), 'personal contact data is not stored');
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'data_request_received' } }), 1);
  });

  test('data request for a customer with no account is stored too, and says nothing is held', async () => {
    const r = await hook.send('customers/data_request', shop, fixture('customers-data_request', shop, newCustomerId(), []));
    assert.strictEqual(r.status, 200);
    const row = await prisma.dataRequest.findFirst({ where: { shop } });
    assert.strictEqual(row.accountId, null);
  });

  test('console: the Data requests screen lists the request and shows the customer\'s account, ledger, orders and codes; other shops see nothing', async () => {
    const site = await startEmbeddedConsole();
    try {
      const customer = newCustomerId();
      const orderId = await earn(customer, 500);
      await installShop(shop);
      await prisma.reward.create({ data: { accountId: (await account(customer)).id, shop, discountCode: 'RWD-TEST-1', discountCodeId: 'gid://x/1', valueInPaise: 5000, pointsUsed: 500 } });
      await hook.send('customers/data_request', shop, fixture('customers-data_request', shop, customer, [orderId]));
      const token = sessionToken(shop, { sub: '5150' });
      const list = await site.call('GET', 'data-requests', { token });
      assert.strictEqual(list.json.requests.length, 1);
      const id = list.json.requests[0].id;
      assert.deepStrictEqual([list.json.requests[0].customerId, list.json.requests[0].status, list.json.requests[0].redacted], [String(customer), 'open', false]);
      const d = (await site.call('GET', `data-requests/${id}`, { token })).json;
      assert.strictEqual(d.account.pending, 500);
      assert.deepStrictEqual(d.ledger.map((e) => [e.type, e.points]), [['earn', 500]]);
      assert.deepStrictEqual(d.orders.map((o) => [o.orderRef, o.pointsEarned]), [[String(orderId), 500]]);
      assert.deepStrictEqual(d.rewards.map((r) => r.code), ['RWD-TEST-1']);
      assert.ok(!JSON.stringify(d).includes('"accountId"'), 'none of our ids');

      // Another shop cannot see or open it.
      const other = newShop('priv-other');
      await installShop(other);
      assert.deepStrictEqual((await site.call('GET', 'data-requests', { token: sessionToken(other) })).json.requests, []);
      assert.strictEqual((await site.call('GET', `data-requests/${id}`, { token: sessionToken(other) })).status, 404);
      assert.strictEqual((await site.call('POST', `data-requests/${id}/sent`, { token: sessionToken(other), body: {} })).status, 404);

      // Marking it sent is audited with the Shopify user.
      assert.strictEqual((await site.call('POST', `data-requests/${id}/sent`, { token, body: {} })).status, 200);
      assert.strictEqual((await site.call('POST', `data-requests/${id}/sent`, { token, body: {} })).json.alreadySent, true);
      const audit = await prisma.auditLog.findMany({ where: { shop, action: 'data_request_sent' } });
      assert.deepStrictEqual(audit.map((a) => a.shopifyUserId), ['5150']);
      assert.strictEqual((await site.call('GET', `data-requests/${id}`, { token })).json.status, 'sent');

      // After the customer is redacted the request shows no data.
      await hook.send('customers/redact', shop, fixture('customers-redact', shop, customer, [orderId]));
      const gone = (await site.call('GET', `data-requests/${id}`, { token })).json;
      assert.deepStrictEqual([gone.redacted, gone.account, gone.ledger.length], [true, null, 0]);
      assert.ok(gone.customerId.startsWith('redacted-'));
      assert.ok(PAGES.some((p) => p.key === 'data'));
    } finally {
      await site.close();
    }
  });

  // ======================= customers/redact =======================

  test('customer redact: id replaced by a random token, notes cleared, payloads blanked; no trace of the id; others untouched', async () => {
    const customer = newCustomerId();
    const bystander = newCustomerId();
    const o1 = await earn(customer, 400);
    const o2 = await earn(customer, 200);
    const oB = await earn(bystander, 300);
    // An admin adjustment with a free-text note: the note lands in the ledger and in the audit detail.
    const admin = await prisma.adminUser.create({ data: { shop, email: `a-${crypto.randomUUID()}@example.test`, passwordHash: 'x', mustChangePassword: false } });
    const adj = await adjustPoints({ shop, shopifyCustomerId: String(customer), points: 50, reason: 'Special bonus', note: 'asked nicely, phone call with Mr John', adminId: admin.id, idempotencyKey: crypto.randomUUID() });
    assert.ok(adj.ok);
    const mine = await account(customer);
    const theirs = await account(bystander);
    // A refund event for one of the customer's orders, an event still waiting, a rate-limit counter, legacy rows, a request.
    const refundEvent = await storeWebhook({ shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(), payload: { id: uniqueId(), order_id: o1, refund_line_items: [], transactions: [] } });
    const waiting = await prisma.webhookEvent.create({ data: { shop, topic: 'orders/paid', status: 'failed', attempts: 1, nextRetryAt: new Date(Date.now() + 60000), payload: { id: uniqueId(), customer: { id: customer }, line_items: [] } } });
    await prisma.redemptionAttempt.create({ data: { shop, customerGid: `gid://shopify/Customer/${customer}` } });
    await prisma.customerPoint.create({ data: { shop, shopifyCustomerId: String(customer), points: 3 } });
    await prisma.pointTransaction.create({ data: { shop, shopifyCustomerId: String(customer), action: 'Order #1', points: 3 } });
    await hook.send('customers/data_request', shop, fixture('customers-data_request', shop, customer, [o1]));

    const ledgerBefore = await prisma.ledgerEntry.findMany({ where: { accountId: mine.id }, orderBy: { id: 'asc' } });
    const auditBefore = await prisma.auditLog.count({ where: { shop } });
    assert.ok(ledgerBefore.some((e) => e.note), 'the ledger has notes to clear');
    assert.ok((await dumpShop(shop)).join('\n').includes(String(customer)), 'the id is in the data before');

    const r = await hook.send('customers/redact', shop, fixture('customers-redact', shop, customer, [o1, o2]));
    assert.strictEqual(r.status, 200);

    // Account: same row and balances, new random id.
    const after = await prisma.loyaltyAccount.findUnique({ where: { id: mine.id } });
    assert.match(after.shopifyCustomerId, /^redacted-[0-9a-f]{32}$/);
    assert.notStrictEqual(after.shopifyCustomerId, String(customer));
    assert.ok(after.redactedAt);
    assert.deepStrictEqual([after.available, after.pending, after.debt], [mine.available, mine.pending, mine.debt]);
    assert.strictEqual(await account(customer), null);
    // Ledger: same rows, same points, notes gone.
    const ledgerAfter = await prisma.ledgerEntry.findMany({ where: { accountId: mine.id }, orderBy: { id: 'asc' } });
    assert.deepStrictEqual(ledgerAfter.map((e) => [e.id, e.type, e.points, e.dedupeKey]), ledgerBefore.map((e) => [e.id, e.type, e.points, e.dedupeKey]));
    assert.ok(ledgerAfter.every((e) => e.note === null));
    // Audit: rows kept, customer id and note gone, one new row without the customer id.
    const audits = await prisma.auditLog.findMany({ where: { shop } });
    assert.strictEqual(audits.length, auditBefore + 1);
    const adjusted = audits.find((a) => a.action === 'points_adjusted');
    assert.ok(adjusted.detail.customerRedacted);
    assert.ok(!('note' in adjusted.detail) && !('shopifyCustomerId' in adjusted.detail));
    assert.strictEqual(adjusted.detail.points, 50);
    const redactRow = audits.find((a) => a.action === 'customer_redacted');
    assert.strictEqual(redactRow.detail.accountId, mine.id);
    assert.strictEqual(redactRow.detail.matched, true);
    // Webhook payloads: the customer's are blanked, a waiting one is skipped, the bystander's is intact.
    const events = await prisma.webhookEvent.findMany({ where: { shop } });
    const blank = (e) => e.payload?._redacted === true && e.payloadPurgedAt !== null;
    for (const e of events.filter((x) => [String(o1), String(o2)].includes(String(x.payload?.id)) || x.id === refundEvent.id || x.id === waiting.id || x.payload?._redacted)) assert.ok(blank(e), `${e.topic} blanked`);
    const waitingNow = events.find((e) => e.id === waiting.id);
    assert.deepStrictEqual([waitingNow.status, waitingNow.nextRetryAt, waitingNow.lastError], ['skipped', null, 'Customer data redacted']);
    const bystanderEvent = events.find((e) => String(e.payload?.id) === String(oB));
    assert.ok(bystanderEvent && !blank(bystanderEvent));
    // Other rows: counters gone, legacy renamed, data request renamed, bystander untouched.
    assert.strictEqual(await prisma.redemptionAttempt.count({ where: { shop } }), 0);
    assert.strictEqual((await prisma.customerPoint.findFirst({ where: { shop } })).shopifyCustomerId, after.shopifyCustomerId);
    assert.strictEqual((await prisma.pointTransaction.findFirst({ where: { shop } })).shopifyCustomerId, after.shopifyCustomerId);
    assert.strictEqual((await prisma.dataRequest.findFirst({ where: { shop } })).shopifyCustomerId, after.shopifyCustomerId);
    const theirsAfter = await prisma.loyaltyAccount.findUnique({ where: { id: theirs.id } });
    assert.deepStrictEqual([theirsAfter.shopifyCustomerId, theirsAfter.redactedAt, theirsAfter.pending], [String(bystander), null, theirs.pending]);
    // No trace anywhere in the shop's rows (the e-mail and phone were never stored).
    const trace = (await dumpShop(shop)).filter((t) => t.includes(String(customer)) || t.includes('john@example.com'));
    assert.deepStrictEqual(trace, []);
  });

  test('customer redact is repeatable, and a customer with no account is a quiet success; nothing in the payload is a quiet success', async () => {
    const customer = newCustomerId();
    await earn(customer);
    const body = fixture('customers-redact', shop, customer, []);
    assert.strictEqual((await hook.send('customers/redact', shop, body)).status, 200);
    const snapshot = await dumpShop(shop);
    assert.strictEqual((await hook.send('customers/redact', shop, body)).status, 200);
    const rows = await prisma.auditLog.findMany({ where: { shop, action: 'customer_redacted' } });
    assert.deepStrictEqual(rows.map((a) => a.detail.matched).sort(), [false, true]);
    assert.strictEqual((await dumpShop(shop)).length, snapshot.length + 1);
    const nobody = { shop_id: 1, shop_domain: shop, orders_to_redact: [] };
    assert.strictEqual((await hook.send('customers/redact', shop, nobody)).status, 200);
    assert.strictEqual((await redactCustomer({ shop, payload: { customer: { id: 'abc; drop table' } } })).matched, false);
  });

  test('a redacted account is never synced to Shopify again, even when it changes', async () => {
    const customer = newCustomerId();
    const other = newCustomerId();
    await earn(customer);
    await earn(other);
    await hook.send('customers/redact', shop, fixture('customers-redact', shop, customer, []));
    const redacted = await prisma.loyaltyAccount.findFirst({ where: { shop, redactedAt: { not: null } } });
    await prisma.loyaltyAccount.update({ where: { id: redacted.id }, data: { available: { increment: 5 } } }); // bumps metafieldSeq
    const r = await syncDirtyAccounts({ shop });
    assert.deepStrictEqual(r.failed, []);
    const written = (gw.metafieldCalls ?? []).flat().map(String);
    assert.ok(written.length > 0, 'the other customer was synced');
    assert.ok(written.includes(String(other)));
    assert.ok(!written.some((id) => id.startsWith('redacted-')), 'nothing written for the redacted id');
    const fresh = await prisma.loyaltyAccount.findUnique({ where: { id: redacted.id } });
    assert.ok(fresh.metafieldSeq > fresh.metafieldSyncedSeq, 'still dirty, still skipped');
  });

  test('a payload that names another shop than the request is refused and changes nothing', async () => {
    const customer = newCustomerId();
    await earn(customer);
    const before = await dumpShop(shop);
    const bad = fixture('customers-redact', 'someone-else.myshopify.com', customer, []);
    assert.notStrictEqual((await hook.send('customers/redact', shop, bad)).status, 200);
    assert.notStrictEqual((await hook.send('shop/redact', shop, { shop_id: 1, shop_domain: 'someone-else.myshopify.com' })).status, 200);
    assert.deepStrictEqual(await dumpShop(shop), before);
    // The placeholder shop_domain the CLI documents ("{shop}.myshopify.com") is not a real domain and is not a mismatch.
    assert.strictEqual((await hook.send('customers/redact', shop, { ...bad, shop_domain: '{shop}.myshopify.com' })).status, 200);
  });

  // ======================= immutability stays =======================

  test('outside a redaction the ledger and audit log stay immutable, and the functions refuse to run', async () => {
    const customer = newCustomerId();
    await earn(customer);
    await prisma.auditLog.create({ data: { shop, action: 'probe', detail: {} } });
    const entry = await prisma.ledgerEntry.findFirst({ where: { account: { shop } } });
    const audit = await prisma.auditLog.findFirst({ where: { shop } });
    await assert.rejects(prisma.ledgerEntry.update({ where: { id: entry.id }, data: { note: 'changed' } }), /immutable/);
    await assert.rejects(prisma.ledgerEntry.delete({ where: { id: entry.id } }), /immutable/);
    await assert.rejects(prisma.auditLog.update({ where: { id: audit.id }, data: { detail: { x: 1 } } }), /immutable/);
    await assert.rejects(prisma.auditLog.delete({ where: { id: audit.id } }), /immutable/);
    await assert.rejects(prisma.$queryRaw`SELECT redact_shop(${shop})`, /redaction transaction/);
    await assert.rejects(prisma.$queryRaw`SELECT redact_customer(${shop}, ${String(customer)}, '{}'::text[], 'redacted-x')`, /redaction transaction/);
    // Allowing it in one transaction does not leak into the next statement outside it, and a delete outside the functions still fails.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rewardpoints.redact_allowed', 'on', true)`;
      await assert.rejects(tx.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${audit.id}`);
    }).catch(() => {});
    await assert.rejects(prisma.$queryRaw`SELECT redact_shop(${shop})`, /redaction transaction/);
    assert.ok(await prisma.auditLog.findUnique({ where: { id: audit.id } }));
    assert.ok(await prisma.ledgerEntry.findUnique({ where: { id: entry.id } }));
    // Only the note may change while redacting: the points of an entry never can.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rewardpoints.redact_allowed', 'on', true)`;
      await tx.$queryRaw`SELECT redact_customer(${shop}, ${'0'}, '{}'::text[], 'redacted-test')`;
      await assert.rejects(tx.$executeRaw`UPDATE "LedgerEntry" SET points = points + 1 WHERE id = ${entry.id}`);
    }).catch(() => {});
    assert.strictEqual((await prisma.ledgerEntry.findUnique({ where: { id: entry.id } })).points, entry.points);
  });
});

// ======================= shop/redact =======================

describe('Shop redact', () => {
  let hook;
  before(async () => { hook = await startWebhookServer(); });
  after(async () => { await hook.close(); await prisma.$disconnect(); });

  /** One row in every table that has the shop (and the account children), for `shop`. */
  async function seed(shop) {
    await prisma.loyaltyConfig.create({ data: { shop, ...CONFIG } });
    const a = await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: String(newCustomerId()), available: 10, pending: 5 } });
    const lot = await prisma.pointLot.create({ data: { accountId: a.id, originalPoints: 5, remaining: 5, shopifyOrderId: String(uniqueId()), activatesAt: new Date(Date.now() + 1e9) } });
    const order = await prisma.loyaltyOrder.create({ data: { accountId: a.id, shop, shopifyOrderId: String(uniqueId()), pointsEarned: 5, eligibleAmountPaise: 500, processedAt: new Date(), lotId: lot.id } });
    await prisma.loyaltyRefund.create({ data: { accountId: a.id, shop, shopifyOrderId: order.shopifyOrderId, pointsReversed: 1, refundAmountPaise: 100, loyaltyOrderId: order.id } });
    await prisma.redemption.create({ data: { accountId: a.id, shop, idempotencyKey: crypto.randomUUID(), pointsUsed: 5, rewardValuePaise: 100 } });
    await prisma.reward.create({ data: { accountId: a.id, shop, discountCode: `C-${crypto.randomUUID()}`, discountCodeId: 'gid://x', valueInPaise: 100, pointsUsed: 5 } });
    await prisma.notification.create({ data: { accountId: a.id, shop, type: 'points_earned', data: {}, dedupeKey: crypto.randomUUID() } });
    await prisma.ledgerEntry.create({ data: { accountId: a.id, type: 'earn', points: 5, dedupeKey: `seed:${crypto.randomUUID()}`, note: 'seed', lotId: lot.id, orderId: order.id } });
    await prisma.webhookEvent.create({ data: { shop, topic: 'orders/paid', payload: { id: 1 }, status: 'processed' } });
    await prisma.auditLog.create({ data: { shop, action: 'seed', detail: {} } });
    await prisma.dataRequest.create({ data: { shop, shopifyRequestId: String(uniqueId()), shopifyCustomerId: a.shopifyCustomerId } });
    await prisma.jobRun.create({ data: { shop, jobType: 'seed', status: 'completed' } });
    const admin = await prisma.adminUser.create({ data: { shop, email: `s-${crypto.randomUUID()}@example.test`, passwordHash: 'x', mustChangePassword: false } });
    await prisma.adminSession.create({ data: { userId: admin.id, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 1e6) } });
    await prisma.adminLoginAttempt.create({ data: { key: `acct:${shop}:someone@example.test` } });
    await prisma.session.create({ data: { id: `offline_${shop}`, shop, state: 's', accessToken: 'tok' } });
    await prisma.shopSettings.create({ data: { shop } });
    await prisma.shopInstall.create({ data: { shop } });
    await prisma.redemptionAttempt.create({ data: { shop, customerGid: 'gid://shopify/Customer/1' } });
    await prisma.processedOrder.create({ data: { shop, orderId: String(uniqueId()) } });
    await prisma.processedRefund.create({ data: { shop, refundId: String(uniqueId()) } });
    await prisma.customerPoint.create({ data: { shop, shopifyCustomerId: '1' } });
    await prisma.pendingPoint.create({ data: { shop, shopifyCustomerId: '1', orderId: String(uniqueId()), points: 1, eligibleAt: new Date() } });
    await prisma.pointTransaction.create({ data: { shop, shopifyCustomerId: '1', action: 'x', points: 1 } });
  }

  const countsFor = async (shop) => {
    const tables = (await prisma.$queryRaw`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'shop' ORDER BY 1`).map((r) => r.table_name);
    const out = {};
    for (const t of tables) out[t] = Number((await prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM "${t}" WHERE shop = $1`, shop))[0].n);
    for (const t of ['LedgerEntry', 'PointLot']) out[t] = Number((await prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM "${t}" WHERE "accountId" IN (SELECT id FROM "LoyaltyAccount" WHERE shop = $1)`, shop))[0].n);
    out.AdminSession = Number((await prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM "AdminSession" WHERE "userId" IN (SELECT id FROM "AdminUser" WHERE shop = $1)`, shop))[0].n);
    out.AdminLoginAttempt = Number((await prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM "AdminLoginAttempt" WHERE "key" LIKE $1`, `acct:${shop}:%`))[0].n);
    return out;
  };

  test('the tables with a shop column are exactly the ones redact_shop knows (add a table: update the SQL function and this list)', async () => {
    const tables = (await prisma.$queryRaw`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'shop' ORDER BY 1`).map((r) => r.table_name);
    assert.deepStrictEqual(tables, ['AdminUser', 'AuditLog', 'CustomerPoint', 'DataRequest', 'JobRun', 'LoyaltyAccount', 'LoyaltyConfig', 'LoyaltyOrder', 'LoyaltyRefund', 'Notification', 'PendingPoint', 'PointTransaction', 'ProcessedOrder', 'ProcessedRefund', 'Redemption', 'RedemptionAttempt', 'Reward', 'Session', 'ShopInstall', 'ShopSettings', 'WebhookEvent']);
    const viaAccount = (await prisma.$queryRaw`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'accountId' ORDER BY 1`).map((r) => r.table_name);
    assert.deepStrictEqual(viaAccount, ['DataRequest', 'LedgerEntry', 'LoyaltyOrder', 'LoyaltyRefund', 'Notification', 'PointLot', 'Redemption', 'Reward']);
  });

  test('shop/redact erases every row of that shop, in every table, and only that shop', async () => {
    const gone = `priv-gone-${Date.now()}.myshopify.com`;
    const kept = `priv-kept-${Date.now()}.myshopify.com`;
    await seed(gone);
    await seed(kept);
    const keptBefore = await countsFor(kept);
    const goneBefore = await countsFor(gone);
    assert.ok(Object.values(goneBefore).every((n) => n >= 1), `seeded every table: ${JSON.stringify(goneBefore)}`);

    const r = await hook.send('shop/redact', gone, { shop_id: 954889, shop_domain: gone });
    assert.strictEqual(r.status, 200);

    assert.ok(Object.values(await countsFor(gone)).every((n) => n === 0), JSON.stringify(await countsFor(gone)));
    assert.deepStrictEqual(await countsFor(kept), keptBefore);
    // A record that it happened, without the shop domain.
    const run = await prisma.jobRun.findFirst({ where: { jobType: 'shop_redact', shop: null }, orderBy: { startedAt: 'desc' } });
    assert.strictEqual(run.result.shopHash, crypto.createHash('sha256').update(gone).digest('hex').slice(0, 12));
    assert.ok(!JSON.stringify(run.result).includes(gone));
    assert.strictEqual(run.result.deleted.LedgerEntry, 1, JSON.stringify(run));
    // Again (a redelivery) and for a shop we never had: fine.
    assert.strictEqual((await hook.send('shop/redact', gone, { shop_id: 954889, shop_domain: gone })).status, 200);
    assert.deepStrictEqual((await eraseShop({ shop: `never-${Date.now()}.myshopify.com` })).deleted.LedgerEntry, 0);
    // The triggers are back: the other shop's ledger and audit rows still cannot be touched.
    const entry = await prisma.ledgerEntry.findFirst({ where: { account: { shop: kept } } });
    await assert.rejects(prisma.ledgerEntry.delete({ where: { id: entry.id } }), /immutable/);
    const audit = await prisma.auditLog.findFirst({ where: { shop: kept } });
    await assert.rejects(prisma.auditLog.delete({ where: { id: audit.id } }), /immutable/);
  });

  test('a shop domain that is not a shop domain is refused before the database is asked', async () => {
    for (const bad of ['', 'x', "a'; DROP TABLE \"LedgerEntry\"; --.myshopify.com", 'a.myshopify.com.evil.com']) await assert.rejects(eraseShop({ shop: bad }), /invalid shop/);
  });
});

describe('Data requests page', () => {
  test('renders the list and a customer\'s data with every value escaped, and the erased and no-account cases', async () => {
    const { renderList, renderDetail } = await import('../../web/admin/public/pages/datarequests.js');
    const list = String(renderList([{ id: 'r1', requestId: '<b>1</b>', customerId: '5', redacted: false, hasAccount: true, status: 'open', receivedAt: '2026-10-01T00:00:00.000Z', completedAt: null }]));
    assert.ok(!list.includes('<b>1</b>') && list.includes('&lt;b&gt;1&lt;/b&gt;'));
    assert.match(list, /data-act="open" data-v="r1"/);
    assert.match(String(renderList([])), /No data requests yet/);
    const detail = String(renderDetail({
      id: 'r1', requestId: '9', customerId: '5', status: 'open', receivedAt: '2026-10-01T00:00:00.000Z', completedAt: null, ordersRequested: ['1'], redacted: false, currency: 'INR',
      account: { available: 1, pending: 2, owed: 0, memberSince: '2026-01-01T00:00:00.000Z' },
      ledger: [{ date: '2026-10-01T00:00:00.000Z', type: 'earn', points: 2, status: 'active', note: '<script>alert(1)</script>' }], orders: [], rewards: [],
    }));
    assert.ok(!detail.includes('<script>') && detail.includes('&lt;script&gt;'));
    assert.match(detail, /Mark as sent/);
    assert.match(String(renderDetail({ id: 'r', requestId: '9', customerId: 'redacted-ab', status: 'open', receivedAt: null, ordersRequested: [], redacted: true, account: null, ledger: [], orders: [], rewards: [] })), /erased at Shopify's request/);
    assert.match(String(renderDetail({ id: 'r', requestId: '9', customerId: '5', status: 'sent', completedAt: '2026-10-02T00:00:00.000Z', receivedAt: null, ordersRequested: [], redacted: false, account: null, ledger: [], orders: [], rewards: [] })), /no rewards account/);
  });
});
