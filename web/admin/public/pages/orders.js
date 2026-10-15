// Orders & webhooks: the design's aOrders, backed by GET /admin/api/orders, GET /admin/api/events and
// POST /admin/api/events/:id/retry. The prototype's failure simulator and Return / Refund / Cancel buttons simulate
// Shopify; here the events are real webhooks, so there is nothing to simulate and those controls are not shown.

import { h } from '../esc.js';
import { P, money, D, DT } from '../format.js';

const FILTERS = ['all', 'pending', 'processing', 'processed', 'failed', 'dead', 'skipped'];
const st = { status: 'all', orders: [], ordersNext: null, events: [], eventsNext: null, attention: [], counts: {}, keep: false };

const pill = (status) => h`<span class="pill st-${status}">${status}</span>`;

function failedPanel(events) {
  const bad = events.filter((e) => e.status === 'failed' || e.status === 'dead');
  if (!bad.length) return '';
  return h`<div class="card danger-card grid"><b class="h-head danger-text">Events that need attention (${bad.length})</b>
    ${bad.map((e) => h`<div class="row-between flex"><span><span class="mono">${e.topic}</span> ${e.orderRef ? h`· order <span class="mono">${e.orderRef}</span>` : ''}${e.refundRef ? h` · refund <span class="mono">${e.refundRef}</span>` : ''}<br>
        <span class="faint">${e.lastError ?? 'No error recorded'} · attempt ${e.attempts} · ${pill(e.status)}${e.status === 'failed' && e.nextRetryAt ? h` · automatic retry ${DT(e.nextRetryAt)}` : ''}${e.status === 'dead' ? ' · gave up, retry by hand' : ''}</span></span>
        ${e.canRetry ? h`<button class="btn small" type="button" data-act="retry" data-v="${e.id}">Retry now</button>` : h`<span class="faint">payload purged</span>`}</div>`)}
  </div>`;
}

export function renderOrders(model) {
  const { orders, events, attention, counts, status, ordersNext, eventsNext, currency } = model;
  return h`<div><h2>Orders &amp; webhooks</h2>
    <p class="lede">Orders that earned points, and the queue of webhook events Shopify sent. Every event is applied once; a failed event is retried on a schedule, and one that gave up can be retried here.</p></div>
  ${failedPanel(attention)}
  <div class="card unavailable grid g6"><b class="h-head">Simulating returns, refunds and cancellations</b><p class="muted">Not available in this version: events here are real webhooks from Shopify, so there is nothing to simulate. Refund or cancel the order in Shopify and it appears below.</p></div>
  <div class="grid g6"><b class="h-head">Orders</b>
    <div class="tbl-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th class="r">Eligible</th><th class="r">Points</th><th>Points state</th><th>Order status</th></tr></thead><tbody>
      ${orders.map((o) => h`<tr><td class="mono">${o.orderRef}<br><span class="faint">${D(o.processedAt, true)}</span></td><td class="mono">${o.customerId}</td><td class="r num">${money(o.eligible, currency)}${o.rewardUsed ? h`<br><span class="faint">reward used</span>` : ''}</td>
        <td class="r num">${P(o.pointsEarned)}${o.pointsReversed ? h`<br><span class="minus">−${P(o.pointsReversed)}</span>` : ''}</td>
        <td>${o.lot ? h`${pill(o.lot.status)}<br><span class="faint">${P(o.lot.remaining)} left${o.lot.status === 'pending' ? h` · usable ${D(o.lot.activatesAt, true)}` : ''}</span>` : '—'}</td><td>${o.state}</td></tr>`)}
      ${orders.length ? '' : h`<tr><td colspan="6" class="muted">No orders have earned points yet.</td></tr>`}
    </tbody></table></div>
    ${ordersNext ? h`<div><button class="btn ghost small" type="button" data-act="moreorders">Load more orders</button></div>` : ''}</div>
  <div class="grid g6"><b class="h-head">Webhook events</b>
    <div class="flex" role="group" aria-label="Filter by status">${FILTERS.map((f) => h`<button class="chip-btn" type="button" data-act="filter" data-v="${f}" aria-pressed="${status === f}">${f}${f !== 'all' && counts[f] ? h` <span class="cnt">${counts[f]}</span>` : ''}</button>`)}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Received</th><th>Topic</th><th>Order / refund</th><th>Status</th><th class="r">Attempts</th><th>Detail</th></tr></thead><tbody>
      ${events.map((e) => h`<tr><td class="num nowrap">${DT(e.receivedAt)}</td><td class="mono">${e.topic}</td><td class="mono">${e.orderRef ?? '—'}${e.refundRef ? h`<br><span class="faint">refund ${e.refundRef}</span>` : ''}</td><td>${pill(e.status)}</td><td class="r num">${P(e.attempts)}</td>
        <td class="wrapany">${e.lastError ?? ''}${e.canRetry ? h`<br><button class="link" type="button" data-act="retry" data-v="${e.id}">Retry</button>` : ''}${e.purged ? h`<br><span class="faint">payload purged</span>` : ''}</td></tr>`)}
      ${events.length ? '' : h`<tr><td colspan="6" class="muted">No events.</td></tr>`}
    </tbody></table></div>
    ${eventsNext ? h`<div><button class="btn ghost small" type="button" data-act="moreevents">Load more events</button></div>` : ''}</div>`;
}

async function fetchAll(ctx) {
  const qs = st.status === 'all' ? '' : `&status=${encodeURIComponent(st.status)}`;
  const [o, e, failed, dead] = await Promise.all([
    ctx.api.get('orders'), ctx.api.get(`events?limit=25${qs}`), ctx.api.get('events?limit=50&status=failed'), ctx.api.get('events?limit=50&status=dead'),
  ]);
  st.orders = o.ok ? o.data.orders : [];
  st.ordersNext = o.ok ? o.data.nextCursor : null;
  st.currency = o.ok ? o.data.currency : null;
  st.events = e.ok ? e.data.events : [];
  st.eventsNext = e.ok ? e.data.nextCursor : null;
  st.counts = e.ok ? e.data.counts : {};
  // The "needs attention" panel always shows failed and dead events, whatever the table is filtered to.
  st.attention = [...(failed.ok ? failed.data.events : []), ...(dead.ok ? dead.data.events : [])];
}

export const ordersPage = {
  async render(ctx) {
    if (!st.keep) await fetchAll(ctx);
    st.keep = false;
    return renderOrders({ orders: st.orders, events: st.events, attention: st.attention, counts: st.counts, status: st.status, ordersNext: st.ordersNext, eventsNext: st.eventsNext, currency: st.currency });
  },
  act: {
    filter: (el, ctx) => { st.status = el.dataset.v; return ctx.rerender(); },
    async retry(el, ctx) {
      const res = await ctx.api.post(`events/${encodeURIComponent(el.dataset.v)}/retry`, {});
      ctx.toast(res.ok ? 'Back in the queue. The worker will pick it up within a minute.' : res.data.message || 'Could not retry this event.');
      return ctx.rerender();
    },
    async moreorders(el, ctx) {
      const res = await ctx.api.get(`orders?cursor=${encodeURIComponent(st.ordersNext)}`);
      if (res.ok) { st.orders = [...st.orders, ...res.data.orders]; st.ordersNext = res.data.nextCursor; }
      st.keep = true;
      return ctx.rerender();
    },
    async moreevents(el, ctx) {
      const qs = st.status === 'all' ? '' : `&status=${encodeURIComponent(st.status)}`;
      const res = await ctx.api.get(`events?limit=25&cursor=${encodeURIComponent(st.eventsNext)}${qs}`);
      if (res.ok) { st.events = [...st.events, ...res.data.events]; st.eventsNext = res.data.nextCursor; }
      st.keep = true;
      return ctx.rerender();
    },
  },
  submit: {},
};
