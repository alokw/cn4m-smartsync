import { parseCsvToObjects } from './csv.js';
import { config } from './config.js';
import { log } from './log.js';
import { getGoogleAccessToken, serviceAccountEmail } from './google-auth.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Only used by the credential-free fallback path.
export function csvUrl() {
  const { sheetId, gid } = config.google;
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

export function authMode() {
  return serviceAccountEmail() ? 'service account' : 'public CSV export';
}

// The values API returns ragged arrays -- trailing empty cells are omitted --
// so index past the end rather than assuming a rectangle.
export function toRecords(values) {
  if (values.length === 0) return { headers: [], records: [] };

  const headers = values[0].map((h) => String(h ?? '').trim());
  const records = [];

  for (const row of values.slice(1)) {
    if (row.every((v) => String(v ?? '').trim() === '')) continue;
    const record = {};
    headers.forEach((h, i) => { record[h] = String(row[i] ?? '').trim(); });
    records.push(record);
  }

  return { headers, records };
}

async function api(path, token, params) {
  const url = `${SHEETS_API}/${config.google.sheetId}${path}${params ? `?${params}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.ok) return res.json();

  const body = await res.text();
  if (res.status === 403) {
    throw new Error(
      `Google Sheets API denied access (403). Share the spreadsheet with the service account `
      + `"${serviceAccountEmail()}" as a Viewer. ${body}`,
    );
  }
  if (res.status === 404) {
    throw new Error(`Spreadsheet ${config.google.sheetId} not found (404). Check GOOGLE_SHEET_ID. ${body}`);
  }
  throw new Error(`Google Sheets API ${res.status}: ${body}`);
}

// The values endpoint addresses tabs by title, but a gid is what appears in the
// sheet URL, so translate one to the other unless a title was given outright.
async function resolveTabTitle(token) {
  if (config.google.tab) return config.google.tab;

  const meta = await api('', token, 'fields=sheets.properties(sheetId,title)');
  const tabs = (meta.sheets ?? []).map((s) => s.properties);
  const gid = Number(config.google.gid);
  const found = tabs.find((t) => t.sheetId === gid);

  if (!found) {
    const available = tabs.map((t) => `"${t.title}" (gid ${t.sheetId})`).join(', ');
    throw new Error(`No tab with gid ${gid}. Available: ${available}`);
  }
  return found.title;
}

async function fetchViaApi(token) {
  const title = await resolveTabTitle(token);
  const data = await api(
    `/values/${encodeURIComponent(title)}`,
    token,
    'majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE',
  );

  const { headers, records } = toRecords(data.values ?? []);
  log.debug(`fetched ${records.length} rows from tab "${title}" via the Sheets API`);
  return { headers, records };
}

async function fetchViaCsv() {
  const res = await fetch(csvUrl(), { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Google Sheet CSV fetch failed (${res.status}). Set GOOGLE_CREDS, or share the sheet as "anyone with the link can view".`);
  }

  const text = await res.text();
  const head = text.trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    throw new Error('Google returned an HTML page instead of CSV -- the sheet is not link-readable. Set GOOGLE_CREDS to use the API instead.');
  }

  const { headers, records } = parseCsvToObjects(text);
  log.debug(`fetched ${records.length} rows via the public CSV export`);
  return { headers, records };
}

// Canonical field names the rest of the app works in. The actual column titles
// live in .env so a renamed source column never needs a code change.
const CANONICAL = ['NAME', 'VERSION', 'PROCESSED', 'DURATION', 'FILENAME', 'STATUS', 'NOTES'];
const REQUIRED = ['NAME', 'PROCESSED'];

const warned = new Set();

export function googleColumns() {
  return {
    NAME: config.google.nameColumn,
    VERSION: config.google.versionColumn,
    PROCESSED: config.google.processedColumn,
    DURATION: config.google.durationColumn,
    FILENAME: config.google.filenameColumn,
    STATUS: config.google.statusColumn,
    NOTES: config.google.notesColumn,
  };
}

// Renames the configured source columns onto the canonical keys. Titles are
// matched case-insensitively; a missing required column is a hard error naming
// every header the sheet actually has.
export function canonicalize(headers, records, columns = googleColumns()) {
  const index = new Map(headers.map((h) => [h.trim().toLowerCase(), h]));
  const resolved = {};
  const missing = [];

  for (const field of CANONICAL) {
    const title = (columns[field] ?? '').trim();
    if (!title) continue;

    const actual = index.get(title.toLowerCase());
    if (actual === undefined) missing.push({ field, title });
    else resolved[field] = actual;
  }

  const fatal = missing.filter((m) => REQUIRED.includes(m.field));
  if (fatal.length) {
    throw new Error(
      `Google Sheet column(s) not found: ${fatal.map((m) => `"${m.title}" (for ${m.field})`).join(', ')}. `
      + `Available: ${headers.join(', ')}`,
    );
  }

  for (const m of missing) {
    if (warned.has(m.title)) continue;
    warned.add(m.title);
    log.warn(`Google Sheet has no column "${m.title}" for ${m.field} -- that field stays empty`);
  }

  const mapped = records.map((record) => {
    const out = { ...record };
    for (const [field, actual] of Object.entries(resolved)) out[field] = record[actual] ?? '';
    return out;
  });

  return { headers, records: mapped, resolved, missing };
}

// Unmapped rows, straight from the source. The diagnostics page uses this so it
// still renders when a required column is missing.
export async function fetchRawRows() {
  const token = await getGoogleAccessToken();

  if (!token) {
    log.warn('GOOGLE_CREDS is not set -- falling back to the public CSV export, which only works for link-readable sheets');
  }

  return token ? fetchViaApi(token) : fetchViaCsv();
}

export async function fetchRows() {
  const raw = await fetchRawRows();
  return canonicalize(raw.headers, raw.records);
}
