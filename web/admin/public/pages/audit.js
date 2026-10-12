// Audit log: the design's aAudit, backed by GET /admin/api/audit. Who, when, action, previous value, new value, reason.

import { h } from '../esc.js';
import { DT } from '../format.js';

const st = { action: '', entries: [], next: null, actions: [], keep: false };

export function renderAudit({ entries, next, actions, action }) {
  return h`<div><h2>Audit log</h2><p class="lede">Admin actions with who, when, previous value, new value and reason: point adjustments, event retries, balance rebuilds and sign-ins. It is append-only: a database trigger refuses any change or delete.</p></div>
  <div class="flex"><label class="f" for="audit-action">Action<select class="inp" id="audit-action" data-input="action"><option value="">All actions</option>${actions.map((a) => h`<option value="${a.action}" ${a.action === action ? 'selected' : ''}>${a.action} (${a.count})</option>`)}</select></label></div>
  <div class="tbl-wrap"><table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Customer</th><th>Previous</th><th>New</th><th>Reason</th></tr></thead><tbody>
    ${entries.map((a) => h`<tr><td class="num nowrap">${DT(a.createdAt)}</td><td>${a.admin}</td><td class="mono">${a.action}</td><td class="mono">${a.subject ?? '—'}</td><td class="mono wrapany">${a.previous}</td><td class="mono wrapany">${a.next}</td><td>${a.reason}</td></tr>`)}
    ${entries.length ? '' : h`<tr><td colspan="7" class="muted">No admin actions yet.</td></tr>`}
  </tbody></table></div>
  ${next ? h`<div><button class="btn ghost small" type="button" data-act="more">Load more</button></div>` : ''}`;
}

async function fetchFirst(ctx) {
  const res = await ctx.api.get(`audit?limit=25${st.action ? `&action=${encodeURIComponent(st.action)}` : ''}`);
  st.entries = res.ok ? res.data.entries : [];
  st.next = res.ok ? res.data.nextCursor : null;
  st.actions = res.ok ? res.data.actions : st.actions;
}

export const auditPage = {
  async render(ctx) {
    if (!st.keep) await fetchFirst(ctx);
    st.keep = false;
    return renderAudit({ entries: st.entries, next: st.next, actions: st.actions, action: st.action });
  },
  act: {
    async more(el, ctx) {
      const res = await ctx.api.get(`audit?limit=25&cursor=${encodeURIComponent(st.next)}${st.action ? `&action=${encodeURIComponent(st.action)}` : ''}`);
      if (res.ok) { st.entries = [...st.entries, ...res.data.entries]; st.next = res.data.nextCursor; }
      st.keep = true;
      return ctx.rerender();
    },
  },
  input: {
    action(el, ctx) { st.action = el.value; return ctx.rerender(); },
  },
  submit: {},
};
