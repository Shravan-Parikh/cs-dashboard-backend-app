#!/usr/bin/env node
/**
 * refresh-cases.js — build the PIT / UPSI case-law corpus from SEBI orders.
 *
 *   node scripts/refresh-cases.js                  # 2015 → current year
 *   node scripts/refresh-cases.js --from 2020
 *   node scripts/refresh-cases.js --limit 15       # cap PDFs (quick smoke run)
 *   node scripts/refresh-cases.js --rederive       # re-run extraction only
 *
 * Writes src/data/cases/cases.json, which is committed for the same reasons as
 * the law corpus: Cloud Run's disk is ephemeral so the API must not scrape SEBI
 * to answer a request, and git gives us the version history for free.
 *
 * Runs from 2015 by default — the PIT Regulations 2015 are the operative code,
 * so orders under the 1992 regulations are of limited use to a CS today.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import {
  SEARCH_TERMS,
  discoverOrders,
  resolveOrderPdf,
  downloadPdf,
} from '../src/caseSources.js';
import { deriveMeta } from '../src/caseMeta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'data', 'cases');
const OUT = join(OUT_DIR, 'cases.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const START = Number(arg('from', 2015));
const END = Number(arg('to', new Date().getFullYear()));
const LIMIT = Number(arg('limit', 0));
/**
 * Recompute metadata from already-stored order text, without touching SEBI.
 * Extraction rules get refined often (order-type patterns, citation regexes),
 * and re-downloading 70 PDFs to test a regex change is both slow and rude.
 */
const REDERIVE = process.argv.includes('--rederive');

mkdirSync(OUT_DIR, { recursive: true });

/** Reuse what we already downloaded, so re-runs only fetch new orders. */
const existing = new Map();
if (existsSync(OUT)) {
  try {
    for (const c of JSON.parse(readFileSync(OUT, 'utf8')).cases || []) existing.set(c.url, c);
    console.log(`Existing corpus: ${existing.size} orders (unchanged ones are reused)`);
  } catch {
    /* start fresh */
  }
}

// ------------------------------------------------------- re-derive only
if (REDERIVE) {
  if (existing.size === 0) {
    console.error('Nothing stored yet — run a full refresh first.');
    process.exit(1);
  }
  const rebuilt = [...existing.values()].map((c) => ({
    ...c,
    ...deriveMeta({ title: c.title, url: c.url, text: c.text || '' }),
  }));
  rebuilt.sort(
    (a, b) => (b.period || '').localeCompare(a.period || '') || a.title.localeCompare(b.title),
  );
  const prevJson = JSON.parse(readFileSync(OUT, 'utf8'));
  writeFileSync(
    OUT,
    JSON.stringify({ ...prevJson, builtAt: new Date().toISOString(), cases: rebuilt }, null, 1),
  );
  const byType = {};
  rebuilt.forEach((c) => (byType[c.orderTypeLabel] = (byType[c.orderTypeLabel] || 0) + 1));
  console.log(`Re-derived metadata for ${rebuilt.length} orders (no downloads).`);
  Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
  process.exit(0);
}

// ---------------------------------------------------------------- discovery
console.log(`\nDiscovering SEBI insider-trading orders, ${START}–${END}…`);
const discovered = new Map();
let capped = 0;

for (const term of SEARCH_TERMS) {
  process.stdout.write(`  "${term}" `);
  try {
    const { orders, cappedWindows } = await discoverOrders({
      term,
      startYear: START,
      endYear: END,
    });
    orders.forEach((o) => discovered.set(o.url, o));
    capped += cappedWindows;
    process.stdout.write(`→ ${orders.length} (running total ${discovered.size})\n`);
  } catch (e) {
    process.stdout.write(`→ failed: ${e.message}\n`);
  }
}

if (capped > 0) {
  console.log(
    `\n⚠️  ${capped} date window(s) still hit SEBI's 20-row cap after splitting — ` +
      `some orders in those windows are not listed.`,
  );
}

const targets = [...discovered.values()];
console.log(`\n${targets.length} orders discovered.`);

// ------------------------------------------------------------ fetch + parse
async function extract(buf) {
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await p.getText();
    return { text: r.text, pages: r.pages?.length ?? 0 };
  } finally {
    await p.destroy().catch(() => {});
  }
}

const cases = [];
let fetched = 0;
let reused = 0;
let failed = 0;
const todo = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;

for (let i = 0; i < todo.length; i++) {
  const { url, title } = todo[i];
  const prev = existing.get(url);
  if (prev?.text) {
    cases.push(prev);
    reused++;
    continue;
  }

  process.stdout.write(`  [${i + 1}/${todo.length}] ${title.slice(0, 66)}… `);
  try {
    const pdfUrl = await resolveOrderPdf(url);
    if (!pdfUrl) throw new Error('no PDF on the order page');
    const buf = await downloadPdf(pdfUrl);
    const { text, pages } = await extract(buf);
    if (text.trim().length < 400) throw new Error('PDF has no extractable text (likely a scan)');

    const meta = deriveMeta({ title, url, text });
    cases.push({
      id: createHash('sha1').update(url).digest('hex').slice(0, 16),
      title,
      url,
      pdfUrl,
      pages,
      sha256: createHash('sha256').update(buf).digest('hex'),
      fetchedAt: new Date().toISOString(),
      chars: text.length,
      text,
      ...meta,
    });
    fetched++;
    process.stdout.write(`✓ ${pages}p\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`✗ ${e.message}\n`);
  }
}

cases.sort((a, b) => (b.period || '').localeCompare(a.period || '') || a.title.localeCompare(b.title));

writeFileSync(
  OUT,
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      range: { from: START, to: END },
      searchTerms: SEARCH_TERMS,
      discovered: targets.length,
      cappedWindows: capped,
      count: cases.length,
      cases,
    },
    null,
    1,
  ),
);

const withPenalty = cases.filter((c) => c.penaltyDetected).length;
console.log(
  `\n✓ ${OUT}\n` +
    `  ${cases.length} orders (${fetched} newly fetched, ${reused} reused, ${failed} failed)\n` +
    `  ${withPenalty} with a detected penalty · ` +
    `${new Set(cases.flatMap((c) => c.citations)).size} distinct citations`,
);
process.exit(cases.length === 0 ? 1 : 0);
