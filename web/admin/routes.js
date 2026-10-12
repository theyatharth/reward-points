// web/admin/routes.js
//
// The data endpoints of the admin console: one JSON endpoint per view, all behind the admin session (router.js).
// Every response is built field by field in web/admin/data/*.js: no database row is ever passed through, and
// every query is scoped to the logged-in admin's shop.

import { overview } from './data/overview.js';
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
}
