// The console's pages, in the design's order. Pages that exist are real; the rest say what they would need.

import { unavailable } from './unavailable.js';
import { overviewPage } from './overview.js';
import { customersPage } from './customers.js';
import { ordersPage } from './orders.js';
import { auditPage } from './audit.js';

const soon = (title) => unavailable({ title, lede: 'This page is being ported from the design.', needs: 'It arrives in the next step of the build.' });

export const PAGES = [
  { key: 'overview', label: 'Overview', page: overviewPage },
  { key: 'customers', label: 'Customers', page: customersPage },
  { key: 'orders', label: 'Orders & webhooks', page: ordersPage },
  { key: 'rules', label: 'Earning & redemption', page: soon('Earning & redemption rules') },
  {
    key: 'rewards', label: 'Reward catalogue',
    page: unavailable({
      title: 'Reward catalogue',
      lede: 'The design lets a shop define several rewards (₹10, ₹25, ₹50 ... each with its own points, minimum cart, usage limit, eligible collections and validity).',
      needs: 'This version has ONE redemption rule per shop (points per reward and reward value, see Earning & redemption). A catalogue needs a reward table, per-reward codes and cart validation in the storefront and the checkout discount.',
    }),
  },
  { key: 'recon', label: 'Reconciliation', page: soon('Reconciliation') },
  {
    key: 'notify', label: 'Notifications',
    page: unavailable({
      title: 'Notifications',
      lede: 'The design switches seven message types on or off for on-site, e-mail and WhatsApp, and lists an outbox.',
      needs: 'Nothing sends notifications yet. On-site notifications for points earned, activated and reward redeemed are planned (Task 9); e-mail and WhatsApp need a provider and are out of scope.',
    }),
  },
  { key: 'audit', label: 'Audit log', page: auditPage },
  {
    key: 'analytics', label: 'Analytics events',
    page: unavailable({
      title: 'Analytics events',
      lede: 'The design counts storefront and engine events (widget opened, reward viewed, points earned ...).',
      needs: 'No analytics events are collected: there is no event pipeline and no storefront tracking in this version.',
    }),
  },
];
