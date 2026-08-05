import { Router } from 'express';
import { fetchForScrips, resolveMany } from '../bseClient.js';
import { nameLookup } from '../companies.js';

const router = Router();

const RESOLVE_CAP = 150; // don't verify links for huge result sets (too slow)

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
