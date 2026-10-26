// Rules: the design's aRules, backed by GET /admin/api/rules, POST /rules/preview and POST /rules.
// An organised settings list: one card per area, label on the left and value on the right, thin dividers.
// View -> Edit -> Review (previous -> new, warnings) -> Save. The server validates everything again, refuses a
// stale form and writes an audit row with the previous and new value of every changed field.
// Markup is classes only (the Content-Security-Policy forbids inline styles) and every value goes through h``.

import { h } from '../esc.js';
import { P, money, D, currencySymbol } from '../format.js';

const ROUNDING = { floor: 'Proportional, round down', round: 'Proportional, nearest', block: 'Whole spend blocks only (a part block earns nothing)' };
const BASIS = { after_discount: 'Product value after discounts', before_discount: 'Product value before discounts' };
const TAX = { inclusive: 'Prices include tax: tax is taken out before earning', exclusive: 'Earn on the price as it is' };
const SHORTFALL = { owe_only: 'Recover from future points (after voiding unused reward codes)' };

const st = { mode: 'view', data: null, draft: null, review: null, error: null, fieldErrors: {}, notice: null };

// ---------- small pieces ----------

const pill = (on) => (on ? h`<span class="rp-pill yes">Yes</span>` : h`<span class="rp-pill no">No</span>`);
const lockPill = h`<span class="rp-pill lock">locked</span>`;

/** One settings row: label (and an optional one-line hint) on the left, the value on the right. */
const row = (label, value, hint) => h`<div class="rp-row"><dt class="rp-label">${label}${hint ? h`<span class="rp-hint">${hint}</span>` : ''}</dt><dd class="rp-value">${value}</dd></div>`;
const card = (title, rows, extra) => h`<section class="rp-card"><h3>${title}</h3><dl class="rp-list">${rows}</dl>${extra ?? ''}</section>`;
const head = (title, lede, action) => h`<div class="rp-head"><div><h2>${title}</h2><p class="lede">${lede}</p></div>${action ?? ''}</div>`;

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
const LABELS = { spend: 'Spend', points: 'Points earned', rewardValue: 'Reward value', pointsPerReward: 'Points per reward', holdPeriodDays: 'Holding period (days)', codeValidDays: 'Reward code valid (days)' };

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

/**
 * The form's own checks, so several problems show at once next to their fields. The server checks everything again.
 * @returns {Object<string, string>} field -> message (empty when the draft is fine)
 */
export function validateDraft(draft, limits = {}) {
  const errors = {};
  for (const k of MONEY_KEYS) {
    const v = draft[k];
    if (typeof v !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(v.trim())) { errors[k] = `${LABELS[k]}: enter an amount such as 100 or 100.50.`; continue; }
    const lim = limits[k];
    const n = Number(v);
    if (lim && (n < Number(lim.min) || n > Number(lim.max))) errors[k] = `${LABELS[k]}: between ${lim.min} and ${lim.max}.`;
  }
  for (const k of INT_KEYS) {
    const v = draft[k];
    if (!Number.isInteger(v)) { errors[k] = `${LABELS[k]}: a whole number.`; continue; }
    const lim = limits[k];
    if (lim && (v < lim.min || v > lim.max)) errors[k] = `${LABELS[k]}: between ${lim.min} and ${lim.max}.`;
  }
  return errors;
}

const showValue = (key, value, cur) => {
  if (MONEY_KEYS.has(key)) return money(value, cur);
  if (typeof value === 'boolean') return pill(value);
  if (key === 'rounding') return ROUNDING[value] ?? String(value);
  if (key === 'basis') return BASIS[value] ?? String(value);
  if (key === 'taxHandling') return TAX[value] ?? String(value);
  return typeof value === 'number' ? P(value) : String(value);
};

// ---------- view mode ----------

export function renderRules(d) {
  if (!d.configured) return h`<div><h2>Earning &amp; redemption rules</h2></div><div class="warnbox">This shop has no loyalty rule yet.</div>`;
  const cur = d.redeem.currency;
  const strip = [
    `${P(d.earn.points)} points per ${money(d.earn.spend, cur)}`,
    `${P(d.redeem.pointsPerReward)} points = ${money(d.redeem.rewardValue, cur)}`,
    `points usable after ${P(d.redeem.holdPeriodDays)} days`,
    `codes valid ${P(d.redeem.codeValidDays)} days`,
  ];
  const collections = d.earn.excludedCollectionIds;
  const flags = d.program.campaignEnabled || d.program.expiryEnabled ? 'a flag is set in the database but nothing uses it' : 'both are off';
  return h`${head('Earning & redemption rules', 'The rules this shop runs on today; a change applies to new orders and redemptions and is audited.', h`<button class="btn small" type="button" data-act="rules-edit">Edit rules</button>`)}
  <p class="rp-strip" aria-label="Rule summary">${strip.map((s, i) => h`${i ? h`<span class="sep" aria-hidden="true">·</span> ` : ''}<span>${s}</span> `)}</p>
  ${st.notice ? h`<div class="warnbox" role="status">${st.notice}</div>` : ''}
  ${card('Purchase earning', [
    row('Earn', `${P(d.earn.points)} points per ${money(d.earn.spend, cur)}`),
    row('Rounding', ROUNDING[d.earn.rounding] ?? d.earn.rounding),
    row('Calculated on', BASIS[d.earn.basis] ?? d.earn.basis),
    row('Tax', TAX[d.earn.taxHandling] ?? d.earn.taxHandling),
    row('Shipping earns points', pill(d.earn.includeShipping)),
    row('Gift cards earn points', pill(!d.earn.excludeGiftCards)),
    row("Collections that don't earn", collections.length ? collections.join(', ') : 'None', collections.length ? 'Stored, but not applied when points are earned in this version: only gift cards are excluded today. Not editable here.' : null),
  ])}
  ${card('Redemption', [
    row('Redemption rate', `${P(d.redeem.pointsPerReward)} points = ${money(d.redeem.rewardValue, cur)}`),
    row('Holding period', `${P(d.redeem.holdPeriodDays)} days`, 'before new points can be used'),
    row('Reward code valid for', `${P(d.redeem.codeValidDays)} days`),
  ])}
  ${card('Returns and shortfall', [
    row('When a return reverses points already spent', SHORTFALL[d.returns.shortfallPolicy] ?? d.returns.shortfallPolicy),
    row('Return reward points when its order is fully refunded or cancelled', pill(d.returns.restoreRewardOnFullRefund)),
    row('Return points when an unused code expires', pill(d.returns.returnPointsOnCodeExpiry)),
  ])}
  <div class="rp-note"><p class="muted">Not in this version: campaign multipliers and points expiry are switched off by design (${flags}). The currency, excluded collections and the start of the ledger are not editable here.</p>
    <p class="muted">Several rewards with their own points, minimum cart and limits (the reward catalogue) are not available: this shop has one redemption rule.</p>
    <p class="faint fs-sm">Last changed ${D(d.program.updatedAt, true)} · the ledger starts ${D(d.program.ledgerStartAt, true)}: earlier orders are ignored.</p></div>`;
}

// ---------- edit mode ----------

/** `errors` is a message, or { general, fields: { name: message } }. */
const normaliseErrors = (errors) => (typeof errors === 'string' ? { general: errors, fields: {} } : { general: errors?.general ?? null, fields: errors?.fields ?? {} });

function summary(errors) {
  const entries = Object.entries(errors.fields);
  if (!entries.length && !errors.general) return '';
  const n = entries.length;
  return h`<div class="err rp-summary" id="rp-summary" role="alert" tabindex="-1">
    ${n ? h`<b>${n === 1 ? 'One thing needs fixing' : `${n} things need fixing`}</b><ul>${entries.map(([name, message]) => h`<li><button class="link" type="button" data-act="rules-goto" data-v="${name}">${message}</button></li>`)}</ul>` : ''}
    ${errors.general ? h`<p>${errors.general}</p>` : ''}
  </div>`;
}

/** A labelled field: label above, control, unit as suffix text, hint and error below. */
function field({ name, label, control, suffix, hint, error }) {
  return h`<div class="rp-field${error ? ' has-error' : ''}"><label for="r-${name}">${label}</label>
    <div class="rp-input">${control}${suffix ? h`<span class="rp-suffix">${suffix}</span>` : ''}</div>
    ${hint ? h`<p class="rp-hint" id="r-${name}-hint">${hint}</p>` : ''}${error ? h`<p class="rp-error" id="r-${name}-err">${error}</p>` : ''}</div>`;
}
const describedBy = (name, hint, error) => [hint ? `r-${name}-hint` : '', error ? `r-${name}-err` : ''].filter(Boolean).join(' ');

const selectField = (name, label, options, value, hint, errors) => field({
  name, label, hint, error: errors[name],
  control: h`<select class="inp" id="r-${name}" name="${name}" aria-invalid="${errors[name] ? 'true' : 'false'}">${Object.entries(options).map(([k, t]) => h`<option value="${k}" ${k === value ? 'selected' : ''}>${t}</option>`)}</select>`,
});
const numberField = (name, label, value, lim, suffix, hint, errors) => field({
  name, label, suffix, hint, error: errors[name],
  control: h`<input class="inp num" id="r-${name}" name="${name}" type="number" step="1" min="${lim.min}" max="${lim.max}" required value="${value ?? ''}" aria-invalid="${errors[name] ? 'true' : 'false'}" aria-describedby="${describedBy(name, hint, errors[name])}">`,
});
const amountField = (name, label, value, suffix, hint, errors) => field({
  name, label, suffix, hint, error: errors[name],
  control: h`<input class="inp num" id="r-${name}" name="${name}" type="text" inputmode="decimal" autocomplete="off" required value="${value ?? ''}" aria-invalid="${errors[name] ? 'true' : 'false'}" aria-describedby="${describedBy(name, hint, errors[name])}">`,
});
const check = (name, label, checked) => h`<label class="check" for="r-${name}"><input id="r-${name}" name="${name}" type="checkbox" ${checked ? 'checked' : ''}><span>${label}</span></label>`;
const lockedRow = (label, value) => h`<div class="rp-row locked"><dt class="rp-label">${label}</dt><dd class="rp-value muted">${value} ${lockPill}</dd></div>`;

export function renderEdit(d, draft, errorsIn) {
  const cur = d.redeem.currency;
  const sym = currencySymbol(cur).trim() || cur;
  const v = draft ?? currentValues(d);
  const L = d.limits;
  const errors = normaliseErrors(errorsIn);
  const e = errors.fields;
  return h`${head('Edit rules', `Amounts are in ${sym} (${cur}). You review every change before it is saved.`)}
  ${summary(errors)}
  <form data-form="rules-review" class="rp-form" novalidate>
    <section class="rp-card"><h3>Purchase earning</h3>
      <div class="rp-grid">
        <fieldset class="rp-group"><legend>Earn rate</legend>
          ${amountField('spend', `Spend (${sym})`, v.spend, sym, 'Customers earn the points in the next field for each amount spent.', e)}
          ${numberField('points', 'Points earned for that spend', v.points, L.points, 'points', null, e)}
        </fieldset>
        ${selectField('rounding', 'Rounding', ROUNDING, v.rounding, null, e)}
        ${selectField('basis', 'Calculated on', BASIS, v.basis, null, e)}
        ${selectField('taxHandling', 'Tax', TAX, v.taxHandling, null, e)}
      </div>
      <div class="rp-checks">${check('includeShipping', 'Shipping earns points', v.includeShipping)}${check('giftCardsEarn', 'Gift cards earn points', !v.excludeGiftCards)}</div>
    </section>
    <section class="rp-card"><h3>Redemption &amp; lifecycle</h3>
      <div class="rp-grid">
        <fieldset class="rp-group"><legend>Redemption rate</legend>
          ${numberField('pointsPerReward', 'Points for one reward', v.pointsPerReward, L.pointsPerReward, 'points', null, e)}
          ${amountField('rewardValue', `Reward value (${sym})`, v.rewardValue, sym, 'What that many points are worth as a discount.', e)}
        </fieldset>
        ${numberField('holdPeriodDays', `Holding period (days, 0 to ${L.holdPeriodDays.max})`, v.holdPeriodDays, L.holdPeriodDays, 'days', `0 means points are usable as soon as the worker activates them, within a minute. At most ${L.holdPeriodDays.max} days: Shopify lets this app read only the last 60 days of orders, and points unlock only after the order is read from Shopify when the hold ends.`, e)}
        ${numberField('codeValidDays', 'Reward code valid for (days)', v.codeValidDays, L.codeValidDays, 'days', '1 to 365 days after the code is issued.', e)}
      </div>
      <div class="rp-checks">${check('restoreRewardOnFullRefund', 'Return reward points when its order is fully refunded or cancelled', v.restoreRewardOnFullRefund)}${check('returnPointsOnCodeExpiry', 'Return points when an unused code expires', v.returnPointsOnCodeExpiry)}</div>
    </section>
    <section class="rp-card"><h3>Fixed in this version</h3>
      <dl class="rp-list">
        ${lockedRow('Campaign multipliers', d.program.campaignEnabled ? 'On (not used)' : 'Off')}
        ${lockedRow('Points expiry', d.program.expiryEnabled ? 'On (not used)' : 'Off')}
        ${lockedRow('When a return reverses points already spent', SHORTFALL[d.returns.shortfallPolicy] ?? d.returns.shortfallPolicy)}
      </dl>
    </section>
    <div class="rp-bar"><button class="btn small" type="submit">Review changes</button><button class="btn ghost small" type="button" data-act="rules-cancel">Cancel</button></div>
  </form>`;
}

// ---------- review ----------

export function renderReview(d, review, errorsIn) {
  const cur = d.redeem.currency;
  const errors = normaliseErrors(errorsIn);
  return h`${head('Review changes', 'Nothing is saved yet. Check the previous and new values.')}
  ${summary(errors)}
  <form data-form="rules-save" class="rp-form">
    <section class="rp-card"><h3>What will change</h3>
      <dl class="rp-list">
        ${review.changes.map((c) => h`<div class="rp-row"><dt class="rp-label">${c.label}</dt><dd class="rp-value"><span class="rp-prev">${showValue(c.field, c.previous, cur)}</span> <span class="rp-arrow" aria-label="becomes">→</span> <strong>${showValue(c.field, c.next, cur)}</strong></dd></div>`)}
      </dl>
    </section>
    ${review.notes.map((n) => h`<p class="muted rp-notes">${n}</p>`)}
    ${review.warnings.map((w) => h`<div class="warnbox" role="alert">${w}</div>`)}
    ${review.warnings.length ? h`<label class="check rp-ack" for="r-ack"><input id="r-ack" name="ack" type="checkbox" required><span>I understand and want to save these rules</span></label>` : ''}
    <div class="rp-bar"><button class="btn small" type="submit">Save rules</button><button class="btn ghost small" type="button" data-act="rules-back">Back to edit</button><button class="btn ghost small" type="button" data-act="rules-cancel">Cancel</button></div>
  </form>`;
}

// ---------- the page ----------

async function load(api) {
  const res = await api.get('rules');
  st.data = res.ok ? res.data : null;
  return res.ok;
}

/** Moves focus to the first field with an error, or to the summary. Called after a re-render. */
export function focusFirstError() {
  if (typeof document === 'undefined') return;
  const target = document.querySelector('[aria-invalid="true"]') || document.getElementById('rp-summary');
  if (target && typeof target.focus === 'function') target.focus();
}

const FORM_FIELDS = new Set(['spend', 'points', 'rounding', 'basis', 'taxHandling', 'includeShipping', 'excludeGiftCards', 'pointsPerReward', 'rewardValue', 'holdPeriodDays', 'codeValidDays', 'returnPointsOnCodeExpiry', 'restoreRewardOnFullRefund']);

export const rulesPage = {
  async render({ api }) {
    if (st.mode === 'view' || !st.data) {
      if (!(await load(api))) return h`<div class="err" role="alert">The rules could not be loaded.</div>`;
    }
    if (st.mode === 'edit' && st.data.configured) return renderEdit(st.data, st.draft, { general: st.error, fields: st.fieldErrors });
    if (st.mode === 'review' && st.data.configured && st.review) return renderReview(st.data, st.review, { general: st.error, fields: {} });
    st.mode = 'view';
    const out = renderRules(st.data);
    st.notice = null;
    return out;
  },
  act: {
    'rules-edit'(el, ctx) { Object.assign(st, { mode: 'edit', draft: null, error: null, fieldErrors: {} }); return ctx.rerender(); },
    'rules-cancel'(el, ctx) { Object.assign(st, { mode: 'view', draft: null, review: null, error: null, fieldErrors: {} }); return ctx.rerender(); },
    'rules-back'(el, ctx) { Object.assign(st, { mode: 'edit', error: null, fieldErrors: {} }); return ctx.rerender(); },
    'rules-goto'(el) {
      const target = typeof document !== 'undefined' ? document.getElementById(`r-${el.dataset.v}`) : null;
      if (target) target.focus();
    },
  },
  submit: {
    async 'rules-review'(form, ctx) {
      const current = currentValues(st.data);
      st.draft = readForm(form);
      st.error = null;
      st.fieldErrors = validateDraft(st.draft, st.data.limits);
      if (Object.keys(st.fieldErrors).length) { await ctx.rerender(); return focusFirstError(); }
      const changes = changedFields(st.draft, current);
      if (Object.keys(changes).length === 0) { st.error = 'Nothing was changed.'; await ctx.rerender(); return focusFirstError(); }
      const res = await ctx.api.post('rules/preview', { changes });
      if (!res.ok) {
        if (FORM_FIELDS.has(res.data.field)) st.fieldErrors = { [res.data.field]: res.data.message };
        else st.error = res.data.message || 'These rules were refused.';
        await ctx.rerender();
        return focusFirstError();
      }
      st.review = { ...res.data, payload: changes };
      st.mode = 'review';
      return ctx.rerender();
    },
    async 'rules-save'(form, ctx) {
      const res = await ctx.api.post('rules', { expected: st.review.expected, changes: st.review.payload, acknowledgeWarnings: Boolean(form.elements.ack?.checked) });
      if (!res.ok) {
        if (res.data.error === 'STALE_RULES') {
          Object.assign(st, { mode: 'view', draft: null, review: null, error: null, fieldErrors: {}, notice: res.data.message });
          return ctx.rerender();
        }
        if (res.data.error === 'WARNINGS_NOT_ACKNOWLEDGED') st.error = 'Tick the box to confirm you understand the warning.';
        else st.error = res.data.message || 'The rules were not saved.';
        await ctx.rerender();
        return focusFirstError();
      }
      Object.assign(st, { mode: 'view', draft: null, review: null, error: null, fieldErrors: {} });
      ctx.toast(res.data.changed === 0 ? 'Nothing to change: already saved.' : 'Rules saved.');
      return ctx.rerender();
    },
  },
};
