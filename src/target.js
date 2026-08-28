import { config } from './config.js';
import { log } from './log.js';
import { getSheet, getReport, resolveColumns, cellValue } from './smartsheet.js';

// Columns we may write. A blank title in .env switches one off.
export const WRITE_FIELDS = ['version', 'processed', 'duration', 'status', 'notes', 'format', 'audio', 'misc'];

export function wantedColumns() {
  const want = { name: config.smartsheet.nameColumn };
  for (const field of WRITE_FIELDS) {
    const title = config.smartsheet[`${field}Column`];
    if (title) want[field] = title;
  }
  return want;
}

export function enabledFields() {
  return WRITE_FIELDS.filter((f) => config.smartsheet[`${f}Column`]);
}

function toRow(sheetId, row, columns) {
  const current = {};
  for (const field of WRITE_FIELDS) {
    if (columns[field]) current[field] = cellValue(row, columns[field].id);
  }
  return { sheetId, rowId: row.id, name: cellValue(row, columns.name.id), current };
}

// Loads the rows we are allowed to match against, plus the column ids needed to
// write them.
//
// A report is treated as a *row filter* over its source sheet(s): the report
// decides which rows are eligible, and the sheet supplies the columns and
// current values. That matters because a report need not expose the columns we
// write -- resolving them against the source sheet works either way, and it
// still guarantees we never match a row the report excludes.
export async function loadTarget() {
  const want = wantedColumns();

  if (config.smartsheet.reportId) {
    const report = await getReport(config.smartsheet.reportId);

    const allowed = new Map();   // sheetId -> Set of eligible row ids
    for (const row of report.rows ?? []) {
      const key = String(row.sheetId);
      if (!allowed.has(key)) allowed.set(key, new Set());
      allowed.get(key).add(row.id);
    }

    const rows = [];
    const columnsBySheet = new Map();

    for (const [sheetId, ids] of allowed) {
      const sheet = await getSheet(sheetId);
      const columns = resolveColumns(sheet, want);
      columnsBySheet.set(sheetId, columns);
      for (const row of sheet.rows) {
        if (ids.has(row.id)) rows.push(toRow(sheetId, row, columns));
      }
    }

    log.info(`target: report "${report.name}" -- ${rows.length} eligible row(s) across ${allowed.size} sheet(s)`);
    return { kind: 'report', label: report.name, rows, columnsBySheet };
  }

  const sheet = await getSheet(config.smartsheet.sheetId);
  const columns = resolveColumns(sheet, want);
  const sheetId = String(sheet.id);

  log.info(`target: sheet "${sheet.name}" -- ${sheet.rows.length} row(s)`);
  return {
    kind: 'sheet',
    label: sheet.name,
    rows: sheet.rows.map((r) => toRow(sheetId, r, columns)),
    columnsBySheet: new Map([[sheetId, columns]]),
  };
}
