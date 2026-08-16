// Tolerant CSV parsing for FantasyPros exports.
//
// Real exports carry title/metadata rows above the header and a footer line
// below the data (e.g. "ADP Sources: RTSports, BB10"). Header punctuation is
// exact and inconsistent between export types ("AVG." vs "AVG", "STD.DEV").
// So: parse rows first, then locate the header by content, then match column
// names on a normalized form.

/** Split raw CSV text into rows of string cells. Handles quoted fields,
 *  embedded commas/newlines, and doubled quotes. */
export function parseRows(text) {
  // Strip a UTF-8 BOM — Excel-exported files routinely carry one and it
  // otherwise becomes part of the first header cell.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* handled by \n */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else { cell += c; }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  return rows.map((r) => r.map((c) => c.trim()));
}

/** Normalize a header cell for matching: uppercase, drop everything that
 *  isn't a letter or digit. "STD.DEV" -> "STDDEV", "BYE WEEK" -> "BYEWEEK". */
export function normHeader(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Find the header row: the first row where at least `minHits` cells
 *  normalize to something in `expected`. Everything above it is title/metadata. */
export function findHeaderRow(rows, expected, minHits = 2) {
  const want = new Set(expected.map(normHeader));
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const hits = rows[i].filter((c) => want.has(normHeader(c))).length;
    if (hits >= minHits) return i;
  }
  return -1;
}

/** A row is data if it has at least 2 non-empty cells and isn't a footer
 *  note. Footers are single-cell lines or lines like "ADP Sources: ...". */
function isDataRow(row, width) {
  const filled = row.filter((c) => c !== '').length;
  if (filled < 2) return false;
  const first = row[0] || '';
  if (/^(adp\s+sources|source|note|updated|generated|data\s+from)\b/i.test(first)) return false;
  // A row far narrower than the header is almost certainly a footer note.
  if (row.length < Math.max(2, Math.floor(width / 2))) return false;
  return true;
}

/**
 * Parse CSV text into objects keyed by normalized header name.
 * Returns { records, headers, unknownHeaders, skipped }.
 *
 * `known` is the set of normalized headers this file type understands;
 * anything else is reported in unknownHeaders rather than dropped silently.
 */
export function parseTable(text, expected, known = []) {
  const rows = parseRows(text).filter((r) => r.some((c) => c !== ''));
  if (!rows.length) return { records: [], headers: [], unknownHeaders: [], skipped: 0 };

  const hIdx = findHeaderRow(rows, expected);
  if (hIdx === -1) {
    throw new Error(
      `Could not find a header row. Expected one of: ${expected.join(', ')}. ` +
      `First row seen was: ${rows[0].slice(0, 8).join(' | ')}`
    );
  }

  const rawHeaders = rows[hIdx];
  const headers = rawHeaders.map(normHeader);
  const knownSet = new Set(known.map(normHeader));
  const unknownHeaders = rawHeaders.filter(
    (h, i) => h !== '' && knownSet.size > 0 && !knownSet.has(headers[i])
  );

  const records = [];
  let skipped = 0;
  for (let i = hIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!isDataRow(row, rawHeaders.length)) { skipped++; continue; }
    const rec = {};
    for (let j = 0; j < headers.length; j++) {
      if (headers[j] === '') continue;
      rec[headers[j]] = row[j] ?? '';
    }
    rec.__row = i + 1;
    records.push(rec);
  }

  return { records, headers, unknownHeaders, skipped };
}

/** Read a File as UTF-8 text. */
export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error || new Error('Could not read file'));
    fr.readAsText(file, 'utf-8');
  });
}

/** Parse a numeric cell, tolerating "-", "", "N/A", "+3", "1,024". */
export function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/[,+]/g, '').trim();
  if (s === '' || s === '-' || s === '--' || /^n\/?a$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
