import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(__dirname, 'data', 'companies.csv');

/** Minimal CSV parser — our file has no quoted commas, so a split is enough. */
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => (row[h.trim()] = (cells[i] ?? '').trim()));
    return row;
  });
}

const rows = parseCsv(readFileSync(CSV_PATH, 'utf8')).map((r) => ({
  company: r.company,
  symbol: r.symbol,
  scrip_code: String(r.scrip_code),
  indices: (r.indices || '').split(';').map((s) => s.trim()).filter(Boolean),
}));

export function allCompanies() {
  return rows;
}

export function listIndices() {
  const set = new Set();
  rows.forEach((r) => r.indices.forEach((i) => set.add(i)));
  return Array.from(set).sort();
}

export function companiesForIndex(indexName) {
  if (!indexName || indexName === 'All') return rows;
  return rows.filter((r) => r.indices.includes(indexName));
}

/** scrip_code -> {company, symbol} for pivot/name resolution. */
export function nameLookup() {
  const map = new Map();
  rows.forEach((r) => map.set(r.scrip_code, { company: r.company, symbol: r.symbol }));
  return map;
}
