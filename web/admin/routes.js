// web/admin/routes.js
//
// The data endpoints of the admin console: one JSON endpoint per view, all behind the admin session (router.js).
// Every response is built field by field in web/admin/data/*.js: no database row is ever passed through, and
// every query is scoped to the logged-in admin's shop.

import { overview } from './data/overview.js';

/** Wraps an async handler so a thrown error reaches the router's error handler. */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export function registerDataRoutes(api) {
  api.get('/meta', (_req, res) => res.json({ ok: true }));
  api.get('/overview', route(async (req, res) => res.json({ ok: true, ...(await overview(req.admin.shop)) })));
}
