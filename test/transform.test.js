import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVersion, displayVersion, normalizeProcessed, normalizeDuration,
  selectNewRows, advanceWatermark, fingerprint,
} from '../src/transform.js';
import { parseCsvToObjects } from '../src/csv.js';

test('normalizeVersion drops the emoji and any underscore suffix', () => {
  assert.equal(normalizeVersion('☝️ v2'), 'v2');
  assert.equal(normalizeVersion('🆕 v01'), 'v01');
  assert.equal(normalizeVersion('🆕 v01_hapaudio'), 'v01');
  assert.equal(normalizeVersion('☝️ v001_30fps_b'), 'v001', 'strips from the FIRST underscore');
  assert.equal(normalizeVersion('☝️ v000n'), 'v000n', 'a non-underscore suffix is kept');
  assert.equal(normalizeVersion('☝️ v0b'), 'v0b');
  assert.equal(normalizeVersion('v3'), 'v3');
  assert.equal(normalizeVersion(''), '');
  assert.equal(normalizeVersion(undefined), '');
});

test('displayVersion keeps the emoji but still drops the underscore suffix', () => {
  assert.equal(displayVersion('☝️ v2'), '☝️ v2');
  assert.equal(displayVersion('🆕 v01_hapaudio'), '🆕 v01');
  assert.equal(displayVersion('☝️ v001_30fps_b'), '☝️ v001');
  assert.equal(displayVersion('☝️v2'), '☝️ v2', 'a missing space is normalised to one');
  assert.equal(displayVersion('v3'), 'v3', 'no emoji, nothing added');
  assert.equal(displayVersion('☝️'), '', 'an emoji with no version is still empty');
  assert.equal(displayVersion(''), '');
  assert.equal(displayVersion(undefined), '');
});

test('normalizeProcessed accepts the sheet format and rejects junk', () => {
  assert.equal(normalizeProcessed('2026-06-18 14:55:34'), '2026-06-18 14:55:34');
  assert.equal(normalizeProcessed('2026-06-18T14:55:34'), '2026-06-18 14:55:34');
  assert.equal(normalizeProcessed(''), null);
  assert.equal(normalizeProcessed('not a date'), null);
});

test('normalized timestamps sort chronologically as plain strings', () => {
  const sorted = ['2026-06-18 14:55:34', '2026-06-06 16:42:43', '2026-06-18 09:01:00'].sort();
  assert.deepEqual(sorted, ['2026-06-06 16:42:43', '2026-06-18 09:01:00', '2026-06-18 14:55:34']);
});

test('normalizeDuration passes both timecode and millisecond forms through', () => {
  assert.equal(normalizeDuration('00:03:00:00'), '00:03:00:00');
  assert.equal(normalizeDuration('00:17:39.067'), '00:17:39.067');
  assert.equal(normalizeDuration(''), '');
});

const row = (NAME, PROCESSED, extra = {}) => ({
  NAME, PROCESSED, FILENAME: `${NAME}.mov`, VERSION: '🆕 v1', DURATION: '00:00:10:00', ...extra,
});

test('selectNewRows takes everything when there is no watermark', () => {
  const rows = [row('a', '2026-06-01 00:00:00'), row('b', '2026-06-02 00:00:00')];
  assert.equal(selectNewRows(rows, { watermark: null, seenAtWatermark: [] }).length, 2);
});

test('selectNewRows ignores rows at or below the watermark', () => {
  const rows = [row('old', '2026-06-01 00:00:00'), row('new', '2026-06-03 00:00:00')];
  const state = { watermark: '2026-06-02 00:00:00', seenAtWatermark: [] };
  const picked = selectNewRows(rows, state);
  assert.deepEqual(picked.map((p) => p.row.NAME), ['new']);
});

test('selectNewRows still catches a row added in the same second as the watermark', () => {
  const already = row('first', '2026-06-02 12:00:00');
  const late = row('second', '2026-06-02 12:00:00');
  const state = { watermark: '2026-06-02 12:00:00', seenAtWatermark: [fingerprint(already)] };
  const picked = selectNewRows([already, late], state);
  assert.deepEqual(picked.map((p) => p.row.NAME), ['second']);
});

test('selectNewRows re-picks a row whose VERSION changed at the same timestamp', () => {
  const before = row('clip', '2026-06-02 12:00:00', { VERSION: '🆕 v1' });
  const after = row('clip', '2026-06-02 12:00:00', { VERSION: '☝️ v2' });
  const state = { watermark: '2026-06-02 12:00:00', seenAtWatermark: [fingerprint(before)] };
  assert.equal(selectNewRows([after], state).length, 1);
});

test('selectNewRows skips rows with an unparseable PROCESSED', () => {
  assert.equal(selectNewRows([row('x', '')], { watermark: null, seenAtWatermark: [] }).length, 0);
});

test('advanceWatermark records the max plus every row sharing it', () => {
  const rows = [row('a', '2026-06-01 00:00:00'), row('b', '2026-06-05 08:00:00'), row('c', '2026-06-05 08:00:00')];
  const { watermark, seenAtWatermark } = advanceWatermark(rows, null);
  assert.equal(watermark, '2026-06-05 08:00:00');
  assert.equal(seenAtWatermark.length, 2);
});

test('advanceWatermark never moves backwards', () => {
  const { watermark } = advanceWatermark([row('a', '2026-01-01 00:00:00')], '2026-06-01 00:00:00');
  assert.equal(watermark, '2026-06-01 00:00:00');
});

test('CSV parsing survives quoted commas, escaped quotes and emoji', () => {
  const csv = 'NAME,NOTES,VERSION\n4020_D4Preshow_F,"a, b ""quoted""",☝️ v2\n';
  const { records } = parseCsvToObjects(csv);
  assert.equal(records[0].NOTES, 'a, b "quoted"');
  assert.equal(normalizeVersion(records[0].VERSION), 'v2');
});

import { compareVersions, highestVersion, highestProcessed, aggregateByName } from '../src/transform.js';

test('compareVersions orders numerically, not lexically', () => {
  assert.ok(compareVersions('v2', 'v01') > 0, 'v2 beats v01');
  assert.ok(compareVersions('v10', 'v9') > 0, 'v10 beats v9');
  assert.ok(compareVersions('v0b', 'v0a') > 0, 'v0b beats v0a');
  assert.ok(compareVersions('v001', 'v000n') > 0, 'v001 beats v000n');
  assert.equal(compareVersions('v2', 'v02'), 0, 'v2 and v02 are the same version');
});

test('highestVersion reduces a group to its top version, emoji and all', () => {
  const rows = [{ VERSION: '🆕 v1' }, { VERSION: '☝️ v3' }, { VERSION: '🆕 v2' }];
  assert.equal(highestVersion(rows), '☝️ v3', 'the winning row keeps its own emoji');
});

test('highestVersion ignores blanks and copes with an all-blank group', () => {
  assert.equal(highestVersion([{ VERSION: '' }, { VERSION: '☝️ v1' }]), '☝️ v1');
  assert.equal(highestVersion([{ VERSION: '' }]), '');
});

test('highestProcessed picks the latest timestamp', () => {
  const rows = [
    { PROCESSED: '2026-06-01 10:00:00' },
    { PROCESSED: '2026-06-02 08:00:00' },
    { PROCESSED: '2026-06-01 23:59:59' },
  ];
  assert.equal(highestProcessed(rows), '2026-06-02 08:00:00');
});

test('aggregateByName reduces VERSION and PROCESSED independently', () => {
  // The top version and the latest timestamp deliberately live on different rows.
  const candidates = [
    { row: { NAME: 'clip_a', VERSION: '🆕 v1', PROCESSED: '2026-06-01 10:00:00', DURATION: '00:00:01:00' } },
    { row: { NAME: 'clip_a', VERSION: '☝️ v3', PROCESSED: '2026-06-01 09:00:00', DURATION: '00:00:03:00' } },
    { row: { NAME: 'clip_a', VERSION: '🆕 v2', PROCESSED: '2026-06-02 08:00:00', DURATION: '00:00:02:00' } },
    { row: { NAME: 'clip_b', VERSION: '🆕 v0', PROCESSED: '2026-06-01 00:00:00', DURATION: '' } },
  ];

  const grouped = aggregateByName(candidates);
  assert.equal(grouped.size, 2);

  const a = grouped.get('clip_a');
  assert.equal(a.rows.length, 3);
  assert.equal(a.values.version, '☝️ v3', 'highest version, from row 2');
  assert.equal(a.values.processed, '2026-06-02 08:00:00', 'latest timestamp, from row 3');
  assert.equal(a.values.duration, '00:00:02:00', 'duration follows the latest-processed row');

  assert.equal(grouped.get('clip_b').values.version, '🆕 v0');
});

test('aggregateByName matches names case-insensitively and skips nameless rows', () => {
  const grouped = aggregateByName([
    { row: { NAME: 'Clip_A', VERSION: '🆕 v1', PROCESSED: '2026-06-01 10:00:00' } },
    { row: { NAME: 'clip_a', VERSION: '☝️ v5', PROCESSED: '2026-06-01 11:00:00' } },
    { row: { NAME: '', VERSION: '🆕 v9', PROCESSED: '2026-06-01 12:00:00' } },
  ]);
  assert.equal(grouped.size, 1);
  assert.equal(grouped.get('clip_a').values.version, '☝️ v5');
});

test('a real group of encoding variants collapses to one version', () => {
  // Six rows for 1105_A1_OpeningFilm. The _30fps / _hapaudio / _b suffixes are
  // encodings of the same v001, so the group must reduce to a clean "v001".
  const rows = [
    { VERSION: '☝️ v001_30fps_b' },
    { VERSION: '☝️ v001_30fps' },
    { VERSION: '☝️ v001_hapaudio' },
    { VERSION: '☝️ v001' },
    { VERSION: '☝️ v000n' },
    { VERSION: '🆕 v000' },
  ];
  assert.equal(highestVersion(rows), '☝️ v001');
});

test('underscore stripping cannot promote a variant above a real version', () => {
  assert.equal(highestVersion([{ VERSION: '☝️ v001_hapaudio' }, { VERSION: '☝️ v002' }]), '☝️ v002');
});

import { selectForSync } from '../src/transform.js';

const sheet = [
  { NAME: 'old_a', FILENAME: 'old_a.mov', VERSION: '🆕 v1', DURATION: '', PROCESSED: '2026-06-01 10:00:00' },
  { NAME: 'old_b', FILENAME: 'old_b.mov', VERSION: '🆕 v1', DURATION: '', PROCESSED: '2026-06-02 10:00:00' },
  { NAME: 'new_c', FILENAME: 'new_c.mov', VERSION: '🆕 v1', DURATION: '', PROCESSED: '2026-06-09 10:00:00' },
];
const atWatermark = { watermark: '2026-06-05 00:00:00', seenAtWatermark: [] };

test('watermark mode considers only new rows, and all of them may notify', () => {
  const { candidates, notifiable } = selectForSync(sheet, atWatermark, 'watermark');
  assert.deepEqual(candidates.map((c) => c.row.NAME), ['new_c']);
  assert.equal(notifiable, null, 'null means every candidate may notify');
});

test('reconcile mode considers every row but only new ones may notify', () => {
  const { candidates, notifiable } = selectForSync(sheet, atWatermark, 'reconcile');
  assert.deepEqual(candidates.map((c) => c.row.NAME), ['old_a', 'old_b', 'new_c']);
  assert.equal(notifiable.size, 1, 'only new_c may notify');
  assert.ok(notifiable.has(fingerprint(sheet[2])));
  assert.ok(!notifiable.has(fingerprint(sheet[0])), 'an old row must not notify again');
});

test('reconcile keeps writing everything once the watermark has caught up', () => {
  const caughtUp = { watermark: '2026-06-09 10:00:00', seenAtWatermark: sheet.map(fingerprint) };
  const { candidates, notifiable } = selectForSync(sheet, caughtUp, 'reconcile');
  assert.equal(candidates.length, 3, 'still reconciles every row');
  assert.equal(notifiable.size, 0, 'but nothing is announced');
});

test('an unknown mode falls back to watermark behaviour', () => {
  const { candidates, notifiable } = selectForSync(sheet, atWatermark, 'anything-else');
  assert.equal(candidates.length, 1);
  assert.equal(notifiable, null);
});

import { renderTemplate } from '../src/transform.js';

const FORMAT = '[{CODEC}][, {WIDTH} x {HEIGHT}][ @ {FPS}]';
const AUDIO = '[{CH}ch ][{AUDIO}][ @ {RATE}k][, {BITS}bit]';
const movie = { CODEC: 'NotchLC', WIDTH: '6912', HEIGHT: '3840', FPS: '30.000', AUDIO: 'PCM', RATE: '48000', BITS: '16', CH: '2' };
const still = { CODEC: '', WIDTH: '6912', HEIGHT: '3840', FPS: '', AUDIO: '', RATE: '', BITS: '', CH: '' };

test('renderTemplate composes a full movie row', () => {
  assert.equal(renderTemplate(FORMAT, movie), 'NotchLC, 6912 x 3840 @ 30.000');
  assert.equal(renderTemplate(AUDIO, movie), '2ch PCM @ 48000k, 16bit');
});

test('a still drops the segments it has no values for', () => {
  assert.equal(renderTemplate(FORMAT, still), '6912 x 3840', 'no dangling comma or @');
  assert.equal(renderTemplate(AUDIO, still), '', 'blank, so SKIP_BLANK_VALUES leaves the cell alone');
});

test('a partly-populated row keeps only the segments it can fill', () => {
  assert.equal(renderTemplate(AUDIO, { ...movie, BITS: '' }), '2ch PCM @ 48000k');
  assert.equal(renderTemplate(FORMAT, { ...movie, FPS: '' }), 'NotchLC, 6912 x 3840');
});

test('a segment needs every placeholder inside it, not just one', () => {
  assert.equal(renderTemplate('[{WIDTH} x {HEIGHT}]', { WIDTH: '100', HEIGHT: '' }), '');
});

test('placeholders match column names case-insensitively', () => {
  assert.equal(renderTemplate('[{codec}]', movie), 'NotchLC');
});

test('a template with nothing to fill renders empty, not punctuation', () => {
  assert.equal(renderTemplate(FORMAT, {}), '');
  assert.equal(renderTemplate('[{A}], [{B}]', {}), '');
});

test('an unset template is simply empty', () => {
  assert.equal(renderTemplate('', movie), '');
  assert.equal(renderTemplate(undefined, movie), '');
});

test('bare placeholders outside brackets still substitute', () => {
  assert.equal(renderTemplate('{CODEC} fixed', movie), 'NotchLC fixed');
});

test('aggregate carries status, notes and the composites from the latest row', () => {
  const rows = [
    { row: { NAME: 'a', VERSION: '🆕 v1', PROCESSED: '2026-06-01 10:00:00', STATUS: 'old', NOTES: 'old note', ...still } },
    { row: { NAME: 'a', VERSION: '🆕 v2', PROCESSED: '2026-06-02 10:00:00', STATUS: 'ingested', NOTES: '🎬', ...movie } },
  ];
  const { values } = aggregateByName(rows, { format: FORMAT, audio: AUDIO }).get('a');
  assert.equal(values.status, 'ingested', 'from the latest row');
  assert.equal(values.notes, '🎬');
  assert.equal(values.format, 'NotchLC, 6912 x 3840 @ 30.000');
  assert.equal(values.audio, '2ch PCM @ 48000k, 16bit');
  assert.equal(values.version, '🆕 v2');
});

const MISC = '[{DURATION}][, {FILENAME}]';

test('the misc composite pairs duration with filename', () => {
  assert.equal(renderTemplate(MISC, { DURATION: '00:00:30:00', FILENAME: 'clip_v001.mov' }), '00:00:30:00, clip_v001.mov');
  assert.equal(renderTemplate(MISC, { DURATION: '', FILENAME: 'still_v001.png' }), 'still_v001.png', 'no dangling comma');
  assert.equal(renderTemplate(MISC, { DURATION: '00:00:30:00', FILENAME: '' }), '00:00:30:00');
  assert.equal(renderTemplate(MISC, {}), '', 'blank, so SKIP_BLANK_VALUES leaves the cell alone');
});

test('aggregate builds misc from the latest-processed row', () => {
  const rows = [
    { row: { NAME: 'a', VERSION: '🆕 v1', PROCESSED: '2026-06-01 10:00:00', DURATION: '00:00:01:00', FILENAME: 'a_v001.mov' } },
    { row: { NAME: 'a', VERSION: '🆕 v2', PROCESSED: '2026-06-02 10:00:00', DURATION: '00:00:02:00', FILENAME: 'a_v002.mov' } },
  ];
  const { values } = aggregateByName(rows, { misc: MISC }).get('a');
  assert.equal(values.misc, '00:00:02:00, a_v002.mov');
});

test('misc is empty when no template is configured', () => {
  const rows = [{ row: { NAME: 'a', VERSION: '🆕 v1', PROCESSED: '2026-06-01 10:00:00', DURATION: '00:00:01:00', FILENAME: 'a.mov' } }];
  assert.equal(aggregateByName(rows).get('a').values.misc, '');
});
