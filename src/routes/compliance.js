import { Router } from 'express';
import {
  occurrencesForFy,
  occurrencesBetween,
  fyOf,
  fyLabel,
  EVENT_RULES,
  AUTHORITIES,
  RULES,
} from '../compliance.js';

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const localIso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * GET /api/compliance?fy=2026            → whole financial year 2026-27
 * GET /api/compliance?from=…&to=…        → an explicit window
 *   &agmDate=YYYY-MM-DD                  → drives AOC-4 / MGT-7 / Reg. 34(1)
 *
 * Dates are computed from rules on each request, so the calendar is correct for
 * any FY without anyone maintaining a date table.
 */
router.get('/compliance', (req, res) => {
  const agmDate = ISO_DATE.test(String(req.query.agmDate || ''))
    ? String(req.query.agmDate)
    : undefined;

  const from = String(req.query.from || '');
  const to = String(req.query.to || '');

  let occurrences;
  let scope;

  if (from && to) {
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    }
    if (from > to) return res.status(400).json({ error: 'from is after to' });
    occurrences = occurrencesBetween(from, to, agmDate);
    scope = { type: 'range', from, to };
  } else {
    const now = new Date();
    const fy = Number.isFinite(Number(req.query.fy)) ? Number(req.query.fy) : fyOf(now);
    if (fy < 2000 || fy > 2100) return res.status(400).json({ error: 'fy out of range' });
    occurrences = occurrencesForFy(fy, agmDate);
    // A financial year's obligations don't all fall inside it: Q4 filings land in
    // April–May and the AGM chain runs to November. Report the real span of due
    // dates rather than 1 Apr – 31 Mar, which the results would contradict.
    scope = {
      type: 'fy',
      fy,
      label: fyLabel(fy),
      fyFrom: `${fy}-04-01`,
      fyTo: `${fy + 1}-03-31`,
      from: occurrences[0]?.due || `${fy}-04-01`,
      to: occurrences[occurrences.length - 1]?.due || `${fy + 1}-03-31`,
      spillsBeyondFy: occurrences.some((o) => o.due > `${fy + 1}-03-31`),
    };
  }

  const today = localIso(new Date());
  const byAuthority = {};
  occurrences.forEach((o) => {
    byAuthority[o.authority] = (byAuthority[o.authority] || 0) + 1;
  });

  res.json({
    occurrences,
    events: EVENT_RULES,
    meta: {
      scope,
      today,
      agmDate: agmDate || null,
      agmAssumed: !agmDate,
      total: occurrences.length,
      upcoming: occurrences.filter((o) => o.due >= today).length,
      overdue: occurrences.filter((o) => o.due < today).length,
      byAuthority,
      authorities: AUTHORITIES,
      ruleCount: RULES.length,
      eventRuleCount: EVENT_RULES.length,
      disclaimer:
        'Standard statutory timelines with the governing provision cited on each item. ' +
        'A planning aid, not legal advice — extensions, exemptions and entity-category ' +
        'carve-outs (SME, HVDLE, top-100/500/1000 by market cap) can shift these dates. ' +
        'Verify against the current regulation before relying on any date.',
    },
  });
});

export default router;
