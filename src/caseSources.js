/**
 * caseSources.js — discovering SEBI enforcement orders on insider trading.
 *
 * Established against the live site:
 *
 *   Listing:  HomeAction.do?doListing=yes&sid=2&ssid=9&smid=0
 *   Search:   &search=insider trading      → server-side, ~20 results per call
 *   Window:   &fromDate=dd-MM-yyyy&toDate=dd-MM-yyyy   (ONLY this date format;
 *             yyyy-MM-dd returns nothing, and MM/dd/yyyy is silently ignored,
 *             which looks like success while actually returning the unfiltered
 *             list — so the format is not negotiable.)
 *   Order:    /enforcement/orders/<mon-yyyy>/<slug>_<id>.html  → shell page whose
 *             iframe carries the real PDF (the shell holds ~500 chars of text).
 *
 * `nextValue` does NOT paginate over GET — pages 1, 2 and 5 all return the same
 * rows — so depth comes from narrow date windows rather than paging. A window
 * that returns the 20-row cap is therefore suspect and gets split in half.
 */

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/pdf,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.sebi.gov.in/',
};

const LISTING = 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do';
/** SEBI caps a listing response at 20 rows; hitting it means we lost records. */
export const PAGE_CAP = 20;
/** With no search term the listing returns ~25 rows before truncating. */
export const SWEEP_CAP = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LISTED_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Sep 10, 2026" -> Date, as printed in the listing's own Date column. */
export function parseListedDate(s) {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mon = LISTED_MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return null;
  return new Date(Number(m[3]), mon, Number(m[2]));
}

/**
 * Whether a listing response left rows behind.
 *
 * Row count is the wrong signal, and getting this wrong under-collects silently:
 * a request for all of August 2026 came back with 19 rows — under any plausible
 * cap — yet they spanned only Aug 25–31. The listing is anchored on `toDate` and
 * returns the newest rows, dropping the older end. So the real test is whether
 * the oldest row reaches back to `from`.
 */
function isTruncated(rows, from) {
  if (rows.length === 0) return false;
  const oldest = rows
    .map((r) => parseListedDate(r.listedDate))
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  if (!oldest) return rows.length >= SWEEP_CAP; // fall back if dates are unparseable
  // A day of slack: the listing's date and our window edge can differ by rounding.
  return oldest.getTime() - from.getTime() > 36 * 3600 * 1000;
}

/**
 * Search terms that between them cover the PIT/UPSI order space.
 *
 * Measured against the live search rather than guessed: "PIT" yields the most,
 * "insider trading" and "insider" overlap heavily but each surfaces rows the
 * others miss. "UPSI", "unpublished price sensitive" and "price sensitive" all
 * return zero — SEBI's search matches order titles, and titles use neither the
 * acronym nor the expanded phrase.
 */
// "insider" subsumes "insider trading", so two terms cover the space; a third
// only multiplies requests against a site that throttles sustained load.
export const SEARCH_TERMS = ['insider', 'PIT'];

const sleepEarly = null;
const dmy = (d) =>
  `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

/**
 * Fetch with retries. A recursive sweep makes hundreds of requests and SEBI will
 * reset the connection under that load (ECONNRESET), so a transient failure must
 * not abort a run that's already twenty minutes in.
 */
async function get(url, { timeoutMs = 45000, attempts = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1500 * i * i); // 1.5s, 6s, 13.5s
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 || res.status === 429) throw new Error(`${res.status} for ${url}`);
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function listingUrl({ search, from, to }) {
  const q = new URLSearchParams({
    doListing: 'yes',
    sid: '2',
    ssid: '9',
    smid: '0',
  });
  if (search) q.set('search', search);
  if (from) q.set('fromDate', dmy(from));
  if (to) q.set('toDate', dmy(to));
  return `${LISTING}?${q}`;
}

/**
 * Listing rows, with the date SEBI prints alongside each order:
 *   <tr><td>Sep 10, 2026</td><td><a href="…" title="…">Title</a></td></tr>
 * Cheaper and more reliable than re-deriving the date from the PDF, and it
 * gives the sweep an exact date to window on.
 */
export function parseListingRows(html) {
  const rows = [];
  const seen = new Set();
  const re = /<tr[^>]*>\s*<td[^>]*>([^<]{6,30})<\/td>\s*<td[^>]*>\s*<a[^>]+href="(https:\/\/www\.sebi\.gov\.in\/enforcement\/orders\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push({
      listedDate: m[1].trim(),
      url,
      title: m[3]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;|&rsquo;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }
  return rows;
}

/**
 * Every order in [from, to], regardless of subject.
 *
 * With no search term the listing caps at 25 rows, so any window that returns
 * the cap is truncated and gets halved. This is how "all orders" is enumerated
 * — `nextValue` does not paginate over GET.
 */
export async function sweepAllOrders({ from, to, onProgress, minSpanDays = 1 } = {}) {
  const found = new Map();
  let requests = 0;
  let capped = 0;

  const walk = async (a, b) => {
    const html = await (await get(listingUrl({ from: a, to: b }))).text();
    requests++;
    const rows = parseListingRows(html);
    const spanDays = Math.round((b - a) / 86400000) + 1;

    // Keep whatever this window did return before deciding to split — those rows
    // are real, and the newest end of a truncated window is exactly what we got.
    rows.forEach((r) => found.set(r.url, r));
    if (onProgress) onProgress({ from: dmy(a), to: dmy(b), rows: rows.length, total: found.size });
    await sleep(400); // be a considerate client

    if (isTruncated(rows, a)) {
      if (spanDays > minSpanDays) {
        const mid = new Date(a.getTime() + Math.floor((b - a) / 2));
        const next = new Date(mid);
        next.setDate(next.getDate() + 1);
        await walk(a, mid);
        await walk(next, b);
        return;
      }
      capped++; // a single day with more rows than the listing will show
    }
  };

  await walk(from, to);
  return { orders: [...found.values()], requests, cappedDays: capped };
}

/** Order links on one listing response, as { url, title }. */
function parseListing(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a[^>]+href="(https:\/\/www\.sebi\.gov\.in\/enforcement\/orders\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const title = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (title.length > 15) out.push({ url, title });
  }
  return out;
}

/**
 * All orders for one search term over [startYear, endYear], windowing by year and
 * splitting any window that comes back at the row cap (where records are hidden).
 */
export async function discoverOrders({
  term,
  startYear,
  endYear,
  onProgress,
} = {}) {
  const found = new Map();
  let cappedWindows = 0;

  const sweep = async (from, to, depth = 0) => {
    const html = await (await get(listingUrl({ search: term, from, to }))).text();
    const rows = parseListingRows(html);
    rows.forEach((r) => found.set(r.url, r));
    if (onProgress) onProgress({ from: dmy(from), to: dmy(to), rows: rows.length });
    await sleep(400);

    // Truncation is a date question, not a row-count one — see isTruncated().
    if (isTruncated(rows, from) && depth < 8) {
      const mid = new Date((from.getTime() + to.getTime()) / 2);
      const dayAfter = new Date(mid);
      dayAfter.setDate(dayAfter.getDate() + 1);
      if (mid > from && dayAfter <= to) {
        await sweep(from, mid, depth + 1);
        await sweep(dayAfter, to, depth + 1);
        return;
      }
      cappedWindows++;
    }
  };

  for (let y = endYear; y >= startYear; y--) {
    await sweep(new Date(y, 0, 1), new Date(y, 11, 31));
  }
  return { orders: [...found.values()], cappedWindows };
}

/** Resolve an order's shell page to its PDF. */
export async function resolveOrderPdf(pageUrl) {
  const html = await (await get(pageUrl)).text();
  const iframe =
    /<iframe[^>]+src=['"][^'"]*[?&]file=([^'"&]+)['"]/i.exec(html) ||
    /<a[^>]+href=['"]([^'"]+\.pdf)['"]/i.exec(html);
  if (!iframe) return null;
  return new URL(decodeURIComponent(iframe[1]), pageUrl).toString();
}

export async function downloadPdf(url) {
  const res = await get(url, { timeoutMs: 90000 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error(`Not a PDF at ${url}`);
  return buf;
}
