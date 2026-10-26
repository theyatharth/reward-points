// web/admin/data/get-started.js: the "Get started" page (GET /admin/api/get-started, POST /admin/api/get-started/done).
//
// The steps to switch the program on in the shop's theme, with the links that open the right Shopify admin page. What the app can
// know on its own (the program is set up, the currency is supported) is marked done or blocked; what only the theme knows (the
// widget is on, the page exists) cannot be read without theme access, so those steps have no state: the merchant marks the whole
// page done. It is the first page a new shop sees: no setup-done mark and no order yet.

import { prisma } from '../../lib/prisma.js';
import { isTwoDecimalCurrency, unsupportedCurrencyReason } from '../../loyalty/rules/currency.js';
import { deepLinks } from '../deep-links.js';
import { iso } from './util.js';

/** True when the shop should land on "Get started": setup not marked done and no order has earned points yet. */
export async function shouldShowGetStarted(shop) {
  const [install, orders] = await Promise.all([
    prisma.shopInstall.findUnique({ where: { shop }, select: { setupDoneAt: true } }),
    prisma.loyaltyOrder.count({ where: { shop } }),
  ]);
  return !install?.setupDoneAt && orders === 0;
}

export async function getStarted({ shop, apiKey }) {
  const [config, install, orders] = await Promise.all([
    prisma.loyaltyConfig.findUnique({ where: { shop }, select: { programName: true, currency: true, holdPeriodDays: true } }),
    prisma.shopInstall.findUnique({ where: { shop }, select: { setupDoneAt: true } }),
    prisma.loyaltyOrder.count({ where: { shop } }),
  ]);
  const links = deepLinks({ shop, apiKey });
  const supported = config ? isTwoDecimalCurrency(config.currency) : true;
  const name = config?.programName ?? 'Reward Points';

  const steps = [
    {
      id: 'program',
      title: config ? 'Your rewards program is ready' : 'Your rewards program is being set up',
      text: !config
        ? 'It is created from your shop currency the first time this console opens. Reload this page in a moment; if it stays like this, contact support.'
        : !supported
          ? `${unsupportedCurrencyReason(config.currency)}. Rewards stay switched off for this shop.`
          : `"${name}" runs in ${config.currency}: customers earn points on paid orders and points can be used after ${config.holdPeriodDays} days. You can change the name and the rules on the Rules page.`,
      state: !config ? 'waiting' : supported ? 'done' : 'blocked',
      links: [{ id: 'rules', label: 'Review the rules', kind: 'console', target: 'rules' }],
    },
    {
      id: 'embed',
      title: 'Turn on the Rewards widget in your theme',
      text: 'Opens the theme editor on App embeds. Switch on "Floating Rewards Widget" and save. It adds the small rewards button to every page.',
      state: 'manual',
      links: [{ id: 'activateEmbed', label: 'Open the theme editor', kind: 'external', url: links.activateEmbed }],
    },
    {
      id: 'page',
      title: 'Create a Rewards page',
      text: `Add a page titled "Rewards" (its address will be ${new URL(links.storefrontPage).pathname}). Customers reach it from the widget.`,
      state: 'manual',
      links: [{ id: 'newPage', label: 'Create the page', kind: 'external', url: links.newPage }],
    },
    {
      id: 'block',
      title: 'Add the Rewards block to that page',
      text: 'Opens the theme editor on the page template with the "Rewards Page Dashboard" block. Save it. If the editor opens without the block, choose Add section > Apps > Rewards Page Dashboard yourself, then preview the Rewards page.',
      state: 'manual',
      links: [{ id: 'addPageBlock', label: 'Add the block', kind: 'external', url: links.addPageBlock }],
    },
    {
      id: 'check',
      title: 'Check it',
      text: 'Open the Rewards page on your shop, then place a test order and mark it paid: points appear under Customers within a minute, as pending until the holding period ends.',
      state: 'manual',
      links: [{ id: 'storefrontPage', label: 'Open the Rewards page', kind: 'external', url: links.storefrontPage }, { id: 'customers', label: 'See customers', kind: 'console', target: 'customers' }],
    },
  ];
  return { shop, steps, done: Boolean(install?.setupDoneAt), doneAt: iso(install?.setupDoneAt), ordersSeen: orders, note: 'These links open the Shopify theme editor. Shopify may open it without selecting the block: the steps above say what to pick by hand.' };
}

/** Marks "Get started" done for the shop. Audited once; repeating it changes nothing. */
export async function markSetupDone({ shop, adminId = null, shopifyUserId = null }) {
  const row = await prisma.shopInstall.findUnique({ where: { shop }, select: { setupDoneAt: true } });
  if (row?.setupDoneAt) return { already: true };
  await prisma.$transaction([
    prisma.shopInstall.upsert({ where: { shop }, create: { shop, setupDoneAt: new Date() }, update: { setupDoneAt: new Date() } }),
    prisma.auditLog.create({ data: { shop, adminId, shopifyUserId, action: 'setup_done', detail: {} } }),
  ]);
  return { already: false };
}
