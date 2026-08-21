#!/usr/bin/env node
/**
 * refresh-law-corpus.js — rebuild the statutory corpus from SEBI.
 *
 *   node scripts/refresh-law-corpus.js              # all sources
 *   node scripts/refresh-law-corpus.js sebi-pit-regulations-2015
 *
 * Writes one JSON per document into src/data/law/, plus index.json. Those files
 * are committed, which is deliberate:
 *
 *   - Cloud Run's filesystem is ephemeral, so the API must not scrape SEBI on
 *     cold start just to answer a search.
 *   - "Version history" and "current effective version" — which the PIT spec
 *     asks for — come free from git: each refresh is a reviewable diff.
 *
 * Run it on a schedule (or by hand) and commit the result.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { SOURCES, resolveSource, downloadPdf } from '../src/lawSources.js';
import { chunkRegulation } from '../src/lawChunker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'data', 'law');

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = only.length ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;

if (targets.length === 0) {
  console.error('No matching sources. Known ids:');
  SOURCES.forEach((s) => console.error('  ' + s.id));
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

async function extractText(buf) {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await parser.getText();
    return { text: r.text, pages: r.pages?.length ?? 0 };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

const index = [];
let failed = 0;

for (const source of targets) {
  process.stdout.write(`\n▸ ${source.id}\n`);
  try {
    const { pageUrl, pdfUrl } = await resolveSource(source);
    console.log(`   page: ${pageUrl}`);
    console.log(`   pdf:  ${pdfUrl}`);

    const buf = await downloadPdf(pdfUrl);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const { text, pages } = await extractText(buf);
    const chunks = chunkRegulation(text, { docId: source.id });

    if (chunks.length === 0) throw new Error('chunker produced nothing — layout may have changed');

    const doc = {
      id: source.id,
      title: source.title,
      authority: source.authority,
      kind: source.kind,
      topics: source.topics,
      note: source.note || '',
      sourcePage: pageUrl,
      pdfUrl,
      pages,
      bytes: buf.length,
      sha256,
      fetchedAt: new Date().toISOString(),
      chars: text.length,
      chunkCount: chunks.length,
      chunks,
    };

    const file = join(OUT_DIR, `${source.id}.json`);
    // Report whether the underlying document actually changed.
    let changed = 'new';
    if (existsSync(file)) {
      try {
        const prev = JSON.parse(readFileSync(file, 'utf8'));
        changed = prev.sha256 === sha256 ? 'unchanged' : 'CHANGED';
      } catch {
        changed = 'new';
      }
    }
    writeFileSync(file, JSON.stringify(doc, null, 1));

    console.log(
      `   ${pages} pages · ${text.length.toLocaleString()} chars · ${chunks.length} chunks · ${changed}`,
    );
    index.push({
      id: doc.id,
      title: doc.title,
      authority: doc.authority,
      kind: doc.kind,
      topics: doc.topics,
      pages: doc.pages,
      chunkCount: doc.chunkCount,
      sha256,
      fetchedAt: doc.fetchedAt,
      sourcePage: pageUrl,
      pdfUrl,
    });
  } catch (e) {
    failed++;
    console.error(`   ✗ ${e.message}`);
  }
}

if (index.length > 0) {
  // Merge with any existing index entries we didn't refresh this run.
  const indexFile = join(OUT_DIR, 'index.json');
  let merged = index;
  if (existsSync(indexFile) && only.length) {
    try {
      const prev = JSON.parse(readFileSync(indexFile, 'utf8')).documents || [];
      const ids = new Set(index.map((d) => d.id));
      merged = [...prev.filter((d) => !ids.has(d.id)), ...index];
    } catch {
      /* fall back to just this run */
    }
  }
  merged.sort((a, b) => a.title.localeCompare(b.title));
  writeFileSync(
    indexFile,
    JSON.stringify({ builtAt: new Date().toISOString(), documents: merged }, null, 2),
  );
  console.log(`\n✓ index.json — ${merged.length} document(s)`);
}

console.log(failed ? `\n${failed} source(s) failed.` : '\nAll sources refreshed.');
process.exit(failed && index.length === 0 ? 1 : 0);
