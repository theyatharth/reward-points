// scripts/admin-user.mjs
//
// Manage AdminUser rows for the standalone /reward-points/admin UI.
//
// Subcommands:
//   create  --shop <domain> --email <email> [--password <pw>]
//             Creates an admin user. If --password is omitted, generates a
//             random one-time password and prints it (must be changed on first login).
//   delete  --shop <domain> --email <email>
//             Removes an admin user who never did anything. An admin with audit log rows cannot be deleted (the
//             log is append-only): use reset-password instead.
//   reset-password  --shop <domain> --email <email>
//             Sets a new random one-time password (must be changed at the next sign-in), ends the admin's sessions,
//             writes an 'admin_password_reset' audit row, and prints the password ONCE to the terminal.
//   list    --shop <domain>
//             Lists all admin users for the shop.
//
// Passwords are hashed with argon2 via @node-rs/argon2 (falls back to
// scrypt from node:crypto if the prebuilt binary is unavailable on the
// current architecture — see T0.5).
//
// Safety: refuses the production database (reward_points).

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: join(__dirname, '..', '.env') });
} catch { /* rely on env vars */ }

import { assertNotProtected } from '../web/lib/db-guard.js';
import { prisma } from '../web/lib/prisma.js';
import { resetAdminPassword, deleteAdmin, AdminUserError } from '../web/admin/user-admin.js';

assertNotProtected(process.env.DATABASE_URL || '');

// ---------------------------------------------------------------------------
// Password hashing — prefer argon2 prebuilt binary, fall back to scrypt
// ---------------------------------------------------------------------------
const scryptAsync = promisify(scrypt);

async function hashPassword(password) {
  try {
    // Try @node-rs/argon2 (prebuilt, fast, preferred per T0.5)
    const { hash } = await import('@node-rs/argon2');
    return await hash(password);
  } catch {
    // Fallback to scrypt from node:crypto
    const salt = randomBytes(16);
    const derived = /** @type {Buffer} */ (await scryptAsync(password, salt, 64));
    return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
  }
}

export async function verifyPassword(stored, candidate) {
  if (stored.startsWith('scrypt:')) {
    const [, saltHex, hashHex] = stored.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = /** @type {Buffer} */ (await scryptAsync(candidate, salt, 64));
    return timingSafeEqual(derived, expected);
  }
  // argon2 verify
  try {
    const { verify } = await import('@node-rs/argon2');
    return await verify(stored, candidate);
  } catch {
    return false;
  }
}

function generatePassword(length = 16) {
  return randomBytes(length).toString('base64url').slice(0, length);
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const subcommand = args[0];

function getArg(flag) {
  const eq = args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  if (eq) return eq;
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const SHOP  = getArg('--shop');
const EMAIL = getArg('--email');
const PASS  = getArg('--password');

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function cmdCreate() {
  if (!SHOP || !EMAIL) {
    console.error('Usage: node scripts/admin-user.mjs create --shop <domain> --email <email> [--password <pw>]');
    process.exit(1);
  }

  const password = PASS || generatePassword();
  const passwordHash = await hashPassword(password);

  const existing = await prisma.adminUser.findUnique({ where: { shop_email: { shop: SHOP, email: EMAIL } } });
  if (existing) {
    console.log(`[admin-user] User ${EMAIL} already exists for ${SHOP} (id: ${existing.id}). Use reset-password to issue a new one-time password.`);
    return;
  }

  const user = await prisma.adminUser.create({
    data: {
      shop: SHOP,
      email: EMAIL,
      passwordHash,
      mustChangePassword: true,
    },
  });

  console.log(`[admin-user] Created admin user:`);
  console.log(`  id:    ${user.id}`);
  console.log(`  shop:  ${user.shop}`);
  console.log(`  email: ${user.email}`);
  if (!PASS) {
    console.log(`  password (one-time, print once): ${password}`);
    console.log(`  ⚠️  This password will not be shown again. User must change it on first login.`);
  } else {
    console.log(`  password: (supplied via --password)`);
  }
}

async function cmdDelete() {
  if (!SHOP || !EMAIL) {
    console.error('Usage: node scripts/admin-user.mjs delete --shop <domain> --email <email>');
    process.exit(1);
  }
  const { deleted } = await deleteAdmin({ shop: SHOP, email: EMAIL });
  console.log(deleted === 0 ? `[admin-user] No user found for ${EMAIL} on ${SHOP}.` : `[admin-user] Deleted ${deleted} user(s) for ${EMAIL} on ${SHOP}.`);
}

async function cmdResetPassword() {
  if (!SHOP || !EMAIL) {
    console.error('Usage: node scripts/admin-user.mjs reset-password --shop <domain> --email <email>');
    process.exit(1);
  }
  const r = await resetAdminPassword({ shop: SHOP, email: EMAIL });
  if (!r.found) {
    console.log(`[admin-user] No admin found for ${EMAIL} on ${SHOP}. Nothing changed.`);
    return;
  }
  console.log(`[admin-user] Password reset for ${r.email} on ${SHOP}: ${r.sessionsEnded} session(s) ended, must change the password at the next sign-in.`);
  console.log(`  one-time password (shown once): ${r.oneTimePassword}`);
}

async function cmdList() {
  if (!SHOP) {
    console.error('Usage: node scripts/admin-user.mjs list --shop <domain>');
    process.exit(1);
  }

  const users = await prisma.adminUser.findMany({ where: { shop: SHOP }, orderBy: { createdAt: 'asc' } });
  if (users.length === 0) {
    console.log(`[admin-user] No admin users found for ${SHOP}.`);
    return;
  }
  console.log(`[admin-user] Admin users for ${SHOP}:`);
  for (const u of users) {
    console.log(`  ${u.email}  id=${u.id}  mustChangePassword=${u.mustChangePassword}  created=${u.createdAt.toISOString()}`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const COMMANDS = { create: cmdCreate, delete: cmdDelete, list: cmdList, 'reset-password': cmdResetPassword };

if (!subcommand || !COMMANDS[subcommand]) {
  console.error('Usage: node scripts/admin-user.mjs <create|delete|list|reset-password> [options]');
  console.error('  create --shop <domain> --email <email> [--password <pw>]');
  console.error('  delete --shop <domain> --email <email>');
  console.error('  list   --shop <domain>');
  console.error('  reset-password --shop <domain> --email <email>');
  process.exit(1);
}

COMMANDS[subcommand]()
  .catch((err) => {
    console.error(err instanceof AdminUserError ? `[admin-user] ${err.message}` : `[admin-user] Failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
