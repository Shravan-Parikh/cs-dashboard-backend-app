/**
 * lawSources.js — where the statutory corpus comes from, and how to reach it.
 *
 * SEBI publishes regulations as PDFs behind a PDF.js viewer: the listing page
 * links to an HTML shell, and the shell embeds
 *   <iframe src='../../../web/?file=https://www.sebi.gov.in/sebi_data/attachdocs/…pdf'>
 * The shell itself carries almost no text (≈700 chars), so scraping the HTML is
 * useless — the PDF behind the iframe is the document. All three hops are
 * verified against the live site.
 *
 * Attachment URLs are dated and change when a regulation is re-consolidated
 * (the current one lives under /aug-2026/), so they are never hardcoded — we
 * always rediscover from the listing.
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

/** SEBI's "doListing" endpoints, by section. */
export const LISTINGS = {
  regulations: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=3&smid=0',
  circulars: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=7&smid=0',
};

/**
 * The corpus. Adding a document is one entry here — the resolver handles the
 * listing → shell → PDF hops generically.
 *
 * @typedef {Object} LawSource
 * @property {string} id            stable slug; also the corpus filename
 * @property {string} title
 * @property {string} authority     SEBI | ICSI | Company
 * @property {string} kind          Regulation | FAQ | Circular | Guidance | Code
 * @property {string[]} topics      used for filtering, e.g. ['PIT']
 * @property {string} listing       key into LISTINGS
 * @property {RegExp} match         matches the document's link on the listing
 * @property {string} [note]
 */

/** @type {LawSource[]} */
export const SOURCES = [
  {
    id: 'sebi-pit-regulations-2015',
    title: 'SEBI (Prohibition of Insider Trading) Regulations, 2015',
    authority: 'SEBI',
    kind: 'Regulation',
    topics: ['PIT'],
    listing: 'regulations',
    match: /prohibition-of-insider-trading/i,
    note: 'Consolidated version as published by SEBI, including Schedules A–E.',
  },
  {
    id: 'sebi-lodr-2015',
    title: 'SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015',
    authority: 'SEBI',
    kind: 'Regulation',
    topics: ['LODR'],
    listing: 'regulations',
    match: /listing-obligations-and-disclosure-requirements/i,
  },
  {
    id: 'sebi-sast-2011',
    title: 'SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 2011',
    authority: 'SEBI',
    kind: 'Regulation',
    topics: ['SAST'],
    listing: 'regulations',
    match: /substantial-acquisition-of-shares-and-takeovers/i,
  },
];

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res;
}

/** Every link on a SEBI listing page, as { href, text }. */
export async function listingLinks(listingKey) {
  const url = LISTINGS[listingKey];
  if (!url) throw new Error(`Unknown listing: ${listingKey}`);
  const html = await (await get(url)).text();
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({
      href: m[1],
      text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/**
 * Resolve a source to its live PDF URL: listing → document shell → iframe.
 * Returns { pageUrl, pdfUrl }.
 */
export async function resolveSource(source) {
  const links = await listingLinks(source.listing);
  const hit = links.find((l) => source.match.test(l.href) || source.match.test(l.text));
  if (!hit) throw new Error(`Not found on the ${source.listing} listing: ${source.id}`);

  const pageUrl = new URL(hit.href, 'https://www.sebi.gov.in/').toString();
  const shell = await (await get(pageUrl)).text();

  // The viewer wraps the real file: <iframe src='..../web/?file=<pdf url>'>
  const iframe = /<iframe[^>]+src=['"][^'"]*[?&]file=([^'"&]+)['"]/i.exec(shell);
  const direct = /<a[^>]+href=['"]([^'"]+\.pdf)['"]/i.exec(shell);
  const raw = iframe?.[1] || direct?.[1];
  if (!raw) throw new Error(`No PDF found on the document page for ${source.id}`);

  const pdfUrl = new URL(decodeURIComponent(raw), pageUrl).toString();
  return { pageUrl, pdfUrl };
}

/** Download a PDF as a Buffer. */
export async function downloadPdf(pdfUrl) {
  const res = await get(pdfUrl);
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (!/pdf/i.test(type) && buf.subarray(0, 4).toString() !== '%PDF') {
    throw new Error(`Not a PDF (${type}) at ${pdfUrl}`);
  }
  return buf;
}
