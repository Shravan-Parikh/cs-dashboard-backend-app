import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import companyRoutes from './routes/companies.js';
import announcementRoutes from './routes/announcements.js';
import exportRoutes from './routes/export.js';

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

// Everything below requires a valid token
app.use('/api', requireAuth, companyRoutes);
app.use('/api', requireAuth, announcementRoutes);
app.use('/api', requireAuth, exportRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(config.port, () => {
  console.log(`CS Dashboard API listening on http://localhost:${config.port}`);
});
