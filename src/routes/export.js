import { Router } from 'express';
import archiver from 'archiver';
import { downloadPdf, resolvePdfUrl } from '../bseClient.js';

// Public router: only the read-only PDF proxy. It's public because the link is
// opened in a new browser tab (which can't send the Authorization header), and
// it only ever serves BSE's own public attachment URLs (validated below).
export const pdfRouter = Router();

// Authenticated router: the batch ZIP export (called via fetch with a token).
export const exportRouter = Router();

const BSE_HOST = 'www.bseindia.com';

/** Only allow proxying BSE's own attachment URLs (no open proxy). */
function isBseAttachment(url) {
  try {
    const u = new URL(url);
    return u.hostname === BSE_HOST && u.pathname.includes('/corpfiling/');
  } catch {
    return false;
  }
}

/**
 * GET /api/pdf?url=<bse attachment url>
 * Streams the PDF through our server (BSE blocks refererless browser clicks
 * and CORS), resolving Live/His automatically.
 */
pdfRouter.get('/pdf', async (req, res) => {
  const url = String(req.query.url || '');
  if (!isBseAttachment(url)) return res.status(400).json({ error: 'Invalid PDF url' });
  try {
    const buf = await downloadPdf(url);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${url.split('/').pop()}"`);
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: `Could not fetch PDF: ${e.message}` });
  }
});

/**
 * POST /api/export/zip  body: { items: [{ url, name }], filename? }
 * Bundles the given PDFs into a ZIP and streams it back.
 */
exportRouter.post('/export/zip', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const filename = (req.body?.filename || 'bse_pdfs').replace(/[^A-Za-z0-9_-]/g, '_');
  const valid = items.filter((i) => i && isBseAttachment(i.url));
  if (valid.length === 0) return res.status(400).json({ error: 'No valid PDF items' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', () => { try { res.status(500).end(); } catch { /* noop */ } });
  archive.pipe(res);

  const seen = new Set();
  for (const item of valid) {
    try {
      const working = await resolvePdfUrl(item.url);
      const buf = await downloadPdf(working);
      let base = (item.name || working.split('/').pop() || 'file.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
      if (!base.toLowerCase().endsWith('.pdf')) base += '.pdf';
      let name = base;
      let n = 1;
      while (seen.has(name)) name = base.replace(/\.pdf$/i, `_${n++}.pdf`);
      seen.add(name);
      archive.append(buf, { name });
    } catch {
      // skip failures, keep going
    }
  }
  await archive.finalize();
});
