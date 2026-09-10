/**
 * caseCorpus.js — load the committed PIT/UPSI case corpus, search and filter it.
 *
 * Two access patterns, both served from memory:
 *   - browse/filter by structured metadata (year, order type, outcome, citation)
 *   - full-text search across the order text, with cited snippets
 *
 * Full order text is kept in the record because that's what makes the search
 * worth having; the API never ships it in list responses.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildIdf,
  parseQuery,
  scoreRecord,
  meetsTermFloor,
  snippet,
} from './textSearch.js';
import { ORDER_TYPE_LIST, OUTCOMES } from './caseMeta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'data', 'cases', 'cases.json');

/** Penalty bands a CS actually thinks in. */
export const PENALTY_BANDS = [
  { id: 'none', label: 'No penalty detected', min: -1, max: 0 },
  { id: 'lt5l', label: 'Under ₹5 lakh', min: 1, max: 500_000 },
  { id: '5lto25l', label: '₹5–25 lakh', min: 500_001, max: 2_500_000 },
  { id: '25lto1cr', label: '₹25 lakh – ₹1 crore', min: 2_500_001, max: 10_000_000 },
  { id: 'gt1cr', label: 'Over ₹1 crore', min: 10_000_001, max: Number.MAX_SAFE_INTEGER },
];

const bandOf = (p) =>
  PENALTY_BANDS.find((b) => p >= b.min && p <= b.max)?.id || 'none';

let CORPUS = null;

function load() {
  if (CORPUS) return CORPUS;

  let raw = { cases: [], builtAt: '' };
  if (existsSync(FILE)) {
    try {
      raw = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch {
      // A malformed corpus must not take the API down.
    }
  }

  const cases = (raw.cases || []).map((c) => ({
    ...c,
    band: bandOf(c.penalty || 0),
    _lower: `${c.title}\n${c.text || ''}`.toLowerCase(),
  }));

  const { idf, N } = buildIdf(cases, (c) => tokensOf(c));
  CORPUS = { cases, idf, N, builtAt: raw.builtAt || '', meta: raw };
  return CORPUS;
}

const tokenCache = new WeakMap();
function tokensOf(c) {
  let t = tokenCache.get(c);
  if (!t) {
    // Title terms are the strongest signal, so they're weighted by repetition.
    t = parseQuery(`${c.title} ${c.title} ${c.text || ''}`).tokens;
    tokenCache.set(c, t);
  }
  return t;
}

/** Strip heavy/internal fields for list responses. */
const publicCase = (c) => {
  const { text, _lower, ...rest } = c;
  return rest;
};

export function corpusStats() {
  const { cases, builtAt, meta } = load();
  const years = [...new Set(cases.map((c) => c.year).filter(Boolean))].sort((a, b) => b - a);
  const citations = new Map();
  cases.forEach((c) => (c.citations || []).forEach((x) => citations.set(x, (citations.get(x) || 0) + 1)));

  return {
    count: cases.length,
    builtAt,
    range: meta.range || null,
    discovered: meta.discovered ?? null,
    cappedWindows: meta.cappedWindows ?? 0,
    years,
    authorities: [...new Set(cases.map((c) => c.authority))].sort(),
    orderTypes: ORDER_TYPE_LIST.filter((t) => cases.some((c) => c.orderType === t.id)),
    outcomes: OUTCOMES.filter((o) => cases.some((c) => c.outcome === o.id)),
    penaltyBands: PENALTY_BANDS.filter((b) => cases.some((c) => c.band === b.id)),
    citations: [...citations.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ id, count: n })),
    totalPenalty: cases.reduce((a, c) => a + (c.penalty || 0), 0),
  };
}

export function getCase(id) {
  const c = load().cases.find((x) => x.id === id);
  if (!c) return null;
  const { _lower, ...rest } = c;
  return rest; // includes full text — this is the detail view
}

function applyFilters(cases, f) {
  return cases.filter((c) => {
    if (f.years?.length && !f.years.includes(String(c.year))) return false;
    if (f.authorities?.length && !f.authorities.includes(c.authority)) return false;
    if (f.orderTypes?.length && !f.orderTypes.includes(c.orderType)) return false;
    if (f.outcomes?.length && !f.outcomes.includes(c.outcome)) return false;
    if (f.bands?.length && !f.bands.includes(c.band)) return false;
    if (f.citations?.length && !f.citations.some((x) => (c.citations || []).includes(x))) {
      return false;
    }
    if (f.company) {
      const needle = f.company.toLowerCase();
      const hay = `${c.company} ${c.subject} ${c.title}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * Browse or search. With `q` the results are ranked and carry a snippet; without
 * it they're the filtered set in reverse-chronological order.
 */
export function queryCases({
  q = '',
  years = [],
  authorities = [],
  orderTypes = [],
  outcomes = [],
  bands = [],
  citations = [],
  company = '',
  sort = 'recent',
  limit = 30,
  offset = 0,
} = {}) {
  const { cases, idf, N } = load();
  const filters = { years, authorities, orderTypes, outcomes, bands, citations, company };
  let pool = applyFilters(cases, filters);

  const term = String(q || '').trim();
  let ranked;

  if (term) {
    const { tokens, phrase } = parseQuery(term);
    if (tokens.length === 0) {
      ranked = [];
    } else {
      ranked = [];
      for (const c of pool) {
        const { score, matched } = scoreRecord(
          { lowerText: c._lower, heading: c.title, length: (c.text || '').length },
          { tokens, phrase, idf, N },
        );
        if (matched === 0 || !meetsTermFloor(matched, tokens)) continue;
        ranked.push({
          c,
          score,
          snippet: snippet(c.text || c.title, phrase, tokens),
        });
      }
      ranked.sort((a, b) => b.score - a.score);
    }
  } else {
    ranked = pool.map((c) => ({ c, score: 0, snippet: '' }));
  }

  if (!term || sort !== 'relevance') {
    if (sort === 'penalty') {
      ranked.sort((a, b) => (b.c.penalty || 0) - (a.c.penalty || 0));
    } else if (sort === 'oldest') {
      ranked.sort((a, b) => (a.c.period || '').localeCompare(b.c.period || ''));
    } else if (sort === 'recent' || !term) {
      ranked.sort((a, b) => (b.c.period || '').localeCompare(a.c.period || ''));
    }
  }

  const total = ranked.length;
  const page = ranked.slice(offset, offset + limit);

  return {
    total,
    results: page.map(({ c, score, snippet: s }) => ({
      ...publicCase(c),
      score: Math.round(score * 100) / 100,
      snippet: s,
    })),
    // Facet counts over the *filtered* pool, so the UI can show what's left.
    facets: {
      years: countBy(pool, (c) => String(c.year)),
      authorities: countBy(pool, (c) => c.authority),
      orderTypes: countBy(pool, (c) => c.orderType),
      outcomes: countBy(pool, (c) => c.outcome),
      bands: countBy(pool, (c) => c.band),
    },
  };
}

function countBy(items, key) {
  const m = {};
  for (const it of items) {
    const k = key(it);
    if (k) m[k] = (m[k] || 0) + 1;
  }
  return m;
}
