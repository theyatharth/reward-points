// @ts-check
import { PrismaClient } from '../../prisma/generated/client/index.js';

// Singleton pattern: reuse the client across hot-reloads in dev
const globalForPrisma = /** @type {any} */ (global);

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
