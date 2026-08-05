import { Router } from 'express';
import { listIndices, companiesForIndex } from '../companies.js';
import { CATEGORIES } from '../bseClient.js';

const router = Router();

router.get('/indices', (_req, res) => {
  res.json({ indices: ['All', ...listIndices()] });
});

router.get('/categories', (_req, res) => {
  res.json({ categories: CATEGORIES });
});

router.get('/companies', (req, res) => {
  const index = req.query.index || 'All';
  res.json({ companies: companiesForIndex(String(index)) });
});

export default router;
