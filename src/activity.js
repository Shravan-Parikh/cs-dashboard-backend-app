/**
 * activity.js — lightweight usage log.
 *
 * The point of the pilot is learning which features earn their place, so every
 * meaningful action lands in `cs_activity`. Writes are fire-and-forget: a
 * logging failure must never break the request the user actually made.
 */

import { addDoc } from './firebase.js';

const COLLECTION = 'cs_activity';

/**
 * @param {object} ctx  an Express req (or any { user:{uid}, idToken })
 * @param {string} event  dotted event name, e.g. 'announcements.search'
 * @param {object} meta   small, non-sensitive detail
 */
export function logEvent(ctx, event, meta = {}) {
  const uid = ctx?.user?.uid;
  const idToken = ctx?.idToken;
  if (!uid || !idToken) return;

  addDoc(
    COLLECTION,
    {
      uid,
      event,
      meta,
      at: new Date(),
    },
    idToken,
  ).catch(() => {
    /* logging is best-effort by design */
  });
}
