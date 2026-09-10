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

/**
 * Search terms that between them cover the PIT/UPSI order space.
 *
 * Measured against the live search rather than guessed: "PIT" yields the most,
 * "insider trading" and "insider" overlap heavily but each surfaces rows the
 * others miss. "UPSI", "unpublished price sensitive" and "price sensitive" all
 * return zero — SEBI's search matches order titles, and titles use neither the
 * acronym nor the expanded phrase.
 */
export const SEARCH_TERMS = ['insider trading', 'PIT', 'insider'];

const dmy = (d) =>
  `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

async function get(url, { timeoutMs = 45000 } = {}) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res;
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
    const rows = parseListing(html);
    rows.forEach((r) => found.set(r.url, r));
    if (onProgress) onProgress({ from: dmy(from), to: dmy(to), rows: rows.length });

    // At the cap the listing is truncated — halve the window and recurse.
    if (rows.length >= PAGE_CAP && depth < 3) {
      const mid = new Date((from.getTime() + to.getTime()) / 2);
      const dayAfter = new Date(mid);
      dayAfter.setDate(dayAfter.getDate() + 1);
      if (mid > from && dayAfter < to) {
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
