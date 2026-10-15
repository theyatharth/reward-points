// web/admin/user-admin.js
//
// Operator actions on admin users, used by scripts/admin-user.mjs (which also refuses protected databases):
//   resetAdminPassword  a new random one-time password, must be changed at the next sign-in; the admin's sessions are ended
//   deleteAdmin         only for an admin who never did anything: the audit log is append-only, so an admin with audit rows is kept
//
// Nothing here prints or logs a password: the caller shows the one-time password once, to the terminal, and nowhere else.

import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/passwords.js';

export class AdminUserError extends Error {}

const findAdmin = (shop, email) => prisma.adminUser.findFirst({ where: { shop, email: { equals: String(email).trim(), mode: 'insensitive' } } });

/**
 * @returns {Promise<{ found: false } | { found: true, email: string, sessionsEnded: number, oneTimePassword: string }>}
 */
export async function resetAdminPassword({ shop, email }) {
  if (!shop || !email) throw new AdminUserError('--shop and --email are required');
  const admin = await findAdmin(shop, email);
  if (!admin) return { found: false };
  const oneTimePassword = randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(oneTimePassword);
  const mail = admin.email.toLowerCase();
  const sessionsEnded = await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: admin.id }, data: { passwordHash, mustChangePassword: true } });
    const ended = await tx.adminSession.deleteMany({ where: { userId: admin.id } });
    // A locked-out admin is unlocked too: the failed-attempt counters for this account (pinned and unpinned keys).
    await tx.adminLoginAttempt.deleteMany({ where: { key: { in: [`acct:${shop}:${mail}`, `acct:*:${mail}`] } } });
    // The audit row names the admin and the action. It carries no password and no hash.
    await tx.auditLog.create({ data: { shop, adminId: admin.id, action: 'admin_password_reset', detail: { via: 'operator script', sessionsEnded: ended.count } } });
    return ended.count;
  });
  return { found: true, email: admin.email, sessionsEnded, oneTimePassword };
}

/** @returns {Promise<{ deleted: number }>} */
export async function deleteAdmin({ shop, email }) {
  if (!shop || !email) throw new AdminUserError('--shop and --email are required');
  const admin = await findAdmin(shop, email);
  if (!admin) return { deleted: 0 };
  const rows = await prisma.auditLog.count({ where: { adminId: admin.id } });
  if (rows > 0) {
    throw new AdminUserError(`${admin.email} has ${rows} audit log row${rows === 1 ? '' : 's'}, and the audit log is append-only, so this admin cannot be deleted. Use "reset-password" instead (it ends their sessions and issues a new one-time password).`);
  }
  await prisma.adminUser.delete({ where: { id: admin.id } }); // their sessions go with them (cascade)
  return { deleted: 1 };
}
