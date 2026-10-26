/* rewards-client.js
 *
 * Shared browser code of the two theme blocks (floating widget, rewards page).
 *
 *  - talks to the app ONLY through the App Proxy path set in the block settings (the dev app answers on
 *    /apps/rewards-dev, public app on /apps/reward-points); the path is validated, never concatenated blindly;
 *  - sends no customer id: the backend takes the customer from Shopify's signed proxy request;
 *  - every redeem click carries an idempotency key, kept across a network error so a retry replays the
 *    same redemption instead of making a second one;
 *  - builds the page with createElement and textContent ONLY. No markup string is ever parsed, so nothing
 *    that comes from the server (labels, codes) or from a customer can run as markup.
 *
 * Plain ES5 so it runs in any storefront browser. Tested in Node (test/loyalty/widget-client.test.js).
 */
(function (root) {
  'use strict';

  var DEFAULT_PROXY = '/apps/reward-points';

  /** A proxy path from the theme settings, or the default if it does not look like /apps/<subpath>. */
  function safeProxyPath(value) {
    var v = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
    return /^\/apps\/[a-z0-9-]{1,60}$/.test(v) ? v : DEFAULT_PROXY;
  }

  /** A same-site path from a theme setting or Liquid URL ("/pages/rewards"), else the fallback. Never a scheme or a host. */
  function safePath(value, fallback) {
    var v = typeof value === 'string' ? value.trim() : '';
    return /^\/(?!\/)[A-Za-z0-9\-_\/.?=&%]{0,200}$/.test(v) ? v : fallback || null;
  }

  // The shop's currency symbol from its configured ISO code (same logic as web/loyalty/rules/currency.js; the theme
  // cannot import server modules, and test/loyalty/currency.test.js proves the copies agree). No code, no symbol.
  var symbolCache = {};
  function currencySymbol(code) {
    var c = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(c)) return '';
    if (symbolCache[c] === undefined) {
      var symbol = c;
      try {
        var parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: 'symbol' }).formatToParts(0);
        for (var i = 0; i < parts.length; i++) if (parts[i].type === 'currency') symbol = parts[i].value;
      } catch (e) { /* shown as the code */ }
      symbolCache[c] = /[A-Za-z]$/.test(symbol) ? symbol + ' ' : symbol;
    }
    return symbolCache[c];
  }
  function formatMoney(amount, currency) {
    return currencySymbol(currency) + String(amount).replace(/\.00$/, '');
  }
  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /** Progress toward the next reward from a /history view. `known` is false until the rule is known. */
  function progress(view) {
    var per = view && view.rule ? Number(view.rule.pointsPerReward) : 0;
    var available = view && view.balance ? Number(view.balance.available) || 0 : 0;
    if (!per || per < 1) return { known: false, pct: 0, needed: 0, ready: false };
    return { known: true, pct: Math.min(100, Math.floor((available * 100) / per)), needed: Math.max(0, per - available), ready: available >= per };
  }

  function newKey() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    var s = '';
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return 'k-' + s;
  }

  /** fetch + JSON. Resolves { ok, status, body } for ANY HTTP answer with a JSON body; rejects on network or non-JSON. */
  function request(fetchImpl, url, options) {
    return fetchImpl(url, options).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
    });
  }

  function loadView(proxyPath, fetchImpl) {
    return request(fetchImpl || root.fetch.bind(root), proxyPath + '/history', { credentials: 'same-origin' });
  }

  /**
   * One redeemer per page. run() performs a redeem and tells the caller what happened:
   *   { kind: 'success', body }   the code is ready
   *   { kind: 'creating', body }  accepted, the code is still being created (refresh in a moment)
   *   { kind: 'refused', body }   the server said no (not enough points, owed points, ...): body.message
   *   { kind: 'network' }         no usable answer: the SAME key is reused on the next run()
   */
  function createRedeemer(options) {
    var proxyPath = safeProxyPath(options && options.proxyPath);
    var fetchImpl = (options && options.fetchImpl) || (root.fetch && root.fetch.bind(root));
    var key = null;
    return {
      run: function () {
        if (!key) key = newKey();
        return request(fetchImpl, proxyPath + '/redeem', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify({ idempotencyKey: key }),
        }).then(function (res) {
          key = null; // any JSON answer settles this attempt; the next click is a new redemption
          if (res.body && res.body.success) return { kind: res.body.code ? 'success' : 'creating', body: res.body };
          return { kind: 'refused', body: res.body || {} };
        }, function () {
          return { kind: 'network' }; // keep the key: a retry must not redeem twice
        });
      },
      currentKey: function () { return key; },
    };
  }

  // ---- DOM helpers: textContent only ----

  function h(tag, className, text) {
    var n = root.document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** The history table, built from view.history. `cls` names the theme's own CSS classes. */
  function renderHistory(container, history, cls) {
    clear(container);
    var table = h('table', cls.table);
    if (!history || history.length === 0) {
      var emptyRow = h('tr');
      var cell = h('td', null, 'No reward history yet. Make a purchase to start earning!');
      cell.setAttribute('colspan', '3');
      cell.style.textAlign = 'center';
      cell.style.padding = '40px';
      emptyRow.appendChild(cell);
      var tbodyEmpty = h('tbody');
      tbodyEmpty.appendChild(emptyRow);
      table.appendChild(tbodyEmpty);
      container.appendChild(table);
      return;
    }
    var thead = h('thead');
    var headRow = h('tr');
    ['Date', 'Activity', 'Points'].forEach(function (t, i) {
      var th = h('th', null, t);
      if (i === 2) th.style.textAlign = 'right';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = h('tbody');
    history.forEach(function (e) {
      var tr = h('tr');
      tr.appendChild(h('td', null, formatDate(e.date)));
      tr.appendChild(h('td', null, e.label));
      var pts = Number(e.points) || 0;
      tr.appendChild(h('td', pts > 0 ? cls.plus : cls.minus, (pts > 0 ? '+' : '') + pts));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function copyText(text, done, fail) {
    var nav = root.navigator;
    if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).then(done, fail);
    else fail();
  }

  // ---- the design (docs/reference prototype: widgetView, rewardsScreen): icons and sections, DOM-built ----

  var SVGNS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    gift: [['path', 'M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9Z'], ['path', 'M3 7h18v4H3z'], ['path', 'M12 7v14'], ['path', 'M12 7c-1.5-3-5-3.5-5-1.2C7 7 9.5 7 12 7Zm0 0c1.5-3 5-3.5 5-1.2C17 7 14.5 7 12 7Z']],
    clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', 'M12 7v5l3 2']],
    bag: [['path', 'M5 8h14l-1 12H6L5 8Z'], ['path', 'M9 8V6a3 3 0 0 1 6 0v2']],
    spark: [['path', 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6']],
    ret: [['path', 'M9 14 4 9l5-5'], ['path', 'M4 9h11a5 5 0 0 1 0 10h-3']],
    tag: [['path', 'M3 12V4h8l10 10-8 8L3 12Z'], ['circle', { cx: 7.5, cy: 8.5, r: 1.3 }]],
    check: [['path', 'm5 12 5 5 9-10']],
    plus: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', 'M12 8v8M8 12h8']],
    minus: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', 'M8 12h8']],
  };
  function icon(name) {
    var svg = root.document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || ICONS.gift).forEach(function (shape) {
      var node = root.document.createElementNS(SVGNS, shape[0]);
      if (typeof shape[1] === 'string') node.setAttribute('d', shape[1]);
      else Object.keys(shape[1]).forEach(function (k) { node.setAttribute(k, String(shape[1][k])); });
      svg.appendChild(node);
    });
    return svg;
  }

  function P(n) { return (Math.round(Number(n) || 0)).toLocaleString('en-IN'); }
  function money(value, currency) {
    var n = Number(value);
    if (!isFinite(n)) return '';
    var c = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
    var text = Math.abs(n).toLocaleString(c === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-' : '') + currencySymbol(currency) + text;
  }
  function el(tag, className, text, children) {
    var n = h(tag, className, text);
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function button(className, text, onClick) {
    var b = h('button', className, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /** What the points are worth under the shop's single rule, from a /history view. */
  function pointsValue(view, points) {
    var rule = view && view.rule;
    if (!rule || !(rule.pointsPerReward > 0)) return null;
    return (Number(rule.rewardValue) * points) / rule.pointsPerReward;
  }
  /** How many whole rewards the available points buy (one redeem turns all of them into ONE code). */
  function rewardsAffordable(view) {
    var p = progress(view);
    return p.known ? Math.floor(view.balance.available / view.rule.pointsPerReward) : 0;
  }
  function hasActivity(view) {
    return !!(view && ((view.history && view.history.length) || (view.balance && (view.balance.available || view.balance.pending || view.balance.owed))));
  }

  function balanceCard(view) {
    var b = view.balance;
    var value = pointsValue(view, b.available);
    var big = el('div', 'big num', P(b.available), [el('small', null, 'points')]);
    return el('section', 'bal', null, [
      el('div', 'lbl', 'Available to use'),
      big,
      value === null ? null : el('span', 'val num', money(value.toFixed(2), view.rule.currency) + ' reward value'),
    ]);
  }
  function owedCard(view) {
    if (!(view.balance.owed > 0)) return null;
    var c = el('div', 'owed', null, [el('b', null, P(view.balance.owed) + ' points are being recovered'),
      root.document.createTextNode('A returned order reversed points you had already used on a reward. New points go toward this first, then your balance grows again. Rewards unlock once it\'s cleared.')]);
    c.setAttribute('role', 'status');
    return c;
  }
  function pendingCard(view) {
    var b = view.balance;
    if (!(b.pending > 0)) return null;
    var lots = view.pending || [];
    var first = lots[0];
    var value = pointsValue(view, b.pending);
    var rows = lots.map(function (l) { return el('div', 'row num', null, [el('span', null, P(l.points) + ' pts'), el('b', null, 'Available on ' + formatDate(l.availableOn))]); });
    var card = el('section', 'pend', null, [
      el('div', 'pend-top', null, [icon('clock'), el('div', null, null, [
        el('h4', 'num', P(b.pending) + ' points are on the way'),
        el('p', null, 'Earned from your recent purchases. They become available after the holding period' + (view.rule && view.rule.holdPeriodDays ? ' (' + view.rule.holdPeriodDays + ' days)' : '') + '.')])]),
      el('div', 'row-between', null, [
        value === null ? el('span') : el('b', 'num', money(value.toFixed(2), view.rule.currency) + ' future reward value'),
        first ? el('span', 'num', 'Next: ' + formatDate(first.availableOn)) : null]),
      rows.length ? el('div', 'rows', null, rows) : null,
    ]);
    card.setAttribute('aria-label', 'Pending points');
    return card;
  }

  var NOTE_ICON = { points_earned: 'bag', points_activated: 'check', reward_redeemed: 'gift' };
  function notesList(items) {
    return el('div', 'notes', null, items.map(function (n) {
      return el('div', 'earnline' + (n.read ? ' plain' : ''), null, [icon(NOTE_ICON[n.type] || 'check'), el('span', null, null, [el('b', null, n.read ? '' : 'New \u00B7 '), root.document.createTextNode(n.text)])]);
    }));
  }
  function notificationsSection(view) {
    var items = view.notifications && view.notifications.items;
    if (!items || !items.length) return null;
    return el('section', 'grid', null, [el('div', 'sec-h', null, [el('h3', null, 'Notifications')]), notesList(items.slice(0, 5))]);
  }
  function unreadCount(view) {
    return view && view.notifications ? Number(view.notifications.unread) || 0 : 0;
  }

  function codesSection(view, handlers) {
    var rewards = view.rewards || [];
    if (!rewards.length) return null;
    var list = rewards.map(function (r) {
      var copy = button('btn small', 'Copy', function () { handlers.onCopy(r.code, copy); });
      return el('div', 'ritem ready', null, [
        el('div', 'rv', money(r.value, view.rule.currency) + ' off'),
        el('div', 'rm', null, [el('b', 'mono', r.code), root.document.createTextNode('Use at checkout' + (r.expiresAt ? ' until ' + formatDate(r.expiresAt) : ''))]),
        copy]);
    });
    return el('section', 'grid', null, [el('div', 'sec-h', null, [el('h3', null, 'Ready to use')]), el('div', 'rlist', null, list)]);
  }

  /** The ONE reward card for our single rule: N whole rewards become one code worth N x the reward value. */
  function rewardCard(view, handlers) {
    var n = rewardsAffordable(view);
    if (n < 1 || view.balance.owed > 0) return null;
    var rule = view.rule;
    var total = Number(rule.rewardValue) * n;
    var btn = button('btn small', 'Redeem', function () { handlers.onRedeem(btn); });
    btn.id = 'ecrRedeem';
    var detail = n === 1 ? P(rule.pointsPerReward) + ' points' : P(n * rule.pointsPerReward) + ' points for ' + n + ' rewards in one code';
    return el('section', 'grid', null, [el('div', 'sec-h', null, [el('h3', null, 'Rewards you can use')]),
      el('div', 'rlist', null, [el('div', 'ritem', null, [el('div', 'rv', money(total.toFixed(2), rule.currency) + ' off'), el('div', 'rm', null, [el('b', null, detail), root.document.createTextNode('Becomes a one-time code for your account')]), btn])])]);
  }

  function goalCard(view) {
    var p = progress(view);
    if (!p.known || p.ready || view.balance.owed > 0) return null;
    var rule = view.rule;
    var bar = el('div', 'bar', null, [el('i')]);
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(rule.pointsPerReward));
    bar.setAttribute('aria-valuenow', String(view.balance.available));
    bar.setAttribute('aria-label', 'Progress to your next reward');
    bar.firstChild.style.width = Math.max(2, p.pct) + '%';
    var onTheWay = view.balance.pending >= p.needed && view.balance.pending > 0;
    var card = el('section', 'card goal', null, [
      el('span', 'eyebrow', 'Your next reward'),
      el('div', 'row-between', null, [el('span', 'gname', money(rule.rewardValue, rule.currency) + ' off'), el('span', 'faint num', P(rule.pointsPerReward) + ' points')]),
      bar,
      el('div', 'row-between', null, [el('span', 'muted num', 'You have ' + P(view.balance.available) + ' points'), el('span', 'togo num', P(p.needed) + ' points to go')]),
      onTheWay ? el('p', 'muted', 'Your ' + P(view.balance.pending) + ' points on the way will get you there once they\'re available.') : null,
    ]);
    card.setAttribute('aria-label', 'Your next reward');
    return card;
  }

  function waysToEarn(view) {
    var r = view.rule || {};
    var shop = r.earnPoints && r.earnSpend
      ? 'Earn ' + P(r.earnPoints) + ' points for every ' + money(r.earnSpend, r.currency) + ' spent on eligible products (after discounts). Gift cards don\'t earn.'
      : 'Earn points automatically on every eligible paid order. Gift cards don\'t earn.';
    return el('section', 'grid', null, [el('div', 'sec-h', null, [el('h3', null, 'Ways to earn')]), el('div', 'earn', null, [
      el('div', 'e', null, [icon('bag'), el('div', null, null, [el('b', null, 'Shop'), el('p', null, shop)])]),
      el('div', 'e', null, [icon('spark'), el('div', null, null, [el('b', null, 'Special bonuses'), el('p', null, 'Receive bonus points from selected promotions.')])]),
    ])]);
  }

  var KIND_ICON = { earned: 'bag', reversed: 'ret', redeemed: 'tag', returned: 'gift', bonus: 'spark', adjusted: 'plus', other: 'check' };
  function dayKey(iso) {
    try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); } catch (e) { return ''; }
  }
  function activitySection(view) {
    var items = view.history || [];
    if (!items.length) return null;
    var groups = [];
    items.forEach(function (e) {
      var k = dayKey(e.date);
      var g = groups[groups.length - 1];
      if (!g || g.k !== k) { g = { k: k, date: e.date, items: [] }; groups.push(g); }
      g.items.push(e);
    });
    var today = dayKey(new Date().toISOString());
    return el('section', 'grid', null, [el('div', 'sec-h', null, [el('h3', null, 'Activity')]), el('div', 'tl', null, groups.map(function (g) {
      return el('div', 'tl-day', null, [el('span', 'eyebrow', g.k === today ? 'Today' : formatDate(g.date))].concat(g.items.map(function (e) {
        var pts = Number(e.points) || 0;
        var ic = e.kind === 'adjusted' && pts < 0 ? 'minus' : KIND_ICON[e.kind] || 'check';
        return el('div', 'tl-item', null, [
          el('span', 'tl-ic', null, [icon(ic)]),
          el('div', 'tl-t', null, [el('b', null, e.label)]),
          el('div', 'tl-p', null, [el('b', 'num ' + (pts > 0 ? 'plus' : 'minus'), (pts > 0 ? '+' : '−') + P(Math.abs(pts)) + ' pts')]),
        ]);
      })));
    }))]);
  }

  function zeroState(view, handlers) {
    var r = view.rule || {};
    var text = r.earnPoints && r.earnSpend
      ? 'Earn points with eligible purchases and special bonuses. Every ' + money(r.earnSpend, r.currency) + ' you spend earns ' + P(r.earnPoints) + ' points, and ' + P(r.pointsPerReward) + ' points are worth ' + money(r.rewardValue, r.currency) + '.'
      : 'Earn points with eligible purchases and special bonuses.';
    return el('section', 'zero', null, [el('h2', null, 'Start earning ' + programName(view)), el('p', 'muted', text),
      r.pointsPerReward ? el('div', 'ladder', null, [el('div', null, null, [el('b', null, money(r.rewardValue, r.currency) + ' off'), el('span', 'muted num', P(r.pointsPerReward) + ' points')])]) : null,
      handlers.shopUrl ? (function () { var a = h('a', 'btn', 'Start Shopping'); a.setAttribute('href', handlers.shopUrl); return a; })() : null]);
  }

  /** What customers see the program called: the shop's name for it from /history, or "Reward Points" before it is known. */
  function programName(view) {
    var name = view && view.program && typeof view.program.name === 'string' ? view.program.name : '';
    return name || 'Reward Points';
  }

  /** A program name from a data attribute: text only, at most 40 characters, or "" (then "Reward Points" is used). */
  function cleanName(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  }

  /** Shown instead of balances when the server says the program does not run for this store (currency not supported). */
  function unavailableNote() {
    return el('p', 'muted', 'Rewards are not available in this store right now.');
  }

  /** The Rewards page body, in the prototype's order. `handlers`: onRedeem(button), onCopy(code, button), shopUrl. */
  function renderRewardsPage(container, view, handlers) {
    clear(container);
    if (view && view.unavailable) { container.appendChild(unavailableNote()); return; }
    var parts = hasActivity(view)
      ? [balanceCard(view), owedCard(view), pendingCard(view), notificationsSection(view), codesSection(view, handlers), rewardCard(view, handlers), goalCard(view), waysToEarn(view), activitySection(view)]
      : [zeroState(view, handlers), waysToEarn(view)];
    parts.forEach(function (n) { if (n) container.appendChild(n); });
  }

  /** The collapsed widget button label: "N pts", or "Rewards" while points are being recovered or unknown. */
  function widgetLabel(view) {
    if (!view || !view.balance || view.balance.owed > 0 || view.unavailable) return 'Rewards';
    return P(view.balance.available) + ' pts';
  }

  /** The expanded widget panel (widgetView): balance, value, next reward bar, pending, View Rewards. */
  function renderWidgetPanel(panel, view, handlers) {
    clear(panel);
    var add = function (n) { if (n) panel.appendChild(n); };
    if (!view) { // logged out
      add(el('h4', null, 'Join ' + (handlers.programName || 'Reward Points')));
      add(el('p', 'muted', 'Join our rewards program and earn points with every purchase.'));
      var login = h('a', 'btn small', 'Log In / Sign Up');
      login.setAttribute('href', handlers.loginUrl || '/account/login');
      add(login);
      return;
    }
    if (view.unavailable) { add(unavailableNote()); return; }
    if (!hasActivity(view)) {
      var r = view.rule || {};
      add(el('h4', null, 'Start earning ' + programName(view)));
      add(el('p', 'muted', r.earnPoints && r.earnSpend ? 'Earn ' + P(r.earnPoints) + ' points for every ' + money(r.earnSpend, r.currency) + ' on eligible purchases.' : 'Earn points on eligible purchases.'));
      if (handlers.shopUrl) { var a = h('a', 'btn small', 'Start Shopping'); a.setAttribute('href', handlers.shopUrl); add(a); }
      return;
    }
    var b = view.balance;
    var value = pointsValue(view, b.available);
    var p = progress(view);
    add(el('h4', null, 'Your ' + programName(view)));
    add(el('div', 'wbig num', P(b.available), [el('span', null, ' points')]));
    if (value !== null) add(el('span', 'pill st-Available', money(value.toFixed(2), view.rule.currency) + ' available'));
    if (b.owed > 0) add(el('p', 'minus', P(b.owed) + ' points being recovered from a return'));
    else if (p.known && p.ready) add(el('b', 'num', 'You can redeem ' + money((Number(view.rule.rewardValue) * rewardsAffordable(view)).toFixed(2), view.rule.currency) + ' now'));
    else if (p.known) {
      add(el('b', 'num', P(p.needed) + ' points to your next reward'));
      var bar = el('div', 'bar', null, [el('i')]);
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(view.rule.pointsPerReward));
      bar.setAttribute('aria-valuenow', String(b.available));
      bar.firstChild.style.width = Math.max(2, p.pct) + '%';
      add(bar);
    }
    if (b.pending > 0) add(el('p', 'muted num', P(b.pending) + ' more on the way'));
    var fresh = ((view.notifications && view.notifications.items) || []).filter(function (n) { return !n.read; }).slice(0, 2);
    if (fresh.length) add(notesList(fresh));
    var link = h('a', 'btn small', 'View Rewards');
    link.setAttribute('href', handlers.pageUrl || '/pages/rewards');
    add(link);
  }

  /**
   * Wires the Rewards page: loads /history, draws it, redeems, copies. Elements are passed in so this can be tested.
   * @param {{ body: Element, message: Element, title?: Element, proxyPath: string, shopUrl?: string, fetchImpl?: Function }} o
   *   title: the page heading, set to the program's name once /history has answered
   */
  function initPage(o) {
    var proxyPath = safeProxyPath(o.proxyPath);
    var redeemer = createRedeemer({ proxyPath: proxyPath, fetchImpl: o.fetchImpl });
    var state = { latest: null, busy: false };
    function say(text, cls) {
      clear(o.message);
      if (text) o.message.appendChild(h('div', cls, text));
    }
    function draw() {
      if (o.title) o.title.textContent = programName(state.latest);
      renderRewardsPage(o.body, state.latest, handlers);
      if (!state.markedRead && unreadCount(state.latest) > 0) {
        state.markedRead = true; // shown as "New" this time; read from now on
        request(o.fetchImpl || root.fetch.bind(root), proxyPath + '/notifications/read', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).catch(function () { state.markedRead = false; });
      }
    }
    function refresh() {
      return loadView(proxyPath, o.fetchImpl).then(function (res) {
        if (res.ok && res.body && res.body.success) { state.latest = res.body; draw(); return true; }
        throw new Error('bad answer');
      }).catch(function () {
        if (!state.latest) { clear(o.body); o.body.appendChild(h('p', 'muted', 'Your rewards could not be loaded right now. Please try again in a moment.')); }
        return false;
      });
    }
    var handlers = {
      shopUrl: safePath(o.shopUrl, null),
      onCopy: function (code, btn) {
        copyText(code, function () {
          btn.textContent = '✓ Copied!';
          root.setTimeout(function () { btn.textContent = 'Copy'; }, 2500);
        }, function () { say('Could not copy automatically. Your code: ' + code, 'err'); });
      },
      onRedeem: function (btn) {
        if (state.busy) return;
        state.busy = true;
        btn.disabled = true;
        btn.textContent = 'Generating code…';
        redeemer.run().then(function (r) {
          state.busy = false;
          if (r.kind === 'success') { say('Your reward code is ready: ' + r.body.code, 'ok'); return refresh(); }
          if (r.kind === 'creating') {
            say('Your reward is being prepared. It will appear here in a moment.', 'ok');
            root.setTimeout(refresh, 3000);
            root.setTimeout(refresh, 9000);
            return refresh();
          }
          say(r.kind === 'network' ? 'Network error. Please try again.' : (r.body && r.body.message) || 'Could not redeem right now.', 'err');
          return state.latest ? draw() : refresh();
        });
      },
    };
    return refresh().then(function () { return { refresh: refresh, state: state }; });
  }

  /**
   * Wires the floating widget: the button label, and the panel (drawn from /history when it opens).
   * @param {{ toggle: Element, label: Element, panel: Element, proxyPath: string, loggedIn: boolean, programName?: string, shopUrl?: string,
   *           pageUrl?: string, loginUrl?: string, fetchImpl?: Function }} o
   */
  function initWidget(o) {
    var proxyPath = safeProxyPath(o.proxyPath);
    var handlers = { shopUrl: safePath(o.shopUrl, null), pageUrl: safePath(o.pageUrl, '/pages/rewards'), loginUrl: safePath(o.loginUrl, '/account/login'), programName: cleanName(o.programName) };
    var state = { open: false, latest: null };
    function draw() {
      renderWidgetPanel(o.panel, o.loggedIn ? state.latest : null, handlers);
      if (state.latest) o.label.textContent = widgetLabel(state.latest);
      if (o.dot && state.latest) o.dot.hidden = !(unreadCount(state.latest) > 0 && !state.open);
    }
    function refresh() {
      if (!o.loggedIn) return Promise.resolve(false);
      return loadView(proxyPath, o.fetchImpl).then(function (res) {
        if (res.ok && res.body && res.body.success) { state.latest = res.body; draw(); return true; }
        return false;
      }, function () { return false; });
    }
    function setOpen(open) {
      state.open = open;
      if (o.dot && open) o.dot.hidden = true;
      o.panel.hidden = !open;
      o.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { if (state.latest || !o.loggedIn) draw(); refresh(); }
    }
    o.toggle.addEventListener('click', function () { setOpen(!state.open); });
    o.panel.hidden = true;
    var ready = refresh();
    return { setOpen: setOpen, refresh: refresh, state: state, ready: ready };
  }

  var api = {
    DEFAULT_PROXY: DEFAULT_PROXY,
    safeProxyPath: safeProxyPath,
    formatMoney: formatMoney,
    currencySymbol: currencySymbol,
    money: money,
    formatDate: formatDate,
    progress: progress,
    newKey: newKey,
    loadView: loadView,
    createRedeemer: createRedeemer,
    h: h,
    clear: clear,
    renderHistory: renderHistory,
    copyText: copyText,
    icon: icon,
    pointsValue: pointsValue,
    rewardsAffordable: rewardsAffordable,
    hasActivity: hasActivity,
    widgetLabel: widgetLabel,
    programName: programName,
    cleanName: cleanName,
    renderRewardsPage: renderRewardsPage,
    renderWidgetPanel: renderWidgetPanel,
    safePath: safePath,
    unreadCount: unreadCount,
    initPage: initPage,
    initWidget: initWidget,
  };
  root.EcoRewards = api;
})(typeof window !== 'undefined' ? window : globalThis);
