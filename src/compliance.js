/**
 * compliance.js — statutory compliance calendar for a listed company's CS.
 *
 * Deliberately a *rules* file, not a table of dates: each obligation declares
 * its cadence and offset, and occurrences are computed for whatever window the
 * caller asks about. That way the calendar stays correct next financial year
 * without anyone re-keying dates.
 *
 * Indian financial year runs 1 April – 31 March. Quarters end 30 Jun, 30 Sep,
 * 31 Dec, 31 Mar (Q1–Q4).
 *
 * ⚠️  These are the standard timelines as commonly applied, with the governing
 * provision cited on every rule so a CS can verify. They are a planning aid,
 * not legal advice: extensions, exemptions and category-specific carve-outs
 * (SME listings, high-value debt listed entities, top-100/500/1000 by market
 * cap) all shift these. Confirm against the current regulation before relying
 * on a date.
 */

/** Cadence types the generator understands. */
const FREQ = {
  QUARTERLY: 'quarterly', // offsetDays after each quarter end
  HALF_YEARLY: 'half-yearly', // offsetDays after each half-year end (30 Sep, 31 Mar)
  ANNUAL_FY: 'annual-fy', // offsetDays after financial year end (31 Mar)
  ANNUAL_FIXED: 'annual-fixed', // a fixed calendar date, e.g. 30 April
  AGM_RELATIVE: 'agm-relative', // offsetDays after the AGM
};

export const AUTHORITIES = [
  'SEBI LODR',
  'SEBI PIT',
  'SEBI SAST',
  'Companies Act',
  'Depositories Regs',
];

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string} title
 * @property {string} authority
 * @property {string} reference
 * @property {'Filing'|'Meeting'|'Payment'|'Certificate'|'Disclosure'} kind
 * @property {string} frequency
 * @property {number} [offsetDays]
 * @property {string} [fixed]        'MM-DD' for ANNUAL_FIXED
 * @property {number[]} [skipQuarters] 1=Apr-Jun … 4=Jan-Mar
 * @property {string} [periodLabel]  overrides the default period label
 * @property {string} [note]
 */

/** @type {Rule[]} */
export const RULES = [
  // ---------------------------------------------------------------- SEBI LODR
  {
    id: 'lodr-13-3',
    title: 'Statement on investor complaints',
    authority: 'SEBI LODR',
    reference: 'Reg. 13(3)',
    kind: 'Filing',
    frequency: FREQ.QUARTERLY,
    offsetDays: 21,
    note: 'Number of complaints pending, received, disposed and unresolved for the quarter.',
  },
  {
    id: 'lodr-27-2',
    title: 'Corporate Governance Report',
    authority: 'SEBI LODR',
    reference: 'Reg. 27(2)(a)',
    kind: 'Filing',
    frequency: FREQ.QUARTERLY,
    offsetDays: 21,
  },
  {
    id: 'lodr-31-shp',
    title: 'Shareholding Pattern',
    authority: 'SEBI LODR',
    reference: 'Reg. 31(1)(b)',
    kind: 'Filing',
    frequency: FREQ.QUARTERLY,
    offsetDays: 21,
  },
  {
    id: 'lodr-33-quarterly',
    title: 'Quarterly financial results',
    authority: 'SEBI LODR',
    reference: 'Reg. 33(3)(a)',
    kind: 'Filing',
    frequency: FREQ.QUARTERLY,
    offsetDays: 45,
    skipQuarters: [4],
    note: 'Q4 is covered by the annual audited results instead.',
  },
  {
    id: 'lodr-32-deviation',
    title: 'Statement of deviation / variation in use of funds',
    authority: 'SEBI LODR',
    reference: 'Reg. 32(1)',
    kind: 'Disclosure',
    frequency: FREQ.QUARTERLY,
    offsetDays: 45,
    note: 'Submitted along with the quarterly results, where the company has raised funds.',
  },
  {
    id: 'lodr-33-annual',
    title: 'Annual audited financial results',
    authority: 'SEBI LODR',
    reference: 'Reg. 33(3)(d)',
    kind: 'Filing',
    frequency: FREQ.ANNUAL_FY,
    offsetDays: 60,
  },
  {
    id: 'lodr-23-9',
    title: 'Related Party Transactions disclosure',
    authority: 'SEBI LODR',
    reference: 'Reg. 23(9)',
    kind: 'Disclosure',
    frequency: FREQ.HALF_YEARLY,
    offsetDays: 45,
    note: 'To be filed on the date of publication of the half-yearly standalone and consolidated results. Also placed on the website.',
  },
  {
    id: 'lodr-24a',
    title: 'Annual Secretarial Compliance Report',
    authority: 'SEBI LODR',
    reference: 'Reg. 24A',
    kind: 'Certificate',
    frequency: FREQ.ANNUAL_FY,
    offsetDays: 60,
    note: 'From a Practising Company Secretary. The Secretarial Audit Report itself forms part of the annual report.',
  },
  {
    id: 'lodr-7-3',
    title: 'Compliance certificate on share transfer facility',
    authority: 'SEBI LODR',
    reference: 'Reg. 7(3)',
    kind: 'Certificate',
    frequency: FREQ.ANNUAL_FY,
    offsetDays: 30,
    note: 'Certified by the compliance officer and the RTA.',
  },
  {
    id: 'lodr-40-9',
    title: 'PCS certificate on transfer / transmission of securities',
    authority: 'SEBI LODR',
    reference: 'Reg. 40(9)',
    kind: 'Certificate',
    frequency: FREQ.ANNUAL_FY,
    offsetDays: 30,
  },
  {
    id: 'lodr-14-fees',
    title: 'Annual listing fees to the exchange',
    authority: 'SEBI LODR',
    reference: 'Reg. 14',
    kind: 'Payment',
    frequency: FREQ.ANNUAL_FIXED,
    fixed: '04-30',
  },
  {
    id: 'lodr-34-ar',
    title: 'Annual Report to the stock exchange',
    authority: 'SEBI LODR',
    reference: 'Reg. 34(1)',
    kind: 'Filing',
    frequency: FREQ.AGM_RELATIVE,
    offsetDays: 21,
    note: 'Within 21 working days of it being approved and adopted at the AGM. Shown here as 21 calendar days — check the working-day count.',
  },

  // ------------------------------------------------------- Depositories Regs
  {
    id: 'dp-76-recon',
    title: 'Reconciliation of Share Capital Audit Report',
    authority: 'Depositories Regs',
    reference: 'Reg. 76, D&P Regulations 2018',
    kind: 'Certificate',
    frequency: FREQ.QUARTERLY,
    offsetDays: 30,
    note: 'From a Practising Company Secretary or Chartered Accountant.',
  },

  // ----------------------------------------------------------------- SEBI PIT
  {
    id: 'pit-9-window',
    title: 'Trading window closure begins',
    authority: 'SEBI PIT',
    reference: 'Reg. 9, Sch. B',
    kind: 'Disclosure',
    frequency: FREQ.QUARTERLY,
    offsetDays: 0,
    note: 'Window closes from the end of every quarter and reopens 48 hours after the results are declared. The CS must notify all designated persons.',
  },

  // ------------------------------------------------------------ Companies Act
  {
    id: 'ca-96-agm',
    title: 'Annual General Meeting',
    authority: 'Companies Act',
    reference: 's.96',
    kind: 'Meeting',
    frequency: FREQ.ANNUAL_FY,
    offsetDays: 183,
    note: 'Within 6 months of financial year end, and not more than 15 months after the previous AGM.',
  },
  {
    id: 'ca-aoc4',
    title: 'AOC-4 — financial statements with the RoC',
    authority: 'Companies Act',
    reference: 's.137',
    kind: 'Filing',
    frequency: FREQ.AGM_RELATIVE,
    offsetDays: 30,
  },
  {
    id: 'ca-mgt7',
    title: 'MGT-7 — annual return with the RoC',
    authority: 'Companies Act',
    reference: 's.92',
    kind: 'Filing',
    frequency: FREQ.AGM_RELATIVE,
    offsetDays: 60,
  },
  {
    id: 'ca-dir3kyc',
    title: 'DIR-3 KYC for all directors',
    authority: 'Companies Act',
    reference: 'Rule 12A, Appointment & Qualification Rules',
    kind: 'Filing',
    frequency: FREQ.ANNUAL_FIXED,
    fixed: '09-30',
  },
  {
    id: 'ca-dpt3',
    title: 'DPT-3 — return of deposits / exempt deposits',
    authority: 'Companies Act',
    reference: 'Rule 16, Deposit Rules',
    kind: 'Filing',
    frequency: FREQ.ANNUAL_FIXED,
    fixed: '06-30',
  },
  {
    id: 'ca-msme1-h1',
    title: 'MSME-1 — half-yearly return of dues to MSMEs',
    authority: 'Companies Act',
    reference: 's.405 order',
    kind: 'Filing',
    frequency: FREQ.ANNUAL_FIXED,
    fixed: '04-30',
    periodLabel: 'Oct–Mar half',
    note: 'Reports outstanding dues for the October–March half, i.e. the second half of the preceding financial year.',
  },
  {
    id: 'ca-msme1-h2',
    title: 'MSME-1 — half-yearly return of dues to MSMEs',
    authority: 'Companies Act',
    reference: 's.405 order',
    kind: 'Filing',
    frequency: FREQ.ANNUAL_FIXED,
    fixed: '10-31',
    periodLabel: 'Apr–Sep half',
  },
];

/**
 * Obligations with no fixed due date — they hang off an event. These belong in a
 * reference panel, not on a calendar grid, but a CS still needs them at hand.
 */
export const EVENT_RULES = [
  {
    id: 'lodr-29-intimation',
    title: 'Prior intimation of board meeting',
    authority: 'SEBI LODR',
    reference: 'Reg. 29',
    trigger: 'Before a board meeting',
    deadline: '5 clear days ahead for financial results; 2 working days for buyback, dividend, fund raising and the other Reg. 29(2) items.',
  },
  {
    id: 'lodr-30-outcome',
    title: 'Outcome of board meeting',
    authority: 'SEBI LODR',
    reference: 'Reg. 30(6)',
    trigger: 'On conclusion of the board meeting',
    deadline: 'Within 30 minutes of closure of the meeting.',
  },
  {
    id: 'lodr-30-material',
    title: 'Disclosure of material events',
    authority: 'SEBI LODR',
    reference: 'Reg. 30 + Sch. III',
    trigger: 'On occurrence of a material event',
    deadline: 'Within 12 hours if it originates within the company; 24 hours if from a board decision; 30 minutes where it arises from a board meeting.',
  },
  {
    id: 'lodr-44-voting',
    title: 'Voting results of a general meeting',
    authority: 'SEBI LODR',
    reference: 'Reg. 44(3)',
    trigger: 'After any general meeting / postal ballot',
    deadline: 'Within 2 working days of conclusion, with the scrutinizer’s report.',
  },
  {
    id: 'lodr-42-record',
    title: 'Intimation of record date / book closure',
    authority: 'SEBI LODR',
    reference: 'Reg. 42',
    trigger: 'Before fixing a record date',
    deadline: 'At least 7 working days’ prior intimation (excluding the date of intimation and the record date).',
  },
  {
    id: 'ca-mgt14',
    title: 'MGT-14 — filing of board / special resolutions',
    authority: 'Companies Act',
    reference: 's.117',
    trigger: 'On passing a resolution requiring filing',
    deadline: 'Within 30 days of passing.',
  },
  {
    id: 'ca-173',
    title: 'Minimum four board meetings a year',
    authority: 'Companies Act',
    reference: 's.173(1)',
    trigger: 'Ongoing through the financial year',
    deadline: 'At least 4 meetings per year with no more than 120 days between two consecutive meetings.',
  },
  {
    id: 'pit-7-2',
    title: 'Continual disclosure of trades by designated persons',
    authority: 'SEBI PIT',
    reference: 'Reg. 7(2)',
    trigger: 'On a trade crossing ₹10 lakh in value',
    deadline: 'Designated person tells the company within 2 trading days; the company tells the exchange within 2 trading days of receipt.',
  },
  {
    id: 'sast-29',
    title: 'SAST acquisition / disposal disclosures',
    authority: 'SEBI SAST',
    reference: 'Reg. 29',
    trigger: 'On crossing 5%, or a 2% change above 5%',
    deadline: 'Within 2 working days of receipt of allotment advice or acquisition.',
  },
];

// ---------------------------------------------------------------- generation

/** The Indian financial year a date falls in. FY 2026-27 → fyStart year 2026. */
export function fyOf(date) {
  const y = date.getFullYear();
  return date.getMonth() >= 3 ? y : y - 1; // month 3 = April
}

export function fyLabel(fyStart) {
  return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
}

const d = (y, m, day) => new Date(y, m, day); // m is 0-indexed

/** Quarter ends for a financial year: Q1 Jun 30 … Q4 Mar 31 (next calendar year). */
function quarterEnds(fyStart) {
  return [
    { q: 1, label: 'Q1 (Apr–Jun)', end: d(fyStart, 5, 30) },
    { q: 2, label: 'Q2 (Jul–Sep)', end: d(fyStart, 8, 30) },
    { q: 3, label: 'Q3 (Oct–Dec)', end: d(fyStart, 11, 31) },
    { q: 4, label: 'Q4 (Jan–Mar)', end: d(fyStart + 1, 2, 31) },
  ];
}

function halfEnds(fyStart) {
  return [
    { h: 1, label: 'H1 (Apr–Sep)', end: d(fyStart, 8, 30) },
    { h: 2, label: 'H2 (Oct–Mar)', end: d(fyStart + 1, 2, 31) },
  ];
}

const addDays = (date, n) => {
  const out = new Date(date);
  out.setDate(out.getDate() + n);
  return out;
};

const isoLocal = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

/**
 * All occurrences of every rule for one financial year.
 * `agmDate` (YYYY-MM-DD) drives the AGM-relative filings; it defaults to the
 * s.96 outer limit of 30 September.
 */
export function occurrencesForFy(fyStart, agmDate) {
  const fyEnd = d(fyStart + 1, 2, 31);
  const agm = agmDate ? new Date(agmDate + 'T00:00:00') : d(fyStart + 1, 8, 30);
  const out = [];

  const push = (rule, due, period) =>
    out.push({
      id: `${rule.id}@${isoLocal(due)}`,
      ruleId: rule.id,
      title: rule.title,
      authority: rule.authority,
      reference: rule.reference,
      kind: rule.kind,
      note: rule.note || '',
      period,
      due: isoLocal(due),
      fy: fyLabel(fyStart),
    });

  for (const rule of RULES) {
    switch (rule.frequency) {
      case FREQ.QUARTERLY:
        for (const q of quarterEnds(fyStart)) {
          if (rule.skipQuarters?.includes(q.q)) continue;
          push(rule, addDays(q.end, rule.offsetDays ?? 0), q.label);
        }
        break;
      case FREQ.HALF_YEARLY:
        for (const h of halfEnds(fyStart)) {
          push(rule, addDays(h.end, rule.offsetDays ?? 0), h.label);
        }
        break;
      case FREQ.ANNUAL_FY:
        push(rule, addDays(fyEnd, rule.offsetDays ?? 0), `FY ${fyLabel(fyStart)}`);
        break;
      case FREQ.ANNUAL_FIXED: {
        const [mm, dd] = rule.fixed.split('-').map(Number);
        // Fixed dates between Jan and Mar fall in the FY's second calendar year.
        const year = mm >= 4 ? fyStart : fyStart + 1;
        push(rule, d(year, mm - 1, dd), rule.periodLabel || `FY ${fyLabel(fyStart)}`);
        break;
      }
      case FREQ.AGM_RELATIVE:
        push(rule, addDays(agm, rule.offsetDays ?? 0), `AGM ${isoLocal(agm)}`);
        break;
      default:
        break;
    }
  }

  out.sort((a, b) => a.due.localeCompare(b.due));
  return out;
}

/**
 * Occurrences due in [from, to]. Spans FY boundaries by generating each FY the
 * window touches, plus the one before (whose AGM-relative and Q4 filings spill
 * into the next year).
 */
export function occurrencesBetween(from, to, agmDate) {
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  const fys = new Set();
  for (let y = fyOf(start) - 1; y <= fyOf(end) + 1; y++) fys.add(y);

  const all = [];
  for (const fy of fys) all.push(...occurrencesForFy(fy, agmDate));

  const seen = new Set();
  return all
    .filter((o) => o.due >= from && o.due <= to)
    .filter((o) => (seen.has(o.id) ? false : seen.add(o.id)))
    .sort((a, b) => a.due.localeCompare(b.due));
}
