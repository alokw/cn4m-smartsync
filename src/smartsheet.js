import { getAccessToken } from './oauth.js';
import { log } from './log.js';

const API = 'https://api.smartsheet.com/2.0';
const MAX_ROWS_PER_UPDATE = 400;   // Smartsheet caps a single write at 500
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NotConnectedError extends Error {
  constructor() {
    super('Smartsheet is not connected yet -- authorize at the web UI first');
    this.name = 'NotConnectedError';
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  if (!token) throw new NotConnectedError();

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.ok) return res.json();

    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;

    if (retryable && attempt < MAX_ATTEMPTS) {
      const wait = 2 ** attempt * 1000;
      log.warn(`Smartsheet ${method} ${path} -> ${res.status}, retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }

    throw new Error(`Smartsheet ${method} ${path} failed (${res.status}): ${text}`);
  }
}

export async function listSheets() {
  const data = await request('/sheets?includeAll=true');
  return (data.data ?? []).map((s) => ({ id: s.id, name: s.name, permalink: s.permalink }));
}

export async function getSheet(sheetId) {
  return request(`/sheets/${encodeURIComponent(sheetId)}?includeAll=true`);
}

// Resolves the configured column titles to their Smartsheet column ids.
export function resolveColumns(sheet, wanted) {
  const byTitle = new Map(sheet.columns.map((c) => [c.title.trim().toLowerCase(), c]));
  const resolved = {};
  const missing = [];

  for (const [key, title] of Object.entries(wanted)) {
    const col = byTitle.get(title.trim().toLowerCase());
    if (col) resolved[key] = col;
    else missing.push(title);
  }

  if (missing.length) {
    const available = sheet.columns.map((c) => c.title).join(', ');
    throw new Error(`Column(s) not found in "${sheet.name}": ${missing.join(', ')}. Available: ${available}`);
  }
  return resolved;
}

export function cellValue(row, columnId) {
  const cell = row.cells.find((c) => c.columnId === columnId);
  if (!cell) return '';
  return (cell.displayValue ?? cell.value ?? '').toString().trim();
}

export async function updateRows(sheetId, rowUpdates) {
  const results = [];
  for (let i = 0; i < rowUpdates.length; i += MAX_ROWS_PER_UPDATE) {
    const chunk = rowUpdates.slice(i, i + MAX_ROWS_PER_UPDATE);
    const res = await request(`/sheets/${encodeURIComponent(sheetId)}/rows`, {
      method: 'PUT',
      body: chunk,
    });
    results.push(...(res.result ?? []));
  }
  return results;
}

export async function listReports() {
  const data = await request('/reports?includeAll=true');
  return (data.data ?? []).map((r) => ({ id: r.id, name: r.name }));
}

export async function getReport(reportId) {
  return request(`/reports/${encodeURIComponent(reportId)}?includeAll=true`);
}
