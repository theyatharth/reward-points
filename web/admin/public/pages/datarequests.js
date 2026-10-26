// Data requests: customers/data_request from Shopify. The list shows what was asked; a request opens to everything this app holds
// about that customer (account, points history, orders with refunds, reward codes) so the merchant can pass it on to the customer.
// "Mark as sent" is audited. If the customer was erased later (customers/redact) the request says so and shows no data.

import { h } from '../esc.js';
import { P, D, DT } from '../format.js';

const st = { msg: null };

export function renderList(requests) {
  return h`<div><h2>Data requests</h2><p class="lede">When a customer asks a shop for their personal data, Shopify tells this app. Open a request to see what this app holds about that customer, send it to them, then mark it as sent. Their name, e-mail and phone are not stored here: that data stays in Shopify.</p></div>
  ${st.msg ? h`<div class="ok" role="status">${st.msg}</div>` : ''}
  <div class="tbl-wrap"><table><thead><tr><th>Received</th><th>Customer</th><th>Request</th><th>Status</th><th></th></tr></thead><tbody>
    ${requests.map((r) => h`<tr><td class="num nowrap">${DT(r.receivedAt)}</td><td class="mono">${r.redacted ? 'erased' : r.customerId}</td><td class="mono">${r.requestId}</td><td>${r.status === 'sent' ? `Sent ${D(r.completedAt, true)}` : 'Open'}${r.hasAccount ? '' : ' · no rewards account'}</td><td><button class="btn ghost small" type="button" data-act="open" data-v="${r.id}">View data</button></td></tr>`)}
    ${requests.length ? '' : h`<tr><td colspan="5" class="muted">No data requests yet.</td></tr>`}
  </tbody></table></div>`;
}

export function renderDetail(d) {
  const head = h`<div><button class="btn ghost small" type="button" data-act="back">Back to requests</button>
    <h2>Data request ${d.requestId}</h2>
    <p class="lede">Received ${DT(d.receivedAt)}. Customer <span class="mono">${d.redacted ? 'erased' : d.customerId}</span>.${d.ordersRequested.length ? ` Orders named by Shopify: ${d.ordersRequested.join(', ')}.` : ''}</p></div>`;
  if (d.redacted) return h`${head}<div class="card"><p>This customer was erased at Shopify's request. Nothing about them is kept here.</p></div>`;
  if (!d.account) return h`${head}<div class="card"><p>This customer has no rewards account in this app: nothing is held about them.</p></div>${actions(d)}`;
  return h`${head}
  <div class="card"><h3>Account</h3><dl class="kv"><dt>Member since</dt><dd>${DT(d.account.memberSince)}</dd><dt>Points available</dt><dd class="num">${P(d.account.available)}</dd><dt>Points pending</dt><dd class="num">${P(d.account.pending)}</dd><dt>Points owed</dt><dd class="num">${P(d.account.owed)}</dd></dl></div>
  <div class="card"><h3>Points history (${P(d.ledger.length)})</h3><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Points</th><th>Status</th><th>Note</th></tr></thead><tbody>
    ${d.ledger.map((e) => h`<tr><td class="num nowrap">${DT(e.date)}</td><td class="mono">${e.type}</td><td class="num">${P(e.points)}</td><td>${e.status}</td><td>${e.note ?? ''}</td></tr>`)}
    ${d.ledger.length ? '' : h`<tr><td colspan="5" class="muted">None.</td></tr>`}
  </tbody></table></div></div>
  <div class="card"><h3>Orders (${P(d.orders.length)})</h3><div class="tbl-wrap"><table><thead><tr><th>Order</th><th>Date</th><th>Counted amount</th><th>Points earned</th><th>Refunds</th></tr></thead><tbody>
    ${d.orders.map((o) => h`<tr><td class="mono">${o.orderRef}</td><td class="num nowrap">${DT(o.processedAt)}</td><td class="num">${o.eligible}</td><td class="num">${P(o.pointsEarned)}</td><td>${o.refunds.length ? o.refunds.map((r) => `${r.cancellation ? 'cancelled' : 'refund'} ${r.refundAmount} (−${P(r.pointsReversed)} points)`).join('; ') : 'None'}</td></tr>`)}
    ${d.orders.length ? '' : h`<tr><td colspan="5" class="muted">None.</td></tr>`}
  </tbody></table></div></div>
  <div class="card"><h3>Reward codes (${P(d.rewards.length)})</h3><div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Status</th><th>Points used</th><th>Value</th><th>Created</th><th>Expires</th></tr></thead><tbody>
    ${d.rewards.map((r) => h`<tr><td class="mono">${r.code}</td><td>${r.status}</td><td class="num">${P(r.pointsUsed)}</td><td class="num">${r.value}</td><td class="num nowrap">${DT(r.createdAt)}</td><td class="num nowrap">${DT(r.expiresAt)}</td></tr>`)}
    ${d.rewards.length ? '' : h`<tr><td colspan="6" class="muted">None.</td></tr>`}
  </tbody></table></div></div>
  ${actions(d)}`;
}

const actions = (d) => (d.status === 'sent'
  ? h`<p class="muted">Marked as sent ${D(d.completedAt, true)}.</p>`
  : h`<div class="flex"><button class="btn" type="button" data-act="sent" data-v="${d.id}">Mark as sent</button></div>`);

export const dataRequestsPage = {
  async render(ctx) {
    if (ctx.route.param) {
      const res = await ctx.api.get(`data-requests/${encodeURIComponent(ctx.route.param)}`);
      if (!res.ok) return h`<div class="err" role="alert">This request could not be found.</div>`;
      return renderDetail(res.data);
    }
    const res = await ctx.api.get('data-requests');
    return renderList(res.ok ? res.data.requests : []);
  },
  act: {
    open: (el, ctx) => { st.msg = null; ctx.go(`data/${el.dataset.v}`); },
    back: (el, ctx) => ctx.go('data'),
    async sent(el, ctx) {
      const res = await ctx.api.post(`data-requests/${encodeURIComponent(el.dataset.v)}/sent`, {});
      st.msg = res.ok ? 'Marked as sent.' : 'It could not be marked as sent.';
      ctx.toast(st.msg);
      return ctx.rerender();
    },
  },
  submit: {},
};
