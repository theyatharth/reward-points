// Overview: the design's aOverview, backed by GET /admin/api/overview. Everything is computed from the ledger.

import { h } from '../esc.js';
import { P, money, pct, DT, ago } from '../format.js';

const kpi = (k, v, s) => h`<div class="kpi"><span class="k">${k}</span><span class="v num">${v}</span>${s ? h`<span class="s">${s}</span>` : ''}</div>`;

const SEGMENTS = [['Pending', 'pending', 'c1'], ['Available', 'available', 'c2'], ['Redeemed', 'redeemed', 'c3'], ['Expired', 'expired', 'c4'], ['Reversed', 'reversed', 'c5']];

function stackBar(points) {
  const total = SEGMENTS.reduce((s, [, k]) => s + Math.max(0, points[k]), 0) || 1;
  let x = 0;
  const rects = SEGMENTS.filter(([, k]) => points[k] > 0).map(([label, k, cls]) => {
    const w = (points[k] / total) * 100;
    const rect = h`<rect class="${cls}" x="${x.toFixed(3)}" y="0" width="${w.toFixed(3)}" height="34"><title>${label}: ${P(points[k])} pts</title></rect>`;
    x += w;
    return rect;
  });
  const summary = SEGMENTS.map(([label, k]) => `${label} ${P(points[k])}`).join(', ');
  return h`<svg class="stack-svg" viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label="${summary}">${rects}</svg>
    <div class="legend">${SEGMENTS.map(([label, k, cls]) => h`<span><i class="${cls}"></i>${label} <b class="num">${P(points[k])}</b></span>`)}</div>`;
}

/** The worker's last tick: green while recent, a warning colour after the server's threshold (5 minutes), red when it never ticked. */
export function workerBanner(w) {
  if (!w || w.state === 'never') {
    return h`<div class="hb bad" role="alert"><b>Background worker: no tick recorded</b><span>It has never run against this database, or the heartbeat table is new. Until it runs, points do not activate and events are not processed.</span></div>`;
  }
  const where = `Last worker tick ${ago(w.ageSeconds)} (${DT(w.lastTickAt)})`;
  if (w.state === 'stale') {
    return h`<div class="hb warn" role="alert"><b>Background worker may be down</b><span>${where}. It ticks every 30 seconds; after ${P(w.staleAfterSeconds / 60)} minutes of silence nothing is activated or processed. Check the worker process.</span></div>`;
  }
  return h`<div class="hb ok"><b>Background worker running</b><span>${where}.${w.lastTickFailed ? ' The last tick failed: see Orders &amp; webhooks and the server log.' : ''}</span></div>`;
}

export function renderOverview(d) {
  if (!d.configured) {
    return h`<div><h2>Rewards overview</h2></div><div class="warnbox">This shop has no loyalty rule yet, so there is nothing to total.</div>`;
  }
  const cur = d.rule.currency;
  const m = (x) => money(x, cur);
  const p = d.points;
  const v = d.values;
  const L = d.liability;
  const failing = (d.events.counts.failed || 0) + (d.events.counts.dead || 0);
  return h`<div><h2>Rewards overview</h2>
    <p class="lede">All figures come from the ledger. ${P(d.rule.pointsPerReward)} points are worth ${m(d.rule.rewardValue)}; points are held ${P(d.rule.holdPeriodDays)} days before they can be used. As of ${DT(d.asOf)}.</p></div>
  ${workerBanner(d.worker)}
  ${failing ? h`<div class="issue"><b>Events need attention</b><span>${P(failing)} webhook event${failing === 1 ? '' : 's'} failed or dead. See Orders &amp; webhooks.</span></div>` : ''}
  <div class="kgroup"><span class="eyebrow">Members</span><div class="kpis">
    ${kpi('Total members', P(d.members.total))}${kpi('Active (90 days)', P(d.members.active90))}${kpi('New (30 days)', P(d.members.new30))}${kpi('Returning buyers', P(d.members.returningBuyers), `of ${P(d.members.buyers)} buyers`)}</div></div>
  <div class="kgroup"><span class="eyebrow">Points</span><div class="kpis">
    ${kpi('Issued', P(p.issued), m(v.issued))}${kpi('Pending', P(p.pending), m(v.pending))}${kpi('Available', P(p.available), m(v.available))}${kpi('Redeemed', P(p.redeemed), m(v.redeemed))}${kpi('Expired', P(p.expired), m(v.expired))}${kpi('Reversed', P(p.reversed), m(v.reversed))}</div>
    <div class="card grid"><b class="h-head">Where issued points are now</b>${stackBar(p)}</div></div>
  <div class="kgroup"><span class="eyebrow">Outstanding reward value (liability)</span>
    <div class="tbl-wrap"><table><thead><tr><th>Bucket</th><th class="r">Points</th><th class="r">Value</th><th>How to read it</th></tr></thead><tbody>
      <tr><td><b>Available</b></td><td class="r num">${P(L.available.points)}</td><td class="r num"><b>${m(L.available.value)}</b></td><td>Customers can redeem this today. This is the live liability.</td></tr>
      <tr><td><b>Unlocked, not used</b></td><td class="r num">${P(L.openCodes.count)} codes</td><td class="r num"><b>${m(L.openCodes.value)}</b></td><td>Discount codes issued and still valid.</td></tr>
      <tr><td>Pending</td><td class="r num">${P(L.pending.points)}</td><td class="r num">${m(L.pending.value)}</td><td>Contingent. Becomes liability only after the holding period, net of returns.</td></tr>
      <tr><td>Redeemed</td><td class="r num">${P(L.redeemed.points)}</td><td class="r num">${m(L.redeemed.value)}</td><td>Already converted to discounts (${m(L.redeemed.usedValue)} used on orders).</td></tr>
      <tr><td>Expired</td><td class="r num">${P(L.expired.points)}</td><td class="r num">${m(L.expired.value)}</td><td>Codes that expired unused and kept their points. Not a liability.</td></tr>
      <tr><td>Being recovered</td><td class="r num">${P(L.owed.points)}</td><td class="r num">${m(L.owed.value)}</td><td>Points reversed after they were spent; recovered from future earnings.</td></tr>
    </tbody></table></div></div>
  <div class="kgroup"><span class="eyebrow">Rewards</span><div class="kpis">
    ${kpi('Rewards unlocked', P(d.rewards.unlocked))}${kpi('Rewards used', P(d.rewards.used), `${m(d.rewards.usedValue)} discount`)}${kpi('Open codes', P(d.rewards.open))}${kpi('Points redemption rate', d.redemptionRate === null ? '—' : pct(d.redemptionRate), 'redeemed ÷ issued, not pending')}</div></div>
  <div class="kgroup"><span class="eyebrow">Business (members only, to date)</span>
    <div class="card unavailable grid g6"><b class="h-head">Not available in this version</b><p class="muted">${d.business.reason} Member revenue, average order value, repeat purchase rate and customer lifetime value need order totals.</p></div></div>
  <div class="kgroup"><span class="eyebrow">Recent webhook events</span>
    <div class="tbl-wrap"><table><thead><tr><th>Received</th><th>Topic</th><th>Status</th><th class="r">Attempts</th></tr></thead><tbody>
      ${d.events.recent.map((e) => h`<tr><td class="num nowrap">${DT(e.receivedAt)}</td><td class="mono">${e.topic}</td><td><span class="pill st-${e.status}">${e.status}</span></td><td class="r num">${P(e.attempts)}</td></tr>`)}
      ${d.events.recent.length ? '' : h`<tr><td colspan="4" class="muted">No events yet.</td></tr>`}
    </tbody></table></div></div>`;
}

export const overviewPage = {
  async render({ api }) {
    const res = await api.get('overview');
    if (!res.ok) return h`<div class="err" role="alert">The overview could not be loaded.</div>`;
    return renderOverview(res.data);
  },
  act: {},
  submit: {},
};
