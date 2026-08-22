/**
 * meetings.js — the statutory timeline around a meeting.
 *
 * A calendar entry tells a CS when the board meets. What they actually need is
 * everything that hangs off that date: notice out 7 days before, exchange
 * intimation 5 clear days before if results are on the agenda, outcome filed
 * within 30 minutes of closure, draft minutes circulated within 15 days, minutes
 * signed within 30. So a meeting here is a date plus a derived checklist.
 *
 * Same approach as compliance.js: rules with offsets, dates computed on request,
 * governing provision cited on every item.
 *
 * ⚠️  Standard timelines, not legal advice. Several are stated in *working* days
 * or *clear* days in the statute; those are flagged rather than silently turned
 * into calendar days, because the difference decides whether a filing is late.
 */

export const MEETING_TYPES = [
  {
    id: 'board',
    label: 'Board Meeting',
    note: 'Meeting of the board of directors under s.173.',
  },
  {
    id: 'committee',
    label: 'Committee Meeting',
    note: 'Audit, NRC, Stakeholders Relationship, CSR or Risk Management committee.',
  },
  { id: 'agm', label: 'Annual General Meeting', note: 'Under s.96.' },
  { id: 'egm', label: 'Extraordinary General Meeting', note: 'Under s.100.' },
  {
    id: 'postal-ballot',
    label: 'Postal Ballot',
    note: 'Resolutions passed by postal ballot under s.110.',
  },
];

export const MEETING_TYPE_IDS = MEETING_TYPES.map((t) => t.id);

export const MEETING_STATUSES = ['planned', 'notice-sent', 'held', 'cancelled'];

/**
 * Timeline rules. `offsetDays` is relative to the meeting date — negative is
 * before, 0 is the day itself, positive is after.
 *
 * `unit` records what the statute actually says: 'calendar', 'clear' (excluding
 * both the day of the notice and the day of the meeting) or 'working'. We
 * compute calendar days and surface the distinction in `caution`.
 */
const RULES = [
  // ---------------------------------------------------------------- before
  {
    id: 'notice-directors',
    label: 'Notice of meeting to every director',
    authority: 'Companies Act',
    reference: 's.173(3)',
    phase: 'before',
    offsetDays: -7,
    unit: 'calendar',
    types: ['board'],
    note: 'At least 7 days’ notice in writing to every director, at their registered address, by hand, post or electronic means.',
  },
  {
    id: 'notice-committee',
    label: 'Notice and agenda to committee members',
    authority: 'Secretarial Standards',
    reference: 'SS-1',
    phase: 'before',
    offsetDays: -7,
    unit: 'calendar',
    types: ['committee'],
  },
  {
    id: 'agenda-notes',
    label: 'Agenda and notes on agenda circulated',
    authority: 'Secretarial Standards',
    reference: 'SS-1, para 1.3.7',
    phase: 'before',
    offsetDays: -7,
    unit: 'calendar',
    types: ['board', 'committee'],
    note: 'Circulated with the notice. Items not in the agenda need the Chairman’s permission and a majority of directors present.',
  },
  {
    id: 'lodr-29-results',
    label: 'Prior intimation to the exchange — financial results',
    authority: 'SEBI LODR',
    reference: 'Reg. 29(1)(a) & 29(2)',
    phase: 'before',
    offsetDays: -5,
    unit: 'clear',
    types: ['board'],
    onlyIfResults: true,
    listedOnly: true,
    caution: 'Five *clear* days — exclude both the intimation date and the meeting date.',
  },
  {
    id: 'lodr-29-other',
    label: 'Prior intimation to the exchange — buyback, dividend, fund raising',
    authority: 'SEBI LODR',
    reference: 'Reg. 29(1)(b)–(f) & 29(3)',
    phase: 'before',
    offsetDays: -2,
    unit: 'working',
    types: ['board'],
    listedOnly: true,
    conditional: true,
    caution: 'Two *working* days, excluding the intimation date and the meeting date.',
  },
  {
    id: 'notice-members',
    label: 'Notice to members, directors and auditors',
    authority: 'Companies Act',
    reference: 's.101',
    phase: 'before',
    offsetDays: -21,
    unit: 'clear',
    types: ['agm', 'egm'],
    caution: 'Twenty-one *clear* days. Shorter notice needs consent under s.101(1).',
  },
  {
    id: 'notice-postal-ballot',
    label: 'Postal ballot notice despatched with e-voting details',
    authority: 'Companies Act',
    reference: 's.110 / Rule 22',
    phase: 'before',
    offsetDays: -30,
    unit: 'calendar',
    types: ['postal-ballot'],
    note: 'E-voting must remain open for at least 30 days from despatch.',
  },
  {
    id: 'newspaper-ad',
    label: 'Newspaper advertisement of the notice',
    authority: 'Companies Act',
    reference: 'Rule 20(4)(v)',
    phase: 'before',
    offsetDays: -21,
    unit: 'calendar',
    types: ['agm', 'egm', 'postal-ballot'],
    conditional: true,
  },

  // ------------------------------------------------------------- on the day
  {
    id: 'lodr-30-outcome',
    label: 'Outcome filed with the exchange',
    authority: 'SEBI LODR',
    reference: 'Reg. 30(6)',
    phase: 'during',
    offsetDays: 0,
    unit: 'calendar',
    types: ['board'],
    listedOnly: true,
    caution: 'Within 30 minutes of the close of the meeting — not end of day.',
  },
  {
    id: 'lodr-30-proceedings',
    label: 'Proceedings of the general meeting disclosed',
    authority: 'SEBI LODR',
    reference: 'Reg. 30 + Sch. III',
    phase: 'during',
    offsetDays: 0,
    unit: 'calendar',
    types: ['agm', 'egm'],
    listedOnly: true,
    caution: 'Within 12 hours where the event originates within the company.',
  },

  // ----------------------------------------------------------------- after
  {
    id: 'lodr-44-voting',
    label: 'Voting results with scrutinizer’s report',
    authority: 'SEBI LODR',
    reference: 'Reg. 44(3)',
    phase: 'after',
    offsetDays: 2,
    unit: 'working',
    types: ['agm', 'egm', 'postal-ballot'],
    listedOnly: true,
    caution: 'Two *working* days from conclusion.',
  },
  {
    id: 'draft-minutes',
    label: 'Draft minutes circulated to all directors',
    authority: 'Secretarial Standards',
    reference: 'SS-1, para 7.3',
    phase: 'after',
    offsetDays: 15,
    unit: 'calendar',
    types: ['board', 'committee'],
    note: 'Directors then have 7 days to comment.',
  },
  {
    id: 'minutes-entered',
    label: 'Minutes entered in the minutes book and signed',
    authority: 'Companies Act',
    reference: 's.118 / SS-1',
    phase: 'after',
    offsetDays: 30,
    unit: 'calendar',
    types: ['board', 'committee', 'agm', 'egm', 'postal-ballot'],
    note: 'Within 30 days of conclusion, signed and each page initialled by the Chairman.',
  },
  {
    id: 'mgt-14',
    label: 'MGT-14 filed for resolutions requiring filing',
    authority: 'Companies Act',
    reference: 's.117',
    phase: 'after',
    offsetDays: 30,
    unit: 'calendar',
    types: ['board', 'agm', 'egm', 'postal-ballot'],
    conditional: true,
    note: 'Private companies are exempt from filing board resolutions under s.179(3) — s.117(3)(g).',
  },
];

const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
};

/**
 * Build the timeline for one meeting.
 *
 * @param {{date: string, type: string, hasResults?: boolean, listed?: boolean}} meeting
 * @returns timeline items with computed due dates, ordered chronologically
 */
export function timelineFor({ date, type = 'board', hasResults = false, listed = true }) {
  if (!date) return [];

  return RULES.filter((r) => r.types.includes(type))
    .filter((r) => (r.listedOnly ? listed : true))
    .filter((r) => (r.onlyIfResults ? hasResults : true))
    .map((r) => ({
      id: r.id,
      label: r.label,
      authority: r.authority,
      reference: r.reference,
      phase: r.phase,
      due: addDays(date, r.offsetDays),
      offsetDays: r.offsetDays,
      unit: r.unit,
      conditional: !!r.conditional,
      note: r.note || '',
      caution: r.caution || '',
    }))
    .sort((a, b) => a.due.localeCompare(b.due) || a.offsetDays - b.offsetDays);
}

/** Normalise and validate a meeting coming off the wire. */
export function sanitiseMeeting(input, existing = {}) {
  const str = (v, max, fallback = '') =>
    v === undefined ? fallback : String(v).trim().slice(0, max);

  const type = MEETING_TYPE_IDS.includes(input?.type)
    ? input.type
    : existing.type || 'board';
  const status = MEETING_STATUSES.includes(input?.status)
    ? input.status
    : existing.status || 'planned';

  const agenda = Array.isArray(input?.agenda)
    ? input.agenda.slice(0, 60).map((a, i) => ({
        id: str(a?.id, 40) || `a${i + 1}`,
        item: str(a?.item, 400),
        done: !!a?.done,
      })).filter((a) => a.item)
    : existing.agenda || [];

  const attendees = Array.isArray(input?.attendees)
    ? input.attendees.slice(0, 40).map((p, i) => ({
        id: str(p?.id, 40) || `p${i + 1}`,
        name: str(p?.name, 120),
        role: str(p?.role, 80),
        present: p?.present === undefined ? null : !!p.present,
      })).filter((p) => p.name)
    : existing.attendees || [];

  // Checklist items the user has ticked off, stored as timeline rule ids.
  const completed = Array.isArray(input?.completed)
    ? [...new Set(input.completed.map((c) => str(c, 60)).filter(Boolean))].slice(0, 60)
    : existing.completed || [];

  return {
    type,
    status,
    title: str(input?.title, 200, existing.title || ''),
    date: /^\d{4}-\d{2}-\d{2}$/.test(input?.date || '')
      ? input.date
      : existing.date || '',
    // Range-checked, not just shape-checked — /^\d{2}:\d{2}$/ happily accepts 25:99.
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(input?.time || '')
      ? input.time
      : existing.time || '',
    mode: ['physical', 'vc', 'hybrid'].includes(input?.mode)
      ? input.mode
      : existing.mode || 'physical',
    venue: str(input?.venue, 240, existing.venue || ''),
    companyScrip: str(input?.companyScrip, 12, existing.companyScrip || ''),
    companyName: str(input?.companyName, 200, existing.companyName || ''),
    listed: input?.listed === undefined ? existing.listed !== false : !!input.listed,
    hasResults:
      input?.hasResults === undefined ? !!existing.hasResults : !!input.hasResults,
    notes: str(input?.notes, 4000, existing.notes || ''),
    agenda,
    attendees,
    completed,
  };
}
