// web/admin/routes.js
//
// The data endpoints of the admin console: one JSON endpoint per view, all behind the admin session (router.js).
// Every response is built field by field in web/admin/data/*.js: no database row is ever passed through, and
// every query is scoped to the logged-in admin's shop.

import { overview } from './data/overview.js';
import { rules } from './data/rules.js';
import { lastReconciliation, runNow } from './data/reconciliation.js';
import { listAudit } from './data/audit.js';
import { listOrders, listEvents, retryEvent } from './data/orders.js';
import { searchCustomers, customerDetail, adjustCustomer, adjustMeta } from './data/customers.js';

/** Wraps an async handler so a thrown error reaches the router's error handler. */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export function registerDataRoutes(api) {
  api.get('/meta', (_req, res) => res.json({ ok: true, adjust: adjustMeta }));
  api.get('/overview', route(async (req, res) => res.json({ ok: true, ...(await overview(req.admin.shop)) })));

  api.get('/customers', route(async (req, res) => res.json({ ok: true, ...(await searchCustomers(req.admin.shop, req.query.query)) })));
  api.get('/customers/:id', route(async (req, res) => {
    if (!/^\d{1,20}$/.test(req.params.id)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const detail = await customerDetail(req.admin.shop, req.params.id, { cursor: req.query.cursor, limit: req.query.limit });
    return detail ? res.json({ ok: true, ...detail }) : res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  }));
  api.post('/customers/:id/adjust', route(async (req, res) => {
    if (!/^\d{1,20}$/.test(req.params.id)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const { status, body } = await adjustCustomer({ shop: req.admin.shop, adminId: req.admin.id, shopifyCustomerId: req.params.id, body: req.body });
    return res.status(status).json(body);
  }));

  api.get('/orders', route(async (req, res) => res.json({ ok: true, ...(await listOrders(req.admin.shop, { cursor: req.query.cursor, limit: req.query.limit })) })));
  api.get('/events', route(async (req, res) => res.json({ ok: true, ...(await listEvents(req.admin.shop, { status: req.query.status, topic: req.query.topic, cursor: req.query.cursor, limit: req.query.limit })) })));
  api.post('/events/:id/retry', route(async (req, res) => {
    const { status, body } = await retryEvent({ shop: req.admin.shop, adminId: req.admin.id, eventId: req.params.id });
    return res.status(status).json(body);
  }));

  api.get('/audit', route(async (req, res) => res.json({ ok: true, ...(await listAudit(req.admin.shop, { action: req.query.action, cursor: req.query.cursor, limit: req.query.limit })) })));

  api.get('/reconciliation', route(async (req, res) => res.json({ ok: true, ...(await lastReconciliation(req.admin.shop)) })));
  api.post('/reconciliation/run', route(async (req, res) => {
    const { status, body } = await runNow(req.admin.shop);
    return res.status(status).json(body);
  }));

  api.get('/rules', route(async (req, res) => res.json({ ok: true, ...(await rules(req.admin.shop)) })));
}
