/* =====================================================================
   ECOFYND REWARDS — LOYALTY ENGINE (runs as the "server" in this prototype)
   The UI never writes balances directly: every change goes through this
   engine, and every point change is a ledger transaction.
   ===================================================================== */
const DAY = 864e5;
const START = Date.UTC(2026, 8, 30, 6, 30); // 30 Sep 2026, 12:00 IST

const PRODUCTS = [
  { id: 'cpot039-05', sku: 'CPOT039-05', title: 'Ceramic Tulsi Plant Pot', sub: 'Glazed ceramic planter for tulsi and indoor plants', price: 419, collection: 'planters', gst: 5, art: 'pot' },
  { id: 'pot031', sku: 'POT031', title: 'Two-Tier Disco Ball Planter with Macrame Hanger', sub: 'Mirrored mosaic planters on a cotton macrame hanger', price: 1349, collection: 'planters', gst: 18, art: 'disco' },
  { id: 'pot030', sku: 'POT030', title: 'Shimmer & Shine Disco Glass Planter', sub: 'Single mirrored planter with macrame hanger', price: 749, collection: 'planters', gst: 18, art: 'disco1' },
  { id: 'ps057-blk-102', sku: 'PS057-BLK-102', title: '2 Pack Cora Wall Mounted Plant Stand', sub: 'Round tray shelf with built-in hanging hook', price: 999, collection: 'plant-stands', gst: 18, art: 'wall' },
  { id: 'ps049-go', sku: 'PS049-GO', title: 'Adam Golden Metal Plant Stand, 2 Tier', sub: 'Two-tier display stand for home and garden', price: 2329, collection: 'plant-stands', gst: 18, art: 'stand' },
  { id: 'cpdisc-110', sku: 'CPDISC-110', title: 'Organic Coir Seedling Coins (Set of 10)', sub: 'Mess-free coir discs for germination', price: 199, collection: 'gardening-essentials', gst: 5, art: 'coins' },
  { id: 'ga001', sku: 'GA001-050', title: 'Plant Support Clips for Climbers (50)', sub: 'Reusable stem and vine clips', price: 179, collection: 'gardening-essentials', gst: 18, art: 'clips' },
  { id: 'gt029', sku: 'GT029', title: 'Garden Hedge Shears, 7.8" Steel Blades', sub: 'Straight blades for hedges and shrubs', price: 659, collection: 'garden-tools', gst: 0, art: 'shears' },
  { id: 'gvase019-wht', sku: 'GVASE019-WHT', title: 'Ribbed Glass Vase, Clear', sub: 'Symmetrical ribbed glass for flowers and décor', price: 349, collection: 'home-decor', gst: 18, art: 'vase' },
  { id: 'gift-1000', sku: 'GIFT-1000', title: 'Ecofynd Gift Card ₹1,000', sub: 'Demo item: shows how gift cards are excluded', price: 1000, collection: 'gift-cards', gst: 0, art: 'card', giftCard: true },
];
const PMAP = Object.fromEntries(PRODUCTS.map(p => [p.id, p]));
const COLLECTIONS = { 'planters': 'Planters', 'plant-stands': 'Plant Stands', 'gardening-essentials': 'Gardening Essentials', 'garden-tools': 'Garden Tools', 'home-decor': 'Home Décor', 'gift-cards': 'Gift Cards' };
const COUPONS = { GARDEN10: { pct: 10, label: 'GARDEN10 · 10% off' } };

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function defaultConfig() {
  return {
    earn: { spend: 100, points: 100, basis: 'after_discount', includeShipping: false, includeTax: false, excludeGiftCards: true, excludedCollections: ['gift-cards'], rounding: 'floor' },
    redeem: { points: 100, value: 10 },
    holdingDays: 30,
    expiryMonths: 12,
    shortfallPolicy: 'void_unused_then_owe',
    returnPointsOnCodeExpiry: true,
    restoreRewardOnFullRefund: true,
    campaign: { enabled: false, name: 'Double Points Weekend', multiplier: 2, start: START, end: START + 2 * DAY, collections: [], maxBonus: 1000 },
    notifications: {
      points_earned: { onsite: true, email: false, whatsapp: false },
      points_activated: { onsite: true, email: true, whatsapp: false },
      reward_unlocked: { onsite: true, email: false, whatsapp: false },
      reward_redeemed: { onsite: false, email: true, whatsapp: false },
      points_expiring: { onsite: true, email: true, whatsapp: false },
      bonus_points: { onsite: true, email: false, whatsapp: false },
      special_campaign: { onsite: false, email: false, whatsapp: false },
    },
  };
}
function defaultRewards() {
  const mk = (id, v, p, min) => ({ id, name: `₹${v} OFF`, type: 'fixed_discount', points: p, value: v, minCart: min, maxUses: 0, eligibleCollections: [], excludedCollections: ['gift-cards'], expiryDays: 30, stackable: false, couponCompatible: true, eligibility: 'all', status: 'active' });
  return [mk('rw10', 10, 100, 299), mk('rw25', 25, 250, 499), mk('rw50', 50, 500, 699), mk('rw100', 100, 1000, 999), mk('rw200', 200, 2000, 1999)];
}
function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

class Engine {
  constructor(now = START) {
    this.rand = mulberry(20260930);
    this.s = {
      now, seq: { txn: 5000, red: 700, ord: 1000, evt: 90000, lot: 1, audit: 1, acct: 300 },
      config: defaultConfig(), rewards: defaultRewards(),
      customers: {}, accounts: {}, txns: [], lots: [], orders: {}, redemptions: [],
      processed: {}, eventLog: [], failed: [], audit: [], analytics: [], outbox: [],
      guestHolds: [], failNext: 0, idem: {},
    };
  }
  get now() { return this.s.now; }
  get cfg() { return this.s.config; }
  nid(kind, prefix) { return prefix + (++this.s.seq[kind]); }
  rate() { return this.cfg.redeem.value / this.cfg.redeem.points; }
  valueOf(points) { return round2(points * this.rate()); }

  /* ---------- telemetry, notifications, audit ---------- */
  track(name, props = {}) { this.s.analytics.unshift({ t: this.now, name, props }); }
  notify(type, customerId, text) {
    const c = this.cfg.notifications[type]; if (!c) return;
    ['onsite', 'email', 'whatsapp'].forEach(ch => { if (c[ch]) this.s.outbox.unshift({ t: this.now, type, ch, customerId, text }); });
  }
  audit(admin, action, prev, next, reason) {
    this.s.audit.unshift({ id: this.nid('audit', 'AUD-'), t: this.now, admin, action, prev, next, reason });
  }

  /* ---------- customers & accounts ---------- */
  createCustomer({ id, name, email, phone }) {
    const existing = Object.values(this.s.customers).find(c => c.email.toLowerCase() === String(email).toLowerCase());
    if (existing) return { ok: true, duplicate: true, customer: existing, account: this.ensureAccount(existing.id) };
    const cid = id || 'c' + (Object.keys(this.s.customers).length + 1) + '-' + Math.floor(this.rand() * 1e4);
    const customer = { id: cid, name, email, phone: phone || '', createdAt: this.now, shopifyId: 'gid://shopify/Customer/' + (7400000000 + Math.floor(this.rand() * 9e8)) };
    this.s.customers[cid] = customer;
    const account = this.ensureAccount(cid);
    this.claimGuestHolds(customer);
    return { ok: true, customer, account };
  }
  ensureAccount(customerId) {
    const found = Object.values(this.s.accounts).find(a => a.customerId === customerId);
    if (found) return found;
    const a = { id: this.nid('acct', 'LA-'), customerId, available: 0, pending: 0, debt: 0, lifetimeEarned: 0, lifetimeRedeemed: 0, status: 'active', createdAt: this.now, updatedAt: this.now };
    this.s.accounts[a.id] = a;
    this.track('loyalty_account_created', { customerId });
    return a;
  }
  acctOf(customerId) { return Object.values(this.s.accounts).find(a => a.customerId === customerId) || null; }

  /* ---------- ledger ---------- */
  addTxn(t) {
    const acct = t.accountId ? this.s.accounts[t.accountId] : null;
    const txn = Object.assign({ id: this.nid('txn', 'TX-'), createdAt: this.now, effectiveAt: this.now, pendingDelta: 0, availableDelta: 0, availableAt: null, expiresAt: null, ref: null, orderId: null, meta: {} }, t);
    if (acct) {
      acct.pending += txn.pendingDelta; acct.available += txn.availableDelta; acct.updatedAt = this.now;
      if (['purchase', 'bonus'].includes(txn.type) || (txn.type === 'adjustment' && txn.points > 0)) acct.lifetimeEarned += txn.points;
      if (['cancellation', 'reversal'].includes(txn.type)) acct.lifetimeEarned += txn.points; // points negative
      if (txn.type === 'redemption') acct.lifetimeRedeemed += -txn.points;
      if (txn.type === 'reward_return') acct.lifetimeRedeemed -= txn.points;
    }
    this.s.txns.push(txn);
    return txn;
  }
  addLot(acct, amount, sourceTxn, orderId, base) {
    const pay = Math.min(acct.debt, amount); acct.debt -= pay;
    const expiresAt = this.cfg.expiryMonths > 0 ? this.addMonths(base || this.now, this.cfg.expiryMonths) : null;
    const lot = { id: this.nid('lot', 'LOT-'), accountId: acct.id, sourceTxn: sourceTxn.id, orderId: orderId || null, amount, remaining: amount - pay, settledDebt: pay, expiresAt, createdAt: this.now, warned: false };
    this.s.lots.push(lot);
    if (pay > 0) sourceTxn.meta.settledOwed = pay;
    return lot;
  }
  consumeLots(acct, k, preferOrderId) {
    const lots = this.s.lots.filter(l => l.accountId === acct.id && l.remaining > 0)
      .sort((a, b) => ((b.orderId === preferOrderId) - (a.orderId === preferOrderId)) || ((a.expiresAt || 9e15) - (b.expiresAt || 9e15)));
    let left = k;
    for (const l of lots) { if (!left) break; const take = Math.min(l.remaining, left); l.remaining -= take; left -= take; }
    return left; // shortfall
  }
  addMonths(ms, m) { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + m); return d.getTime(); }

  /* ---------- rule engine: eligibility → calculation ---------- */
  eligibleValue(lines, discount = 0, shipping = 0) {
    const c = this.cfg.earn; let all = 0, elig = 0, eligTax = 0, campaignElig = 0;
    for (const l of lines) {
      const p = PMAP[l.productId]; const v = l.price * l.qty; all += v;
      const excluded = (c.excludeGiftCards && p.giftCard) || c.excludedCollections.includes(p.collection);
      if (!excluded) { elig += v; eligTax += v - v / (1 + p.gst / 100); }
    }
    const share = all ? elig / all : 0;
    let base = c.basis === 'after_discount' ? elig - discount * share : elig;
    if (!c.includeTax && elig) base = base * (1 - eligTax / elig);
    if (c.includeShipping) base += shipping;
    // campaign-eligible part (same basis) for future multipliers
    const camp = this.cfg.campaign;
    if (camp.enabled && elig) {
      for (const l of lines) {
        const p = PMAP[l.productId];
        const excluded = (c.excludeGiftCards && p.giftCard) || c.excludedCollections.includes(p.collection);
        if (!excluded && (!camp.collections.length || camp.collections.includes(p.collection))) campaignElig += l.price * l.qty;
      }
      campaignElig = campaignElig / elig * (base - (c.includeShipping ? shipping : 0));
    }
    return { value: Math.max(0, round2(base)), campaignValue: Math.max(0, round2(campaignElig)), merch: all, eligibleMerch: elig };
  }
  pointsFor(value) {
    const { spend, points, rounding } = this.cfg.earn;
    if (rounding === 'block') return Math.floor(value / spend + 1e-9) * points;
    const raw = value * points / spend;
    return rounding === 'round' ? Math.round(raw) : Math.floor(raw + 1e-9);
  }
  campaignActive(at = this.now) { const c = this.cfg.campaign; return c.enabled && at >= c.start && at < c.end; }
  calcPoints(lines, discount = 0, shipping = 0) {
    const ev = this.eligibleValue(lines, discount, shipping);
    const base = this.pointsFor(ev.value);
    let bonus = 0;
    if (this.campaignActive()) { const c = this.cfg.campaign; bonus = Math.min(c.maxBonus, this.pointsFor(ev.campaignValue) * (c.multiplier - 1)); }
    return { ...ev, base, bonus, points: base + bonus };
  }

  /* ---------- Shopify webhook intake (idempotent) ---------- */
  ingest(evt) {
    if (this.s.processed[evt.id]) {
      this.s.eventLog.unshift({ t: this.now, id: evt.id, topic: evt.topic, ref: evt.payload.name || evt.payload.orderId, result: 'duplicate', note: 'Already processed — ignored' });
      return { status: 'duplicate' };
    }
    if (this.s.failNext > 0) {
      this.s.failNext--;
      const attempts = (evt.attempts || 0) + 1;
      const f = { ...evt, attempts, error: 'Loyalty DB write timed out (simulated)', nextRetryAt: this.now + Math.min(6, 2 ** attempts) * 36e5 };
      this.s.failed = this.s.failed.filter(x => x.id !== evt.id); this.s.failed.push(f);
      this.s.eventLog.unshift({ t: this.now, id: evt.id, topic: evt.topic, ref: evt.payload.name || evt.payload.orderId, result: 'failed', note: `Attempt ${attempts} failed · queued for retry` });
      return { status: 'failed' };
    }
    let res;
    try {
      if (evt.topic === 'orders/create') res = this.onOrderCreate(evt.payload);
      else if (evt.topic === 'refunds/create') res = this.onRefund(evt.payload);
      else if (evt.topic === 'orders/cancelled') res = this.onCancel(evt.payload);
      else throw new Error('Unknown topic ' + evt.topic);
    } catch (e) {
      const attempts = (evt.attempts || 0) + 1;
      this.s.failed.push({ ...evt, attempts, error: e.message, nextRetryAt: this.now + 36e5 });
      this.s.eventLog.unshift({ t: this.now, id: evt.id, topic: evt.topic, ref: evt.payload.orderId, result: 'failed', note: e.message });
      return { status: 'failed', error: e.message };
    }
    this.s.processed[evt.id] = this.now;
    this.s.failed = this.s.failed.filter(x => x.id !== evt.id);
    this.s.eventLog.unshift({ t: this.now, id: evt.id, topic: evt.topic, ref: evt.payload.name || (this.s.orders[evt.payload.orderId] || {}).name, result: res && res.skipped ? 'skipped' : 'processed', note: (res && res.note) || '' });
    return { status: 'processed', ...res };
  }
  retryEvent(id) {
    const f = this.s.failed.find(x => x.id === id); if (!f) return { status: 'missing' };
    return this.ingest(f);
  }

  /* ---------- checkout (server validates reward before creating order) ---------- */
  cartTotals(lines, { couponCode, rewardCode, customerId } = {}) {
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const coupon = couponCode && COUPONS[couponCode] ? round2(subtotal * COUPONS[couponCode].pct / 100) : 0;
    let reward = 0, rewardErr = null;
    if (rewardCode) { const v = this.validateRewardForCart(customerId, rewardCode, lines, couponCode); if (v.ok) reward = v.discount; else rewardErr = v.error; }
    const discount = round2(coupon + reward);
    const afterDisc = subtotal - discount;
    const shipping = subtotal === 0 ? 0 : afterDisc >= 499 ? 0 : 79;
    const total = round2(afterDisc + shipping);
    const gst = round2(lines.reduce((s, l) => { const p = PMAP[l.productId]; const v = l.price * l.qty * (subtotal ? afterDisc / subtotal : 0); return s + v - v / (1 + p.gst / 100); }, 0));
    return { subtotal, coupon, reward, discount, shipping, total, gst, rewardErr };
  }
  checkout({ customerId, email, lines, couponCode, rewardCode, eventId }) {
    if (!lines.length) return { ok: false, error: 'Your cart is empty.' };
    const cust = customerId ? this.s.customers[customerId] : null;
    if (rewardCode) { const v = this.validateRewardForCart(customerId, rewardCode, lines, couponCode); if (!v.ok) return { ok: false, error: v.error }; }
    const t = this.cartTotals(lines, { couponCode, rewardCode, customerId });
    const orderId = 'gid://shopify/Order/' + (5900000000 + this.s.seq.ord + 1);
    const payload = { orderId, name: '#' + (this.s.seq.ord + 1), customerId: cust ? cust.id : null, email: cust ? cust.email : email, lines: lines.map(l => ({ ...l })), discount: t.discount, shipping: t.shipping, total: t.total, rewardCode: rewardCode || null, couponCode: couponCode || null, createdAt: this.now };
    this.s.seq.ord++;
    const r = this.ingest({ id: eventId || this.nid('evt', 'evt_'), topic: 'orders/create', payload });
    return { ok: true, orderId, name: payload.name, webhook: r.status, order: this.s.orders[orderId] || null, payload };
  }

  onOrderCreate(p) {
    if (this.s.orders[p.orderId]) return { skipped: true, note: `${p.name} already has loyalty entries — not awarded twice` };
    const calc = this.calcPoints(p.lines, p.discount, p.shipping);
    const order = { id: p.orderId, name: p.name, customerId: p.customerId, email: p.email, lines: p.lines, discount: p.discount, shipping: p.shipping, total: p.total, createdAt: p.createdAt || this.now,
      eligible: calc.value, points: calc.points, bonus: calc.bonus, pendingLeft: 0, activated: 0, reversed: 0, refundedValue: 0, refunds: [], status: 'open', rewardCode: p.rewardCode, couponCode: p.couponCode, earnTxn: null, availableAt: this.now + this.cfg.holdingDays * DAY, guest: !p.customerId };
    this.s.orders[order.id] = order;
    if (p.rewardCode) this.markRewardUsed(p.rewardCode, order);
    if (!order.points) return { note: `${p.name}: no eligible value — 0 points` };
    if (!p.customerId) {
      this.s.guestHolds.push({ email: p.email.toLowerCase(), orderId: order.id, points: order.points, availableAt: order.availableAt, claimed: false });
      return { note: `${p.name}: ${order.points} pts held for guest ${p.email}` };
    }
    this.earnForOrder(order);
    return { note: `${p.name}: +${order.points} pts pending` };
  }
  earnForOrder(order) {
    const acct = this.ensureAccount(order.customerId);
    const bonusNote = order.bonus ? ` (incl. ${order.bonus} campaign bonus)` : '';
    order.earnTxn = this.addTxn({ accountId: acct.id, customerId: order.customerId, orderId: order.id, type: 'purchase', points: order.points, pendingDelta: order.points, status: 'Pending', source: 'shopify_order',
      description: `Order ${order.name}${bonusNote}`, availableAt: order.availableAt, meta: { eligibleValue: order.eligible, rule: `₹${this.cfg.earn.spend} → ${this.cfg.earn.points} pts · ${this.cfg.earn.rounding}` } }).id;
    order.pendingLeft = order.points;
    this.track('points_earned', { order: order.name, points: order.points }); this.track('points_pending', { order: order.name, points: order.points });
    this.notify('points_earned', order.customerId, `You're earning ${order.points} points on ${order.name}`);
    if (order.availableAt <= this.now) this.activate(order);
  }
  claimGuestHolds(customer) {
    const holds = this.s.guestHolds.filter(h => !h.claimed && h.email === customer.email.toLowerCase());
    for (const h of holds) {
      const order = this.s.orders[h.orderId]; h.claimed = true;
      order.customerId = customer.id; order.guest = false; order.claimedAt = this.now;
      const remaining = order.points - order.reversed;
      if (remaining > 0) { const saved = order.points; order.points = remaining; this.earnForOrder(order); order.points = saved; order.pendingLeft = remaining; }
    }
    return holds.length;
  }
  activate(order) {
    const r = order.pendingLeft; if (r <= 0) return 0;
    const acct = this.acctOf(order.customerId);
    const eff = Math.min(this.now, order.availableAt);
    const txn = this.addTxn({ accountId: acct.id, customerId: order.customerId, orderId: order.id, type: 'activation', points: r, pendingDelta: -r, availableDelta: r, status: 'Available', source: 'lifecycle', description: `Points from order ${order.name} are ready to use`, ref: order.earnTxn, effectiveAt: eff });
    const lot = this.addLot(acct, r, txn, order.id, eff); txn.expiresAt = lot.expiresAt;
    order.pendingLeft = 0; order.activated += r;
    const e = this.s.txns.find(t => t.id === order.earnTxn); if (e) e.status = 'Available';
    this.track('points_activated', { order: order.name, points: r });
    this.notify('points_activated', order.customerId, `${r} points from ${order.name} are now available`);
    return r;
  }

  onRefund(p) {
    const order = this.s.orders[p.orderId]; if (!order) throw new Error('Order not found yet (out-of-order webhook)');
    if (order.refunds.find(r => r.refundId === p.refundId)) return { skipped: true, note: 'Refund already applied' };
    const room = round2(order.eligibleMerchRemaining ?? this.merchValue(order));
    const amt = Math.min(p.amount, room);
    order.refunds.push({ refundId: p.refundId, amount: amt, kind: p.kind, at: this.now });
    order.eligibleMerchRemaining = round2(room - amt);
    const full = order.eligibleMerchRemaining <= 0.005;
    const note = this.reverseForOrder(order, full, p.kind === 'return' ? 'returned' : 'refunded', amt);
    if (full) { order.status = p.kind === 'return' ? 'returned' : 'refunded'; this.restoreRewardIfNeeded(order, 'Order fully refunded'); }
    else order.status = 'partially ' + (p.kind === 'return' ? 'returned' : 'refunded');
    return { note };
  }
  onCancel(p) {
    const order = this.s.orders[p.orderId]; if (!order) throw new Error('Order not found yet');
    if (order.status === 'cancelled') return { skipped: true, note: 'Already cancelled' };
    order.eligibleMerchRemaining = 0;
    const note = this.reverseForOrder(order, true, 'cancelled', null);
    order.status = 'cancelled';
    this.restoreRewardIfNeeded(order, 'Order cancelled');
    return { note };
  }
  merchValue(order) { return order.lines.reduce((s, l) => s + (this.isEarnExcluded(l.productId) ? 0 : l.price * l.qty), 0); }
  isEarnExcluded(pid) { const p = PMAP[pid], c = this.cfg.earn; return (c.excludeGiftCards && p.giftCard) || c.excludedCollections.includes(p.collection); }

  // Proportional, cumulative reversal: target = round(points × refunded share). A final full refund always lands on exactly order.points.
  reverseForOrder(order, full, verb, amount) {
    const merch = this.merchValue(order) || 1;
    const refunded = merch - (order.eligibleMerchRemaining ?? merch);
    const target = full ? order.points : Math.round(order.points * refunded / merch);
    const k = target - order.reversed;
    const amtTxt = amount != null ? `₹${amount.toLocaleString('en-IN')} ${verb}` : verb;
    if (k <= 0) return `${order.name}: ${amtTxt} — no points to reverse`;
    order.reversed += k;
    if (order.guest || !order.customerId) {
      const h = this.s.guestHolds.find(x => x.orderId === order.id); if (h) h.points = Math.max(0, h.points - k);
      return `${order.name}: ${k} held guest points removed`;
    }
    const acct = this.acctOf(order.customerId);
    const fromPending = Math.min(k, order.pendingLeft);
    if (fromPending > 0) {
      order.pendingLeft -= fromPending;
      this.addTxn({ accountId: acct.id, customerId: order.customerId, orderId: order.id, type: 'cancellation', points: -fromPending, pendingDelta: -fromPending, status: 'Cancelled', source: 'shopify_' + verb,
        description: `Order ${order.name}: ${amtTxt} before points were available — pending points cancelled`, ref: order.earnTxn, meta: { reason: verb, amount } });
    }
    const rest = k - fromPending;
    let owed = 0, voided = [];
    if (rest > 0) {
      if (acct.available < rest && this.cfg.shortfallPolicy === 'void_unused_then_owe') voided = this.voidUnusedRewards(acct, rest - acct.available);
      const txn = this.addTxn({ accountId: acct.id, customerId: order.customerId, orderId: order.id, type: 'reversal', points: -rest, availableDelta: -rest, status: 'Reversed', source: 'shopify_' + verb,
        description: `Order ${order.name}: ${amtTxt} — points reversed`, ref: order.earnTxn, meta: { reason: verb, amount } });
      owed = this.consumeLots(acct, rest, order.id);
      if (owed > 0) { acct.debt += owed; txn.meta.owed = owed; }
      this.track('points_reversed', { order: order.name, points: rest });
    }
    const e = this.s.txns.find(t => t.id === order.earnTxn);
    if (e && order.reversed >= order.points) e.status = order.activated > 0 ? 'Reversed' : 'Cancelled';
    return `${order.name}: ${fromPending ? fromPending + ' pending cancelled ' : ''}${rest ? rest + ' reversed' : ''}${voided.length ? ` · ${voided.length} unused reward voided` : ''}${owed ? ` · ${owed} owed` : ''}`.trim();
  }
  voidUnusedRewards(acct, need) {
    const reds = this.s.redemptions.filter(r => r.customerId === acct.customerId && r.status === 'unlocked').sort((a, b) => b.createdAt - a.createdAt);
    const voided = [];
    for (const r of reds) {
      if (need <= 0) break;
      r.status = 'cancelled'; r.cancelReason = 'Voided to cover a returned order';
      const txn = this.addTxn({ accountId: acct.id, customerId: acct.customerId, type: 'reward_return', points: r.pointsUsed, availableDelta: r.pointsUsed, status: 'Adjusted', source: 'lifecycle',
        description: `Unused ${r.name} reward cancelled — ${r.pointsUsed} points returned to cover a returned order`, ref: r.txnId, meta: { redemption: r.id } });
      this.addLot(acct, r.pointsUsed, txn, null);
      need -= r.pointsUsed; voided.push(r.id);
    }
    return voided;
  }
  restoreRewardIfNeeded(order, why) {
    if (!order.rewardCode || !this.cfg.restoreRewardOnFullRefund || !order.customerId) return;
    const r = this.s.redemptions.find(x => x.code === order.rewardCode && x.status === 'used'); if (!r) return;
    r.status = 'returned';
    const acct = this.acctOf(order.customerId);
    const txn = this.addTxn({ accountId: acct.id, customerId: order.customerId, orderId: order.id, type: 'reward_return', points: r.pointsUsed, availableDelta: r.pointsUsed, status: 'Adjusted', source: 'lifecycle',
      description: `${why} — ${r.pointsUsed} points from your ${r.name} reward returned`, ref: r.txnId, meta: { redemption: r.id } });
    this.addLot(acct, r.pointsUsed, txn, null);
  }

  /* ---------- rewards & redemption ---------- */
  customerEligible(reward, customerId) {
    if (reward.eligibility === 'has_order') return Object.values(this.s.orders).some(o => o.customerId === customerId);
    return true;
  }
  redeem(customerId, rewardId, idemKey) {
    if (idemKey && this.s.idem[idemKey]) { const r = this.s.redemptions.find(x => x.id === this.s.idem[idemKey]); return { ok: true, replay: true, redemption: r }; }
    const acct = this.acctOf(customerId); if (!acct) return { ok: false, error: 'Create an account to use rewards.' };
    const reward = this.s.rewards.find(r => r.id === rewardId);
    if (!reward || reward.status !== 'active') return { ok: false, error: 'This reward is no longer available.' };
    if (!this.customerEligible(reward, customerId)) return { ok: false, error: `${reward.name} unlocks after your first order.` };
    if (acct.debt > 0) return { ok: false, error: `Rewards are paused while ${acct.debt.toLocaleString('en-IN')} points from a returned order are recovered.` };
    if (acct.available < reward.points) { const n = reward.points - acct.available; return { ok: false, error: `You need ${n.toLocaleString('en-IN')} more point${n === 1 ? '' : 's'} for ${reward.name}.` }; }
    const used = this.s.redemptions.filter(r => r.customerId === customerId && r.rewardId === rewardId && !['cancelled', 'returned', 'expired'].includes(r.status)).length;
    if (reward.maxUses && used >= reward.maxUses) return { ok: false, error: `${reward.name} can be used ${reward.maxUses} time${reward.maxUses > 1 ? 's' : ''} per customer.` };
    const code = 'ECO-' + Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(this.rand() * 32)]).join('');
    const txn = this.addTxn({ accountId: acct.id, customerId, type: 'redemption', points: -reward.points, availableDelta: -reward.points, status: 'Redeemed', source: 'customer', description: `${reward.name} reward unlocked`, meta: { rewardId, code } });
    this.consumeLots(acct, reward.points);
    const red = { id: this.nid('red', 'RD-'), customerId, rewardId, name: reward.name, pointsUsed: reward.points, discountValue: reward.value, minCart: reward.minCart, code,
      shopifyRef: 'gid://shopify/DiscountCodeNode/' + (1100000000 + this.s.seq.red), status: 'unlocked', createdAt: this.now, expiresAt: this.now + reward.expiryDays * DAY, usedAt: null, orderId: null, txnId: txn.id };
    txn.meta.redemption = red.id;
    this.s.redemptions.push(red);
    if (idemKey) this.s.idem[idemKey] = red.id;
    this.track('reward_redeemed', { reward: reward.name, points: reward.points });
    this.notify('reward_unlocked', customerId, `${reward.name} unlocked — code ${code}`);
    return { ok: true, redemption: red };
  }
  validateRewardForCart(customerId, code, lines, couponCode) {
    const r = this.s.redemptions.find(x => x.code === code);
    if (!r || r.customerId !== customerId) return { ok: false, error: 'This reward code does not belong to your account.' };
    if (r.status === 'used') return { ok: false, error: `This reward was already used on order ${this.s.orders[r.orderId] ? this.s.orders[r.orderId].name : ''}.` };
    if (r.status !== 'unlocked') return { ok: false, error: `This reward is ${r.status} and can't be applied.` };
    if (r.expiresAt <= this.now) return { ok: false, error: 'This reward has expired.' };
    const reward = this.s.rewards.find(x => x.id === r.rewardId) || {};
    const eligSub = lines.reduce((s, l) => { const p = PMAP[l.productId];
      const inc = (!reward.eligibleCollections || !reward.eligibleCollections.length || reward.eligibleCollections.includes(p.collection)) && !(reward.excludedCollections || []).includes(p.collection);
      return s + (inc ? l.price * l.qty : 0); }, 0);
    const couponAmt = couponCode && COUPONS[couponCode] ? eligSub * COUPONS[couponCode].pct / 100 : 0;
    if (couponCode && reward.couponCompatible === false) return { ok: false, error: `${r.name} can't be combined with coupon ${couponCode}.` };
    if (eligSub - couponAmt < r.minCart) return { ok: false, error: `Add ₹${Math.ceil(r.minCart - (eligSub - couponAmt)).toLocaleString('en-IN')} more of eligible items to use ${r.name} (min. order ₹${r.minCart.toLocaleString('en-IN')}).`, shortBy: r.minCart - (eligSub - couponAmt) };
    return { ok: true, discount: Math.min(r.discountValue, eligSub - couponAmt), redemption: r };
  }
  markRewardUsed(code, order) {
    const r = this.s.redemptions.find(x => x.code === code); if (!r) return;
    r.status = 'used'; r.usedAt = this.now; r.orderId = order.id;
    this.track('reward_used', { reward: r.name, order: order.name });
  }

  /* ---------- time-based lifecycle ---------- */
  processDue() {
    const out = [];
    for (const f of [...this.s.failed]) if (f.nextRetryAt <= this.now && f.attempts < 5) { const r = this.ingest(f); out.push(`Queued ${f.topic === 'refunds/create' ? 'refund' : 'event'} ${r.status}`); }
    for (const o of Object.values(this.s.orders)) {
      if (o.customerId && o.pendingLeft > 0 && o.availableAt <= this.now && o.status !== 'cancelled') { const n = this.activate(o); if (n) out.push(`${n} pts activated · ${o.name}`); }
    }
    for (const l of this.s.lots) {
      if (l.remaining > 0 && l.expiresAt && l.expiresAt <= this.now) {
        const acct = this.s.accounts[l.accountId]; const k = l.remaining; l.remaining = 0;
        const src = this.s.txns.find(t => t.id === l.sourceTxn); const ord = l.orderId ? this.s.orders[l.orderId] : null;
        this.addTxn({ accountId: acct.id, customerId: acct.customerId, orderId: l.orderId, type: 'expiry', points: -k, availableDelta: -k, status: 'Expired', source: 'lifecycle',
          description: `${k} points ${ord ? 'from order ' + ord.name : ''} expired ${this.cfg.expiryMonths} months after they became available`.replace('  ', ' '), ref: src ? src.id : null });
        this.track('points_expired', { points: k }); out.push(`${k} pts expired`);
      } else if (l.remaining > 0 && l.expiresAt && !l.warned && l.expiresAt - this.now <= 30 * DAY) {
        l.warned = true; const acct = this.s.accounts[l.accountId];
        this.notify('points_expiring', acct.customerId, `${l.remaining} points expire on ${new Date(l.expiresAt).toDateString()}`);
      }
    }
    for (const r of this.s.redemptions) {
      if (r.status === 'unlocked' && r.expiresAt <= this.now) {
        r.status = 'expired';
        if (this.cfg.returnPointsOnCodeExpiry) {
          const acct = this.acctOf(r.customerId);
          const txn = this.addTxn({ accountId: acct.id, customerId: r.customerId, type: 'reward_return', points: r.pointsUsed, availableDelta: r.pointsUsed, status: 'Adjusted', source: 'lifecycle',
            description: `${r.name} reward expired unused — ${r.pointsUsed} points returned`, ref: r.txnId, meta: { redemption: r.id } });
          this.addLot(acct, r.pointsUsed, txn, null);
        }
        out.push(`${r.name} code ${r.code} expired`);
      }
    }
    return out;
  }
  advance(days) { this.s.now += days * DAY; return this.processDue(); }
  setNow(ms) { this.s.now = ms; return this.processDue(); }

  /* ---------- admin operations ---------- */
  adjust(customerId, delta, reason, note, admin) {
    const acct = this.acctOf(customerId);
    if (!acct) return { ok: false, error: 'Customer has no rewards account.' };
    if (!Number.isInteger(delta) || delta === 0) return { ok: false, error: 'Enter a whole number of points other than 0.' };
    if (!reason) return { ok: false, error: 'Choose a reason.' };
    if (!note || note.trim().length < 5) return { ok: false, error: 'Add an internal note (at least 5 characters) so support can explain this change.' };
    if (!admin) return { ok: false, error: 'Admin name is required.' };
    if (delta < 0 && -delta > acct.available) return { ok: false, error: `Deduction exceeds the available balance of ${acct.available.toLocaleString('en-IN')} points.` };
    const prev = acct.available;
    const isBonus = reason === 'Special bonus';
    const txn = this.addTxn({ accountId: acct.id, customerId, type: isBonus ? 'bonus' : 'adjustment', points: delta, availableDelta: delta, status: isBonus ? 'Available' : 'Adjusted', source: 'admin:' + admin,
      description: isBonus ? `Special bonus from Ecofynd` : `${delta > 0 ? 'Added' : 'Deducted'} by Ecofynd: ${reason}`, meta: { reason, note: note.trim(), admin } });
    if (delta > 0) { const lot = this.addLot(acct, delta, txn, null); txn.expiresAt = lot.expiresAt; } else this.consumeLots(acct, -delta);
    this.audit(admin, 'points_adjusted', `${prev} available`, `${acct.available} available`, `${reason} (${delta > 0 ? '+' : ''}${delta}) — ${note.trim()}`);
    this.track(isBonus ? 'bonus_points_earned' : 'points_adjusted', { customerId, points: delta });
    if (isBonus) this.notify('bonus_points', customerId, `You received ${delta} bonus points`);
    return { ok: true, txn };
  }
  validateConfig(c) {
    const e = [];
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!(c.earn.spend > 0)) e.push('Spend amount must be greater than ₹0.');
    if (!int(c.earn.points, 1, 100000)) e.push('Points earned must be a whole number from 1.');
    if (!['floor', 'round', 'block'].includes(c.earn.rounding)) e.push('Choose a rounding rule.');
    if (!int(c.redeem.points, 1, 1e6)) e.push('Redemption points must be a whole number from 1.');
    if (!(c.redeem.value > 0)) e.push('Redemption value must be greater than ₹0.');
    if (!int(c.holdingDays, 0, 365)) e.push('Holding period must be 0–365 days.');
    if (!int(c.expiryMonths, 0, 60)) e.push('Expiry must be 0–60 months (0 = never).');
    if (c.redeem.value / c.redeem.points * c.earn.points / c.earn.spend > 0.5) e.push('This combination returns more than 50% of spend as reward value. Check the numbers.');
    if (c.campaign.enabled && !(c.campaign.multiplier > 1)) e.push('Campaign multiplier must be above 1.');
    return e;
  }
  updateConfig(next, admin, reason) {
    const errs = this.validateConfig(next); if (errs.length) return { ok: false, errors: errs };
    if (!reason || reason.trim().length < 3) return { ok: false, errors: ['Add a reason for this rule change (kept in the audit log).'] };
    const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ? flat(v, p + k + '.') : [[p + k, JSON.stringify(v)]]);
    const before = Object.fromEntries(flat(this.cfg)), after = Object.fromEntries(flat(next));
    const changed = Object.keys(after).filter(k => before[k] !== after[k]);
    if (!changed.length) return { ok: false, errors: ['Nothing changed.'] };
    changed.forEach(k => this.audit(admin, 'rule_changed:' + k, before[k], after[k], reason.trim()));
    this.s.config = JSON.parse(JSON.stringify(next));
    return { ok: true, changed };
  }
  validateReward(r) {
    const e = [];
    if (!r.name || !r.name.trim()) e.push('Reward name is required.');
    if (!Number.isInteger(r.points) || r.points < 1) e.push('Points required must be a whole number from 1.');
    if (!(r.value > 0)) e.push('Reward value must be greater than ₹0.');
    if (!(r.minCart >= 0)) e.push('Minimum cart value cannot be negative.');
    if (r.minCart && r.value >= r.minCart) e.push('Reward value must be lower than the minimum cart value.');
    if (!Number.isInteger(r.expiryDays) || r.expiryDays < 1) e.push('Code validity must be at least 1 day.');
    if ((r.eligibleCollections || []).some(c => (r.excludedCollections || []).includes(c))) e.push('A collection cannot be both eligible and excluded.');
    return e;
  }
  saveReward(r, admin, reason) {
    const errs = this.validateReward(r); if (errs.length) return { ok: false, errors: errs };
    const i = this.s.rewards.findIndex(x => x.id === r.id);
    const prev = i >= 0 ? JSON.stringify(this.s.rewards[i]) : '—';
    if (i >= 0) this.s.rewards[i] = r; else this.s.rewards.push(r);
    this.s.rewards.sort((a, b) => a.points - b.points);
    this.audit(admin, i >= 0 ? 'reward_changed' : 'reward_created', prev, JSON.stringify(r), reason || 'Catalog update');
    const warn = Math.abs(r.value - this.valueOf(r.points)) > 0.01 ? `Note: ${r.points} points are worth ${'₹' + this.valueOf(r.points)} at the redemption rule, but this reward gives ₹${r.value}.` : null;
    return { ok: true, warn };
  }

  /* ---------- read models ---------- */
  balances(customerId) {
    const a = this.acctOf(customerId);
    if (!a) return null;
    const pendingOrders = Object.values(this.s.orders).filter(o => o.customerId === customerId && o.pendingLeft > 0).sort((x, y) => x.availableAt - y.availableAt)
      .map(o => ({ name: o.name, points: o.pendingLeft, availableAt: o.availableAt }));
    const soon = this.s.lots.filter(l => l.accountId === a.id && l.remaining > 0 && l.expiresAt && l.expiresAt - this.now <= 45 * DAY).sort((x, y) => x.expiresAt - y.expiresAt);
    return { acct: a, available: a.available, pending: a.pending, debt: a.debt, availableValue: this.valueOf(Math.max(0, a.available)), pendingValue: this.valueOf(a.pending), pendingOrders, expiring: soon[0] ? { points: soon.filter(l => l.expiresAt === soon[0].expiresAt).reduce((s, l) => s + l.remaining, 0), at: soon[0].expiresAt } : null };
  }
  rewardState(customerId) {
    const b = customerId ? this.balances(customerId) : null;
    const have = b ? Math.max(0, b.available) : 0;
    const active = this.s.rewards.filter(r => r.status === 'active' && (!customerId || this.customerEligible(r, customerId)));
    const blocked = b && b.debt > 0;
    const affordable = blocked ? [] : active.filter(r => r.points <= have);
    const next = active.find(r => r.points > have) || null;
    const best = affordable[affordable.length - 1] || null;
    return { have, affordable, next, best, need: next ? next.points - have : 0, progress: next ? have / next.points : 1, blocked, all: active };
  }
  estimate(lines) { return this.calcPoints(lines, 0, 0); }

  /* ---------- reconciliation ---------- */
  reconcile() {
    const issues = [];
    const rows = Object.values(this.s.accounts).map(a => {
      const tx = this.s.txns.filter(t => t.accountId === a.id);
      const lp = tx.reduce((s, t) => s + t.pendingDelta, 0), la = tx.reduce((s, t) => s + t.availableDelta, 0);
      const lotSum = this.s.lots.filter(l => l.accountId === a.id).reduce((s, l) => s + l.remaining, 0);
      const c = this.s.customers[a.customerId];
      const ok = lp === a.pending && la === a.available && lotSum - a.debt === la;
      if (lp !== a.pending || la !== a.available) issues.push({ kind: 'Incorrect balance', who: c ? c.name : a.id, detail: `Cached ${a.available}/${a.pending} vs ledger ${la}/${lp} (available/pending)` });
      if (lotSum - a.debt !== la) issues.push({ kind: 'Lot mismatch', who: c ? c.name : a.id, detail: `Point lots ${lotSum} − owed ${a.debt} ≠ ledger available ${la}` });
      return { acct: a, name: c ? c.name : a.id, cachedA: a.available, cachedP: a.pending, ledgerA: la, ledgerP: lp, ok };
    });
    for (const o of Object.values(this.s.orders)) {
      if (!o.customerId) continue;
      const earns = this.s.txns.filter(t => t.orderId === o.id && t.type === 'purchase');
      if (o.points > 0 && earns.length === 0) issues.push({ kind: 'Missing points', who: o.name, detail: `${o.points} points expected, no ledger entry` });
      if (earns.length > 1) issues.push({ kind: 'Duplicate points', who: o.name, detail: `${earns.length} purchase entries for one order` });
      const rev = -this.s.txns.filter(t => t.orderId === o.id && ['cancellation', 'reversal'].includes(t.type)).reduce((s, t) => s + t.points, 0);
      if (rev !== o.reversed) issues.push({ kind: 'Incorrect reversal', who: o.name, detail: `Ledger reversed ${rev}, order expects ${o.reversed}` });
    }
    for (const f of this.s.failed) issues.push({ kind: 'Failed event', who: (this.s.orders[f.payload.orderId] || {}).name || f.payload.name || f.id, detail: `${f.topic} · ${f.attempts} attempt(s) · ${f.error}` });
    return { at: this.now, rows, issues, orders: Object.keys(this.s.orders).length };
  }
  rebuildCache(admin) {
    for (const a of Object.values(this.s.accounts)) {
      const tx = this.s.txns.filter(t => t.accountId === a.id);
      const prev = `${a.available}/${a.pending}`;
      a.pending = tx.reduce((s, t) => s + t.pendingDelta, 0); a.available = tx.reduce((s, t) => s + t.availableDelta, 0);
      if (prev !== `${a.available}/${a.pending}`) this.audit(admin, 'balance_rebuilt', prev, `${a.available}/${a.pending}`, 'Rebuilt cached balance from ledger');
    }
  }

  stats() {
    const S = this.s, accts = Object.values(S.accounts), orders = Object.values(S.orders);
    const sumT = type => S.txns.filter(t => t.type === type).reduce((s, t) => s + t.points, 0);
    const members = accts.length;
    const active = accts.filter(a => S.txns.some(t => t.accountId === a.id && this.now - t.createdAt <= 90 * DAY)).length;
    const newM = accts.filter(a => this.now - a.createdAt <= 30 * DAY).length;
    const byCust = {}; orders.filter(o => o.customerId).forEach(o => { (byCust[o.customerId] = byCust[o.customerId] || []).push(o); });
    const buyers = Object.keys(byCust).length, returning = Object.values(byCust).filter(x => x.length > 1).length;
    const memberOrders = orders.filter(o => o.customerId && o.status !== 'cancelled');
    const revenue = memberOrders.reduce((s, o) => s + o.total - (o.refunds || []).reduce((a, r) => a + r.amount, 0), 0);
    const issued = sumT('purchase') + sumT('bonus') + S.txns.filter(t => t.type === 'adjustment' && t.points > 0).reduce((s, t) => s + t.points, 0);
    const pending = accts.reduce((s, a) => s + a.pending, 0);
    const available = accts.reduce((s, a) => s + Math.max(0, a.available), 0);
    const owed = accts.reduce((s, a) => s + a.debt, 0);
    const redeemed = -sumT('redemption') - sumT('reward_return');
    const expired = Math.abs(sumT('expiry'));
    const reversed = -(sumT('reversal') + sumT('cancellation'));
    const reds = S.redemptions;
    const unlockedOpen = reds.filter(r => r.status === 'unlocked');
    const used = reds.filter(r => r.status === 'used');
    const activatedEver = sumT('activation') + sumT('bonus');
    return { members, active, newM, returning, buyers, issued, pending, available, owed, redeemed, expired, reversed,
      unlocked: reds.length, rewardsUsed: used.length, openRewards: unlockedOpen.length, openRewardValue: unlockedOpen.reduce((s, r) => s + r.discountValue, 0), usedValue: used.reduce((s, r) => s + r.discountValue, 0),
      redemptionRate: activatedEver ? redeemed / activatedEver : 0, revenue, aov: memberOrders.length ? revenue / memberOrders.length : 0,
      repeatRate: buyers ? returning / buyers : 0, frequency: buyers ? memberOrders.length / buyers : 0, clv: buyers ? revenue / buyers : 0 };
  }
}

/* ---------- seed: real Ecofynd products, sample customers, run through the engine so every number is ledger-derived ---------- */
function seedEngine() {
  const E = new Engine(Date.UTC(2025, 6, 1, 6, 30));
  const at = (y, m, d) => E.setNow(Date.UTC(y, m - 1, d, 6, 30));
  const L = (...pairs) => pairs.map(([id, qty]) => ({ productId: id, qty, price: PMAP[id].price, title: PMAP[id].title }));
  E.createCustomer({ id: 'ananya', name: 'Ananya Iyer', email: 'ananya.iyer@example.com', phone: '+91 98450 12345' });
  at(2025, 7, 20); E.checkout({ customerId: 'ananya', lines: L(['gt029', 1]) });
  at(2026, 5, 2); E.createCustomer({ id: 'priya', name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+91 98200 44321' });
  at(2026, 7, 12); E.checkout({ customerId: 'priya', lines: L(['cpot039-05', 1], ['pot030', 1]) });
  at(2026, 7, 28); E.createCustomer({ id: 'kabir', name: 'Kabir Nair', email: 'kabir.nair@example.com', phone: '+91 99300 76543' });
  at(2026, 8, 1); const k1 = E.checkout({ customerId: 'kabir', lines: L(['ps049-go', 1], ['pot031', 1], ['gt029', 1]) });
  at(2026, 8, 14); const r1 = E.redeem('priya', 'rw50', 'seed-1');
  at(2026, 8, 18); E.checkout({ customerId: 'priya', lines: L(['ps057-blk-102', 1]), rewardCode: r1.redemption.code });
  at(2026, 8, 25); E.checkout({ customerId: 'ananya', lines: L(['gvase019-wht', 1], ['ga001', 1], ['cpdisc-110', 1]) });
  at(2026, 9, 1); const kr = E.redeem('kabir', 'rw200', 'seed-2');
  at(2026, 9, 5); E.checkout({ customerId: 'kabir', lines: L(['pot031', 1], ['ps057-blk-102', 1]), rewardCode: kr.redemption.code });
  at(2026, 9, 10); E.adjust('priya', 100, 'Special bonus', 'Monsoon garden bonus for July buyers', 'Sumair');
  at(2026, 9, 20); const p3 = E.checkout({ customerId: 'priya', lines: L(['cpdisc-110', 2], ['ga001', 1]) });
  E.ingest({ id: 'evt_dup_' + p3.orderId, topic: 'orders/create', payload: p3.payload }); // duplicate order webhook (different event id) — ignored
  at(2026, 9, 22); E.checkout({ email: 'meera.kapoor@example.com', lines: L(['pot030', 1]) }); // guest checkout
  at(2026, 9, 24); E.ingest({ id: 'evt_ret_k1', topic: 'refunds/create', payload: { orderId: k1.orderId, refundId: 'rf_k1', amount: 2329, kind: 'return' } });
  at(2026, 9, 28); E.checkout({ customerId: 'priya', lines: L(['gvase019-wht', 1]) });
  at(2026, 9, 30); E.createCustomer({ id: 'rahul', name: 'Rahul Mehta', email: 'rahul.mehta@example.com', phone: '+91 97111 22334' });
  E.s.failNext = 1; E.ingest({ id: 'evt_rf_p3', topic: 'refunds/create', payload: { orderId: p3.orderId, refundId: 'rf_p3', amount: 179, kind: 'return' } });
  E.s.failed.forEach(f => f.nextRetryAt = E.now + 36e5);
  E.s.analytics = E.s.analytics.slice(0, 40);
  return E;
}
if (typeof module !== 'undefined') module.exports = { Engine, seedEngine, PRODUCTS, PMAP, DAY, START, COUPONS };
