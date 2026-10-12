// Customers: the design's aCustomers, backed by GET /admin/api/customers and /customers/:id, and the adjust form
// (POST /customers/:id/adjust). Search is by Shopify customer id: this build stores no name, e-mail or phone (D5).

import { h } from '../esc.js';
import { P, money, DT, D } from '../format.js';

const kpi = (k, v, s) => h`<div class="kpi"><span class="k">${k}</span><span class="v num">${v}</span>${s ? h`<span class="s">${s}</span>` : ''}</div>`;
const pill = (status) => h`<span class="pill st-${status}">${status}</span>`;

// Page state (kept between renders of this page).
const st = { query: '', adj: null, msg: null, detail: null, extra: [], nextCursor: null, loadedFor: null };

function ledgerRows(entries, cur) {
  return entries.map((e) => h`<tr>
    <td class="num nowrap">${DT(e.createdAt)}</td>
    <td>${e.type}</td>
    <td class="r num"><b class="${e.points > 0 ? 'plus' : e.points < 0 ? 'minus' : ''}">${e.points > 0 ? '+' : ''}${P(e.points)}</b></td>
    <td>${pill(e.status)}</td>
    <td class="mono">${e.orderRef ?? '—'}</td>
    <td class="mono">${e.source ?? '—'}</td>
    <td class="wide">${e.note ?? ''}${e.adminNote ? h`<br><span class="faint">Note: ${e.adminNote}${e.adminEmail ? h` · ${e.adminEmail}` : ''}</span>` : ''}${e.adminReason ? h`<br><span class="faint">Reason: ${e.adminReason}</span>` : ''}</td>
  </tr>`);
}

function adjustForm(adj, reasons, minNote) {
  const list = adj.kind === 'add' ? reasons.add : reasons.deduct;
  return h`<form class="fs surface" data-form="adjust"><h3>${adj.kind === 'add' ? 'Add points' : 'Deduct points'}</h3>
    <div class="form-grid">
      <label class="f" for="adj-amt">Points<input class="inp num" id="adj-amt" name="points" type="number" min="1" step="1" required value="${adj.points ?? ''}"></label>
      <label class="f" for="adj-reason">Reason<select class="inp" id="adj-reason" name="reason" required><option value="">Choose…</option>${list.map((r) => h`<option ${adj.reason === r ? 'selected' : ''}>${r}</option>`)}</select></label>
    </div>
    <label class="f" for="adj-note">Internal note, at least ${minNote} characters (not shown to the customer)<textarea class="inp" id="adj-note" name="note" placeholder="e.g. Ticket #4821: planter arrived chipped">${adj.note ?? ''}</textarea></label>
    ${adj.error ? h`<div class="err" role="alert">${adj.error}</div>` : ''}
    <div class="flex"><button class="btn small" type="submit">${adj.kind === 'add' ? 'Add points' : 'Deduct points'}</button><button class="btn ghost small" type="button" data-act="adjclose">Cancel</button></div>
  </form>`;
}

function detailView(d, meta) {
  const a = d.account;
  const cur = d.rule.currency;
  const m = (x) => money(x, cur);
  return h`<div class="card grid">
      <div class="row-between"><div><h3 class="h-display">Customer <span class="mono">${a.shopifyCustomerId}</span></h3>
        <p class="muted">Member since ${D(a.memberSince, true)}</p></div>
        <div class="flex"><button class="btn small" type="button" data-act="adjopen" data-v="add">Add Points</button><button class="btn ghost small" type="button" data-act="adjopen" data-v="deduct">Deduct Points</button></div></div>
      <div class="kpis">${kpi('Available', P(a.available), m(a.availableValue))}${kpi('Pending', P(a.pending), m(a.pendingValue))}${kpi('Lifetime earned', P(a.lifetimeEarned), 'net of returns')}${kpi('Lifetime redeemed', P(a.lifetimeRedeemed))}${a.owed ? kpi('Being recovered', P(a.owed), m(a.owedValue)) : ''}</div>
      ${st.adj ? adjustForm(st.adj, meta.reasons, meta.minNoteLength) : ''}
      ${st.msg ? h`<div class="ok" role="status">${st.msg}</div>` : ''}
    </div>
    <div class="grid g6"><b class="h-head">Ledger</b>
      <div class="tbl-wrap"><table><thead><tr><th>Created</th><th>Activity</th><th class="r">Points</th><th>Status</th><th>Order</th><th>Source</th><th>Why (support view)</th></tr></thead><tbody>
        ${ledgerRows([...d.ledger.entries, ...st.extra])}
        ${d.ledger.entries.length ? '' : h`<tr><td colspan="7" class="muted">No ledger entries.</td></tr>`}
      </tbody></table></div>
      ${(st.extra.length ? st.nextCursor : d.ledger.nextCursor) ? h`<div><button class="btn ghost small" type="button" data-act="more">Load more</button></div>` : ''}</div>
    <div class="grid g6"><b class="h-head">Point lots</b><div class="tbl-wrap"><table><thead><tr><th>Source</th><th>Status</th><th class="r">Started with</th><th class="r">Remaining</th><th>Usable from</th></tr></thead><tbody>
      ${d.lots.map((l) => h`<tr><td>${l.source}${l.orderRef ? h` <span class="mono">${l.orderRef}</span>` : ''}</td><td>${pill(l.status)}</td><td class="r num">${P(l.originalPoints)}</td><td class="r num">${P(l.remaining)}</td><td class="num nowrap">${D(l.activatesAt, true)}</td></tr>`)}
      ${d.lots.length ? '' : h`<tr><td colspan="5" class="muted">No lots.</td></tr>`}
    </tbody></table></div></div>
    <div class="form-grid">
      <div class="grid g6"><b class="h-head">Orders</b><div class="tbl-wrap"><table><thead><tr><th>Order</th><th class="r">Eligible</th><th class="r">Points</th><th class="r">Reversed</th><th>State</th></tr></thead><tbody>
        ${d.orders.map((o) => h`<tr><td class="mono">${o.orderRef}<br><span class="faint">${D(o.processedAt, true)}</span></td><td class="r num">${m(o.eligible)}</td><td class="r num">${P(o.pointsEarned)}</td><td class="r num">${P(o.pointsReversed)}</td><td>${o.state}</td></tr>`)}
        ${d.orders.length ? '' : h`<tr><td colspan="5" class="muted">No orders</td></tr>`}
      </tbody></table></div></div>
      <div class="grid g6"><b class="h-head">Rewards &amp; redemptions</b><div class="tbl-wrap"><table><thead><tr><th>Code</th><th class="r">Points</th><th>Status</th><th>Expires</th></tr></thead><tbody>
        ${d.rewards.map((r) => h`<tr><td class="mono">${r.code}</td><td class="r num">${P(r.pointsUsed)}<br><span class="faint">${m(r.value)}</span></td><td>${pill(r.status)}${r.usedOrderRef ? h`<br><span class="faint">on <span class="mono">${r.usedOrderRef}</span></span>` : ''}${r.deletePending ? h`<br><span class="faint">deleting in Shopify</span>` : ''}</td><td class="num nowrap">${D(r.expiresAt, true)}</td></tr>`)}
        ${d.rewards.length ? '' : h`<tr><td colspan="4" class="muted">None</td></tr>`}
      </tbody></table></div></div>
    </div>`;
}

export function renderCustomers({ list, detail, meta, selected }) {
  return h`<div><h2>Customers</h2><p class="lede">Search a member by Shopify customer id to see balances, the full ledger and why each change happened. This build stores no name, e-mail or phone.</p></div>
  <div class="split"><div class="grid">
      <form data-form="csearch" class="grid g6"><label class="sr" for="csearch">Search by Shopify customer id</label>
        <input class="inp" id="csearch" name="query" inputmode="numeric" placeholder="Shopify customer id (digits)" value="${st.query}">
        <button class="btn small" type="submit">Search</button></form>
      ${list.hint ? h`<p class="faint fs-sm">${list.hint}</p>` : ''}
      <div class="cust-list">${list.results.map((c) => h`<button type="button" data-act="cust" data-v="${c.shopifyCustomerId}" aria-pressed="${c.shopifyCustomerId === selected}"><span><b class="mono">${c.shopifyCustomerId}</b><br><span class="faint fs-sm">${P(c.pending)} pending${c.owed ? ` · ${P(c.owed)} owed` : ''}</span></span><span class="num"><b>${P(c.available)}</b></span></button>`)}
        ${list.results.length ? '' : h`<p class="muted">No match.</p>`}</div></div>
    <div class="grid g16">${detail ? detailView(detail, meta) : h`<div class="card unavailable"><p class="muted">Pick a member to see their account.</p></div>`}</div></div>`;
}

async function load(ctx, resetDetail) {
  const wanted = ctx.route.param;
  const [list, meta] = await Promise.all([ctx.api.get(`customers?query=${encodeURIComponent(st.query)}`), ctx.api.get('meta')]);
  let detail = null;
  if (wanted) {
    if (resetDetail || st.loadedFor !== wanted || !st.detail) {
      const res = await ctx.api.get(`customers/${encodeURIComponent(wanted)}`);
      st.detail = res.ok ? res.data : null;
      st.extra = [];
      st.nextCursor = res.ok ? res.data.ledger.nextCursor : null;
      st.loadedFor = wanted;
      if (st.adj && st.adj.forId !== wanted) st.adj = null;
    }
    detail = st.detail;
  } else {
    st.detail = null;
    st.loadedFor = null;
  }
  return { list: list.ok ? list.data : { results: [], hint: 'The list could not be loaded.' }, detail, meta: meta.data.adjust, selected: wanted };
}

export const customersPage = {
  async render(ctx) {
    return renderCustomers(await load(ctx, false));
  },
  act: {
    cust: (el, ctx) => { st.msg = null; ctx.go(`customers/${el.dataset.v}`); },
    adjopen: (el, ctx) => { st.adj = { kind: el.dataset.v, forId: ctx.route.param, key: ctx.newKey() }; st.msg = null; return ctx.rerender(); },
    adjclose: (el, ctx) => { st.adj = null; return ctx.rerender(); },
    async more(el, ctx) {
      const res = await ctx.api.get(`customers/${encodeURIComponent(ctx.route.param)}?cursor=${encodeURIComponent(st.nextCursor)}`);
      if (res.ok) { st.extra = [...st.extra, ...res.data.ledger.entries]; st.nextCursor = res.data.ledger.nextCursor; }
      return ctx.rerender();
    },
  },
  submit: {
    csearch(form, ctx) {
      st.query = String(new FormData(form).get('query') ?? '').trim();
      st.msg = null;
      return ctx.rerender();
    },
    async adjust(form, ctx) {
      const f = new FormData(form);
      const sign = st.adj.kind === 'deduct' ? -1 : 1;
      const points = Math.round(Number(f.get('points'))) * sign;
      Object.assign(st.adj, { points: f.get('points'), reason: f.get('reason'), note: f.get('note'), error: null });
      const res = await ctx.api.post(`customers/${encodeURIComponent(ctx.route.param)}/adjust`, { points, reason: String(f.get('reason')), note: String(f.get('note')), idempotencyKey: st.adj.key });
      if (!res.ok) {
        st.adj.error = res.data.message || 'The adjustment was refused.';
        return ctx.rerender();
      }
      st.msg = `${res.data.points > 0 ? 'Added' : 'Deducted'} ${P(Math.abs(res.data.points))} points. Available is now ${P(res.data.available)}.`;
      st.adj = null;
      ctx.toast(res.data.replayed ? 'Already applied.' : 'Points adjusted.');
      await load(ctx, true);
      return ctx.rerender();
    },
  },
};
