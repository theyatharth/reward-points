// test/loyalty/admin-rules-page.test.js
//
// The Rules page as an organised settings list (no database, no browser): view mode, edit mode and the review step render as cards of
// labelled rows, never KPI tiles; rows are in order; Yes/No are pills; errors sit next to their field and in a summary; hostile
// values are escaped; the stylesheet has the stacking breakpoint, a 15px value size and no literal colours (so the dark theme works).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderRules, renderEdit, renderReview, validateDraft, currentValues, focusFirstError, rulesPage } from '../../web/admin/public/pages/rules.js';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'admin', 'public', 'admin.css'), 'utf8');
const RULES_CSS = CSS.slice(CSS.indexOf('/* ---------- Rules page'));

const rule = (over = {}) => ({
  configured: true,
  earn: { spend: '100.00', points: 100, rounding: 'floor', basis: 'after_discount', taxHandling: 'inclusive', includeShipping: false, excludeGiftCards: true, excludedCollectionIds: ['900001', '900002'], ...over.earn },
  redeem: { pointsPerReward: 100, rewardValue: '10.00', currency: 'INR', codeValidDays: 90, holdPeriodDays: 0, ...over.redeem },
  returns: { shortfallPolicy: 'owe_only', restoreRewardOnFullRefund: true, returnPointsOnCodeExpiry: false, ...over.returns },
  program: { campaignEnabled: false, expiryEnabled: false, ledgerStartAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-12T10:00:00.000Z', ...over.program },
  limits: { points: { min: 1, max: 1000000 }, pointsPerReward: { min: 1, max: 1000000 }, holdPeriodDays: { min: 0, max: 365 }, codeValidDays: { min: 1, max: 365 }, spend: { min: '0.01', max: '1000000.00' }, rewardValue: { min: '0.01', max: '1000000.00' } },
});

const html = (fragment) => String(fragment);
const text = (fragment) => html(fragment).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const sections = (markup) => markup.split('<section class="rp-card">').slice(1).map((s) => ({
  title: (s.match(/<h3>(.*?)<\/h3>/) || [])[1],
  labels: [...s.matchAll(/<dt class="rp-label">([\s\S]*?)(?:<span class="rp-hint">[\s\S]*?<\/span>)?<\/dt>/g)].map((m) => m[1].trim().replace(/&#39;/g, "'")),
  html: s,
}));

describe('Rules page: view mode', () => {
  const view = html(renderRules(rule()));

  test('no KPI tiles anywhere on the page', () => {
    for (const markup of [view, html(renderEdit(rule(), null, null)), html(renderReview(rule(), { changes: [{ field: 'holdPeriodDays', label: 'Holding period (days)', previous: 30, next: 0 }], warnings: [], notes: [] }, null))]) {
      assert.ok(!/class="[^"]*\bkpis?\b/.test(markup), 'no element with class kpi or kpis');
    }
  });

  test('the title and the Edit rules button share one header row; the lede is one short sentence', () => {
    const head = view.match(/<div class="rp-head">([\s\S]*?)<\/div>\s*<p class="rp-strip"/)[1];
    assert.match(head, /<h2>Earning &amp; redemption rules<\/h2>/);
    assert.match(head, /data-act="rules-edit">Edit rules<\/button>/);
    assert.ok(head.indexOf('<h2>') < head.indexOf('Edit rules'), 'title first, button after it in the same row');
    const lede = head.match(/<p class="lede">(.*?)<\/p>/)[1];
    assert.equal((lede.match(/\./g) || []).length, 1, 'one sentence');
  });

  test('a summary strip built from the rule, with the shop symbol', () => {
    const strip = text(view.match(/<p class="rp-strip"[\s\S]*?<\/p>/)[0]);
    assert.equal(strip, '100 points per ₹100 · 100 points = ₹10 · points usable after 0 days · codes valid 90 days');
    const usd = text(html(renderRules(rule({ redeem: { currency: 'USD', holdPeriodDays: 30 } }))).match(/<p class="rp-strip"[\s\S]*?<\/p>/)[0]);
    assert.equal(usd, '100 points per $100 · 100 points = $10 · points usable after 30 days · codes valid 90 days');
  });

  test('three section cards, each a settings list with its rows in order', () => {
    const s = sections(view);
    assert.deepEqual(s.map((x) => x.title), ['Purchase earning', 'Redemption', 'Returns and shortfall']);
    assert.deepEqual(s[0].labels, ['Earn', 'Rounding', 'Calculated on', 'Tax', 'Shipping earns points', 'Gift cards earn points', 'Collections that don\'t earn']);
    assert.deepEqual(s[1].labels, ['Redemption rate', 'Holding period', 'Reward code valid for']);
    assert.deepEqual(s[2].labels, ['When a return reverses points already spent', 'Return reward points when its order is fully refunded or cancelled', 'Return points when an unused code expires']);
    for (const x of s) assert.match(x.html, /<dl class="rp-list">/);
  });

  test('every value sits in a value cell; the strings the earlier tests relied on are all there', () => {
    for (const t of ['100 points per ₹100', 'Proportional, round down', 'Product value after discounts', 'tax is taken out', '100 points = ₹10', '0 days', '90 days', '900001, 900002', 'not applied when points are earned', 'Edit rules', 'reward catalogue', 'before new points can be used', 'Recover from future points (after voiding unused reward codes)']) assert.ok(view.includes(t), t);
    assert.equal((view.match(/<dd class="rp-value/g) || []).length, 13, 'thirteen rows, thirteen values');
  });

  test('Yes and No are pills: olive for Yes, grey for No', () => {
    const [earning, , returns] = sections(view);
    const pills = (markup) => [...markup.matchAll(/<span class="rp-pill (yes|no)">(Yes|No)<\/span>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(pills(earning.html), [['no', 'No'], ['no', 'No']], 'shipping No; gift cards earn No (they are excluded)');
    assert.deepEqual(pills(returns.html), [['yes', 'Yes'], ['no', 'No']]);
    const flipped = sections(html(renderRules(rule({ earn: { includeShipping: true, excludeGiftCards: false }, returns: { returnPointsOnCodeExpiry: true, restoreRewardOnFullRefund: false } }))));
    assert.deepEqual(pills(flipped[0].html), [['yes', 'Yes'], ['yes', 'Yes']]);
    assert.deepEqual(pills(flipped[2].html), [['no', 'No'], ['yes', 'Yes']]);
    assert.ok(!/>(Yes|No)<\/dd>/.test(view), 'never bare text');
  });

  test('a long text value wraps in the value column; the note and the last-changed line sit under the cards', () => {
    const tail = view.slice(view.lastIndexOf('</section>'));
    assert.match(tail, /<div class="rp-note">/);
    assert.equal((tail.match(/<p class="muted">/g) || []).length, 2, 'a two-line muted note');
    assert.match(tail, /Not in this version/);
    assert.match(tail, /Last changed 12 Oct 2026/);
    assert.match(RULES_CSS, /\.rp-value\{[^}]*overflow-wrap:anywhere/);
  });

  test('"both are off" or "a flag is set": the note says what is true', () => {
    assert.match(view, /\(both are off\)/);
    assert.match(html(renderRules(rule({ program: { campaignEnabled: true } }))), /a flag is set in the database but nothing uses it/);
  });

  test('no collections: "None", and no hint', () => {
    const none = html(renderRules(rule({ earn: { excludedCollectionIds: [] } })));
    assert.match(none, /<dd class="rp-value">None<\/dd>/);
    assert.ok(!none.includes('not applied when points are earned'));
  });

  test('a shop with no rule says so', () => {
    assert.match(html(renderRules({ configured: false })), /no loyalty rule yet/);
  });

  test('hostile values are escaped everywhere', () => {
    const bad = '<img src=x onerror=alert(1)>';
    const markup = html(renderRules(rule({ earn: { rounding: bad, basis: bad, taxHandling: bad, excludedCollectionIds: [bad, '<script>alert(2)</script>'] }, returns: { shortfallPolicy: bad }, redeem: { currency: bad } })));
    assert.ok(!markup.includes('<img src=x') && !markup.includes('<script>alert'));
    assert.ok(markup.includes('&lt;img src=x'));
    assert.ok(!/\sstyle=/.test(markup));
  });
});

describe('Rules page: edit mode', () => {
  const d = rule();
  const edit = html(renderEdit(d, null, null));

  test('three section cards: earning, redemption, and what is fixed in this version', () => {
    const s = sections(edit);
    assert.deepEqual(s.map((x) => x.title), ['Purchase earning', 'Redemption &amp; lifecycle', 'Fixed in this version']);
  });

  test('a two-column field grid with the labels above the inputs and the hints below', () => {
    assert.match(RULES_CSS, /\.rp-grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    const hold = edit.match(/<div class="rp-field[^"]*"><label for="r-holdPeriodDays">[\s\S]*?<\/div>\s*<p class="rp-hint"[\s\S]*?<\/p><\/div>/)[0];
    assert.ok(hold.indexOf('<label') < hold.indexOf('<input'), 'label above the input');
    assert.ok(hold.indexOf('<input') < hold.indexOf('class="rp-hint"'), 'hint below the input');
    assert.match(hold, /aria-describedby="r-holdPeriodDays-hint"/);
  });

  test('"spend + points" and "redemption points + value" are groups; units are suffix text', () => {
    const groups = [...edit.matchAll(/<fieldset class="rp-group"><legend>(.*?)<\/legend>([\s\S]*?)<\/fieldset>/g)];
    assert.deepEqual(groups.map((g) => g[1]), ['Earn rate', 'Redemption rate']);
    assert.ok(groups[0][2].includes('name="spend"') && groups[0][2].includes('name="points"'));
    assert.ok(groups[1][2].includes('name="pointsPerReward"') && groups[1][2].includes('name="rewardValue"'));
    const suffixes = [...edit.matchAll(/<span class="rp-suffix">(.*?)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(suffixes, ['₹', 'points', 'points', '₹', 'days', 'days']);
  });

  test('locked items are muted read-only rows with a "locked" pill (campaigns, expiry, shortfall policy)', () => {
    const locked = sections(edit)[2];
    assert.deepEqual(locked.labels, ['Campaign multipliers', 'Points expiry', 'When a return reverses points already spent']);
    assert.equal((locked.html.match(/<span class="rp-pill lock">locked<\/span>/g) || []).length, 3);
    assert.ok(!/<input|<select/.test(locked.html), 'read-only: no controls');
    assert.equal((edit.match(/class="rp-row locked"/g) || []).length, 3);
  });

  test('a sticky action bar at the bottom with Review changes and Cancel', () => {
    const bar = edit.match(/<div class="rp-bar">([\s\S]*?)<\/div>\s*<\/form>/)[1];
    assert.match(bar, /type="submit">Review changes<\/button>/);
    assert.match(bar, /data-act="rules-cancel">Cancel<\/button>/);
    assert.match(RULES_CSS, /\.rp-bar\{[^}]*position:sticky;bottom:0/);
  });

  test('no errors: no summary, nothing marked invalid', () => {
    assert.ok(!edit.includes('rp-summary') && !edit.includes('aria-invalid="true"') && !edit.includes('rp-error'));
    assert.equal((edit.match(/aria-invalid="false"/g) || []).length, 9, 'every input and select says it is valid');
  });

  test('errors show next to the field and in a summary at the top', () => {
    const markup = html(renderEdit(d, null, { general: null, fields: { holdPeriodDays: 'Holding period (days): between 0 and 365.', spend: 'Spend: enter an amount such as 100 or 100.50.' } }));
    assert.equal((markup.match(/aria-invalid="true"/g) || []).length, 2);
    assert.match(markup, /<p class="rp-error" id="r-holdPeriodDays-err">Holding period \(days\): between 0 and 365\.<\/p>/);
    assert.match(markup, /aria-describedby="[^"]*r-holdPeriodDays-err/);
    assert.match(markup, /class="rp-field has-error"/);
    const sum = markup.match(/<div class="err rp-summary" id="rp-summary" role="alert" tabindex="-1">([\s\S]*?)<\/div>/)[1];
    assert.match(sum, /2 things need fixing/);
    assert.ok(markup.indexOf('rp-summary') < markup.indexOf('<form'), 'the summary is above the form');
    assert.deepEqual([...sum.matchAll(/data-act="rules-goto" data-v="(\w+)"/g)].map((m) => m[1]), ['holdPeriodDays', 'spend'], 'each summary line jumps to its field');
    assert.match(html(renderEdit(d, null, { fields: { spend: 'x' } })), /One thing needs fixing/);
  });

  test('a general message (not tied to a field) shows in the summary, and a plain string still works', () => {
    assert.match(html(renderEdit(d, null, { general: 'Nothing was changed.', fields: {} })), /id="rp-summary"[\s\S]*Nothing was changed\./);
    assert.match(html(renderEdit(d, null, 'Some message')), /Some message/);
  });

  test('hostile values and messages are escaped in the form', () => {
    const bad = '"><script>alert(1)</script>';
    const markup = html(renderEdit(d, { ...currentValues(d), spend: bad }, { general: bad, fields: { points: bad } }));
    assert.ok(!markup.includes('<script>alert'));
    assert.ok(markup.includes('&lt;script&gt;alert(1)'));
    assert.ok(!/\sstyle=/.test(markup));
  });
});

describe('Rules page: review step', () => {
  const d = rule();
  const review = { changes: [{ field: 'holdPeriodDays', label: 'Holding period (days)', previous: 0, next: 5 }, { field: 'rewardValue', label: 'Reward value', previous: '10.00', next: '500.00' }, { field: 'includeShipping', label: 'Shipping earns points', previous: false, next: true }], warnings: ['These rules give customers back about 500%.'], notes: ['Changes apply to new orders only.'] };
  const markup = html(renderReview(d, review, null));

  test('the same card style: previous -> new per row, with the shop symbol and pills for yes/no', () => {
    const [card] = sections(markup);
    assert.equal(card.title, 'What will change');
    assert.deepEqual(card.labels, ['Holding period (days)', 'Reward value', 'Shipping earns points']);
    assert.ok(card.html.includes('₹10') && card.html.includes('₹500'));
    assert.ok(/rp-prev">[\s\S]*?<span class="rp-pill no">No<\/span>[\s\S]*?<strong>[\s\S]*?<span class="rp-pill yes">Yes<\/span>/.test(card.html));
    assert.ok(/<span class="rp-prev">0<\/span> <span class="rp-arrow"[^>]*>→<\/span> <strong>5<\/strong>/.test(card.html));
  });

  test('warnings need a tick, and Save, Back and Cancel are in the sticky bar', () => {
    assert.match(markup, /<div class="warnbox" role="alert">These rules give customers back about 500%\.<\/div>/);
    assert.match(markup, /name="ack" type="checkbox" required/);
    const bar = markup.match(/<div class="rp-bar">([\s\S]*?)<\/div>\s*<\/form>/)[1];
    assert.match(bar, /Save rules<\/button>/);
    assert.match(bar, /data-act="rules-back">Back to edit<\/button>/);
    assert.match(bar, /data-act="rules-cancel">Cancel<\/button>/);
    assert.ok(!html(renderReview(d, { ...review, warnings: [] }, null)).includes('name="ack"'));
  });

  test('a save error shows in the summary; hostile text is escaped', () => {
    const bad = html(renderReview(d, review, { general: '<img src=x onerror=alert(1)>', fields: {} }));
    assert.match(bad, /id="rp-summary"/);
    assert.ok(!bad.includes('<img src=x'));
  });
});

describe('Rules page: the form checks, focus, and the stylesheet', () => {
  const limits = rule().limits;
  const ok = { spend: '100.00', rewardValue: '10', points: 100, pointsPerReward: 100, holdPeriodDays: 0, codeValidDays: 90 };

  test('a good draft has no errors', () => assert.deepEqual(validateDraft(ok, limits), {}));

  test('several problems are reported at once, each under its own field name', () => {
    const errors = validateDraft({ spend: 'abc', rewardValue: '0', points: null, pointsPerReward: 1.5, holdPeriodDays: 400, codeValidDays: 0 }, limits);
    assert.deepEqual(Object.keys(errors).sort(), ['codeValidDays', 'holdPeriodDays', 'points', 'pointsPerReward', 'rewardValue', 'spend']);
    assert.equal(errors.spend, 'Spend: enter an amount such as 100 or 100.50.');
    assert.equal(errors.holdPeriodDays, 'Holding period (days): between 0 and 365.');
    assert.equal(errors.points, 'Points earned: a whole number.');
    assert.equal(errors.rewardValue, 'Reward value: between 0.01 and 1000000.00.');
  });

  test('the limits are inclusive', () => {
    assert.deepEqual(validateDraft({ ...ok, holdPeriodDays: 365, codeValidDays: 1, spend: '0.01', rewardValue: '1000000.00' }, limits), {});
    assert.ok(validateDraft({ ...ok, holdPeriodDays: -1 }, limits).holdPeriodDays);
  });

  describe('focus moves to the first error', () => {
    let saved;
    beforeEach(() => { saved = globalThis.document; });
    afterEach(() => { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; });
    const fake = (invalid, summary) => ({ querySelector: (sel) => (sel === '[aria-invalid="true"]' ? invalid : null), getElementById: (id) => (id === 'rp-summary' ? summary : null) });

    test('the first field marked invalid, else the summary, else nothing happens', () => {
      const calls = [];
      const el = (name) => ({ focus: () => calls.push(name) });
      globalThis.document = fake(el('field'), el('summary'));
      focusFirstError();
      globalThis.document = fake(null, el('summary'));
      focusFirstError();
      globalThis.document = fake(null, null);
      assert.doesNotThrow(() => focusFirstError());
      delete globalThis.document;
      assert.doesNotThrow(() => focusFirstError());
      assert.deepEqual(calls, ['field', 'summary']);
    });

    test('a summary line jumps to its field', () => {
      const calls = [];
      globalThis.document = { getElementById: (id) => ({ focus: () => calls.push(id) }) };
      rulesPage.act['rules-goto']({ dataset: { v: 'holdPeriodDays' } });
      assert.deepEqual(calls, ['r-holdPeriodDays']);
    });
  });

  test('the stylesheet: labels 13px, values 15px and never larger, stacked under 720px, dividers, no literal colours (dark theme), no fixed widths', () => {
    assert.match(RULES_CSS, /\.rp-label\{[^}]*font-size:13px/);
    const sizes = [...RULES_CSS.matchAll(/\.rp-value[^{]*\{[^}]*font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length > 0 && sizes.every((n) => n <= 15), `value sizes ${sizes}`);
    assert.match(RULES_CSS, /\.rp-row\{[^}]*border-top:1px solid var\(--line\)/);
    assert.match(RULES_CSS, /@media \(max-width:720px\)\{[^@]*\.rp-row\{grid-template-columns:minmax\(0,1fr\)/);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(RULES_CSS) && !/rgba?\(/.test(RULES_CSS), 'every colour is a theme variable');
    assert.ok(!/[^-]width:\s*\d{3,}px/.test(RULES_CSS), 'no fixed pixel widths');
    for (const name of ['--olive-soft', '--surface-2', '--umber-soft', '--danger', '--line']) assert.ok(CSS.includes(`${name}:`), `${name} is defined for both themes`);
  });
});
