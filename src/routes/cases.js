import { Router } from 'express';
import { queryCases, getCase, corpusStats, PENALTY_BANDS } from '../caseCorpus.js';

const router = Router();

const csv = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt;
};

/** Filter vocabulary for the UI — years, order types, outcomes, citations. */
router.get('/cases/facets', (_req, res) => {
  res.json({ stats: corpusStats(), penaltyBands: PENALTY_BANDS });
});

/**
 * GET /api/cases
 *   ?q= &years= &authorities= &orderTypes= &outcomes= &bands= &citations=
 *   &company= &sort=recent|relevance|penalty|oldest &limit= &offset=
 *
 * Browsing and searching are the same endpoint: without `q` you get the filtered
 * set newest-first, with `q` you get ranked results carrying a snippet. Order
 * text is never included here — it's large, and only the detail view needs it.
 */
router.get('/cases', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length > 300) return res.status(400).json({ error: 'Query is too long' });

  const started = Date.now();
  const out = queryCases({
    q,
    years: csv(req.query.years),
    authorities: csv(req.query.authorities),
    orderTypes: csv(req.query.orderTypes),
    outcomes: csv(req.query.outcomes),
    bands: csv(req.query.bands),
    citations: csv(req.query.citations),
    company: String(req.query.company || '').trim().slice(0, 120),
    sort: ['recent', 'relevance', 'penalty', 'oldest'].includes(String(req.query.sort))
      ? String(req.query.sort)
      : q
        ? 'relevance'
        : 'recent',
    limit: clamp(req.query.limit, 1, 100, 30),
    offset: clamp(req.query.offset, 0, 5000, 0),
  });

  res.json({
    query: q,
    results: out.results,
    facets: out.facets,
    meta: {
      total: out.total,
      returned: out.results.length,
      elapsedMs: Date.now() - started,
      corpus: corpusStats().count,
    },
  });
});

/** One order, including its full extracted text. */
router.get('/cases/:id', (req, res) => {
  const c = getCase(String(req.params.id));
  if (!c) return res.status(404).json({ error: 'Order not found' });
  res.json({ case: c });
});

export default router;
