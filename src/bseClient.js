/**
 * bseClient.js — Node port of the Python bse_client.
 *
 * Wraps BSE India's (undocumented but public) corporate announcement JSON
 * endpoint. No API key; requires browser-like headers or BSE 403s.
 *
 * If BSE changes the API, this is the single file to patch.
 */

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
async function decode(res) {
  const text = await res.text();
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
    if (v !== undefined && v !== null && v !== '') return String(v).trim();
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

/** Fetch announcements for a single scrip (or all if empty) over a date range. */
export async function fetchAnnouncements({
  from,
  to,
  scripCode = '',
  category = '-1',
  maxPages = 25,
}) {
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      pageno: String(page),
      strCat: category || '-1',
      subcategory: '-1',
      strPrevDate: fmt(from),
      strToDate: fmt(to),
      strSearch: 'P',
      strscrip: scripCode || '',
      strType: 'C',
    });
    const res = await fetch(`${ANN_URL}?${params}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`BSE ${res.status} for scrip ${scripCode}`);
    const payload = await decode(res);
    const rows = payload.Table || [];
    if (rows.length === 0) break;
    results.push(...rows.map(parseRow));
    if (rows.length < 50) break;
  }
  return results;
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
      const res = await fetch(candidate, { headers: HEADERS });
      if (res.ok) {
        // don't consume the body
        try { await res.body?.cancel(); } catch { /* noop */ }
        return candidate;
      }
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
      const res = await fetch(candidate, { headers: HEADERS });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('download failed');
}
