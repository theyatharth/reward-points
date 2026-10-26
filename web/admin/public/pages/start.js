// Get started: the steps to switch the program on in the theme, each with a link that opens the right Shopify admin page.
// The URLs come from the server (web/admin/deep-links.js) and are never put in an attribute: a click on a button asks
// openLink() to open one, and it opens only an https address on the shop's own domain, in a new tab.

import { h } from '../esc.js';

const st = { links: new Map(), shopHost: null };

/** True for an https address on the shop's own domain: the only kind of link this page opens. */
export const safeLink = (url, shopHost) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && Boolean(shopHost) && u.hostname === shopHost && u.username === '' && u.password === '';
  } catch {
    return false;
  }
};

const STATE = { done: 'Done', blocked: 'Needs attention', waiting: 'Setting up', manual: '' };

export function renderStart(d) {
  st.shopHost = d.shop;
  st.links = new Map();
  d.steps.forEach((s) => s.links.forEach((l) => { if (l.kind === 'external') st.links.set(`${s.id}.${l.id}`, l.url); }));
  return h`<div><h2>Get started</h2><p class="lede">Four short steps put the rewards widget and the Rewards page on your shop. Everything else (earning, redeeming, the ledger) already works.</p></div>
  <ol class="gs-steps">
    ${d.steps.map((s, i) => h`<li class="card gs-step gs-${s.state}"><div class="gs-n" aria-hidden="true">${i + 1}</div>
      <div class="gs-body"><h3>${s.title}${STATE[s.state] ? h` <span class="gs-pill gs-pill-${s.state}">${STATE[s.state]}</span>` : ''}</h3>
        <p class="muted">${s.text}</p>
        <div class="flex">${s.links.map((l) => (l.kind === 'external'
          ? h`<button class="btn small" type="button" data-act="gs-open" data-v="${s.id + '.' + l.id}">${l.label}</button>`
          : h`<button class="btn ghost small" type="button" data-act="gs-go" data-v="${l.target}">${l.label}</button>`))}</div>
      </div></li>`)}
  </ol>
  <p class="faint fs-sm">${d.note}</p>
  <div class="flex">${d.done
    ? h`<span class="muted">Marked done. This page stays here under "Get started" if you need the links again.</span>`
    : h`<button class="btn" type="button" data-act="gs-done">I have done these steps</button><span class="muted">${d.ordersSeen ? 'Orders are already earning points.' : 'Until you do, or until the first order arrives, the console opens on this page.'}</span>`}</div>`;
}

export const startPage = {
  async render(ctx) {
    const res = await ctx.api.get('get-started');
    if (!res.ok) return h`<div class="err" role="alert">This page could not be loaded.</div>`;
    return renderStart(res.data);
  },
  act: {
    'gs-open'(el) {
      const url = st.links.get(el.dataset.v);
      if (url && safeLink(url, st.shopHost) && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
    },
    'gs-go'(el, ctx) { ctx.go(el.dataset.v); },
    async 'gs-done'(el, ctx) {
      const res = await ctx.api.post('get-started/done', {});
      ctx.toast(res.ok ? 'Marked as done.' : 'It could not be saved.');
      if (res.ok && ctx.refreshProgram) await ctx.refreshProgram();
      return ctx.rerender();
    },
  },
  submit: {},
};
