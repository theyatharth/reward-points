// test/loyalty/config-constraints.test.js
//
// Migration 3 adds two CHECK constraints to LoyaltyConfig. config.js validates
// the same rules in code; these tests prove the database refuses bad rows even
// if something bypasses validateConfig (a script, a hand-run SQL statement).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '../../web/lib/prisma.js';

describe('LoyaltyConfig CHECK constraints (migration 3)', () => {
  const newShop = () => `cfgcheck-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  after(async () => {
    await prisma.$disconnect();
  });

  test('spendAmountPaise must be positive', async () => {
    for (const bad of [0, -100]) {
      await assert.rejects(
        prisma.loyaltyConfig.create({ data: { shop: newShop(), spendAmountPaise: bad } }),
        /LoyaltyConfig_spendAmountPaise_positive|check constraint/i,
        `spendAmountPaise ${bad} must be refused`
      );
    }
  });

  test('earnBasis must be after_discount or before_discount', async () => {
    await assert.rejects(
      prisma.loyaltyConfig.create({ data: { shop: newShop(), earnBasis: 'proportional' } }),
      /LoyaltyConfig_earnBasis_valid|check constraint/i
    );
    for (const ok of ['after_discount', 'before_discount']) {
      const row = await prisma.loyaltyConfig.create({ data: { shop: newShop(), earnBasis: ok } });
      assert.strictEqual(row.earnBasis, ok);
    }
  });

  test('a minimal row gets the documented defaults', async () => {
    const row = await prisma.loyaltyConfig.create({ data: { shop: newShop() } });
    assert.strictEqual(row.spendAmountPaise, 100);
    assert.strictEqual(row.excludeGiftCards, true);
    assert.deepStrictEqual(row.excludedCollectionIds, []);
  });
});
