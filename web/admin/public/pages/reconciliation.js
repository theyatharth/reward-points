// Reconciliation: the design's aRecon, backed by GET /admin/api/reconciliation and POST /admin/api/reconciliation/run.
// It checks every cached balance against the lots and the ledger, and every order against its entries. The design's
// "Simulate cache drift" and "Rebuild balances" buttons are not exposed: a rebuild is a script, and is audited.

import { h } from '../esc.js';
import { P, DT } from '../format.js';

const st = { last: null, running: false };

export function renderReconciliation({ last, running }) {
  const head = h`<div><h2>Reconciliation</h2><p class="lede">Checks every cached balance against its lots and the ledger, and every order against its earn and reversal entries. Missing, duplicate or wrong entries show up here. The worker also runs it every night.</p></div>
    <div class="flex"><button class="btn small" type="button" data-act="run" ${running ? 'disabled' : ''}>${running ? 'Running…' : 'Run reconciliation'}</button></div>`;
  if (!last) return h`${head}<div class="card unavailable"><p class="muted">No run has been recorded yet. Run it now to see the result.</p></div>`;
  const clean = last.discrepancyCount === 0;
  const codes = Object.entries(last.byCode);
  const health = last.eventHealth;
  return h`${head}
    <p class="muted fs-sm">Last run ${DT(last.at)} (${last.trigger ?? 'unknown trigger'}) · ${P(last.accountsChecked)} accounts · <b>${clean ? 'no issues' : `${P(last.discrepancyCount)} issue${last.discrepancyCount === 1 ? '' : 's'} in ${P(last.accountsWithDiscrepancies)} account${last.accountsWithDiscrepancies === 1 ? '' : 's'}`}</b></p>
    ${clean ? h`<div class="ok">Every balance matches its lots and ledger, every order has its earn entry, and every reversal matches.</div>` : ''}
    ${codes.length ? h`<div class="kpis">${codes.map(([code, count]) => h`<div class="kpi"><span class="k mono">${code}</span><span class="v num">${P(count)}</span></div>`)}</div>` : ''}
    ${last.discrepancies.length ? h`<div class="grid">${last.discrepancies.map((d) => h`<div class="issue"><b>${d.code}</b><span>Customer <span class="mono">${d.shopifyCustomerId}</span> · ${d.detail}${d.expected !== null ? h` (expected ${P(d.expected)}, found ${P(d.found)})` : ''}${d.help ? h`<br><span class="faint">${d.help}</span>` : ''}</span></div>`)}</div>` : ''}
    ${last.truncated ? h`<p class="faint fs-sm">Only the first findings are listed; the counts above are complete.</p>` : ''}
    ${last.unrepairable.length ? h`<div class="warnbox">${last.unrepairable.length} account${last.unrepairable.length === 1 ? '' : 's'} cannot be rebuilt automatically and need a person: ${last.unrepairable.map((u) => h`<span class="mono">${u.shopifyCustomerId}</span> `)}</div>` : ''}
    <div class="grid g6"><b class="h-head">Webhook queue at that time</b><div class="kpis">${Object.entries(health).map(([k, v]) => h`<div class="kpi"><span class="k">${k}</span><span class="v num">${P(v)}</span></div>`)}</div></div>
    <div class="card unavailable grid g6"><b class="h-head">Per-member comparison table</b><p class="muted">Not available in this version: a run records the findings, not a row for every member that matched.</p></div>`;
}

export const reconciliationPage = {
  async render(ctx) {
    const res = await ctx.api.get('reconciliation');
    if (!res.ok) return h`<div class="err" role="alert">The last result could not be loaded.</div>`;
    st.last = res.data.last;
    return renderReconciliation({ last: st.last, running: false });
  },
  act: {
    async run(el, ctx) {
      el.disabled = true;
      const res = await ctx.api.post('reconciliation/run', {});
      ctx.toast(res.ok ? 'Reconciliation finished.' : res.data.message || 'Reconciliation could not run.');
      return ctx.rerender();
    },
  },
  submit: {},
};
