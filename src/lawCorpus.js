/**
 * lawCorpus.js — load the committed statutory corpus and search it.
 *
 * The corpus is ~550 chunks / ~1 MB, held in memory and scanned per query, so
 * there's no search service to run and no index to keep in sync. Scoring lives
 * in textSearch.js, shared with the case-law corpus.
 *
 * Regenerate with: node scripts/refresh-law-corpus.js
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildIdf,
  parseQuery,
  scoreRecord,
  meetsTermFloor,
  snippet,
  tokenize,
} from './textSearch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAW_DIR = join(__dirname, 'data', 'law');

let CORPUS = null;

function load() {
  if (CORPUS) return CORPUS;

  const documents = [];
  const chunks = [];

  if (existsSync(LAW_DIR)) {
    for (const file of readdirSync(LAW_DIR)) {
      if (!file.endsWith('.json') || file === 'index.json') continue;
      try {
        const doc = JSON.parse(readFileSync(join(LAW_DIR, file), 'utf8'));
        const { chunks: docChunks = [], ...meta } = doc;
        documents.push(meta);
        for (const c of docChunks) {
          chunks.push({
            ...c,
            docId: meta.id,
            docTitle: meta.title,
            authority: meta.authority,
            kind: meta.kind,
            topics: meta.topics || [],
            // Precomputed — the corpus is static at runtime.
            _text: c.text.toLowerCase(),
            _tokens: tokenize(`${c.ref} ${c.heading} ${c.text}`),
          });
        }
      } catch {
        // A malformed corpus file shouldn't take the API down.
      }
    }
  }

  documents.sort((a, b) => a.title.localeCompare(b.title));
  const { idf, N } = buildIdf(chunks, (c) => c._tokens);
  CORPUS = { documents, chunks, idf, N };
  return CORPUS;
}

/** Documents in the corpus, without their chunk bodies. */
export function listDocuments() {
  return load().documents;
}

export function getDocument(id) {
  const { documents, chunks } = load();
  const doc = documents.find((d) => d.id === id);
  if (!doc) return null;
  return {
    ...doc,
    chunks: chunks.filter((c) => c.docId === id).map(({ _text, _tokens, ...c }) => c),
  };
}

export function getChunk(id) {
  const c = load().chunks.find((x) => x.id === id);
  if (!c) return null;
  const { _text, _tokens, ...rest } = c;
  return rest;
}

export function corpusStats() {
  const { documents, chunks } = load();
  return {
    documents: documents.length,
    chunks: chunks.length,
    topics: [...new Set(documents.flatMap((d) => d.topics || []))].sort(),
    authorities: [...new Set(documents.map((d) => d.authority))].sort(),
    builtAt: documents.reduce((a, d) => (d.fetchedAt > a ? d.fetchedAt : a), ''),
  };
}

/**
 * Look a provision up by its reference, e.g. "Regulation 4" or "Schedule B".
 *
 * This is not a text search and must not be one: `tokenize` drops "regulation"
 * as a stopword and single digits as too short, so searching "regulation 4"
 * yields an empty query and zero hits. A citation chip on a case order needs
 * the actual clause, so it matches the chunk's own `ref` instead.
 */
export function lookupByRef(ref, { docIds = [], limit = 20 } = {}) {
  const { chunks } = load();
  const want = String(ref || '').trim().toLowerCase();
  if (!want) return [];

  const norm = (r) => r.toLowerCase().replace(/\s*\(part \d+ of \d+\)\s*$/, '').trim();
  const pool = docIds.length ? chunks.filter((c) => docIds.includes(c.docId)) : chunks;

  const exact = pool.filter((c) => norm(c.ref) === want);
  const hits = exact.length > 0 ? exact : pool.filter((c) => norm(c.ref).startsWith(want));

  return hits
    .slice(0, limit)
    .map(({ _text, _tokens, ...c }) => ({
      ...c,
      score: 0,
      // No query to highlight, so lead with the opening of the clause.
      snippet: c.text.length > 420 ? c.text.slice(0, 420).trim() + ' …' : c.text,
    }));
}

/**
 * Search the corpus.
 * @param {string} query
 * @param {{topics?:string[], docIds?:string[], limit?:number}} opts
 */
export function search(query, { topics = [], docIds = [], limit = 25 } = {}) {
  const { chunks, idf, N } = load();
  const q = String(query || '').trim();
  if (!q) return { results: [], total: 0, tokens: [] };

  const { tokens, phrase } = parseQuery(q);
  if (tokens.length === 0) return { results: [], total: 0, tokens: [] };

  const scored = [];
  for (const c of chunks) {
    if (topics.length && !c.topics.some((t) => topics.includes(t))) continue;
    if (docIds.length && !docIds.includes(c.docId)) continue;

    const { score, matched } = scoreRecord(
      { lowerText: c._text, heading: `${c.ref} ${c.heading}`, length: c.text.length },
      { tokens, phrase, idf, N },
    );
    if (matched === 0 || !meetsTermFloor(matched, tokens)) continue;
    scored.push({ c, score });
  }

  scored.sort((a, b) => b.score - a.score || a.c.page - b.c.page);
  const total = scored.length;

  const results = scored.slice(0, limit).map(({ c, score }) => ({
    id: c.id,
    docId: c.docId,
    docTitle: c.docTitle,
    authority: c.authority,
    kind: c.kind,
    topics: c.topics,
    ref: c.ref,
    heading: c.heading,
    chapter: c.chapter,
    page: c.page,
    score: Math.round(score * 100) / 100,
    snippet: snippet(c.text, phrase, tokens),
  }));

  return { results, total, tokens };
}
