import { config, configProblems } from './config.js';
import { log } from './log.js';
import { fetchRows } from './gsheet.js';
import { notifyUnmatched, notifyMultipleMatches } from './discord.js';
import { stateStore } from './store.js';
import { updateRows, NotConnectedError } from './smartsheet.js';
import { loadTarget, WRITE_FIELDS, enabledFields } from './target.js';
import { selectForSync, advanceWatermark, aggregateByName, normalizeName, fingerprint } from './transform.js';

let running = false;

// Decides the cells to write for one matched row, skipping any value that is
// already correct so an unchanged row never generates a Smartsheet write.
function buildCellUpdates(targetRow, values, columns) {
  const cells = [];

  for (const field of WRITE_FIELDS) {
    const column = columns[field];
    if (!column) continue;                       // disabled by a blank title

    const value = values[field] ?? '';
    if (value === '' && config.skipBlankValues) continue;
    if ((targetRow.current[field] ?? '') === value) continue;

    cells.push({ columnId: column.id, value });
  }
  return cells;
}

export async function runSync({ force = false } = {}) {
  if (running) {
    log.debug('sync already in progress, skipping this tick');
    return { skipped: true, reason: 'already running' };
  }
  running = true;

  try {
    return await performSync({ force });
  } catch (err) {
    if (err instanceof NotConnectedError) {
      log.warn(err.message);
      return { ok: false, reason: 'not connected' };
    }
    log.error(`sync failed: ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    running = false;
  }
}

async function performSync({ force }) {
  const problems = configProblems().filter((p) => !p.includes('DISCORD'));
  if (problems.length) {
    log.warn(`sync paused: ${problems.join('; ')}`);
    return { ok: false, reason: problems.join('; ') };
  }

  const state = await stateStore.read();
  const { records } = await fetchRows();
  const { candidates, notifiable } = selectForSync(records, state, config.syncMode);

  // null means "everything may notify" -- watermark mode, where candidates are
  // already limited to new rows.
  const mayNotify = (row) => notifiable === null || notifiable.has(fingerprint(row));

  // First ever run: record where the sheet stands and report what would happen,
  // but write nothing. Otherwise every pre-existing row looks brand new.
  const firstRun = !state.initialized && !force;

  if (candidates.length === 0) {
    log.info(`no new rows (${records.length} total, watermark ${state.watermark ?? 'unset'})`);
    const advanced = advanceWatermark(records, state.watermark);
    await stateStore.write({
      ...state, ...advanced, initialized: true,
      lastRunAt: new Date().toISOString(),
      lastResult: { ok: true, newRows: 0, updated: 0, unmatched: 0 },
    });
    return { ok: true, newRows: 0, updated: 0, unmatched: 0 };
  }

  if (firstRun) {
    const advanced = advanceWatermark(records, state.watermark);
    log.info(`first run: ${candidates.length} existing row(s) seen, nothing written. Watermark set to ${advanced.watermark}.`);
    log.info('Only rows processed after this point will sync. Use "Run sync now (force)" in the UI to backfill instead.');
    await stateStore.write({
      ...state, ...advanced, initialized: true,
      lastRunAt: new Date().toISOString(),
      lastResult: { ok: true, firstRun: true, newRows: candidates.length, updated: 0, unmatched: 0 },
    });
    return { ok: true, firstRun: true, newRows: candidates.length, updated: 0, unmatched: 0 };
  }

  log.info(config.syncMode === 'reconcile'
    ? `reconciling all ${candidates.length} row(s); ${notifiable.size} newer than ${state.watermark ?? 'the beginning'} may notify`
    : `${candidates.length} new row(s) since ${state.watermark ?? 'the beginning'}`);

  const target = await loadTarget();
  log.info(`writing columns: ${enabledFields().join(', ') || '(none configured)'}`);

  // NAME -> every eligible row carrying it. Duplicates are possible, and
  // silently updating only the first one would be a quiet data bug.
  const byName = new Map();
  for (const row of target.rows) {
    const key = normalizeName(row.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }

  // Grouped per source sheet: a report can span several, and each sheet takes
  // its own write request.
  const updatesBySheet = new Map();
  const unmatched = [];
  const ambiguous = [];
  let unchanged = 0;

  // Several Google rows can share a NAME, so reduce each name to one set of
  // values first -- highest VERSION and highest PROCESSED across the group.
  for (const [key, group] of aggregateByName(candidates, {
    format: config.google.formatTemplate,
    audio: config.google.audioTemplate,
    misc: config.google.miscTemplate,
  })) {
    const matches = byName.get(key);

    if (!matches?.length) {
      for (const row of group.rows) {
        if (mayNotify(row)) unmatched.push(row.FILENAME || row.NAME || '(unnamed row)');
      }
      continue;
    }

    if (group.rows.length > 1) {
      log.debug(`NAME "${group.rows[0].NAME}" has ${group.rows.length} new rows -> version ${group.values.version || '-'}, processed ${group.values.processed || '-'}`);
    }

    if (matches.length > 1) {
      log.warn(`NAME "${group.rows[0].NAME}" matches ${matches.length} rows, updating all of them`);
      if (group.rows.some(mayNotify)) ambiguous.push({ name: group.rows[0].NAME, count: matches.length });
    }

    for (const targetRow of matches) {
      const columns = target.columnsBySheet.get(targetRow.sheetId);
      const cells = buildCellUpdates(targetRow, group.values, columns);
      if (cells.length === 0) { unchanged++; continue; }
      if (!updatesBySheet.has(targetRow.sheetId)) updatesBySheet.set(targetRow.sheetId, []);
      updatesBySheet.get(targetRow.sheetId).push({ id: targetRow.rowId, cells });
    }
  }

  const updateCount = [...updatesBySheet.values()].reduce((n, rows) => n + rows.length, 0);

  if (config.dryRun) {
    log.info(`DRY_RUN: would update ${updateCount} row(s) in ${target.kind} "${target.label}", ${unmatched.length} unmatched, ${ambiguous.length} ambiguous, ${unchanged} already current`);
    for (const name of unmatched) log.info(`DRY_RUN: ${name}: no match found in smartsheet`);
    for (const a of ambiguous) log.info(`DRY_RUN: ${a.name}: matched ${a.count} rows in smartsheet`);
    return { ok: true, dryRun: true, target: target.label, newRows: candidates.length, updated: updateCount, unchanged, unmatched: unmatched.length, ambiguous: ambiguous.length };
  }

  if (updateCount) {
    for (const [sheetId, rows] of updatesBySheet) await updateRows(sheetId, rows);
    log.info(`updated ${updateCount} row(s) across ${updatesBySheet.size} sheet(s)`);
  }

  await notifyUnmatched(unmatched);
  await notifyMultipleMatches(ambiguous);

  // Only advance past rows we actually handled, so a mid-run failure retries them.
  const advanced = advanceWatermark(candidates.map((c) => c.row), state.watermark);
  const result = {
    ok: true,
    target: target.label,
    mode: config.syncMode,
    newRows: candidates.length,
    updated: updateCount,
    unchanged,
    unmatched: unmatched.length,
    ambiguous: ambiguous.length,
  };

  await stateStore.write({
    ...state, ...advanced, initialized: true,
    lastRunAt: new Date().toISOString(),
    lastResult: result,
  });

  log.info(`sync complete: ${JSON.stringify(result)}`);
  return result;
}
