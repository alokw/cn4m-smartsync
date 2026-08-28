// Minimal RFC 4180 CSV reader. The sheet contains emoji, quoted fields and
// embedded commas (NOTES, FOLDER), so a naive split(',') is not safe here.

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }

  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Turns a CSV body into objects keyed by header name. Trailing blank lines and
// fully-empty rows are dropped so they never look like real records.
export function parseCsvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim());
  const records = [];

  for (const row of rows.slice(1)) {
    if (row.every((v) => v.trim() === '')) continue;
    const record = {};
    headers.forEach((h, i) => { record[h] = (row[i] ?? '').trim(); });
    records.push(record);
  }

  return { headers, records };
}
