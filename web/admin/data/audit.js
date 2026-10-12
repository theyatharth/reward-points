// web/admin/data/audit.js: the Audit log view (GET /admin/api/audit?action=&cursor=&limit=).
//
// The design shows who, when, action, previous value, new value and reason. AuditLog.detail is free-form JSON
// written by many callers, so it is NEVER sent: describe() reads only the keys it knows for each action and builds
// the three display strings. An action it does not know shows dashes.

import { prisma } from '../../lib/prisma.js';
import { iso, limitOf, cursorOf } from './util.js';

const balance = (b) => (b && typeof b === 'object' ? `available ${b.available ?? '?'} · pending ${b.pending ?? '?'} · owed ${b.debt ?? '?'}` : '—');
const str = (v, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : '');

/** @returns {{ previous: string, next: string, reason: string, subject: string|null }} */
export function describe(action, detail) {
  const d = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
  const none = { previous: '—', next: '—', reason: '', subject: null };

  if (action === 'points_adjusted') {
    const sign = Number(d.points) > 0 ? '+' : '';
    return {
      previous: `${str(d.before?.available)} available`,
      next: `${str(d.after?.available)} available`,
      reason: `${str(d.reason)} (${sign}${str(d.points)}) — ${str(d.note)}`,
      subject: str(d.shopifyCustomerId) || null,
    };
  }
  if (action.startsWith('rebuild_cache')) {
    return { previous: balance(d.before), next: balance(d.after), reason: 'Rebuilt the cached balance from the lots and the ledger', subject: null };
  }
  if (action === 'event_retried') {
    return { previous: str(d.previousStatus) || '—', next: 'pending', reason: `${str(d.topic)}${d.orderRef ? ` · order ${str(d.orderRef)}` : ''}`, subject: null };
  }
  if (action.startsWith('reward_used_')) {
    const what = { reward_used_twice: 'A reward code was carried by a second order', reward_used_by_other_customer: 'A reward code was used by a different customer' }[action]
      ?? `A reward code was used after it was ${action.replace('reward_used_after_', '')}`;
    return { ...none, reason: `${what}${d.order || d.secondOrder ? ` · order ${str(d.order ?? d.secondOrder)}` : ''}` };
  }
  if (action === 'admin_login') return { ...none, reason: 'Signed in' };
  if (action === 'admin_logout') return { ...none, reason: 'Signed out' };
  if (action === 'admin_login_failed') return { ...none, reason: 'A sign-in attempt failed' };
  if (action === 'admin_password_changed') return { ...none, reason: 'Password changed' };
  return none;
}

export async function listAudit(shop, { action, cursor, limit } = {}) {
  const take = limitOf(limit, 25, 100);
  const filter = typeof action === 'string' && /^[a-z_:]{1,60}$/.test(action) ? { action } : {};
  const [rows, kinds] = await Promise.all([
    prisma.auditLog.findMany({
      where: { shop, ...filter },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursorOf(cursor) ? { cursor: { id: cursorOf(cursor) } } : {}),
      include: { admin: { select: { email: true } } },
    }),
    prisma.auditLog.groupBy({ by: ['action'], where: { shop }, _count: { _all: true }, orderBy: { action: 'asc' } }),
  ]);
  const page = rows.slice(0, take);
  return {
    entries: page.map((a) => ({
      id: a.id,
      createdAt: iso(a.createdAt),
      admin: a.admin?.email ?? 'system',
      action: a.action,
      ...describe(a.action, a.detail),
    })),
    nextCursor: rows.length > take ? rows[take].id : null,
    actions: kinds.map((k) => ({ action: k.action, count: k._count._all })),
  };
}
