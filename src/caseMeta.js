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
  const fromUrl = dateFromUrl(url);
  const orderDate = extractOrderDate(text);
  return {
    orderType,
    orderTypeLabel,
    authority: authorityOf(orderType),
    ...fromUrl,
    // The precise signed date where we could read it; the URL month is only a
    // fallback so sorting still works.
    orderDate,
    dateExact: !!orderDate,
    orderNo: extractOrderNumber(text, title),
    ...extractSubject(title),
    penalty,
    penaltyDetected,
    citations: extractCitations(text),
    upsi: extractUpsi(text),
    outcome: extractOutcome(text, penalty),
  };
}

// ---------------------------------------------------------------------------
// Fields a CS needs in order to actually *cite* a case
// ---------------------------------------------------------------------------

const MONTH_NAMES = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const iso = (y, m, d) =>
  y > 1990 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : '';

function parseDate(raw) {
  let m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(raw); // September 09, 2026
  if (m) return iso(Number(m[3]), MONTH_NAMES[m[1].toLowerCase()] || 0, Number(m[2]));
  m = /^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/.exec(raw); // 13 August 2026
  if (m) return iso(Number(m[3]), MONTH_NAMES[m[2].toLowerCase()] || 0, Number(m[1]));
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(raw); // 13-08-2026 (dd first)
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  return '';
}

/**
 * The date the order was signed.
 *
 * A CS cannot cite "Sep 2026" in a board note, and the month in the URL is all
 * the listing gives us. SEBI signs off with a "Place: … Date: …" block, so a
 * date sitting next to "Place" is preferred; failing that the last dated line
 * wins, since letterheads and quoted correspondence appear earlier in the text.
 */
export function extractOrderDate(text) {
  const DATE = String.raw`([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+,?\s+\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})`;
  const near = new RegExp(`Place\\s*[:\\-][^\\n]{0,60}\\s*Dat(?:e|ed)\\s*[:\\-]?\\s*${DATE}`, 'i');
  const hit = near.exec(text);
  if (hit) {
    const d = parseDate(hit[1].trim());
    if (d) return d;
  }
  const all = [...text.matchAll(new RegExp(`Dat(?:e|ed)\\s*[:\\-]?\\s*${DATE}`, 'gi'))];
  for (let i = all.length - 1; i >= 0; i--) {
    const d = parseDate(all[i][1].trim());
    if (d) return d;
  }
  return '';
}

/**
 * The order's own reference number — how a CS actually refers to it
 * ("Order/JS/YK/2026-27/32473", "Appeal No. 485 of 2022").
 */
export function extractOrderNumber(text, title) {
  const head = text.slice(0, 12000);
  const appeal = /Appeal\s+No\.?\s*:?\s*(\d+\s*(?:of|\/)\s*\d{4})/i.exec(`${title}\n${head}`);
  if (appeal) return `Appeal No. ${appeal[1].replace(/\s*\/\s*/, ' of ').replace(/\s+/g, ' ')}`;
  // Slash-delimited SEBI reference, optionally prefixed by its own label.
  const ref = /\b((?:Order|SO|AO|ADJ|WTM|EFD|QJA)\s*[\/:]?\s*[A-Z0-9]{1,8}(?:\/[A-Z0-9\-]{1,14}){1,5})/.exec(head);
  if (ref) return ref[1].replace(/\s*\/\s*/g, '/').replace(/^Order[:\/]?/i, 'Order/').trim();
  return '';
}

/**
 * What the unpublished price sensitive information actually was.
 *
 * The single most useful way for a CS to slice case law ("show me cases where
 * the UPSI was unpublished results"). Matched only inside windows around a UPSI
 * mention — scanning the whole order would tag anything that merely mentions a
 * dividend somewhere in 40 pages.
 */
const UPSI_KINDS = [
  { id: 'results', label: 'Financial results', match: /financial results|quarterly results|audited results|earnings/i },
  { id: 'ma', label: 'Merger / acquisition', match: /merger|amalgamation|acquisition|scheme of arrangement|takeover|slump sale/i },
  { id: 'dividend', label: 'Dividend', match: /dividend/i },
  { id: 'fundraise', label: 'Fund raising', match: /preferential (?:issue|allotment)|qip|rights issue|fund rais|debenture/i },
  { id: 'order-win', label: 'Order win / contract', match: /order win|receipt of (?:an? )?order|letter of award|new contract|bagg/i },
  { id: 'kmp', label: 'Change in KMP', match: /resignation|appointment of (?:the )?(?:managing director|md|ceo|cfo|chairman)/i },
  { id: 'buyback', label: 'Buyback', match: /buy[- ]?back/i },
  { id: 'stake', label: 'Open offer / stake change', match: /open offer|stake sale|divest|pledge/i },
  { id: 'restructuring', label: 'Restructuring / insolvency', match: /insolvency|nclt|restructuring|resolution plan/i },
];

export function extractUpsi(text) {
  const found = new Set();
  const cue = /unpublished price sensitive information|\bUPSI\b/gi;
  let m;
  let windows = 0;
  while ((m = cue.exec(text)) && windows < 400) {
    windows++;
    const w = text.slice(Math.max(0, m.index - 350), m.index + 450);
    for (const k of UPSI_KINDS) if (k.match.test(w)) found.add(k.id);
  }
  return [...found];
}

export const UPSI_LIST = UPSI_KINDS.map(({ id, label }) => ({ id, label }));
