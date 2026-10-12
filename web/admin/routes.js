// web/admin/routes.js
//
// The data endpoints of the admin console: one JSON endpoint per view. Every response is built field by
// field in web/admin/data/*.js (no database row is ever passed through). Added view by view.

export function registerDataRoutes(api) {
  api.get('/meta', (_req, res) => res.json({ ok: true }));
}
