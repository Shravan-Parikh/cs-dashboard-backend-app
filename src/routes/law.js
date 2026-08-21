import { Router } from 'express';
import {
  listDocuments,
  getDocument,
  getChunk,
  corpusStats,
  search,
} from '../lawCorpus.js';

const router = Router();

const csv = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The document library — metadata only, no chunk bodies. */
router.get('/law/documents', (_req, res) => {
  res.json({ documents: listDocuments(), stats: corpusStats() });
});

/**
 * GET /api/law/search?q=…&topics=PIT&docs=sebi-pit-regulations-2015&limit=25
 *
 * Ranked by IDF-weighted term frequency plus adjacency and phrase bonuses, so a
 * rare discriminating term ("closure") outranks a ubiquitous one ("trading").
 * Snippets come back with <mark> spans already applied.
 */
router.get('/law/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'A search query is required' });
  if (q.length > 300) return res.status(400).json({ error: 'Query is too long' });

  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const started = Date.now();
  const { results, total, tokens } = search(q, {
    topics: csv(req.query.topics),
    docIds: csv(req.query.docs),
    limit,
  });

  res.json({
    query: q,
    results,
    meta: {
      total,
      returned: results.length,
      tokens,
      elapsedMs: Date.now() - started,
      corpus: corpusStats(),
    },
  });
});

/** One document with all of its chunks, for reading straight through. */
router.get('/law/documents/:id', (req, res) => {
  const doc = getDocument(String(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json({ document: doc });
});

/** A single chunk — used to expand a search hit to its full clause text. */
router.get('/law/chunk', (req, res) => {
  const chunk = getChunk(String(req.query.id || ''));
  if (!chunk) return res.status(404).json({ error: 'Passage not found' });
  res.json({ chunk });
});

export default router;
