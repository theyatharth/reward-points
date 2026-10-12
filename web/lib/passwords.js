// web/lib/passwords.js
//
// Admin password hashing: argon2id through @node-rs/argon2, with the scrypt fallback format that
// scripts/admin-user.mjs writes ("scrypt:<salt hex>:<hash hex>") when the prebuilt binary is not
// available. verifyPassword reads either.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export async function hashPassword(password) {
  try {
    const { hash } = await import('@node-rs/argon2');
    return await hash(password);
  } catch {
    const salt = randomBytes(16);
    const derived = await scryptAsync(password, salt, 64);
    return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
  }
}

export async function verifyPassword(stored, candidate) {
  if (typeof stored !== 'string' || typeof candidate !== 'string') return false;
  if (stored.startsWith('scrypt:')) {
    const [, saltHex, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scryptAsync(candidate, Buffer.from(saltHex, 'hex'), 64);
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
  try {
    const { verify } = await import('@node-rs/argon2');
    return await verify(stored, candidate);
  } catch {
    return false;
  }
}

/** A new password must be a string of 12 to 200 characters. Returns an error message or null. */
export function passwordProblem(password) {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (/^(.)\1+$/.test(password)) return 'Do not repeat a single character.';
  return null;
}
