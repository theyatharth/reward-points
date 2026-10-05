// @ts-check
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { assertDbAllowed } from './db-guard.js';

// Guard: refuse connection to denied hosts and databases before creating the
// PrismaClient.  This runs at module-load time, so every script and server
// process that imports prisma.js is automatically covered.
const dbUrl = process.env.DATABASE_URL || '';
if (dbUrl) {
  assertDbAllowed(dbUrl);
}

// Singleton pattern: reuse the client across hot-reloads in dev
const globalForPrisma = /** @type {any} */ (global);

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
