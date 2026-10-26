// The console's pages, in the design's order. Pages that exist are real; the rest say what they would need.

import { unavailable } from './unavailable.js';
import { overviewPage } from './overview.js';
import { customersPage } from './customers.js';
import { ordersPage } from './orders.js';
import { auditPage } from './audit.js';
import { reconciliationPage } from './reconciliation.js';
import { rulesPage } from './rules.js';
import { notificationsPage } from './notifications.js';
import { dataRequestsPage } from './datarequests.js';

export const PAGES = [
  { key: 'overview', label: 'Overview', page: overviewPage },
  { key: 'customers', label: 'Customers', page: customersPage },
  { key: 'orders', label: 'Orders & webhooks', page: ordersPage },
  { key: 'rules', label: 'Earning & redemption', page: rulesPage },
  {
    key: 'rewards', label: 'Reward catalogue',
    page: unavailable({
      title: 'Reward catalogue',
      lede: 'The design lets a shop define several rewards (for example a small, a medium and a large reward, each with its own points, minimum cart, usage limit, eligible collections and validity).',
      needs: 'This version has ONE redemption rule per shop (points per reward and reward value, see Earning & redemption). A catalogue needs a reward table, per-reward codes and cart validation in the storefront and the checkout discount.',
    }),
  },
  { key: 'recon', label: 'Reconciliation', page: reconciliationPage },
  { key: 'notify', label: 'Notifications', page: notificationsPage },
  { key: 'audit', label: 'Audit log', page: auditPage },
  { key: 'data', label: 'Data requests', page: dataRequestsPage },
  {
    key: 'analytics', label: 'Analytics events',
    page: unavailable({
      title: 'Analytics events',
      lede: 'The design counts storefront and engine events (widget opened, reward viewed, points earned ...).',
      needs: 'No analytics events are collected: there is no event pipeline and no storefront tracking in this version.',
    }),
  },
];
