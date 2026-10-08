#!/usr/bin/env node
// scripts/export-webhook-payloads.mjs
//
// READ-ONLY export of stored webhook payloads as REDACTED candidate fixtures.
//
//   node scripts/export-webhook-payloads.mjs --topic orders/paid --limit 5 --out captures
//
//   --topic  slash form ("orders/paid") or enum form ("ORDERS_PAID"); omit for all topics
//   --limit  how many of the newest events (default 5, maximum 50)
//   --out    output directory, must be INSIDE the repository (default: captures)
//
// What it does and does not do:
//   * It only reads (one findMany on WebhookEvent). It writes no database row.
//   * The database is reached through web/lib/prisma.js, so the db-guard applies:
//     the production database and the other databases on that server are refused.
//   * Every payload is redacted (web/lib/redact-payload.js) BEFORE anything is
//     written. A raw payload is never written to disk and never printed.
//   * It prints file names, key counts and the PATHS (not values) of anything that
//     still looks personal. Review each file by eye before it becomes a fixture.
//   * Existing files are never overwritten.

import '../web/lib/load-env.js'; // first: prisma.js reads DATABASE_URL on import
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../web/lib/prisma.js';
import { assertNotProtected } from '../web/lib/db-guard.js';
import { TOPIC_MAP, normalizeTopic } from '../web/loyalty/service/topics.js';
import { redactPayload, findLeftovers } from '../web/lib/redact-payload.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LIMIT = 50;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const die = (msg) => { console.error('[export] ' + msg); process.exit(1); };

assertNotProtected(process.env.DATABASE_URL || '');

const topicArg = opt('--topic');
const limit = opt('--limit') === null ? 5 : Number(opt('--limit'));
if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) die(`--limit must be an integer from 1 to ${MAX_LIMIT}`);

const outDir = path.resolve(REPO_ROOT, opt('--out') || 'captures');
const rel = path.relative(REPO_ROOT, outDir);
if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) die('--out must be a directory inside the repository');

// Both stored forms of the topic: rows stored before the intake map hold the enum form.
let topics = null;
if (topicArg) {
  const slash = normalizeTopic(topicArg);
  topics = [slash, ...Object.keys(TOPIC_MAP).filter((k) => TOPIC_MAP[k] === slash)];
}

async function main() {
  const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1).split('?')[0];
  console.log(`[export] database: ${dbName} | topic: ${topicArg || '(all)'} | limit: ${limit} | out: ${rel}`);

  const events = await prisma.webhookEvent.findMany({
    where: topics ? { topic: { in: topics } } : {},
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, topic: true, payload: true, createdAt: true, shopifyWebhookId: true },
  });
  if (events.length === 0) { console.log('[export] no matching events'); return; }

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  let written = 0;
  for (const [i, ev] of events.entries()) {
    const redacted = redactPayload(ev.payload);
    const leftovers = findLeftovers(redacted);
    const file = path.join(outDir, `${normalizeTopic(ev.topic).replace('/', '-')}-${String(i + 1).padStart(2, '0')}-${ev.id.slice(0, 8)}.json`);
    const doc = {
      _exported: {
        note: 'Redacted export of a stored webhook payload: every key kept, personal and secret values replaced. Not a raw capture.',
        topic: normalizeTopic(ev.topic),
        receivedAt: ev.createdAt.toISOString(),
      },
      ...redacted,
    };
    try {
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err.code === 'EEXIST') { console.log(`[export] exists, not overwritten: ${path.relative(REPO_ROOT, file)}`); continue; }
      throw err;
    }
    written++;
    console.log(`[export] wrote ${path.relative(REPO_ROOT, file)} | top-level keys: ${Object.keys(redacted).length}`);
    for (const h of leftovers) console.log(`[export]   REVIEW ${h.path}: ${h.kind}`);
  }
  console.log(`[export] done: ${written} file(s) written, none overwritten, no database row changed`);
}

main()
  .catch((err) => { console.error('[export] failed:', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
