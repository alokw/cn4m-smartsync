import { log } from './log.js';

function required(name) {
  const v = process.env[name]?.trim();
  return v || null;
}

function str(name, fallback) {
  const v = process.env[name]?.trim();
  return v || fallback;
}

function bool(name, fallback) {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

function int(name, fallback, min) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    log.warn(`${name}="${raw}" is not a number, using ${fallback}`);
    return fallback;
  }
  if (min !== undefined && n < min) {
    log.warn(`${name}=${n} is below the minimum of ${min}, using ${min}`);
    return min;
  }
  return n;
}

function choice(name, fallback, allowed) {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  if (!allowed.includes(v)) {
    log.warn(`${name}="${v}" is not one of ${allowed.join(', ')}, using ${fallback}`);
    return fallback;
  }
  return v;
}

export const config = {
  port: int('PORT', 2646),
  dataDir: str('DATA_DIR', './data'),
  dryRun: bool('DRY_RUN', false),

  syncIntervalSeconds: int('SYNC_INTERVAL_SECONDS', 60, 10),

  // reconcile: every pass matches all rows and writes any difference, so a row
  //   can never be permanently missed. The watermark only suppresses repeat
  //   Discord messages.
  // watermark: only rows newer than the watermark are considered at all.
  syncMode: choice('SYNC_MODE', 'reconcile', ['reconcile', 'watermark']),

  smartsheet: {
    clientId: required('SMARTSHEET_CLIENT_ID'),
    clientSecret: required('SMARTSHEET_CLIENT_SECRET'),
    // Optional escape hatch: a personal API token skips the OAuth flow entirely.
    accessToken: required('SMARTSHEET_ACCESS_TOKEN'),
    sheetId: required('SMARTSHEET_SHEET_ID'),
    // A report is used as a row filter over its source sheet(s). Takes priority.
    reportId: required('SMARTSHEET_REPORT_ID'),
    nameColumn: str('SMARTSHEET_NAME_COLUMN', 'NAME'),
    // Write targets. A blank title disables that column entirely.
    versionColumn: str('SMARTSHEET_VERSION_COLUMN', 'VERSION'),
    processedColumn: str('SMARTSHEET_PROCESSED_COLUMN', 'PROCESSED'),
    durationColumn: str('SMARTSHEET_DURATION_COLUMN', ''),
    statusColumn: str('SMARTSHEET_STATUS_COLUMN', ''),
    notesColumn: str('SMARTSHEET_NOTES_COLUMN', ''),
    // Composite columns, built from GOOGLE_*_TEMPLATE below.
    formatColumn: str('SMARTSHEET_FORMAT_COLUMN', ''),
    audioColumn: str('SMARTSHEET_AUDIO_COLUMN', ''),
    miscColumn: str('SMARTSHEET_MISC_COLUMN', ''),
    scopes: str('SMARTSHEET_SCOPES', 'READ_SHEETS WRITE_SHEETS'),
  },

  google: {
    sheetId: str('GOOGLE_SHEET_ID', ''),
    gid: str('GOOGLE_SHEET_GID', '0'),
    // Tab title. Optional -- normally the gid above is translated to a title.
    tab: str('GOOGLE_SHEET_TAB', ''),
    // Service account key: raw JSON on one line, or base64, or a file path.
    creds: required('GOOGLE_CREDS'),
    credsFile: required('GOOGLE_CREDS_FILE'),
    // Source column titles. NAME and PROCESSED are required; the rest may be
    // absent, in which case that field is simply empty.
    nameColumn: str('GOOGLE_NAME_COLUMN', 'NAME'),
    versionColumn: str('GOOGLE_VERSION_COLUMN', 'VERSION'),
    processedColumn: str('GOOGLE_PROCESSED_COLUMN', 'PROCESSED'),
    durationColumn: str('GOOGLE_DURATION_COLUMN', 'DURATION'),
    filenameColumn: str('GOOGLE_FILENAME_COLUMN', 'FILENAME'),
    statusColumn: str('GOOGLE_STATUS_COLUMN', 'STATUS'),
    notesColumn: str('GOOGLE_NOTES_COLUMN', 'NOTES'),
    // Composites. {COL} is substituted; a [...] segment vanishes if any
    // placeholder inside it is blank.
    formatTemplate: str('GOOGLE_FORMAT_TEMPLATE', '[{CODEC}][, {WIDTH} x {HEIGHT}][ @ {FPS}]'),
    audioTemplate: str('GOOGLE_AUDIO_TEMPLATE', '[{CH}ch ][{AUDIO}][ @ {RATE}k][, {BITS}bit]'),
    miscTemplate: str('GOOGLE_MISC_TEMPLATE', '[{DURATION}][, {FILENAME}]'),
  },

  discord: {
    webhookUrl: required('DISCORD_WEBHOOK_URL'),
  },

  // Status updates to cn4m, the parent system. Unlike every other setting, an
  // EMPTY value is meaningful here: STATUS_URL= switches updates off, while
  // leaving it unset takes the default.
  status: {
    url: process.env.STATUS_URL === undefined
      ? 'http://localhost:2640/suite/status'
      : process.env.STATUS_URL.trim(),
    app: str('STATUS_APP', 'smartsync'),
  },

  // Never blank out a Smartsheet cell because the Google Sheet cell is empty
  // (348 of the current rows have no DURATION -- stills).
  skipBlankValues: bool('SKIP_BLANK_VALUES', true),
};

// Problems that stop the sync loop but still let the web UI boot, so the
// container stays up and can tell you what is missing.
export function configProblems() {
  const problems = [];
  if (!config.google.sheetId) problems.push('GOOGLE_SHEET_ID is not set');
  if (!config.smartsheet.sheetId && !config.smartsheet.reportId) {
    problems.push('Set SMARTSHEET_SHEET_ID or SMARTSHEET_REPORT_ID');
  }
  if (!config.smartsheet.accessToken && !(config.smartsheet.clientId && config.smartsheet.clientSecret)) {
    problems.push('Set SMARTSHEET_CLIENT_ID + SMARTSHEET_CLIENT_SECRET (OAuth), or SMARTSHEET_ACCESS_TOKEN');
  }
  if (!config.discord.webhookUrl) problems.push('DISCORD_WEBHOOK_URL is not set (unmatched rows will only be logged)');
  return problems;
}
