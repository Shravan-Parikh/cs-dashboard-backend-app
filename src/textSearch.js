/**
 * textSearch.js — the small search engine shared by the law corpus and case law.
 *
 * Both corpora are static at runtime, committed to the repo, and small enough
 * (hundreds of documents) to scan in memory. That buys us full-text search with
 * no Algolia/Typesense to run, no index to deploy and nothing to keep in sync.
 *
 * The scoring is deliberately IDF-weighted: in a corpus of insider-trading
 * orders "insider" and "trading" appear nearly everywhere, so raw term frequency
 * ranks generic passages first. The discriminating term has to carry the result.
 */

/** Words too common in Indian securities law to be worth scoring. */
const STOP = new Set(
  ('a an the and or of to in for on by with as is are be shall may any such other than that this ' +
    'these those it its from at not no under section regulation regulations sub clause provided ' +
    'said have has been was were which who whom their his her they i ii iii')
    .split(' '),
);

export function tokenize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Inverse document frequency over a set of records' token arrays.
 * `getTokens(record) -> string[]`
 */
export function buildIdf(records, getTokens) {
  const df = new Map();
  for (const r of records) {
    for (const t of new Set(getTokens(r))) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = records.length || 1;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + N / (1 + n)));
  return { idf, N };
}

/** Unseen terms are treated as maximally rare. */
export const idfOf = (idf, N, t) => idf.get(t) ?? Math.log(1 + N);

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escHtml = (x) =>
  x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A readable snippet centred on the best match, with non-nesting <mark> spans.
 * The single-alternation pass matters: highlighting a phrase and then its own
 * words separately produces <mark><mark>…</mark></mark>.
 */
export function snippet(text, phrase, tokens, width = 340) {
  const lower = text.toLowerCase();
  let at = phrase ? lower.indexOf(phrase) : -1;

  if (at < 0) {
    // Anchor on the densest passage, not the first hit. In a 40-page order the
    // first "trading" is in the header; the passage worth reading is where
    // several query terms occur together.
    const hits = [];
    for (const t of tokens) {
      let i = lower.indexOf(t);
      while (i >= 0 && hits.length < 4000) {
        hits.push({ at: i, t });
        i = lower.indexOf(t, i + t.length);
      }
    }
    if (hits.length > 0) {
      hits.sort((a, b) => a.at - b.at);
      let best = { at: hits[0].at, distinct: 0, count: 0 };
      for (let i = 0; i < hits.length; i++) {
        const start = hits[i].at;
        const seen = new Set();
        let count = 0;
        for (let k = i; k < hits.length && hits[k].at - start <= width; k++) {
          seen.add(hits[k].t);
          count++;
        }
        if (
          seen.size > best.distinct ||
          (seen.size === best.distinct && count > best.count)
        ) {
          best = { at: start, distinct: seen.size, count };
        }
      }
      at = best.at;
    }
  }
  if (at < 0) at = 0;

  let start = Math.max(0, at - Math.floor(width / 3));
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
  const terms = [...new Set([phrase, ...tokens].filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escRe);

  let out;
  if (terms.length === 0) {
    out = escHtml(raw);
  } else {
    const re = new RegExp(`(${terms.join('|')})`, 'gi');
    out = '';
    let last = 0;
    for (const m of raw.matchAll(re)) {
      out += escHtml(raw.slice(last, m.index)) + `<mark>${escHtml(m[0])}</mark>`;
      last = m.index + m[0].length;
    }
    out += escHtml(raw.slice(last));
    out = out.replace(/<\/mark>(\s{0,3})<mark>/g, '$1');
  }
  return (start > 0 ? '… ' : '') + out.trim() + (end < text.length ? ' …' : '');
}

/** Occurrences of `needle` in `haystack` without a global regex. */
export function countOf(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Score one record against a query.
 *
 * @param {{lowerText: string, heading: string, length: number}} rec
 * @param {{tokens: string[], phrase: string, idf: Map, N: number}} q
 * @returns {{score: number, matched: number}}
 */
export function scoreRecord(rec, { tokens, phrase, idf, N }) {
  let score = 0;
  let matched = 0;
  const heading = (rec.heading || '').toLowerCase();

  for (const t of tokens) {
    const w = idfOf(idf, N, t);
    const n = countOf(rec.lowerText, t);
    if (n > 0) {
      matched++;
      score += (1 + Math.log(n)) * w;
    }
    if (heading.includes(t)) score += 2.5 * w;
  }
  if (matched === 0) return { score: 0, matched: 0 };

  // Adjacent query terms appearing adjacently is strong evidence.
  for (let k = 0; k + 1 < tokens.length; k++) {
    const pair = `${tokens[k]} ${tokens[k + 1]}`;
    if (rec.lowerText.includes(pair)) {
      score += 3 * (idfOf(idf, N, tokens[k]) + idfOf(idf, N, tokens[k + 1]));
    }
  }
  if (phrase && rec.lowerText.includes(phrase)) score += 15;
  score += (matched / tokens.length) * 4;
  // Mild preference for tighter passages — a hit in a short clause says more.
  score *= 1 + Math.min(0.3, 900 / Math.max(400, rec.length));

  return { score, matched };
}

/** Most multi-term queries should require most of their terms. */
export const meetsTermFloor = (matched, tokens) =>
  tokens.length <= 1 || matched >= Math.ceil(tokens.length * 0.6);

/** Split a query into scoring inputs. */
export function parseQuery(q) {
  const tokens = tokenize(q);
  return {
    tokens,
    phrase: tokens.length > 1 ? String(q).trim().toLowerCase().replace(/\s+/g, ' ') : '',
  };
}
