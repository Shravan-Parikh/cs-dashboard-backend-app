/**
 * lawCorpus.js — load the committed statutory corpus and search it.
 *
 * Firestore has no full-text search, and the alternatives (Algolia, Typesense)
 * are another service to run and pay for. The corpus is ~550 chunks / ~1 MB, so
 * it's held in memory and scanned per query — a few milliseconds, no index to
 * deploy, nothing to keep in sync. Revisit if the corpus grows past ~50k chunks.
 *
 * Regenerate with: node scripts/refresh-law-corpus.js
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAW_DIR = join(__dirname, 'data', 'law');

/** Words too common in legislation to be worth scoring. */
const STOP = new Set(
  ('a an the and or of to in for on by with as is are be shall may any such other than that this ' +
    'these those it its from at not no under section regulation regulations sub clause provided')
    .split(' '),
);

const tokenize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

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
            // Precomputed for scoring — the corpus is static at runtime.
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

  /**
   * Inverse document frequency. Without it "trading window closure" ranks
   * generic clauses first, because "trading" occurs in most of the corpus while
   * "closure" is the term that actually discriminates.
   */
  const df = new Map();
  for (const c of chunks) {
    for (const t of new Set(c._tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = chunks.length || 1;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + N / (1 + n)));

  CORPUS = { documents, chunks, idf, N };
  return CORPUS;
}

/** Unseen terms are treated as maximally rare. */
const idfOf = (idf, N, t) => idf.get(t) ?? Math.log(1 + N);

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
    chunks: chunks
      .filter((c) => c.docId === id)
      .map(({ _text, _tokens, ...c }) => c),
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

/** Build a readable snippet centred on the best match, with <mark> spans. */
function snippet(text, phrase, tokens, width = 340) {
  const lower = text.toLowerCase();
  let at = phrase ? lower.indexOf(phrase) : -1;
  if (at < 0) {
    for (const t of tokens) {
      const i = lower.indexOf(t);
      if (i >= 0) {
        at = i;
        break;
      }
    }
  }
  if (at < 0) at = 0;

  let start = Math.max(0, at - Math.floor(width / 3));
  // Snap to a word boundary so snippets don't start mid-word.
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp > 0 && sp - start < 25) start = sp + 1;
  }
  let end = Math.min(text.length, start + width);
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > start + width * 0.6) end = sp;
  }

  const raw = text.slice(start, end);

  // One pass over a single alternation, longest term first, so matches cannot
  // nest — a phrase and its own words previously produced
  // <mark><mark>pre-clearance</mark> of <mark>trades</mark></mark>.
  const terms = [...new Set([phrase, ...tokens].filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let out;
  if (terms.length === 0) {
    out = esc(raw);
  } else {
    const re = new RegExp(`(${terms.join('|')})`, 'gi');
    out = '';
    let last = 0;
    for (const m of raw.matchAll(re)) {
      out += esc(raw.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
      last = m.index + m[0].length;
    }
    out += esc(raw.slice(last));
    // Merge highlights separated only by whitespace, so "pre-clearance of trades"
    // reads as one span instead of three.
    out = out.replace(/<\/mark>(\s{0,3})<mark>/g, '$1');
  }

  return (start > 0 ? '… ' : '') + out.trim() + (end < text.length ? ' …' : '');
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

  const tokens = tokenize(q);
  if (tokens.length === 0) return { results: [], total: 0, tokens: [] };
  // Treat a multi-word query as a phrase candidate too.
  const phrase = tokens.length > 1 ? q.toLowerCase().replace(/\s+/g, ' ') : '';

  const scored = [];
  for (const c of chunks) {
    if (topics.length && !c.topics.some((t) => topics.includes(t))) continue;
    if (docIds.length && !docIds.includes(c.docId)) continue;

    let score = 0;
    let matched = 0;

    for (const t of tokens) {
      const w = idfOf(idf, N, t);
      // Count occurrences without a global regex (cheaper, no escaping needed).
      let n = 0;
      let i = c._text.indexOf(t);
      while (i >= 0) {
        n++;
        i = c._text.indexOf(t, i + t.length);
      }
      if (n > 0) {
        matched++;
        score += (1 + Math.log(n)) * w; // rare terms carry the ranking
      }
      if (`${c.ref} ${c.heading}`.toLowerCase().includes(t)) score += 2.5 * w;
    }

    if (matched === 0) continue;
    // Require most terms for multi-term queries, so results stay on-topic.
    if (tokens.length > 1 && matched < Math.ceil(tokens.length * 0.6)) continue;

    // Adjacent query terms appearing adjacently is strong evidence, and it's
    // what rescues "trading window closure" from every clause mentioning trading.
    for (let k = 0; k + 1 < tokens.length; k++) {
      const pair = `${tokens[k]} ${tokens[k + 1]}`;
      if (c._text.includes(pair)) {
        score += 3 * (idfOf(idf, N, tokens[k]) + idfOf(idf, N, tokens[k + 1]));
      }
    }

    if (phrase && c._text.includes(phrase)) score += 15;
    score += (matched / tokens.length) * 4;
    // Mild preference for tighter passages — a hit in a short clause is more useful.
    score *= 1 + Math.min(0.3, 900 / Math.max(400, c.text.length));

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
