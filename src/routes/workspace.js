/**
 * workspace.js — the first genuinely persistent features.
 *
 * Everything here is stored per user, one document per user, so no composite
 * indexes are needed and reads are a single round-trip:
 *
 *   cs_watchlists/{uid}   { companies: [...] }   the companies a CS actually tracks
 *   cs_saved_views/{uid}  { views: [...] }       saved search/filter presets
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getDoc, setDoc, queryCollection, FirebaseError } from '../firebase.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logEvent } from '../activity.js';

const router = Router();

const WATCHLISTS = 'cs_watchlists';
const SAVED_VIEWS = 'cs_saved_views';

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const status = e instanceof FirebaseError ? e.status : 500;
    res.status(status).json({ error: e.message || 'Something went wrong' });
  }
};

// --- Watchlist -------------------------------------------------------------

router.get(
  '/workspace/watchlist',
  requireAuth,
  handle(async (req, res) => {
    const doc = await getDoc(WATCHLISTS, req.user.uid, req.idToken);
    res.json({ companies: doc?.companies || [] });
  }),
);

router.put(
  '/workspace/watchlist',
  requireAuth,
  handle(async (req, res) => {
    const incoming = Array.isArray(req.body?.companies) ? req.body.companies : [];
    // Normalise + dedupe by scrip code so the stored shape stays predictable.
    const seen = new Set();
    const companies = [];
    for (const c of incoming) {
      const scrip = String(c?.scrip_code || '').trim();
      if (!scrip || seen.has(scrip)) continue;
      seen.add(scrip);
      companies.push({
        scrip_code: scrip,
        company: String(c?.company || scrip),
        symbol: String(c?.symbol || ''),
      });
    }
    await setDoc(
      WATCHLISTS,
      req.user.uid,
      { uid: req.user.uid, companies, updatedAt: new Date() },
      req.idToken,
    );
    logEvent(req, 'watchlist.save', { count: companies.length });
    res.json({ companies });
  }),
);

// --- Saved views -----------------------------------------------------------

router.get(
  '/workspace/views',
  requireAuth,
  handle(async (req, res) => {
    const doc = await getDoc(SAVED_VIEWS, req.user.uid, req.idToken);
    res.json({ views: doc?.views || [] });
  }),
);

router.post(
  '/workspace/views',
  requireAuth,
  handle(async (req, res) => {
    const { name, filters } = req.body || {};
    if (!name || typeof filters !== 'object' || filters === null) {
      return res.status(400).json({ error: 'name and filters are required' });
    }
    const doc = await getDoc(SAVED_VIEWS, req.user.uid, req.idToken);
    const views = doc?.views || [];
    const view = {
      id: randomUUID(),
      name: String(name).trim().slice(0, 80),
      filters,
      createdAt: new Date().toISOString(),
    };
    const next = [view, ...views].slice(0, 50);
    await setDoc(
      SAVED_VIEWS,
      req.user.uid,
      { uid: req.user.uid, views: next, updatedAt: new Date() },
      req.idToken,
    );
    logEvent(req, 'view.save', { name: view.name });
    res.status(201).json({ view, views: next });
  }),
);

router.delete(
  '/workspace/views/:id',
  requireAuth,
  handle(async (req, res) => {
    const doc = await getDoc(SAVED_VIEWS, req.user.uid, req.idToken);
    const views = (doc?.views || []).filter((v) => v.id !== req.params.id);
    await setDoc(
      SAVED_VIEWS,
      req.user.uid,
      { uid: req.user.uid, views, updatedAt: new Date() },
      req.idToken,
    );
    res.json({ views });
  }),
);

// --- Admin: what the pilot user is actually doing --------------------------

router.get(
  '/admin/activity',
  requireAuth,
  requireAdmin,
  handle(async (req, res) => {
    const events = await queryCollection('cs_activity', {
      idToken: req.idToken,
      orderBy: { field: 'at', direction: 'DESCENDING' },
      limit: Math.min(Number(req.query.limit) || 100, 500),
    });
    res.json({ events });
  }),
);

export default router;
