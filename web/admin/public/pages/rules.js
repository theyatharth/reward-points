// Rules: the design's aRules, backed by GET /admin/api/rules, POST /rules/preview and POST /rules.
// View -> Edit -> Review (previous -> new, warnings) -> Save. The server validates everything again, refuses a
// stale form and writes an audit row with the previous and new value of every changed field.

import { h } from '../esc.js';
import { P, money, D } from '../format.js';

const ROUNDING = { floor: 'Proportional, round down', round: 'Proportional, nearest', block: 'Whole spend blocks only (a part block earns nothing)' };
const BASIS = { after_discount: 'Product value after discounts', before_discount: 'Product value before discounts' };
const TAX = { inclusive: 'Prices include tax: tax is taken out before earning', exclusive: 'Earn on the price as it is' };
const SHORTFALL = { owe_only: 'Recover from future points (after voiding unused reward codes)' };
const yes = (v) => (v ? 'Yes' : 'No');

const st = { mode: 'view', data: null, draft: null, review: null, error: null, notice: null };

const row = (label, value, hint) => h`<div class="kpi"><span class="k">${label}</span><span class="v">${value}</span>${hint ? h`<span class="s">${hint}</span>` : ''}</div>`;

/** The current values keyed like the API's editable fields. */
export const currentValues = (d) => ({
  spend: d.earn.spend, points: d.earn.points, rounding: d.earn.rounding, basis: d.earn.basis, taxHandling: d.earn.taxHandling,
  includeShipping: d.earn.includeShipping, excludeGiftCards: d.earn.excludeGiftCards,
  pointsPerReward: d.redeem.pointsPerReward, rewardValue: d.redeem.rewardValue, holdPeriodDays: d.redeem.holdPeriodDays, codeValidDays: d.redeem.codeValidDays,
  returnPointsOnCodeExpiry: d.returns.returnPointsOnCodeExpiry, restoreRewardOnFullRefund: d.returns.restoreRewardOnFullRefund,
});

const MONEY_KEYS = new Set(['spend', 'rewardValue']);
const INT_KEYS = ['points', 'pointsPerReward', 'holdPeriodDays', 'codeValidDays'];
const BOOL_KEYS = ['includeShipping', 'returnPointsOnCodeExpiry', 'restoreRewardOnFullRefund'];

/** What the form currently holds, typed like the API wants it. The gift-card box reads "gift cards earn", the API field is the inverse. */
export function readForm(form) {
  const el = (n) => form.elements[n];
  const v = {};
  for (const k of ['spend', 'rewardValue']) v[k] = String(el(k).value).trim();
  for (const k of INT_KEYS) v[k] = el(k).value.trim() === '' ? null : Number(el(k).value);
  for (const k of ['rounding', 'basis', 'taxHandling']) v[k] = String(el(k).value);
  for (const k of BOOL_KEYS) v[k] = el(k).checked;
  v.excludeGiftCards = !el('giftCardsEarn').checked;
  return v;
}

/** Only the fields whose value differs from what the page loaded. */
export function changedFields(draft, current) {
  return Object.fromEntries(Object.keys(current).filter((k) => draft[k] !== current[k]).map((k) => [k, draft[k]]));
}

const showValue = (key, value, cur) => {
  if (MONEY_KEYS.has(key)) return money(value, cur);
  if (typeof value === 'boolean') return yes(value);
  if (key === 'rounding') return ROUNDING[value] ?? String(value);
  if (key === 'basis') return BASIS[value] ?? String(value);
  if (key === 'taxHandling') return TAX[value] ?? String(value);
  return typeof value === 'number' ? P(value) : String(value);
};

const select = (name, label, options, value) => h`<label class="f" for="r-${name}">${label}<select class="inp" id="r-${name}" name="${name}">${Object.entries(options).map(([k, t]) => h`<option value="${k}" ${k === value ? 'selected' : ''}>${t}</option>`)}</select></label>`;
const number = (name, label, value, lim) => h`<label class="f" for="r-${name}">${label}<input class="inp num" id="r-${name}" name="${name}" type="number" step="1" min="${lim.min}" max="${lim.max}" required value="${value ?? ''}"></label>`;
const amount = (name, label, value) => h`<label class="f" for="r-${name}">${label}<input class="inp num" id="r-${name}" name="${name}" type="text" inputmode="decimal" autocomplete="off" required value="${value ?? ''}"></label>`;
const check = (name, label, checked) => h`<label class="check" for="r-${name}"><input id="r-${name}" name="${name}" type="checkbox" ${checked ? 'checked' : ''}><span>${label}</span></label>`;

export function renderRules(d) {
  if (!d.configured) return h`<div><h2>Earning &amp; redemption rules</h2></div><div class="warnbox">This shop has no loyalty rule yet.</div>`;
  const cur = d.redeem.currency;
  return h`<div><h2>Earning &amp; redemption rules</h2>
    <p class="lede">The rules this shop runs on today. Rules are configuration, not code. A change applies to new orders and new redemptions, is checked before it is saved, and is written to the audit log with its previous value.</p>
    <div class="flex"><button class="btn small" type="button" data-act="rules-edit">Edit rules</button></div></div>
  ${st.notice ? h`<div class="warnbox" role="status">${st.notice}</div>` : ''}
  <div class="fs"><h3>Purchase earning</h3><div class="kpis">
    ${row('Earn', `${P(d.earn.points)} points per ${money(d.earn.spend, cur)}`)}
    ${row('Rounding', ROUNDING[d.earn.rounding] ?? d.earn.rounding)}
    ${row('Calculated on', BASIS[d.earn.basis] ?? d.earn.basis)}
    ${row('Tax', TAX[d.earn.taxHandling] ?? d.earn.taxHandling)}
    ${row('Shipping earns points', yes(d.earn.includeShipping))}
    ${row('Gift cards earn points', yes(!d.earn.excludeGiftCards))}</div>
    <div><span class="eyebrow">Collections that don't earn</span>
      <p class="muted">${d.earn.excludedCollectionIds.length ? d.earn.excludedCollectionIds.join(', ') : 'None'}</p>
      ${d.earn.excludedCollectionIds.length ? h`<p class="faint fs-sm">Stored, but not applied when points are earned in this version: only gift cards are excluded today. Not editable here.</p>` : ''}</div></div>
  <div class="fs"><h3>Redemption &amp; lifecycle</h3><div class="kpis">
    ${row('Redemption', `${P(d.redeem.pointsPerReward)} points = ${money(d.redeem.rewardValue, cur)}`)}
    ${row('Holding period', `${P(d.redeem.holdPeriodDays)} days`, 'before new points can be used')}
    ${row('Reward code valid for', `${P(d.redeem.codeValidDays)} days`)}
    ${row('When a return reverses points already spent', SHORTFALL[d.returns.shortfallPolicy] ?? d.returns.shortfallPolicy)}
    ${row('Return reward points when its order is fully refunded or cancelled', yes(d.returns.restoreRewardOnFullRefund))}
    ${row('Return points when an unused code expires', yes(d.returns.returnPointsOnCodeExpiry))}</div></div>
  <div class="fs"><h3>Not in this version</h3>
    <p class="muted">Campaign multipliers and points expiry (the design's "Points expire after ... months") are switched off by design: ${d.program.campaignEnabled || d.program.expiryEnabled ? 'a flag is set in the database but nothing uses it' : 'both are off'}. Several rewards with their own points, minimum cart and limits (the reward catalogue) are not available: this shop has one redemption rule. The currency, excluded collections and the start of the ledger are not editable here.</p>
    <p class="faint fs-sm">Points earned for orders paid before ${D(d.program.ledgerStartAt, true)} are ignored (the ledger starts then). Last changed ${D(d.program.updatedAt, true)}.</p></div>`;
}

export function renderEdit(d, draft, error) {
  const cur = d.redeem.currency;
  const v = draft ?? currentValues(d);
  const L = d.limits;
  return h`<div><h2>Edit rules</h2><p class="lede">Amounts are in ${cur}. You review every change before it is saved.</p></div>
  <form data-form="rules-review" class="grid g16" novalidate>
    <div class="fs surface"><h3>Purchase earning</h3>
      <div class="form-grid">
        ${amount('spend', `Spend (${cur})`, v.spend)}
        ${number('points', 'Points earned for that spend', v.points, L.points)}
        ${select('rounding', 'Rounding', ROUNDING, v.rounding)}
        ${select('basis', 'Calculated on', BASIS, v.basis)}
        ${select('taxHandling', 'Tax', TAX, v.taxHandling)}
      </div>
      <div class="grid g6">${check('includeShipping', 'Shipping earns points', v.includeShipping)}${check('giftCardsEarn', 'Gift cards earn points', !v.excludeGiftCards)}</div>
    </div>
    <div class="fs surface"><h3>Redemption &amp; lifecycle</h3>
      <div class="form-grid">
        ${number('pointsPerReward', 'Points for one reward', v.pointsPerReward, L.pointsPerReward)}
        ${amount('rewardValue', `Reward value (${cur})`, v.rewardValue)}
        ${number('holdPeriodDays', 'Holding period (days, 0 to 365)', v.holdPeriodDays, L.holdPeriodDays)}
        ${number('codeValidDays', 'Reward code valid for (days)', v.codeValidDays, L.codeValidDays)}
      </div>
      <div class="grid g6">${check('restoreRewardOnFullRefund', 'Return reward points when its order is fully refunded or cancelled', v.restoreRewardOnFullRefund)}${check('returnPointsOnCodeExpiry', 'Return points when an unused code expires', v.returnPointsOnCodeExpiry)}</div>
    </div>
    ${error ? h`<div class="err" role="alert">${error}</div>` : ''}
    <div class="flex"><button class="btn small" type="submit">Review changes</button><button class="btn ghost small" type="button" data-act="rules-cancel">Cancel</button></div>
  </form>`;
}

export function renderReview(d, review, error) {
  const cur = d.redeem.currency;
  return h`<div><h2>Review changes</h2><p class="lede">Nothing is saved yet. Check the previous and new values.</p></div>
  <div class="tbl-wrap"><table><thead><tr><th>Setting</th><th>Previous</th><th>New</th></tr></thead><tbody>
    ${review.changes.map((c) => h`<tr><td>${c.label}</td><td>${showValue(c.field, c.previous, cur)}</td><td><strong>${showValue(c.field, c.next, cur)}</strong></td></tr>`)}
  </tbody></table></div>
  ${review.notes.map((n) => h`<p class="muted">${n}</p>`)}
  <form data-form="rules-save" class="grid g16">
    ${review.warnings.map((w) => h`<div class="warnbox" role="alert">${w}</div>`)}
    ${review.warnings.length ? h`<label class="check" for="r-ack"><input id="r-ack" name="ack" type="checkbox" required><span>I understand and want to save these rules</span></label>` : ''}
    ${error ? h`<div class="err" role="alert">${error}</div>` : ''}
    <div class="flex"><button class="btn small" type="submit">Save rules</button><button class="btn ghost small" type="button" data-act="rules-back">Back to edit</button><button class="btn ghost small" type="button" data-act="rules-cancel">Cancel</button></div>
  </form>`;
}

async function load(api) {
  const res = await api.get('rules');
  st.data = res.ok ? res.data : null;
  return res.ok;
}

export const rulesPage = {
  async render({ api }) {
    if (st.mode === 'view' || !st.data) {
      if (!(await load(api))) return h`<div class="err" role="alert">The rules could not be loaded.</div>`;
    }
    if (st.mode === 'edit' && st.data.configured) return renderEdit(st.data, st.draft, st.error);
    if (st.mode === 'review' && st.data.configured && st.review) return renderReview(st.data, st.review, st.error);
    st.mode = 'view';
    const out = renderRules(st.data);
    st.notice = null;
    return out;
  },
  act: {
    'rules-edit'(el, ctx) { st.mode = 'edit'; st.draft = null; st.error = null; return ctx.rerender(); },
    'rules-cancel'(el, ctx) { Object.assign(st, { mode: 'view', draft: null, review: null, error: null }); return ctx.rerender(); },
    'rules-back'(el, ctx) { st.mode = 'edit'; st.error = null; return ctx.rerender(); },
  },
  submit: {
    async 'rules-review'(form, ctx) {
      const current = currentValues(st.data);
      st.draft = readForm(form);
      const changes = changedFields(st.draft, current);
      if (Object.keys(changes).length === 0) { st.error = 'Nothing was changed.'; return ctx.rerender(); }
      const res = await ctx.api.post('rules/preview', { changes });
      if (!res.ok) { st.error = res.data.message || 'These rules were refused.'; return ctx.rerender(); }
      st.review = { ...res.data, payload: changes };
      st.mode = 'review';
      st.error = null;
      return ctx.rerender();
    },
    async 'rules-save'(form, ctx) {
      const res = await ctx.api.post('rules', { expected: st.review.expected, changes: st.review.payload, acknowledgeWarnings: Boolean(form.elements.ack?.checked) });
      if (!res.ok) {
        if (res.data.error === 'STALE_RULES') {
          Object.assign(st, { mode: 'view', draft: null, review: null, error: null, notice: res.data.message });
        } else if (res.data.error === 'WARNINGS_NOT_ACKNOWLEDGED') {
          st.error = 'Tick the box to confirm you understand the warning.';
        } else {
          st.error = res.data.message || 'The rules were not saved.';
        }
        return ctx.rerender();
      }
      Object.assign(st, { mode: 'view', draft: null, review: null, error: null });
      ctx.toast(res.data.changed === 0 ? 'Nothing to change: already saved.' : 'Rules saved.');
      return ctx.rerender();
    },
  },
};
