// Notifications: the design's aNotify, PARTLY available. This build writes three on-site notifications (points earned,
// points activated, reward redeemed) and this page is a read-only log of them. The design's per-channel switches, e-mail,
// WhatsApp, the other four message types and the outbox are not part of this version.

import { h } from '../esc.js';
import { P, DT } from '../format.js';

const st = { items: [], next: null, counts: {}, keep: false };
const LABEL = { points_earned: 'Points earned', points_activated: 'Points activated', reward_redeemed: 'Reward redeemed' };

export function renderNotifications({ items, next, counts }) {
  return h`<div><h2>Notifications</h2><p class="lede">On-site notifications the storefront shows to members: points earned, points activated and reward redeemed. This is a read-only log of what was sent.</p></div>
  <div class="kpis">${Object.entries(LABEL).map(([type, label]) => h`<div class="kpi"><span class="k">${label}</span><span class="v num">${P(counts[type] ?? 0)}</span></div>`)}</div>
  <div class="tbl-wrap"><table><thead><tr><th>Sent</th><th>Type</th><th>Customer</th><th>Message</th><th>Read</th></tr></thead><tbody>
    ${items.map((n) => h`<tr><td class="num nowrap">${DT(n.createdAt)}</td><td class="mono">${n.type}</td><td class="mono">${n.customerId}</td><td>${n.text}</td><td>${n.read ? 'Yes' : 'No'}</td></tr>`)}
    ${items.length ? '' : h`<tr><td colspan="5" class="muted">No notifications yet.</td></tr>`}
  </tbody></table></div>
  ${next ? h`<div><button class="btn ghost small" type="button" data-act="more">Load more</button></div>` : ''}
  <div class="card unavailable grid g6"><b class="h-head">Not available in this version</b>
    <p class="muted">Switching each message type on or off per channel, e-mail and WhatsApp delivery, the other message types in the design (reward unlocked, points expiring, bonus points, special campaign) and the outbox. Nothing sends e-mail or WhatsApp.</p></div>`;
}

async function first(ctx) {
  const res = await ctx.api.get('notifications?limit=25');
  st.items = res.ok ? res.data.notifications : [];
  st.next = res.ok ? res.data.nextCursor : null;
  st.counts = res.ok ? res.data.counts : {};
}

export const notificationsPage = {
  async render(ctx) {
    if (!st.keep) await first(ctx);
    st.keep = false;
    return renderNotifications({ items: st.items, next: st.next, counts: st.counts });
  },
  act: {
    async more(el, ctx) {
      const res = await ctx.api.get(`notifications?limit=25&cursor=${encodeURIComponent(st.next)}`);
      if (res.ok) { st.items = [...st.items, ...res.data.notifications]; st.next = res.data.nextCursor; }
      st.keep = true;
      return ctx.rerender();
    },
  },
  submit: {},
};
