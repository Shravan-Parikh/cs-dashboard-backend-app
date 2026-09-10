/**
 * caseMeta.js — derive filterable structure from an order's title and text.
 *
 * A CS wants to slice case law by "what kind of order", "which regulation",
 * "how big was the penalty", "which company". None of that needs a model — it's
 * all stated in the order, in fairly regular language. So it's extracted with
 * rules, and anything uncertain is labelled as detected rather than asserted.
 */

const ORDER_TYPES = [
  { id: 'adjudication', label: 'Adjudication Order', match: /adjudication order/i },
  { id: 'settlement', label: 'Settlement Order', match: /settlement order/i },
  // SAT titles arrive several ways: "Appeal No. 7046 of 2026 filed by X" and
  // "[SAT Appeal No.: 485/2022 & Misc. App. No. 810/2022]" — so match anywhere,
  // not just at the start.
  { id: 'appeal', label: 'SAT Appeal', match: /\bSAT\b|\bappeal no\.?\s*:?\s*\d+|\bmisc\.?\s*app\b/i },
  { id: 'interim', label: 'Interim Order', match: /interim order|ex-parte/i },
  { id: 'wtm', label: 'WTM / Member Order', match: /order of the whole time member|wtm/i },
  { id: 'recovery', label: 'Recovery Certificate', match: /recovery (certificate|proceedings)/i },
  { id: 'final', label: 'Final Order', match: /final order/i },
  { id: 'informal', label: 'Informal Guidance', match: /informal guidance|interpretive letter/i },
];

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Order type from the title, falling back to a generic label. */
export function classify(title) {
  for (const t of ORDER_TYPES) {
    if (t.match.test(title)) return { orderType: t.id, orderTypeLabel: t.label };
  }
  return { orderType: 'order', orderTypeLabel: 'Order' };
}

/** SAT hears appeals against SEBI; everything else here is SEBI's own. */
export const authorityOf = (orderType) => (orderType === 'appeal' ? 'SAT' : 'SEBI');

/** Month and year from the URL path segment, e.g. /orders/sep-2026/. */
export function dateFromUrl(url) {
  const m = /\/orders\/([a-z]{3})-(\d{4})\//i.exec(url);
  if (!m) return { year: 0, month: '', period: '' };
  const mon = m[1].toLowerCase();
  const year = Number(m[2]);
  const idx = MONTHS[mon];
  return {
    year,
    month: idx === undefined ? '' : String(idx + 1).padStart(2, '0'),
    // Sort key that stays correct without pretending we know the day.
    period: idx === undefined ? `${year}` : `${year}-${String(idx + 1).padStart(2, '0')}`,
  };
}

/**
 * Indian-format money to integer rupees. "Rs. 10,00,000/-" -> 1000000.
 * Handles lakh/crore words too, since orders mix both styles.
 */
function toRupees(raw, unit) {
  const n = Number(String(raw).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return 0;
  if (/crore/i.test(unit || '')) return Math.round(n * 10_000_000);
  if (/lakh|lac/i.test(unit || '')) return Math.round(n * 100_000);
  return Math.round(n);
}

/**
 * Penalty amounts, scoped to text that actually talks about a penalty.
 *
 * Deliberately narrow: an order is full of numbers (trade values, disgorgement,
 * interest), so a bare "largest rupee figure" would be wrong more often than
 * right. Only amounts within ~120 chars after a penalty/fine cue are considered,
 * and the result is surfaced as "detected".
 */
export function extractPenalty(text) {
  const amounts = [];
  const cue = /\b(penalt(?:y|ies)|fine|monetary penalty)\b/gi;
  let m;
  while ((m = cue.exec(text))) {
    const window = text.slice(m.index, m.index + 160);
    const money =
      /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)\s*(crore|crores|lakh|lakhs|lac)?/i.exec(window);
    if (money) {
      const v = toRupees(money[1], money[2]);
      if (v >= 1000) amounts.push(v);
    }
  }
  if (amounts.length === 0) return { penalty: 0, penaltyDetected: false };
  return { penalty: Math.max(...amounts), penaltyDetected: true };
}

/**
 * PIT regulations and SEBI Act sections cited in the order.
 * Returns canonical labels like "PIT Reg. 4" so they group and filter cleanly.
 */
export function extractCitations(text) {
  const out = new Set();
  const body = text.slice(0, 120_000); // orders repeat citations; the head is enough

  // "regulation 3(1)", "Regulation 4", "Reg. 9A" — PIT numbering runs 1..12 plus letters.
  for (const m of body.matchAll(/\bregulation\s+(\d{1,2}[A-Z]?)\s*(?:\(\d+\))?/gi)) {
    const n = m[1].toUpperCase();
    if (Number(n.replace(/[A-Z]/g, '')) <= 12) out.add(`PIT Reg. ${n}`);
  }
  // SEBI Act sections that carry insider-trading liability.
  for (const m of body.matchAll(/\bsection\s+(12A|15G|11\(4\)|11B|15HB|15J)\b/gi)) {
    out.add(`SEBI Act s.${m[1].toUpperCase()}`);
  }
  if (/\bschedule\s+B\b/i.test(body)) out.add('PIT Schedule B');
  if (/structured digital database|\bSDD\b/i.test(body)) out.add('SDD (Reg. 3(5))');
  if (/trading window/i.test(body)) out.add('Trading window');
  if (/contra[- ]trade/i.test(body)) out.add('Contra trade');
  if (/pre[- ]?clearance/i.test(body)) out.add('Pre-clearance');
  return [...out].sort();
}

/** The company whose scrip the case concerns, where the title names it. */
export function extractSubject(title) {
  const scrip =
    /in the (?:scrip|shares|securities) of\s+(.+?)(?:\s+(?:limited|ltd\.?|private limited)\b)?\s*$/i.exec(
      title,
    ) || /in the scrip of\s+([^,.]+)/i.exec(title);
  const matter =
    /in the matter of\s+(.+?)\s*$/i.exec(title) || /in respect of\s+(.+?)\s*$/i.exec(title);

  const clean = (s) =>
    (s || '')
      .replace(/\s*[-–]\s*(?:proprietor|prop\.).*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);

  const company = clean(scrip?.[1] || '');
  let subject = clean(matter?.[1] || '');

  // When the title is framed around a scrip, the "in the matter of ..." text is
  // just the same sentence again ("insider trading activity of an entity in the
  // scrip of X") — noise, not a second fact. Only keep a subject that names
  // someone, which is the case for "in respect of <person>" titles.
  if (company || /\bin the (?:scrip|shares|securities) of\b/i.test(subject)) subject = '';
  if (/^(?:suspected\s+)?(?:insider trading|dealing|trading)\b/i.test(subject)) subject = '';

  return { company, subject };
}

/** A coarse outcome, useful as a filter and honest about uncertainty. */
export function extractOutcome(text, penalty) {
  if (/\bpenalty\b[^.]{0,80}\bimposed\b/i.test(text) || penalty > 0) return 'penalty';
  if (/\bwarning\b|\bcautioned\b|\badvised to be careful\b/i.test(text)) return 'warning';
  if (/\bsettle(?:d|ment)\b/i.test(text)) return 'settled';
  if (/\bdisposed of\b|\bdismissed\b/i.test(text)) return 'disposed';
  if (/\bexonerat|\bno violation\b|\bcharges? (?:are )?not established\b/i.test(text)) {
    return 'exonerated';
  }
  return 'unclear';
}

export const OUTCOMES = [
  { id: 'penalty', label: 'Penalty imposed' },
  { id: 'settled', label: 'Settled' },
  { id: 'warning', label: 'Warning / caution' },
  { id: 'disposed', label: 'Disposed / dismissed' },
  { id: 'exonerated', label: 'Exonerated' },
  { id: 'unclear', label: 'Not determined' },
];

export const ORDER_TYPE_LIST = ORDER_TYPES.map(({ id, label }) => ({ id, label })).concat({
  id: 'order',
  label: 'Order',
});

/** Everything derivable about one order. */
export function deriveMeta({ title, url, text }) {
  const { orderType, orderTypeLabel } = classify(title);
  const { penalty, penaltyDetected } = extractPenalty(text);
  return {
    ...classify(title),
    authority: authorityOf(orderType),
    ...dateFromUrl(url),
    ...extractSubject(title),
    penalty,
    penaltyDetected,
    citations: extractCitations(text),
    outcome: extractOutcome(text, penalty),
    orderTypeLabel,
  };
}
