#!/usr/bin/env node
/**
 * sweep-cases.js — the coverage fix: enumerate every SEBI order in a window and
 * keep the ones whose *text* invokes the PIT Regulations.
 *
 *   node scripts/sweep-cases.js --from 2024 --to 2026
 *   node scripts/sweep-cases.js --from 2015 --to 2026     # full history (long)
 *   node scripts/sweep-cases.js --from 2026 --to 2026 --dry   # enumerate only
 *
 * Why this exists: SEBI's own search matches order *titles* only — searching
 * "Structured Digital Database", "Schedule B" or "window closure" returns
 * nothing, though all three appear in order bodies. So a PIT order titled
 * "Adjudication Order in respect of Mr X" is invisible to a title search, and
 * the only reliable test is the order's text.
 *
 * Enumerating is cheap (HTML); downloading is not (~1,000 orders a year). So a
 * title prefilter drops orders that clearly belong to another enforcement
 * domain, and everything else gets fetched and text-checked. The prefilter is
 * deliberately loose — it excludes, it does not select.
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { sweepAllOrders, resolveOrderPdf, downloadPdf, parseListedDate } from '../src/caseSources.js';
import { deriveMeta } from '../src/caseMeta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'data', 'cases');
const OUT = join(OUT_DIR, 'cases.json');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const FROM = Number(arg('from', 2024));
const TO = Number(arg('to', new Date().getFullYear()));
const DRY = process.argv.includes('--dry');
const MAX_FETCH = Number(arg('max', 0));

/** Titles that name a different enforcement domain outright. */
const NOT_PIT = new RegExp(
  [
    'research analyst', 'investment advis', 'unregistered advis',
    'stock broker', 'sub-broker', 'depository particip', 'merchant banker',
    'portfolio manag', 'mutual fund distributor', 'credit rating agency',
    'debenture trustee', 'registrar to an issue', 'share transfer agent',
    'collective investment', 'deemed public issue', 'illiquid stock option',
    'front running', 'algorit', 'GDR', 'IPO', 'buyback offer',
    'takeover of', 'delisting', 'non-compliance with.{0,30}LODR',
    'annual report.{0,20}non-submission', 'shareholding pattern.{0,20}non',
    'refund', 'recovery certificate', 'attachment of', 'demat account',
  ].join('|'),
  'i',
);

/** Titles that already announce a PIT case — no need to guess. */
const IS_PIT = /insider|\bPIT\b|unpublished price sensitive|\bUPSI\b/i;

/** Does the order text actually invoke the PIT Regulations? */
function citesPit(text) {
  const t = text.slice(0, 200_000);
  return (
    /Prohibition of Insider Trading\s*\)?\s*Regulations/i.test(t) ||
    /\bPIT Regulations\b/i.test(t) ||
    (/\binsider\b/i.test(t) && /regulation\s*[34]\s*\(/i.test(t))
  );
}

mkdirSync(OUT_DIR, { recursive: true });

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { cases: [] };
const existing = new Map((prev.cases || []).map((c) => [c.url, c]));
console.log(`Existing corpus: ${existing.size} orders\n`);

// ------------------------------------------------------------- enumerate
console.log(`Enumerating every SEBI order, ${FROM}–${TO}…`);
let swept = [];
let requests = 0;
for (let y = TO; y >= FROM; y--) {
  const r = await sweepAllOrders({ from: new Date(y, 0, 1), to: new Date(y, 11, 31) });
  swept.push(...r.orders);
  requests += r.requests;
  console.log(`  ${y}: ${r.orders.length} orders (${r.requests} requests)`);
}
const byUrl = new Map(swept.map((o) => [o.url, o]));
swept = [...byUrl.values()];
console.log(`\n${swept.length} distinct orders enumerated in ${requests} requests.`);

// -------------------------------------------------------------- prefilter
const known = swept.filter((o) => IS_PIT.test(o.title));
const excluded = swept.filter((o) => !IS_PIT.test(o.title) && NOT_PIT.test(o.title));
const candidates = swept.filter((o) => !IS_PIT.test(o.title) && !NOT_PIT.test(o.title));

console.log(
  `\n  ${known.length} titled as PIT (fetch)\n` +
    `  ${candidates.length} uninformative titles (fetch + text-check)\n` +
    `  ${excluded.length} clearly another domain (skipped)`,
);

if (DRY) {
  console.log('\n--dry: stopping before any download.');
  process.exit(0);
}

// ------------------------------------------------------ fetch + text-check
async function extract(buf) {
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await p.getText();
    return { text: r.text, pages: r.pages?.length ?? 0 };
  } finally {
    await p.destroy().catch(() => {});
  }
}

let todo = [...known, ...candidates].filter((o) => !existing.has(o.url));
if (MAX_FETCH > 0) todo = todo.slice(0, MAX_FETCH);
console.log(`\nFetching ${todo.length} orders not already in the corpus…`);

const added = [];
let checked = 0;
let rejected = 0;
let failed = 0;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < todo.length; i++) {
  const o = todo[i];
  const label = `[${i + 1}/${todo.length}]`;
  // Hundreds of multi-megabyte PDFs from a government site deserve a gap.
  if (i > 0) await pause(350);
  try {
    const pdfUrl = await resolveOrderPdf(o.url);
    if (!pdfUrl) throw new Error('no PDF');
    const buf = await downloadPdf(pdfUrl);
    const { text, pages } = await extract(buf);
    checked++;
    if (text.trim().length < 400) throw new Error('no text layer (scan)');

    if (!citesPit(text)) {
      rejected++;
      if (i % 25 === 0) process.stdout.write(`  ${label} … ${added.length} kept\n`);
      continue;
    }
    const listed = parseListedDate(o.listedDate);
    added.push({
      id: createHash('sha1').update(o.url).digest('hex').slice(0, 16),
      title: o.title,
      url: o.url,
      pdfUrl,
      pages,
      sha256: createHash('sha256').update(buf).digest('hex'),
      fetchedAt: new Date().toISOString(),
      chars: text.length,
      listedDate: listed ? listed.toISOString().slice(0, 10) : '',
      text,
      ...deriveMeta({ title: o.title, url: o.url, text }),
    });
    process.stdout.write(`  ${label} ✓ ${o.title.slice(0, 58)}\n`);
  } catch (e) {
    failed++;
  }
}

// ------------------------------------------------------------------ merge
const merged = [...existing.values()];
const have = new Set(merged.map((c) => c.url));
added.forEach((c) => !have.has(c.url) && merged.push(c));
merged.sort(
  (a, b) =>
    (b.orderDate || b.period || '').localeCompare(a.orderDate || a.period || '') ||
    a.title.localeCompare(b.title),
);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      ...prev,
      builtAt: new Date().toISOString(),
      range: { from: Math.min(FROM, prev.range?.from ?? FROM), to: Math.max(TO, prev.range?.to ?? TO) },
      discovery: 'sweep+text',
      swept: swept.length,
      excludedByTitle: excluded.length,
      textChecked: checked,
      count: merged.length,
      cases: merged,
    },
    null,
    1,
  ),
);

console.log(
  `\n✓ ${merged.length} orders in the corpus (was ${existing.size}, +${added.length})\n` +
    `  ${checked} PDFs text-checked · ${rejected} rejected as not PIT · ${failed} unreadable`,
);
