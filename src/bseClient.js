/**
 * bseClient.js — Node port of the Python bse_client.
 *
 * Wraps BSE India's (undocumented but public) corporate announcement JSON
 * endpoint. No API key; requires browser-like headers or BSE 403s.
 *
 * If BSE changes the API, this is the single file to patch.
 */

import { request as httpsRequest } from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const ANN_URL = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w';
const ATTACH_LIVE = (name) => `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${name}`;
const ATTACH_HIS = (name) => `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${name}`;

export const CATEGORIES = [
  '-1', // All
  'AGM/EGM',
  'Board Meeting',
  'Company Update',
  'Corp. Action',
  'Insider Trading / SAST',
  'New Listing',
  'Result',
  'Integrated Filing',
  'Others',
];

/**
 * BSE's limits, established by probing the live endpoint:
 *
 *  - single scrip (strscrip set)  → no date-span limit (180d works fine)
 *  - market-wide + strCat='-1'    → ONE DAY only; wider ranges return `{}`
 *  - market-wide + named category → ~30 days; wider returns `{}`
 *
 * The span cap is volume-independent (30d/19k rows succeeds, 60d/125 rows
 * fails), so it's a server-side date check, not a result-size guard. We chunk
 * market-wide queries at 25 days to stay safely inside a flaky boundary.
 */
export const MARKET_MAX_SPAN_DAYS = 25;

export const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
  Connection: 'keep-alive',
};

/**
 * BSE occasionally serves responses with malformed HTTP/1.1 headers — a leading
 * space before the header name (" X-Frame-Options: SAMEORIGIN"). Node's fetch
 * (undici) rejects those outright with "Response does not match the HTTP/1.1
 * protocol", and it is *deterministic* per response: retrying never helps, and
 * some pages become permanently unreachable (e.g. page 4+ of a year of Reliance
 * filings). node:https can be told to tolerate it via insecureHTTPParser.
 *
 * So: try fetch first, and fall back to the lenient parser only when undici
 * refuses to parse. `insecureHTTPParser` relaxes header framing only — TLS
 * verification is untouched.
 */
function insecureGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'GET', headers: { ...headers, 'Accept-Encoding': 'gzip, deflate' }, insecureHTTPParser: true },
      (res) => {
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc.includes('br')) stream = res.pipe(createBrotliDecompress());
        else if (enc.includes('gzip')) stream = res.pipe(createGunzip());
        else if (enc.includes('deflate')) stream = res.pipe(createInflate());

        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body: Buffer.concat(chunks),
          }),
        );
        stream.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('BSE request timed out')));
    req.end();
  });
}

const isParserError = (e) => {
  const m = `${e?.message || ''} ${e?.cause?.message || ''} ${e?.cause?.code || ''}`;
  return /HTTP\/1\.1 protocol|HPE_|Parse Error|header/i.test(m);
};

/** GET a BSE URL, tolerating their malformed headers. Returns { ok, status, body }. */
export async function bseGet(url, { timeoutMs = 30000 } = {}) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  } catch (e) {
    if (!isParserError(e)) throw e;
    return insecureGet(url, HEADERS, timeoutMs);
  }
}

/** YYYYMMDD from a JS Date or 'YYYY-MM-DD' string. */
function fmt(d) {
  const date = typeof d === 'string' ? new Date(d + 'T00:00:00') : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function buildPdfUrl(attachment, historical = false) {
  if (!attachment) return '';
  return historical ? ATTACH_HIS(attachment) : ATTACH_LIVE(attachment);
}

/**
 * BSE returns the body as a JSON-*encoded string* (double-encoded), and a bare
 * "No Record Found!" string when a query matches nothing. Normalise to an object.
 */
function decode(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { Table: [], Table1: [] };
  }
  if (typeof data === 'string') {
    const t = data.trim();
    if (!t || /^no record/i.test(t)) return { Table: [], Table1: [] };
    try {
      data = JSON.parse(t);
    } catch {
      return { Table: [], Table1: [] };
    }
  }
  return data && typeof data === 'object' ? data : { Table: [], Table1: [] };
}

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== '') {
      // BSE leaks SQL-escaped quotes into text fields ("scrutinizer''s report").
      return String(v).trim().replace(/''/g, "'");
    }
  }
  return '';
}

function parseRow(row) {
  const attachment = pick(row, 'ATTACHMENTNAME', 'Attachmentname');
  return {
    scrip_code: pick(row, 'SCRIP_CD', 'Scrip_Cd'),
    company: pick(row, 'SLONGNAME', 'Slongname', 'COMPANYNAME'),
    headline: pick(row, 'HEADLINE', 'NEWSSUB'),
    category: pick(row, 'CATEGORYNAME', 'Categoryname'),
    subcategory: pick(row, 'SUBCATNAME', 'Subcatname'),
    news_dt: pick(row, 'NEWS_DT', 'News_dt', 'DissemDT'),
    news_id: pick(row, 'NEWSID', 'Newsid'),
    attachment,
    pdf_url: buildPdfUrl(attachment),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PAGE_SIZE = 50;

/**
 * Run async thunks with a bounded concurrency. A thunk that throws resolves to
 * `null` so one bad page never sinks a whole feed.
 */
export async function pool(tasks, limit = 6) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        try {
          out[i] = await tasks[i]();
        } catch {
          out[i] = null;
        }
      }
    }),
  );
  return out;
}

/**
 * One page of announcements. Returns { rows, total } — `total` comes from
 * BSE's Table1[0].ROWCNT, which is what makes real pagination possible.
 *
 * `subcategory` is filtered server-side by exact name (verified), so passing it
 * is far cheaper than fetching a whole category and filtering locally.
 */
export async function fetchPage({
  from,
  to,
  scripCode = '',
  category = '-1',
  subcategory = '-1',
  page = 1,
  attempts = 3,
}) {
  const params = new URLSearchParams({
    pageno: String(page),
    strCat: category || '-1',
    subcategory: subcategory || '-1',
    strPrevDate: fmt(from),
    strToDate: fmt(to),
    strSearch: 'P',
    strscrip: scripCode || '',
    strType: 'C',
  });

  // BSE also drops a share of requests under concurrency, so give each page a
  // couple of tries with backoff. Without this a single blip loses a slice.
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(300 * attempt);
    try {
      const res = await bseGet(`${ANN_URL}?${params}`);
      if (!res.ok) throw new Error(`BSE ${res.status} for scrip ${scripCode || 'market'}`);
      const payload = decode(res.body.toString('utf8'));
      const rows = (payload.Table || []).map(parseRow);
      const total = Number(payload.Table1?.[0]?.ROWCNT ?? rows.length) || 0;
      return { rows, total };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Fetch announcements for a single scrip (or all if empty) over a date range. */
export async function fetchAnnouncements({
  from,
  to,
  scripCode = '',
  category = '-1',
  subcategory = '-1',
  maxPages = 25,
}) {
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    let rows;
    try {
      ({ rows } = await fetchPage({ from, to, scripCode, category, subcategory, page }));
    } catch (e) {
      // Page 1 failing means we have nothing to show, so surface it. A later
      // page failing should degrade to a partial result, not lose everything.
      if (page === 1) throw e;
      break;
    }
    if (rows.length === 0) break;
    results.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return results;
}

/**
 * Fetch every page of one (category, subcategory) slice concurrently.
 * Page 1 tells us the total, so the rest can go out in parallel.
 */
export async function fetchSlice(
  { from, to, scripCode = '', category = '-1', subcategory = '-1' },
  { maxPages = 4, concurrency = 6 } = {},
) {
  // Page 1 is load-bearing — it carries the total that sizes the rest.
  const first = await fetchPage({ from, to, scripCode, category, subcategory, page: 1 });
  const pages = Math.min(Math.ceil(first.total / PAGE_SIZE) || 1, maxPages);
  if (pages <= 1) return { rows: first.rows, total: first.total, truncated: false };

  const rest = await pool(
    Array.from({ length: pages - 1 }, (_, i) => () =>
      fetchPage({ from, to, scripCode, category, subcategory, page: i + 2 }),
    ),
    concurrency,
  );
  const rows = [...first.rows, ...rest.flatMap((r) => r?.rows || [])];
  return {
    rows,
    total: first.total,
    truncated: first.total > pages * PAGE_SIZE,
  };
}

/** Split [from, to] into windows of at most `spanDays` (BSE market-wide cap). */
export function dateWindows(from, to, spanDays = MARKET_MAX_SPAN_DAYS) {
  const start = typeof from === 'string' ? new Date(from + 'T00:00:00') : new Date(from);
  const end = typeof to === 'string' ? new Date(to + 'T00:00:00') : new Date(to);
  const windows = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const wEnd = new Date(cursor);
    wEnd.setDate(wEnd.getDate() + spanDays - 1);
    windows.push({ from: new Date(cursor), to: wEnd > end ? new Date(end) : wEnd });
    cursor = new Date(wEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return windows;
}

/**
 * Fetch for many scrips sequentially (gentle on BSE). Retries each scrip once
 * on failure, and reports which scrips ultimately failed so the caller can
 * distinguish "no filing" from "couldn't fetch". onProgress(done,total,code).
 *
 * Returns { announcements, failed: string[] }.
 */
export async function fetchForScrips(scrips, { from, to, category = '-1', onProgress } = {}) {
  const out = [];
  const failed = [];
  const codes = scrips.filter(Boolean);
  for (let i = 0; i < codes.length; i++) {
    if (onProgress) onProgress(i + 1, codes.length, codes[i]);
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const anns = await fetchAnnouncements({ from, to, scripCode: codes[i], category });
        out.push(...anns);
        ok = true;
      } catch {
        if (attempt === 0) await sleep(400); // brief backoff before one retry
      }
    }
    if (!ok) failed.push(codes[i]);
    await sleep(60); // small pause to avoid throttling
  }
  return { announcements: out, failed };
}

function alternates(url) {
  if (!url) return [];
  const out = [url];
  if (url.includes('AttachLive')) out.push(url.replace('AttachLive', 'AttachHis'));
  else if (url.includes('AttachHis')) out.push(url.replace('AttachHis', 'AttachLive'));
  return out;
}

/** Return a PDF URL that actually 200s (Live then His). BSE HEAD is unreliable. */
export async function resolvePdfUrl(url) {
  if (!url) return '';
  for (const candidate of alternates(url)) {
    try {
      const res = await bseGet(candidate);
      if (res.ok) return candidate;
    } catch {
      // try next
    }
  }
  return url;
}

/** Resolve many URLs, deduped. Returns Map(url -> workingUrl). */
export async function resolveMany(urls, onProgress) {
  const unique = [...new Set(urls.filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < unique.length; i++) {
    if (onProgress) onProgress(i + 1, unique.length);
    map.set(unique[i], await resolvePdfUrl(unique[i]));
  }
  return map;
}

/** Download a single PDF as a Buffer, with Live/His fallback. */
export async function downloadPdf(url) {
  let lastErr;
  for (const candidate of alternates(url)) {
    try {
      const res = await bseGet(candidate);
      if (res.ok) return res.body;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('download failed');
}
