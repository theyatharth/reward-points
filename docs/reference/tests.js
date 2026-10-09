/* =====================================================================
   EDGE-CASE TEST SUITE (BRD §73) — every test runs on a fresh engine
   ===================================================================== */
function runRewardTests() {
  const L = (...pairs) => pairs.map(([id, qty]) => ({ productId: id, qty, price: PMAP[id].price, title: PMAP[id].title }));
  const fresh = (patch) => {
    const E = new Engine(START);
    if (patch) patch(E.s.config);
    E.createCustomer({ id: 'u1', name: 'Test One', email: 'one@test.in' });
    return E;
  };
  const ledgerOK = E => E.reconcile().issues.filter(i => i.kind !== 'Failed event').length === 0;
  // gift-free, GST-0 product so ₹ in = points out: hedge shears ₹659
  const T = [];
  const t = (group, name, fn) => T.push({ group, name, fn });

  t('Customers', 'New customer gets exactly one loyalty account', () => {
    const E = fresh(); E.ensureAccount('u1'); E.ensureAccount('u1');
    const n = Object.values(E.s.accounts).filter(a => a.customerId === 'u1').length;
    return [n === 1, `${n} account(s) for one customer`];
  });
  t('Customers', 'Returning customer: each order earns its own ledger entry', () => {
    const E = fresh(); E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) });
    const n = E.s.txns.filter(x => x.type === 'purchase').length; const b = E.balances('u1');
    return [n === 2 && b.pending === 1318, `${n} purchase entries, ${b.pending} pending`];
  });
  t('Customers', 'Zero points: no rewards affordable, next reward is the smallest', () => {
    const E = fresh(); const r = E.rewardState('u1');
    return [r.have === 0 && r.affordable.length === 0 && r.next.id === 'rw10', `have ${r.have}, next ${r.next && r.next.name}`];
  });
  t('Customers', 'Duplicate customer (same email) reuses the existing account', () => {
    const E = fresh(); const r = E.createCustomer({ name: 'Test Dup', email: 'ONE@test.in' });
    return [r.duplicate && Object.keys(E.s.accounts).length === 1, `duplicate=${r.duplicate}, accounts=${Object.keys(E.s.accounts).length}`];
  });
  t('Customers', 'Guest checkout holds points; account creation claims them with the original date', () => {
    const E = fresh(); const o = E.checkout({ email: 'guest@test.in', lines: L(['gt029', 1]) });
    const before = E.s.guestHolds[0].points; E.advance(5);
    E.createCustomer({ id: 'g', name: 'Guest Person', email: 'guest@test.in' });
    const b = E.balances('g'); const ord = E.s.orders[o.orderId];
    return [before === 659 && b.pending === 659 && ord.availableAt === START + 30 * DAY, `held ${before}, claimed pending ${b.pending}, available ${new Date(ord.availableAt).toISOString().slice(0, 10)}`];
  });

  t('Earning', 'Earning rule is configurable (₹100 → 50 points)', () => {
    const E = fresh(c => { c.earn.points = 50; }); E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) });
    return [E.balances('u1').pending === 329, `₹659 → ${E.balances('u1').pending} pts`];
  });
  t('Earning', 'Rounding: ₹149 → 149 (proportional), 100 (per full ₹100 block), 150 when ₹149.5 rounds', () => {
    const E = fresh(); const a = E.pointsFor(149); E.s.config.earn.rounding = 'block'; const b = E.pointsFor(149); E.s.config.earn.rounding = 'round'; const c = E.pointsFor(149.5);
    return [a === 149 && b === 100 && c === 150, `floor ${a} · block ${b} · round ${c}`];
  });
  t('Earning', 'Eligible value excludes gift cards, shipping and GST; uses price after discount', () => {
    const E = fresh(); const r = E.calcPoints(L(['gt029', 1], ['gift-1000', 1]), 100, 79);
    // share of discount on eligible = 100 × 659/1659 = 39.72 → 619.28, GST 0
    return [r.points === 619, `₹659 shears + ₹1,000 gift card, ₹100 discount, ₹79 shipping → ${r.points} pts`];
  });
  t('Earning', 'GST-inclusive price: ₹419 at 5% GST earns on ₹399.05', () => {
    const E = fresh(); const r = E.calcPoints(L(['cpot039-05', 1]));
    return [r.points === 399, `${r.points} pts`];
  });

  t('Lifecycle', 'Purchase points start pending with the holding-period date', () => {
    const E = fresh(); E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); const b = E.balances('u1');
    return [b.pending === 659 && b.available === 0 && b.pendingOrders[0].availableAt === START + 30 * DAY, `pending ${b.pending}, available ${b.available}`];
  });
  t('Lifecycle', 'Points activate after the holding period (not a day before)', () => {
    const E = fresh(); E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); E.advance(29); const mid = E.balances('u1').available; E.advance(1);
    return [mid === 0 && E.balances('u1').available === 659, `day 29: ${mid}, day 30: ${E.balances('u1').available}`];
  });
  t('Lifecycle', 'Holding period 0 days → available immediately', () => {
    const E = fresh(c => { c.holdingDays = 0; }); E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) });
    return [E.balances('u1').available === 659, `available ${E.balances('u1').available}`];
  });
  t('Lifecycle', 'Expired points: expire 12 months after activation, with a ledger entry', () => {
    const E = fresh(); E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); E.advance(30); E.advance(366);
    const x = E.s.txns.find(t => t.type === 'expiry');
    return [E.balances('u1').available === 0 && x && x.points === -659, `available ${E.balances('u1').available}, expiry entry ${x ? x.points : 'none'}`];
  });
  t('Lifecycle', 'Expiry takes oldest points first; redeemed points are not expired again', () => {
    const E = fresh(c => { c.holdingDays = 0; c.returnPointsOnCodeExpiry = false; }); E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); E.redeem('u1', 'rw50', 'k'); E.advance(200); E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); E.advance(170);
    const exp = -E.s.txns.filter(t => t.type === 'expiry').reduce((s, t) => s + t.points, 0);
    return [exp === 159 && E.balances('u1').available === 659, `expired ${exp}, available ${E.balances('u1').available}`];
  });

  t('Returns & refunds', 'Full return before activation cancels pending points', () => {
    const E = fresh(); const o = E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) });
    E.ingest({ id: 'r1', topic: 'refunds/create', payload: { orderId: o.orderId, refundId: 'rf1', amount: 659, kind: 'return' } }); E.advance(31);
    const b = E.balances('u1'); const c = E.s.txns.find(t => t.type === 'cancellation');
    return [b.pending === 0 && b.available === 0 && c.status === 'Cancelled' && E.s.txns.filter(t => t.type === 'purchase').length === 1, `pending ${b.pending}, available ${b.available}, original entry kept`];
  });
  t('Returns & refunds', 'Full return after activation creates a linked reversal', () => {
    const E = fresh(); const o = E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); E.advance(30);
    E.ingest({ id: 'r1', topic: 'refunds/create', payload: { orderId: o.orderId, refundId: 'rf1', amount: 659, kind: 'return' } });
    const r = E.s.txns.find(t => t.type === 'reversal'); const orig = E.s.txns.find(t => t.type === 'purchase');
    return [E.balances('u1').available === 0 && r.ref === orig.id && orig.status === 'Reversed', `reversal ${r.points} → ref ${r.ref}`];
  });
  t('Returns & refunds', 'Partial return reverses only the returned share (₹500 of ₹2,000)', () => {
    const E = fresh(c => { c.earn.includeTax = true; }); // ₹ = points for easy reading
    const o = E.checkout({ customerId: 'u1', lines: L(['ps057-blk-102', 2]) }); // ₹1,998
    E.advance(30); E.ingest({ id: 'r1', topic: 'refunds/create', payload: { orderId: o.orderId, refundId: 'rf1', amount: 500, kind: 'return' } });
    const rev = -E.s.txns.find(t => t.type === 'reversal').points;
    return [rev === 500 && E.balances('u1').available === 1498, `reversed ${rev} of 1,998`];
  });
  t('Returns & refunds', 'Multiple refunds (3 × ₹333 on ₹999) reverse exactly the points earned', () => {
    const E = fresh(c => { c.earn.includeTax = true; }); const o = E.checkout({ customerId: 'u1', lines: L(['ps057-blk-102', 1]) }); E.advance(30);
    [1, 2, 3].forEach(i => E.ingest({ id: 'r' + i, topic: 'refunds/create', payload: { orderId: o.orderId, refundId: 'rf' + i, amount: 333, kind: 'refund' } }));
    const rev = -E.s.txns.filter(t => t.type === 'reversal').reduce((s, t) => s + t.points, 0);
    return [rev === 999 && E.balances('u1').available === 0, `reversed ${rev}, balance ${E.balances('u1').available}`];
  });
  t('Returns & refunds', 'Same refund delivered twice is applied once', () => {
    const E = fresh(); const o = E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) });
    E.ingest({ id: 'r1', topic: 'refunds/create', payload: { orderId: o.orderId, refundId: 'rf1', amount: 200, kind: 'refund' } });
    E.ingest({ id: 'r1b', topic: 'refunds/create', payload: { orderId: o.orderId, refundId: 'rf1', amount: 200, kind: 'refund' } });
    return [E.balances('u1').pending === 459, `pending ${E.balances('u1').pending}`];
  });
  t('Returns & refunds', 'Cancellation cancels pending points', () => {
    const E = fresh(); const o = E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) });
    E.ingest({ id: 'c1', topic: 'orders/cancelled', payload: { orderId: o.orderId } }); E.advance(40);
    return [E.balances('u1').pending === 0 && E.balances('u1').available === 0, `pending ${E.balances('u1').pending}`];
  });
  t('Returns & refunds', 'Negative balance: reward already used, return creates an owed balance that later earnings repay', () => {
    const E = fresh(); const o = E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); E.advance(30);
    const r = E.redeem('u1', 'rw50', 'x'); E.checkout({ customerId: 'u1', lines: L(['ps057-blk-102', 1]), rewardCode: r.redemption.code });
    E.ingest({ id: 'rr', topic: 'refunds/create', payload: { orderId: o.orderId, refundId: 'rf', amount: 659, kind: 'return' } });
    const owed = E.balances('u1').debt, avail1 = E.balances('u1').available; const blocked = E.redeem('u1', 'rw10', 'y');
    E.advance(30); const b = E.balances('u1');
    return [owed === 500 && avail1 === -500 && !blocked.ok && b.debt === 0 && b.available === 804 - 500 && ledgerOK(E), `owed ${owed} (balance ${avail1}), redeem blocked: ${!blocked.ok}; after next activation available ${b.available}, owed ${b.debt}`];
  });
  t('Returns & refunds', 'Unused reward is voided before creating an owed balance', () => {
    const E = fresh(); const o = E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); E.advance(30);
    const r = E.redeem('u1', 'rw50', 'x');
    E.ingest({ id: 'rr', topic: 'refunds/create', payload: { orderId: o.orderId, refundId: 'rf', amount: 659, kind: 'return' } });
    const red = E.s.redemptions.find(x => x.id === r.redemption.id);
    return [red.status === 'cancelled' && E.balances('u1').available === 0 && E.balances('u1').debt === 0 && ledgerOK(E), `code ${red.status}, available ${E.balances('u1').available}, owed ${E.balances('u1').debt}`];
  });

  t('Webhooks', 'Duplicate webhook (same event id) awards points once', () => {
    const E = fresh(); const o = E.checkout({ customerId: 'u1', lines: L(['gt029', 1]), eventId: 'e1' });
    const d = E.ingest({ id: 'e1', topic: 'orders/create', payload: o.payload });
    return [d.status === 'duplicate' && E.balances('u1').pending === 659, `second delivery: ${d.status}`];
  });
  t('Webhooks', 'Same order via a different event id is still awarded once', () => {
    const E = fresh(); const o = E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) });
    E.ingest({ id: 'other', topic: 'orders/create', payload: o.payload });
    return [E.s.txns.filter(t => t.type === 'purchase').length === 1, `purchase entries: ${E.s.txns.filter(t => t.type === 'purchase').length}`];
  });
  t('Webhooks', 'Failed webhook is kept, visible, and retried without duplicates', () => {
    const E = fresh(); E.s.failNext = 1; const o = E.checkout({ customerId: 'u1', lines: L(['gt029', 1]), eventId: 'ef' });
    const failedVisible = E.s.failed.length === 1 && E.balances('u1').pending === 0 && E.reconcile().issues.some(i => i.kind === 'Failed event');
    E.advance(1); E.retryEvent('ef');
    return [failedVisible && E.balances('u1').pending === 659 && E.s.failed.length === 0, `queued: ${failedVisible}; after retry pending ${E.balances('u1').pending}`];
  });
  t('Webhooks', 'Refund arriving before its order is queued, then applied on retry', () => {
    const E = fresh(); E.ingest({ id: 'early', topic: 'refunds/create', payload: { orderId: 'gid://shopify/Order/5900001001', refundId: 'rfx', amount: 100, kind: 'refund' } });
    const q = E.s.failed.length; E.checkout({ customerId: 'u1', lines: L(['gt029', 1]) }); E.retryEvent('early');
    return [q === 1 && E.balances('u1').pending === 559, `queued ${q}, pending after retry ${E.balances('u1').pending}`];
  });

  t('Redemption', 'Exactly enough points (500) redeems ₹50 OFF and leaves 0', () => {
    const E = fresh(c => { c.holdingDays = 0; }); E.adjust('u1', 500, 'Customer service goodwill', 'test setup exact', 'QA');
    const r = E.redeem('u1', 'rw50', 'a');
    return [r.ok && E.balances('u1').available === 0, `ok=${r.ok}, left ${E.balances('u1').available}`];
  });
  t('Redemption', 'Insufficient points (499) is refused with the gap', () => {
    const E = fresh(); E.adjust('u1', 499, 'Customer service goodwill', 'test setup short', 'QA');
    const r = E.redeem('u1', 'rw50', 'a');
    return [!r.ok && /1 more point\b/.test(r.error), r.error];
  });
  t('Redemption', 'Double-tap on Redeem (same request key) debits once', () => {
    const E = fresh(); E.adjust('u1', 1000, 'Customer service goodwill', 'test setup dbl', 'QA');
    const a = E.redeem('u1', 'rw50', 'same'), b = E.redeem('u1', 'rw50', 'same');
    return [a.redemption.id === b.redemption.id && E.balances('u1').available === 500, `replay=${b.replay}, balance ${E.balances('u1').available}`];
  });
  t('Redemption', 'Simultaneous redemptions from two browser sessions: only one succeeds', () => {
    const E = fresh(); E.adjust('u1', 600, 'Customer service goodwill', 'test setup race', 'QA');
    const tabA = E.redeem('u1', 'rw50', 'tabA'), tabB = E.redeem('u1', 'rw50', 'tabB');
    return [tabA.ok && !tabB.ok && E.balances('u1').available === 100, `tab A ${tabA.ok ? 'ok' : 'refused'}, tab B ${tabB.ok ? 'ok' : 'refused'}, balance ${E.balances('u1').available}`];
  });
  t('Redemption', 'Reward already used cannot be applied again', () => {
    const E = fresh(); E.adjust('u1', 500, 'Customer service goodwill', 'test setup used', 'QA'); const r = E.redeem('u1', 'rw50', 'a');
    E.checkout({ customerId: 'u1', lines: L(['ps057-blk-102', 1]), rewardCode: r.redemption.code });
    const again = E.checkout({ customerId: 'u1', lines: L(['ps057-blk-102', 1]), rewardCode: r.redemption.code });
    return [!again.ok && /already used/.test(again.error), again.error];
  });
  t('Redemption', 'Minimum cart value is enforced server-side', () => {
    const E = fresh(); E.adjust('u1', 500, 'Customer service goodwill', 'test setup min', 'QA'); const r = E.redeem('u1', 'rw50', 'a');
    const v = E.checkout({ customerId: 'u1', lines: L(['gvase019-wht', 1]), rewardCode: r.redemption.code });
    return [!v.ok && /min\. order ₹699/.test(v.error), v.error];
  });
  t('Redemption', 'Another customer\'s code is refused', () => {
    const E = fresh(); E.createCustomer({ id: 'u2', name: 'Two', email: 'two@test.in' }); E.adjust('u1', 500, 'Customer service goodwill', 'test setup steal', 'QA');
    const r = E.redeem('u1', 'rw50', 'a'); const v = E.checkout({ customerId: 'u2', lines: L(['ps057-blk-102', 1]), rewardCode: r.redemption.code });
    return [!v.ok, v.error];
  });
  t('Redemption', 'Expired reward code returns its points', () => {
    const E = fresh(); E.adjust('u1', 500, 'Customer service goodwill', 'test setup exp', 'QA'); const r = E.redeem('u1', 'rw50', 'a'); E.advance(31);
    const red = E.s.redemptions[0]; const v = E.validateRewardForCart('u1', r.redemption.code, L(['ps057-blk-102', 1]));
    return [red.status === 'expired' && E.balances('u1').available === 500 && !v.ok, `code ${red.status}, balance ${E.balances('u1').available}`];
  });
  t('Redemption', 'Cancelling an order that used a reward returns the reward\'s points', () => {
    const E = fresh(); E.adjust('u1', 500, 'Customer service goodwill', 'test setup cancel', 'QA'); const r = E.redeem('u1', 'rw50', 'a');
    const o = E.checkout({ customerId: 'u1', lines: L(['ps057-blk-102', 1]), rewardCode: r.redemption.code });
    E.ingest({ id: 'cx', topic: 'orders/cancelled', payload: { orderId: o.orderId } });
    return [E.balances('u1').available === 500 && E.balances('u1').pending === 0, `available ${E.balances('u1').available}`];
  });

  t('Admin', 'Manual adjustment needs amount, reason, note and admin; it lands in ledger and audit log', () => {
    const E = fresh(); const bad = E.adjust('u1', 200, 'Customer service goodwill', '', 'QA'); const good = E.adjust('u1', 200, 'Customer service goodwill', 'Delayed delivery apology', 'QA');
    return [!bad.ok && good.ok && E.s.audit[0].action === 'points_adjusted' && E.s.txns.some(t => t.type === 'adjustment'), `without note: ${bad.error}`];
  });
  t('Admin', 'Deduction larger than the available balance is refused', () => {
    const E = fresh(); E.adjust('u1', 100, 'Customer service goodwill', 'setup deduct', 'QA'); const r = E.adjust('u1', -300, 'Order issue correction', 'Wrong order credit', 'QA');
    return [!r.ok, r.error];
  });
  t('Admin', 'Invalid rule (₹0 spend) is refused and the live rule is unchanged', () => {
    const E = fresh(); const next = JSON.parse(JSON.stringify(E.cfg)); next.earn.spend = 0; const r = E.updateConfig(next, 'QA', 'test');
    return [!r.ok && E.cfg.earn.spend === 100, r.errors && r.errors[0]];
  });
  t('Admin', 'Rule change is recorded with previous and new value', () => {
    const E = fresh(); const next = JSON.parse(JSON.stringify(E.cfg)); next.holdingDays = 14; E.updateConfig(next, 'QA', 'Faster activation');
    const a = E.s.audit[0];
    return [a.prev === '30' && a.next === '14' && E.cfg.holdingDays === 14, `${a.action}: ${a.prev} → ${a.next}`];
  });
  t('Admin', 'Invalid reward (value above min cart) is refused', () => {
    const E = fresh(); const r = E.saveReward({ ...E.s.rewards[0], value: 400, minCart: 299 }, 'QA');
    return [!r.ok, r.errors && r.errors[0]];
  });

  t('Integrity', 'Reconciliation is clean after a busy scenario', () => {
    const E = seedEngine(); E.advance(45);
    const r = E.reconcile(); const bad = r.issues.filter(i => i.kind !== 'Failed event');
    return [bad.length === 0, `${r.rows.length} accounts, ${r.orders} orders, ${bad.length} issues`];
  });
  t('Integrity', 'Reconciliation detects a drifted cached balance; rebuild fixes it from the ledger', () => {
    const E = seedEngine(); E.acctOf('priya').available += 250; const found = E.reconcile().issues.some(i => i.kind === 'Incorrect balance');
    E.rebuildCache('QA');
    return [found && !E.reconcile().issues.some(i => i.kind === 'Incorrect balance'), `detected ${found}, fixed after rebuild`];
  });
  t('Integrity', 'Future campaign: 2× points only inside its window, capped at max bonus', () => {
    const E = fresh(c => { c.campaign.enabled = true; c.campaign.maxBonus = 300; });
    const inside = E.calcPoints(L(['gt029', 1])); E.advance(3); const outside = E.calcPoints(L(['gt029', 1]));
    return [inside.points === 959 && outside.points === 659, `inside ${inside.points} (bonus capped 300), outside ${outside.points}`];
  });
  return T.map(x => { let r; try { r = x.fn(); } catch (e) { r = [false, 'Threw: ' + e.message]; } return { group: x.group, name: x.name, pass: !!r[0], detail: r[1] }; });
}
if (typeof module !== 'undefined') module.exports = { runRewardTests };
