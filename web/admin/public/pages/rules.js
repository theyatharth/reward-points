// Rules: the design's aRules, READ ONLY in this version, backed by GET /admin/api/rules. Editing (validated, audited,
// with a diff of previous and new values) is a later step; the shop's rule is set by the seed script until then.

import { h } from '../esc.js';
import { P, money, D } from '../format.js';

const ROUNDING = { floor: 'Proportional, round down', round: 'Proportional, nearest', block: 'Whole points only' };
const BASIS = { after_discount: 'Product value after discounts', before_discount: 'Product value before discounts' };
const TAX = { inclusive: 'Prices include tax: tax is taken out before earning', exclusive: 'Earn on the price as it is' };
const SHORTFALL = { owe_only: 'Recover from future points (after voiding unused reward codes)' };
const yes = (v) => (v ? 'Yes' : 'No');

const row = (label, value, hint) => h`<div class="kpi"><span class="k">${label}</span><span class="v">${value}</span>${hint ? h`<span class="s">${hint}</span>` : ''}</div>`;

export function renderRules(d) {
  if (!d.configured) return h`<div><h2>Earning &amp; redemption rules</h2></div><div class="warnbox">This shop has no loyalty rule yet.</div>`;
  const cur = d.redeem.currency;
  return h`<div><h2>Earning &amp; redemption rules</h2>
    <p class="lede">The rules this shop runs on today. Rules are configuration, not code. This page is read only for now: changing a rule (validated, written to the audit log with its previous value) comes in a later step.</p></div>
  <div class="fs"><h3>Purchase earning</h3><div class="kpis">
    ${row('Earn', `${P(d.earn.points)} points per ${money(d.earn.spend, cur)}`)}
    ${row('Rounding', ROUNDING[d.earn.rounding] ?? d.earn.rounding)}
    ${row('Calculated on', BASIS[d.earn.basis] ?? d.earn.basis)}
    ${row('Tax', TAX[d.earn.taxHandling] ?? d.earn.taxHandling)}
    ${row('Shipping earns points', yes(d.earn.includeShipping))}
    ${row('Gift cards earn points', yes(!d.earn.excludeGiftCards))}</div>
    <div><span class="eyebrow">Collections that don't earn</span>
      <p class="muted">${d.earn.excludedCollectionIds.length ? d.earn.excludedCollectionIds.join(', ') : 'None'}</p>
      ${d.earn.excludedCollectionIds.length ? h`<p class="faint fs-sm">Stored, but not applied when points are earned in this version: only gift cards are excluded today.</p>` : ''}</div></div>
  <div class="fs"><h3>Redemption &amp; lifecycle</h3><div class="kpis">
    ${row('Redemption', `${P(d.redeem.pointsPerReward)} points = ${money(d.redeem.rewardValue, cur)}`)}
    ${row('Holding period', `${P(d.redeem.holdPeriodDays)} days`, 'before new points can be used')}
    ${row('Reward code valid for', `${P(d.redeem.codeValidDays)} days`)}
    ${row('When a return reverses points already spent', SHORTFALL[d.returns.shortfallPolicy] ?? d.returns.shortfallPolicy)}
    ${row('Return reward points when its order is fully refunded or cancelled', yes(d.returns.restoreRewardOnFullRefund))}
    ${row('Return points when an unused code expires', yes(d.returns.returnPointsOnCodeExpiry))}</div></div>
  <div class="fs"><h3>Not in this version</h3>
    <p class="muted">Campaign multipliers and points expiry (the design's "Points expire after ... months") are switched off by design: ${d.program.campaignEnabled || d.program.expiryEnabled ? 'a flag is set in the database but nothing uses it' : 'both are off'}. Several rewards with their own points, minimum cart and limits (the reward catalogue) are not available: this shop has one redemption rule.</p>
    <p class="faint fs-sm">Points earned for orders paid before ${D(d.program.ledgerStartAt, true)} are ignored (the ledger starts then). Last changed ${D(d.program.updatedAt, true)}.</p></div>`;
}

export const rulesPage = {
  async render({ api }) {
    const res = await api.get('rules');
    if (!res.ok) return h`<div class="err" role="alert">The rules could not be loaded.</div>`;
    return renderRules(res.data);
  },
  act: {},
  submit: {},
};
