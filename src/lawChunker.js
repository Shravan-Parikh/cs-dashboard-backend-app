/**
 * lawChunker.js — turn a regulation PDF's text into citable chunks.
 *
 * Search results have to answer "where does it say that?", so chunks are cut on
 * the document's own structure rather than a fixed character window. SEBI's
 * layout, from the extracted text:
 *
 *   CHAPTER – II\nPROHIBITIONS…            chapter heading
 *   Trading Plans.\n5. \t(1) \tAn insider…  title line, then reg number
 *   Disclosures by certain persons\n5E. (1) …   (no trailing dot, no tabs)
 *   SCHEDULE B                             schedule sections
 *   -- 30 of 82 --                         inline page markers
 *
 * Regulation numbers can carry a letter suffix (5E, 9A), which is why the
 * pattern is `\d{1,2}[A-Z]?` and not `\d+`.
 */

const PAGE_MARKER = /^--\s*(\d+)\s+of\s+(\d+)\s*--$/;
const CHAPTER = /^CHAPTER\s*[–-]\s*([IVXLC]+)\s*$/i;
/**
 * Schedule headings can carry an amendment footnote marker, e.g. "123[SCHEDULE B1"
 * — SEBI's consolidated PDFs mark substituted text that way, so a bare
 * /^SCHEDULE [A-Z]$/ silently misses B1, C, D and E.
 */
const SCHEDULE = /^(?:\d+\[)?\s*SCHEDULE\s*[-–]?\s*([A-Z]\d?)\s*\]?\s*$/i;
// A regulation body opens with its number at line start: "5. \t(1) \t" or "5E. (1) "
const REG_START = /^(\d{1,2}[A-Z]?)\.\s*(?:\t|\(|\s)/;
/**
 * Amendment footnotes sit at the foot of each page, e.g.
 *   95 Omitted by Securities and Exchange Board of India (Prohibition of …
 * They are provenance, not operative text. Left in, they dominate snippets and
 * let a chunk rank on "Inserted by … Amendment Regulations, 2018" instead of the
 * provision itself. The inline NN[…] markers in the body still flag amendments.
 */
const FOOTNOTE_START = new RegExp(
  [
    // "95 Omitted by …", "12 Substituted by …"
    String.raw`^\d{1,3}\s+(?:Inserted|Substituted|Omitted|Renumbered|Deleted|Added|Amended)\b`,
    // "35 Prior to substitution, sub-regulation 5 was inserted by …" — the verb
    // isn't adjacent to the marker, so allow a short lead-in.
    String.raw`^\d{1,3}\s+.{0,90}?\b(?:inserted|substituted|omitted|renumbered|deleted)\s+by\b`,
    // "40 Prior to substitution it read as …"
    String.raw`^\d{1,3}\s+Prior to\b`,
  ].join('|'),
  'i',
);

/** Chunks longer than this get split at sub-clause boundaries. */
const MAX_CHUNK = 4200;

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

/** A title line precedes a regulation number: prose-like, not itself a clause. */
function looksLikeTitle(line) {
  if (!line) return false;
  const t = line.trim();
  if (t.length < 3 || t.length > 140) return false;
  if (/^\(/.test(t)) return false; // a sub-clause
  if (/^\d/.test(t)) return false; // a numbered clause
  if (PAGE_MARKER.test(t) || CHAPTER.test(t) || SCHEDULE.test(t)) return false;
  if (/[;:]$/.test(t)) return false; // continuation of a list
  return /^[A-Z0-9“"(\[]/.test(t);
}

/**
 * Split sections that are too long at sub-clause markers "(1)", "(2)" …,
 * so a hit inside a huge regulation still cites a tight passage.
 */
function splitLong(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    const isSubClause = /^\s*\(\d{1,2}\)\s/.test(line);
    if (isSubClause && buf.length >= MAX_CHUNK * 0.6) {
      parts.push(buf.trim());
      buf = line + '\n';
    } else {
      buf += line + '\n';
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length ? parts : [text];
}

/**
 * @param {string} text  full extracted PDF text
 * @param {{docId: string}} opts
 * @returns {{ref:string, heading:string, chapter:string, page:number, text:string, id:string}[]}
 */
export function chunkRegulation(text, { docId }) {
  const lines = text.split('\n');

  let page = 1;
  let chapter = '';
  let chapterPending = false;
  // Footnotes run from the first footnote line to the end of that page.
  let inFootnote = false;
  // Once inside a Schedule, numbered paragraphs are Schedule paragraphs — not
  // regulations. Labelling them "Regulation 2" would cite the wrong instrument.
  let schedule = '';

  const sections = [];
  let current = null;

  const flush = () => {
    if (current && current.body.trim()) sections.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    const pm = PAGE_MARKER.exec(line);
    if (pm) {
      page = Number(pm[1]);
      inFootnote = false; // footnotes don't cross a page boundary
      continue; // page markers are furniture, not content
    }

    if (FOOTNOTE_START.test(line)) inFootnote = true;
    if (inFootnote) continue;

    const cm = CHAPTER.exec(line);
    if (cm) {
      // The chapter's name is on the following line(s), in caps.
      chapter = `Chapter ${cm[1].toUpperCase()}`;
      chapterPending = true;
      continue;
    }
    if (chapterPending) {
      if (line && line === line.toUpperCase() && /[A-Z]/.test(line)) {
        chapter += ` — ${line.replace(/\s+/g, ' ')}`;
      }
      chapterPending = false;
      if (line && REG_START.test(line) === false && !SCHEDULE.test(line)) continue;
    }

    const sm = SCHEDULE.exec(line);
    if (sm) {
      flush();
      schedule = `Schedule ${sm[1].toUpperCase()}`;
      current = { ref: schedule, heading: '', chapter: '', page, body: '' };
      continue;
    }

    const rm = REG_START.exec(line);
    if (rm) {
      // Walk back over blanks for the title line.
      let title = '';
      for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
        const prev = lines[k].trim();
        if (!prev) continue;
        if (looksLikeTitle(prev)) title = prev.replace(/\.$/, '');
        break;
      }
      // A title line already consumed as body of the previous section: trim it.
      if (current && title && current.body.trimEnd().endsWith(title)) {
        current.body = current.body.trimEnd().slice(0, -title.length);
      }
      flush();
      current = {
        ref: schedule ? `${schedule}, para ${rm[1]}` : `Regulation ${rm[1]}`,
        heading: title,
        chapter: schedule ? '' : chapter,
        page,
        body: line + '\n',
      };
      continue;
    }

    if (current) current.body += raw + '\n';
  }
  flush();

  // Expand oversized sections, keeping the citation and adding a part suffix.
  const chunks = [];
  for (const s of sections) {
    const parts = splitLong(s.body.trim());
    parts.forEach((body, idx) => {
      const slug = s.ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      chunks.push({
        id: `${docId}#${slug}${parts.length > 1 ? `-p${idx + 1}` : ''}`,
        ref: s.ref + (parts.length > 1 ? ` (part ${idx + 1} of ${parts.length})` : ''),
        heading: s.heading,
        chapter: s.chapter,
        page: s.page,
        text: body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
      });
    });
  }
  return chunks.filter((c) => c.text.length > 40);
}
