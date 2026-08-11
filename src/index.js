import express from 'express';
import cors from 'cors';
import { config, assertConfig } from './config.js';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import companyRoutes from './routes/companies.js';
import announcementRoutes from './routes/announcements.js';
import complianceRoutes from './routes/compliance.js';
import workspaceRoutes from './routes/workspace.js';
import { pdfRouter, exportRouter } from './routes/export.js';

assertConfig();

const app = express();

/**
 * An allowed origin is either an exact match or a `*.` wildcard entry, so a
 * single `https://*.vercel.app` covers every preview deployment without
 * re-configuring the service on each push.
 */
function originAllowed(origin) {
  return config.corsOrigins.some((allowed) => {
    if (allowed === origin) return true;
    if (!allowed.includes('*')) return false;
    const pattern = new RegExp(
      `^${allowed.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*')}$`,
    );
    return pattern.test(origin);
  });
}

app.use(
  cors({
    origin: (origin, cb) => {
      // allow same-origin / curl / server-to-server (no Origin header)
      if (!origin || originAllowed(origin)) return cb(null, true);
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
app.use('/api', requireAuth, complianceRoutes);
app.use('/api', requireAuth, exportRouter);

// Persistent per-user data (watchlist, saved views) + admin views. These carry
// their own requireAuth so the admin guard can run straight after it.
app.use('/api', workspaceRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(config.port, () => {
  console.log(`CS Dashboard API listening on http://localhost:${config.port}`);
});
