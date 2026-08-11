/**
 * csRelevance.js — what a Company Secretary actually needs to see.
 *
 * BSE publishes ~20,000 announcements a month. Most are noise for a CS. These
 * buckets narrow that to the filings that carry a secretarial or compliance
 * consequence, and they do it *server-side*: each bucket is a list of
 * (category, subcategory) pairs, and BSE's `subcategory` query param filters by
 * exact name. So "show me trading window closures" is one cheap call, not a
 * scan of 5,000 Insider Trading rows.
 *
 * The subcategory strings below are BSE's own, taken from live responses — they
 * must match exactly or the filter silently returns nothing. If BSE renames
 * one, this file is the only place to patch.
 */

/**
 * @typedef {Object} Bucket
 * @property {string} id
 * @property {string} label      short name for chips/columns
 * @property {string} why        why a CS cares — shown as help text
 * @property {string} [reference] governing regulation, where there is one
 * @property {{category: string, subcategory: string}[]} filters
 */

/** @type {Bucket[]} */
export const CS_BUCKETS = [
  {
    id: 'trading-window',
    label: 'Trading Window',
    why: 'Closure/reopening intimations — the CS owns the designated-persons list and the window itself.',
    reference: 'SEBI (PIT) Reg. 9',
    filters: [{ category: 'Insider Trading / SAST', subcategory: 'Closure of Trading Window' }],
  },
  {
    id: 'board-meetings',
    label: 'Board Meetings',
    why: 'Prior intimation and outcome — the core Reg. 29/30 cycle the CS runs.',
    reference: 'LODR Reg. 29, 30',
    filters: [
      { category: 'Board Meeting', subcategory: 'Board Meeting' },
      { category: 'Board Meeting', subcategory: 'Outcome of Board Meeting' },
      { category: 'Company Update', subcategory: 'Board Meeting Rescheduled' },
      { category: 'Others', subcategory: 'Outcome without intimation' },
    ],
  },
  {
    id: 'general-meetings',
    label: 'AGM / EGM / Postal Ballot',
    why: 'Notices, proceedings, scrutinizer reports and voting results — squarely the CS remit.',
    reference: 'Companies Act s.96–110, LODR Reg. 44',
    filters: [
      { category: 'AGM/EGM', subcategory: 'AGM' },
      { category: 'AGM/EGM', subcategory: 'EGM' },
      { category: 'AGM/EGM', subcategory: 'Postal Ballot' },
      { category: 'AGM/EGM', subcategory: 'Court Convened Meeting' },
    ],
  },
  {
    id: 'corp-actions',
    label: 'Corporate Actions',
    why: 'Record dates, book closure, dividend, bonus, splits — all need exchange intimation and registrar coordination.',
    reference: 'LODR Reg. 42',
    filters: [
      { category: 'Corp. Action', subcategory: 'Record Date' },
      { category: 'Corp. Action', subcategory: 'Book Closure' },
      { category: 'Corp. Action', subcategory: 'Dividend' },
      { category: 'Corp. Action', subcategory: 'Bonus' },
      { category: 'Corp. Action', subcategory: 'Sub-division / Stock Split' },
      { category: 'Corp. Action', subcategory: 'Bonds / Right issue' },
    ],
  },
  {
    id: 'insider-sast',
    label: 'Insider Trading & SAST',
    why: 'Substantial acquisition and shareholding disclosures the CS receives, records and forwards.',
    reference: 'SEBI (SAST) Reg. 29, 31; (PIT) Reg. 7',
    filters: [
      {
        category: 'Insider Trading / SAST',
        subcategory: 'Disclosures under Reg. 29(1) of SEBI (SAST) Regulations, 2011',
      },
      {
        category: 'Insider Trading / SAST',
        subcategory: 'Disclosures under Reg. 29(2) of SEBI (SAST) Regulations, 2011',
      },
      {
        category: 'Insider Trading / SAST',
        subcategory: 'Disclosures under Reg. 31(1) and 31(2) of SEBI (SAST) Regulations, 2011',
      },
      {
        category: 'Insider Trading / SAST',
        subcategory: 'Disclosures under Reg. 10(6) of SEBI (SAST) Regulations, 2011',
      },
      {
        category: 'Insider Trading / SAST',
        subcategory:
          'Disclosures under Reg. 10(5) in respect of acquisition under Reg. 10(1)(a) of SEBI (SAST) Reg. 2011',
      },
    ],
  },
  {
    id: 'results',
    label: 'Financial Results',
    why: 'Reg. 33 results drive the trading-window reopening and the results-linked filing chain.',
    reference: 'LODR Reg. 33',
    filters: [{ category: 'Result', subcategory: 'Financial Results' }],
  },
  {
    id: 'kmp-changes',
    label: 'Directors & KMP',
    why: 'Appointments, resignations and cessations — each triggers MCA filings and register updates.',
    reference: 'LODR Reg. 30 Sch. III, Companies Act s.170',
    filters: [
      { category: 'Company Update', subcategory: 'Change in Management' },
      { category: 'Company Update', subcategory: 'Change in Directorate' },
      { category: 'Company Update', subcategory: 'Resignation of Director' },
      { category: 'Company Update', subcategory: 'Cessation' },
      {
        category: 'Company Update',
        subcategory: 'Appointment of Company Secretary / Compliance Officer',
      },
      { category: 'Company Update', subcategory: 'Appointment of Statutory Auditor/s' },
    ],
  },
  {
    id: 'governance',
    label: 'Governance & Secretarial',
    why: 'Annual report, CEO/CFO certification, BRSR and share-certificate matters the CS signs off.',
    reference: 'LODR Reg. 34, 17(8), 39(3)',
    filters: [
      { category: 'Others', subcategory: 'Reg. 34 (1) Annual Report' },
      { category: 'Others', subcategory: 'Certificate from CEO/CFO' },
      {
        category: 'Others',
        subcategory: 'Business Responsibility and Sustainability Reporting (BRSR)',
      },
      {
        category: 'Others',
        subcategory: 'Reg. 39 (3) - Details of Loss of Certificate / Duplicate Certificate',
      },
    ],
  },
  {
    id: 'disclosures',
    label: 'Statutory Disclosures',
    why: 'Deviation statements, newspaper publications, credit rating and monitoring reports — recurring LODR obligations.',
    reference: 'LODR Reg. 32, 47, 30',
    filters: [
      {
        category: 'Company Update',
        subcategory: 'Reg. 32 (1), (3) - Statement of Deviation & Variation',
      },
      { category: 'Company Update', subcategory: 'Newspaper Publication' },
      { category: 'Company Update', subcategory: 'Credit Rating' },
      { category: 'Company Update', subcategory: 'Monitoring Agency Report' },
    ],
  },
];

export const BUCKET_IDS = CS_BUCKETS.map((b) => b.id);

/** Public shape for the frontend — filters are an implementation detail. */
export function bucketCatalogue() {
  return CS_BUCKETS.map(({ id, label, why, reference, filters }) => ({
    id,
    label,
    why,
    reference,
    filterCount: filters.length,
  }));
}

/** Resolve a comma-separated id list (or empty = all) to Bucket objects. */
export function resolveBuckets(ids) {
  if (!ids) return CS_BUCKETS;
  const wanted = new Set(
    String(ids)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (wanted.size === 0) return CS_BUCKETS;
  const picked = CS_BUCKETS.filter((b) => wanted.has(b.id));
  return picked.length > 0 ? picked : CS_BUCKETS;
}

/** (category, subcategory) -> bucket, for tagging rows we didn't fetch per-bucket. */
const BY_PAIR = new Map();
for (const b of CS_BUCKETS) {
  for (const f of b.filters) {
    BY_PAIR.set(`${f.category}||${f.subcategory}`.toLowerCase(), b);
  }
}

/**
 * Tag an arbitrary announcement row with its CS bucket, if any.
 * Used by the company timeline, where rows arrive unfiltered.
 */
export function bucketFor(row) {
  const b = BY_PAIR.get(`${row.category}||${row.subcategory}`.toLowerCase());
  return b ? { bucket: b.id, bucketLabel: b.label } : { bucket: '', bucketLabel: '' };
}
