import { Router } from 'express';
import {
  fetchForScrips,
  resolveMany,
  fetchAnnouncements,
  fetchSlice,
  dateWindows,
  pool,
} from '../bseClient.js';
import { nameLookup, companiesForIndex } from '../companies.js';
import { bucketCatalogue, resolveBuckets, bucketFor } from '../csRelevance.js';

const router = Router();

const RESOLVE_CAP = 150; // don't verify links for huge result sets (too slow)

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

/**
 * Local YYYY-MM-DD. Deliberately not toISOString(): the server runs in IST, so
 * UTC would report "yesterday" for anything before 05:30 and the reported range
 * would disagree with the range actually sent to BSE (which uses local dates).
 */
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function applyKeyword(rows, keyword) {
  if (!keyword) return rows;
  const kw = keyword.toLowerCase();
  return rows.filter((r) =>
    `${r.headline} ${r.subcategory} ${r.category}`.toLowerCase().includes(kw),
  );
}

/** One row per company in `roster`, carrying its most recent matching filing. */
function latestPerCompany(rows, roster, names, failedSet) {
  // newest match per scrip
  const byScrip = new Map();
  for (const r of rows) {
    const prev = byScrip.get(r.scrip_code);
    if (!prev || new Date(r.news_dt) > new Date(prev.news_dt)) byScrip.set(r.scrip_code, r);
  }
  const out = roster.map((c) => {
    const code = String(c.scrip_code);
    const match = byScrip.get(code);
    const nm = names.get(code) || {};
    const errored = failedSet.has(code) && !match;
    return {
      // status: 'matched' | 'none' | 'error'
      status: match ? 'matched' : errored ? 'error' : 'none',
      found: match ? '✓' : '',
      company: c.company || nm.company || match?.company || code,
      symbol: c.symbol || nm.symbol || '',
      scrip_code: code,
      news_dt: match?.news_dt || '',
      category: match?.category || '',
      subcategory: match?.subcategory || '',
      headline: match?.headline || (errored ? "Couldn't fetch from BSE — try again" : ''),
      pdf_url: match?.pdf_url || '',
    };
  });
  // matched first (newest), then errors, then blanks
  const rank = (s) => (s === 'matched' ? 0 : s === 'error' ? 1 : 2);
  out.sort((a, b) => {
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return (b.news_dt || '').localeCompare(a.news_dt || '');
  });
  return out;
}

/** The CS relevance buckets, for rendering filter chips. */
router.get('/announcements/buckets', (_req, res) => {
  res.json({ buckets: bucketCatalogue() });
});

/**
 * GET /api/announcements/latest
 *   ?days=2 &buckets=trading-window,results &index=Nifty50 &keyword= &limit=300
 *
 * Market-wide CS-relevant feed. Unlike the company search (which makes one BSE
 * call per company), this fetches by (category, subcategory) — BSE filters both
 * server-side — so it covers the *whole market* in a few dozen parallel calls.
 *
 * PDF links are deliberately NOT pre-resolved here: /api/pdf already falls back
 * between AttachLive and AttachHis, and resolving hundreds of links would cost
 * more than the feed itself.
 */
router.get('/announcements/latest', async (req, res) => {
  const days = clamp(req.query.days, 1, 90, 2);
  const limit = clamp(req.query.limit, 1, 2000, 300);
  const maxPages = clamp(req.query.maxPages, 1, 20, 3);
  const buckets = resolveBuckets(req.query.buckets);
  const keyword = String(req.query.keyword || '').trim().toLowerCase();
  const index = String(req.query.index || 'All');

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));

  // Market-wide queries are capped at ~30 days by BSE, so chunk the range.
  const windows = dateWindows(from, to);

  const jobs = [];
  for (const b of buckets) {
    for (const f of b.filters) {
      for (const w of windows) jobs.push({ bucket: b, filter: f, window: w });
    }
  }

  const started = Date.now();
  const settled = await pool(
    jobs.map(
      (j) => () =>
        fetchSlice(
          { from: j.window.from, to: j.window.to, category: j.filter.category, subcategory: j.filter.subcategory },
          { maxPages, concurrency: 2 },
        ),
    ),
    5,
  );

  // Merge, tagging each row with the bucket it was fetched under.
  const names = nameLookup();
  const seen = new Map();
  const perBucket = {};
  let truncated = false;
  let failedSlices = 0;

  settled.forEach((slice, i) => {
    const { bucket } = jobs[i];
    if (!slice) {
      failedSlices++;
      return;
    }
    if (slice.truncated) truncated = true;
    for (const r of slice.rows) {
      const key = r.news_id || `${r.scrip_code}|${r.news_dt}|${r.headline}`;
      if (seen.has(key)) continue;
      const nm = names.get(r.scrip_code) || {};
      seen.set(key, {
        ...r,
        symbol: nm.symbol || '',
        company: r.company || nm.company || r.scrip_code,
        bucket: bucket.id,
        bucketLabel: bucket.label,
        reference: bucket.reference || '',
        inUniverse: names.has(r.scrip_code),
      });
    }
  });

  let rows = [...seen.values()];

  // Count per bucket before narrowing, so the chips show the true feed shape.
  for (const b of buckets) perBucket[b.id] = 0;
  rows.forEach((r) => {
    perBucket[r.bucket] = (perBucket[r.bucket] || 0) + 1;
  });

  if (index && index !== 'All') {
    const allowed = new Set(companiesForIndex(index).map((c) => c.scrip_code));
    rows = rows.filter((r) => allowed.has(r.scrip_code));
  }
  if (keyword) {
    rows = rows.filter((r) =>
      `${r.headline} ${r.company} ${r.subcategory}`.toLowerCase().includes(keyword),
    );
  }

  rows.sort((a, b) => (b.news_dt || '').localeCompare(a.news_dt || ''));
  const total = rows.length;
  rows = rows.slice(0, limit);

  res.json({
    rows,
    meta: {
      from: iso(from),
      to: iso(to),
      days,
      windows: windows.length,
      slices: jobs.length,
      failedSlices,
      buckets: buckets.map((b) => b.id),
      perBucket,
      total,
      returned: rows.length,
      truncated,
      elapsedMs: Date.now() - started,
    },
  });
});

/**
 * GET /api/company/:scrip?months=12
 *
 * Full filing timeline for one company. Single-scrip queries have no date-span
 * limit at BSE, so a year comes back in one paged sweep.
 */
router.get('/company/:scrip', async (req, res) => {
  const scrip = String(req.params.scrip || '').trim();
  if (!/^\d{4,8}$/.test(scrip)) {
    return res.status(400).json({ error: 'Invalid BSE scrip code' });
  }
  const months = clamp(req.query.months, 1, 36, 12);

  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - months);

  let raw;
  try {
    raw = await fetchAnnouncements({ from, to, scripCode: scrip, category: '-1', maxPages: 40 });
  } catch (e) {
    return res.status(502).json({ error: `BSE request failed: ${e.message}` });
  }

  const names = nameLookup();
  const nm = names.get(scrip) || {};
  const rows = raw
    .map((r) => ({ ...r, ...bucketFor(r) }))
    .sort((a, b) => (b.news_dt || '').localeCompare(a.news_dt || ''));

  // Category mix, so the panel can show where this company's filings cluster.
  const byCategory = {};
  const byBucket = {};
  rows.forEach((r) => {
    byCategory[r.category || 'Uncategorised'] = (byCategory[r.category || 'Uncategorised'] || 0) + 1;
    if (r.bucket) byBucket[r.bucket] = (byBucket[r.bucket] || 0) + 1;
  });

  res.json({
    company: {
      scrip_code: scrip,
      company: nm.company || rows[0]?.company || scrip,
      symbol: nm.symbol || '',
      inUniverse: names.has(scrip),
    },
    rows,
    meta: {
      from: iso(from),
      to: iso(to),
      months,
      total: rows.length,
      csRelevant: rows.filter((r) => r.bucket).length,
      byCategory,
      byBucket,
    },
  });
});

router.post('/announcements', async (req, res) => {
  const {
    companies = [],
    from,
    to,
    category = '-1',
    keyword = '',
    mode = 'latest',
  } = req.body || {};

  if (!Array.isArray(companies) || companies.length === 0) {
    return res.status(400).json({ error: 'Provide at least one company (scrip_code).' });
  }
  if (!from || !to) return res.status(400).json({ error: 'from and to dates are required.' });
  if (from > to) return res.status(400).json({ error: 'Start date is after end date.' });

  const roster = companies
    .map((c) => ({
      scrip_code: String(c.scrip_code || '').trim(),
      company: c.company || '',
      symbol: c.symbol || '',
    }))
    .filter((c) => c.scrip_code);

  const scrips = [...new Set(roster.map((c) => c.scrip_code))];
  const names = nameLookup();

  let fetched, failed;
  try {
    ({ announcements: fetched, failed } = await fetchForScrips(scrips, { from, to, category }));
  } catch (e) {
    return res.status(502).json({ error: `BSE request failed: ${e.message}` });
  }
  const failedSet = new Set(failed);

  const totalFetched = fetched.length;
  const matched = applyKeyword(fetched, keyword);

  let rows;
  if (mode === 'latest') {
    rows = latestPerCompany(matched, roster, names, failedSet);
  } else {
    rows = [...matched]
      .sort((a, b) => (b.news_dt || '').localeCompare(a.news_dt || ''))
      .map((r) => ({
        status: 'matched',
        found: '✓',
        company: r.company || names.get(r.scrip_code)?.company || r.scrip_code,
        symbol: names.get(r.scrip_code)?.symbol || '',
        scrip_code: r.scrip_code,
        news_dt: r.news_dt,
        category: r.category,
        subcategory: r.subcategory,
        headline: r.headline,
        pdf_url: r.pdf_url,
      }));
  }

  // Verify/resolve PDF links (Live vs His) for a reasonable-sized result set.
  const urls = rows.map((r) => r.pdf_url).filter(Boolean);
  let resolved = false;
  if (urls.length > 0 && urls.length <= RESOLVE_CAP) {
    const map = await resolveMany(urls);
    rows = rows.map((r) => ({ ...r, pdf_url: r.pdf_url ? map.get(r.pdf_url) || r.pdf_url : '' }));
    resolved = true;
  }

  const withMatch = rows.filter((r) => r.found === '✓').length;

  res.json({
    rows,
    meta: {
      mode,
      companies: scrips.length,
      totalFetched,
      matched: matched.length,
      withMatch,
      failed: failed.length,
      failedScrips: failed,
      resolved,
    },
  });
});

export default router;
