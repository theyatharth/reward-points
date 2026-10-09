/* rewards-client.js
 *
 * Shared browser code of the two theme blocks (floating widget, rewards page).
 *
 *  - talks to the app ONLY through the App Proxy path set in the block settings (the dev app answers on
 *    /apps/rewards-dev, production on /apps/rewards); the path is validated, never concatenated blindly;
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

  var DEFAULT_PROXY = '/apps/rewards';

  /** A proxy path from the theme settings, or the default if it does not look like /apps/<subpath>. */
  function safeProxyPath(value) {
    var v = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
    return /^\/apps\/[a-z0-9-]{1,60}$/.test(v) ? v : DEFAULT_PROXY;
  }

  function currencySymbol(code) {
    if (code === 'INR') return '₹';
    if (code === 'USD') return '$';
    return code ? code + ' ' : '';
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

  var api = {
    DEFAULT_PROXY: DEFAULT_PROXY,
    safeProxyPath: safeProxyPath,
    formatMoney: formatMoney,
    formatDate: formatDate,
    progress: progress,
    newKey: newKey,
    loadView: loadView,
    createRedeemer: createRedeemer,
    h: h,
    clear: clear,
    renderHistory: renderHistory,
    copyText: copyText,
  };
  root.EcoRewards = api;
})(typeof window !== 'undefined' ? window : globalThis);
