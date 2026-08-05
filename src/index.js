import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import companyRoutes from './routes/companies.js';
import announcementRoutes from './routes/announcements.js';
import { pdfRouter, exportRouter } from './routes/export.js';

const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      // allow same-origin / curl (no origin) and configured frontends
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  }),
);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'cs-dashboard-api' }));

// Public auth routes
app.use('/api/auth', authRoutes);

// Public PDF proxy — opened directly in a browser tab, so it can't carry a
// Bearer token. Safe: it only serves validated BSE public attachment URLs.
app.use('/api', pdfRouter);

// Everything below requires a valid token
app.use('/api', requireAuth, companyRoutes);
app.use('/api', requireAuth, announcementRoutes);
app.use('/api', requireAuth, exportRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(config.port, () => {
  console.log(`CS Dashboard API listening on http://localhost:${config.port}`);
});
