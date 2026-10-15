// web/admin/auth.js
//
// Authentication for the admin console (/admin), which lives OUTSIDE the Shopify iframe and has its own
// login. Everything here is server side:
//
//   * Passwords: argon2id (web/lib/passwords.js). A new admin has mustChangePassword = true: with the one-time
//     password the only things a session can do are read its own state, log out and change the password.
//   * Sessions: a random 256-bit token in an httpOnly, Secure, SameSite=Strict cookie scoped to the admin path.
//     The database stores only SHA-256(token), so a leaked table does not hand out sessions. Idle expiry 60
//     minutes (sliding), absolute expiry 8 hours. A password change revokes every other session of that admin.
//   * CSRF: the page gets a per-session token (SHA-256 of "csrf:" + the session token, so it cannot be computed
//     without the cookie) and must send it in X-CSRF-Token on every non-GET request; plus an Origin check
//     (a request carrying an Origin that is not this host is refused) and SameSite=Strict.
//   * Login rate limit: failed attempts are counted in Postgres per account (5 per 15 minutes) and per IP
//     (30 per 15 minutes); a blocked login is refused before the password is looked at.
//   * No timing or message difference between "no such admin" and "wrong password".
//   * Login, failed login, logout, password change and retries are written to the audit log.

import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { now } from '../loyalty/adapters/clock.js';
import { hashPassword, verifyPassword, passwordProblem } from '../lib/passwords.js';

export const COOKIE_NAME = 'rw_admin';
export const IDLE_MS = 60 * 60 * 1000;
export const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const LOGIN_WINDOW_MINUTES = 15;
export const ACCOUNT_FAILURE_LIMIT = 5;
export const IP_FAILURE_LIMIT = 30;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const csrfFor = (token) => sha256(`csrf:${token}`);
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---- cookies ----

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookieBase = (basePath) => `Path=${basePath}/admin; HttpOnly; Secure; SameSite=Strict`;
export const sessionCookie = (token, basePath) => `${COOKIE_NAME}=${token}; ${cookieBase(basePath)}`;
export const clearedCookie = (basePath) => `${COOKIE_NAME}=; ${cookieBase(basePath)}; Max-Age=0`;

// ---- request checks ----

/** A browser always sends Origin on a cross-site POST. If it is present it must be this host. */
export function originAllowed(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

export function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

// ---- failed-login counters ----

async function recordFailure(key) {
  await prisma.$executeRaw`
    INSERT INTO "AdminLoginAttempt" (id, "key", "count", "windowStart", "updatedAt")
    VALUES (${crypto.randomUUID()}, ${key}, 1, NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "AdminLoginAttempt"."windowStart" < NOW() - INTERVAL '15 minutes' THEN 1 ELSE "AdminLoginAttempt"."count" + 1 END,
      "windowStart" = CASE WHEN "AdminLoginAttempt"."windowStart" < NOW() - INTERVAL '15 minutes' THEN NOW() ELSE "AdminLoginAttempt"."windowStart" END,
      "updatedAt" = NOW()`;
}

/** { blocked, retryAfterSeconds } for a key and its limit, by the database clock window. */
async function blockState(key, limit) {
  const row = await prisma.adminLoginAttempt.findUnique({ where: { key } });
  if (!row) return { blocked: false };
  const windowEnd = row.windowStart.getTime() + LOGIN_WINDOW_MINUTES * 60 * 1000;
  if (row.count >= limit && windowEnd > Date.now()) return { blocked: true, retryAfterSeconds: Math.ceil((windowEnd - Date.now()) / 1000) };
  return { blocked: false };
}

const accountKey = (shop, email) => `acct:${shop}:${email}`;
const ipKey = (ip) => `ip:${ip}`;

// ---- audit ----

export const audit = (shop, adminId, action, detail) =>
  prisma.auditLog.create({ data: { shop, adminId: adminId ?? null, action, detail: detail ?? undefined } }).catch((err) => {
    console.error('[admin] audit write failed:', err.message);
  });

// ---- users and sessions ----

/** The shop the console serves: ADMIN_SHOP, or the only shop that has a loyalty config. */
export async function configuredShop() {
  if (process.env.ADMIN_SHOP) return process.env.ADMIN_SHOP;
  const shops = await prisma.loyaltyConfig.findMany({ select: { shop: true }, take: 2 });
  return shops.length === 1 ? shops[0].shop : null;
}

/** The admins an e-mail could be: the pinned shop's one, or every shop's (at most 5) when no shop is pinned. */
async function findAdmins(email, shopHint) {
  const emailMatch = { equals: email, mode: 'insensitive' };
  if (shopHint) {
    const one = await prisma.adminUser.findFirst({ where: { shop: shopHint, email: emailMatch } });
    return one ? [one] : [];
  }
  return prisma.adminUser.findMany({ where: { email: emailMatch }, take: 5 });
}

export const AMBIGUOUS_EMAIL_MESSAGE = 'This e-mail address is an admin of more than one shop, so it cannot sign in here. Ask for a different e-mail address for each shop.';

async function createSession(user, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  await prisma.adminSession.create({
    data: {
      userId: user.id,
      token: sha256(token),
      ip: clientIp(req),
      userAgent: String(req.get('user-agent') || '').slice(0, 200),
      createdAt: t,
      expiresAt: new Date(t.getTime() + IDLE_MS),
    },
  });
  await prisma.adminSession.deleteMany({ where: { expiresAt: { lt: t } } }); // opportunistic clean-up
  return token;
}

/** The session behind a cookie token, or null. Slides the idle expiry, never past the absolute one. */
export async function loadSession(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const session = await prisma.adminSession.findUnique({ where: { token: sha256(token) }, include: { user: true } });
  if (!session) return null;
  const t = now().getTime();
  const absoluteEnd = session.createdAt.getTime() + ABSOLUTE_MS;
  if (session.expiresAt.getTime() <= t || absoluteEnd <= t) {
    await prisma.adminSession.deleteMany({ where: { id: session.id } });
    return null;
  }
  await prisma.adminSession.update({ where: { id: session.id }, data: { expiresAt: new Date(Math.min(t + IDLE_MS, absoluteEnd)) } });
  return { session, user: session.user, token };
}

// ---- middleware ----

/** Requires a valid session cookie. Sets req.admin = { id, shop, email, mustChangePassword, csrf, sessionId }. */
export async function requireSession(req, res, next) {
  try {
    const found = await loadSession(parseCookies(req.get('cookie'))[COOKIE_NAME]);
    if (!found) return res.status(401).json({ ok: false, error: 'NOT_LOGGED_IN' });
    req.admin = {
      id: found.user.id, shop: found.user.shop, email: found.user.email,
      mustChangePassword: found.user.mustChangePassword, csrf: csrfFor(found.token), sessionId: found.session.id,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** On any request that is not a GET/HEAD: Origin must be this host and X-CSRF-Token must match the session's. */
export function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'BAD_ORIGIN' });
  if (!safeEqual(req.get('x-csrf-token') || '', req.admin.csrf)) return res.status(403).json({ ok: false, error: 'BAD_CSRF' });
  next();
}

/** While the one-time password is still in use, only the endpoints that let the admin fix that are open. */
export function requirePasswordChanged(req, res, next) {
  if (!req.admin.mustChangePassword) return next();
  return res.status(403).json({ ok: false, error: 'PASSWORD_CHANGE_REQUIRED' });
}

// ---- handlers ----

const DUMMY_HASH_PROMISE = hashPassword('not-a-real-admin-password');

export function loginHandler({ basePath }) {
  return async (req, res, next) => {
    try {
      if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'BAD_ORIGIN' });
      const { email, password } = req.body || {};
      if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 1024 || !email.trim()) {
        return res.status(400).json({ ok: false, error: 'INVALID_REQUEST' });
      }
      const mail = email.trim().toLowerCase();
      const shop = await configuredShop();
      const ip = clientIp(req);
      const keys = [[accountKey(shop ?? '*', mail), ACCOUNT_FAILURE_LIMIT], [ipKey(ip), IP_FAILURE_LIMIT]];

      for (const [key, limit] of keys) {
        const state = await blockState(key, limit);
        if (state.blocked) {
          res.set('Retry-After', String(state.retryAfterSeconds));
          return res.status(429).json({ ok: false, error: 'TOO_MANY_ATTEMPTS', retryAfterSeconds: state.retryAfterSeconds });
        }
      }

      const candidates = await findAdmins(mail, shop);
      const user = candidates.length === 1 ? candidates[0] : null;
      if (candidates.length > 1) {
        // The same e-mail in several shops: never guess which one. Say so clearly, but only to someone who knows the
        // password of at least one of them (a wrong password gets the usual answer, so this does not reveal who is an admin).
        let knows = false;
        for (const c of candidates) knows = (await verifyPassword(c.passwordHash, password)) || knows;
        if (knows) return res.status(409).json({ ok: false, error: 'AMBIGUOUS_ADMIN_EMAIL', message: AMBIGUOUS_EMAIL_MESSAGE });
      }
      const stored = user ? user.passwordHash : await DUMMY_HASH_PROMISE; // the same work whether or not the admin exists
      const good = await verifyPassword(stored, password);
      if (!user || !good) {
        for (const [key] of keys) await recordFailure(key);
        await audit(user?.shop ?? shop ?? 'unknown', user?.id ?? null, 'admin_login_failed', { ip });
        return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
      }

      await prisma.adminLoginAttempt.deleteMany({ where: { key: keys[0][0] } });
      const token = await createSession(user, req);
      await audit(user.shop, user.id, 'admin_login', { ip });
      res.set('Set-Cookie', sessionCookie(token, basePath));
      return res.json({ ok: true, mustChangePassword: user.mustChangePassword, csrfToken: csrfFor(token) });
    } catch (err) {
      next(err);
    }
  };
}

export function sessionHandler(req, res) {
  res.json({ ok: true, admin: { email: req.admin.email }, mustChangePassword: req.admin.mustChangePassword, csrfToken: req.admin.csrf });
}

export function logoutHandler({ basePath }) {
  return async (req, res, next) => {
    try {
      await prisma.adminSession.deleteMany({ where: { id: req.admin.sessionId } });
      await audit(req.admin.shop, req.admin.id, 'admin_logout', null);
      res.set('Set-Cookie', clearedCookie(basePath));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  };
}

export function changePasswordHandler() {
  return async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') return res.status(400).json({ ok: false, error: 'INVALID_REQUEST' });

      const key = accountKey(req.admin.shop, req.admin.email.toLowerCase());
      const state = await blockState(key, ACCOUNT_FAILURE_LIMIT);
      if (state.blocked) {
        res.set('Retry-After', String(state.retryAfterSeconds));
        return res.status(429).json({ ok: false, error: 'TOO_MANY_ATTEMPTS', retryAfterSeconds: state.retryAfterSeconds });
      }

      const user = await prisma.adminUser.findUnique({ where: { id: req.admin.id } });
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        await recordFailure(key);
        return res.status(400).json({ ok: false, error: 'WRONG_CURRENT_PASSWORD' });
      }
      const problem = passwordProblem(newPassword);
      if (problem) return res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: problem });
      if (newPassword === currentPassword) return res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: 'Choose a password you have not used for this account.' });

      await prisma.$transaction([
        prisma.adminUser.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false } }),
        prisma.adminSession.deleteMany({ where: { userId: user.id, id: { not: req.admin.sessionId } } }),
      ]);
      await audit(user.shop, user.id, 'admin_password_changed', null);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  };
}
