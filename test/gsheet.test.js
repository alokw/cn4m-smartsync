import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/gsheet.js';

const COLUMNS = {
  NAME: 'Asset Name',
  PROCESSED: 'Processed At',
  VERSION: 'Ver',
  DURATION: 'Runtime',
  FILENAME: 'File',
};

const headers = ['Asset Name', 'Ver', 'Runtime', 'Processed At', 'File', 'Notes'];
const records = [{
  'Asset Name': '4020_D4Preshow_F',
  Ver: '☝️ v2',
  Runtime: '00:17:39.067',
  'Processed At': '2026-06-18 14:55:34',
  File: '4020_D4Preshow_F_V2.mov',
  Notes: 'ignore me',
}];

test('canonicalize maps configured titles onto the canonical keys', () => {
  const { records: [row] } = canonicalize(headers, records, COLUMNS);
  assert.equal(row.NAME, '4020_D4Preshow_F');
  assert.equal(row.VERSION, '☝️ v2');
  assert.equal(row.PROCESSED, '2026-06-18 14:55:34');
  assert.equal(row.FILENAME, '4020_D4Preshow_F_V2.mov');
});

test('canonicalize keeps the original columns alongside', () => {
  const { records: [row] } = canonicalize(headers, records, COLUMNS);
  assert.equal(row.Notes, 'ignore me');
  assert.equal(row['Asset Name'], '4020_D4Preshow_F');
});

test('titles match case- and whitespace-insensitively', () => {
  const { records: [row] } = canonicalize(headers, records, { ...COLUMNS, NAME: '  asset name  ' });
  assert.equal(row.NAME, '4020_D4Preshow_F');
});

test('a missing required column fails loudly and lists the real headers', () => {
  assert.throws(
    () => canonicalize(headers, records, { ...COLUMNS, NAME: 'Nope' }),
    (err) => /"Nope" \(for NAME\)/.test(err.message) && /Available: Asset Name, Ver/.test(err.message),
  );
  assert.throws(() => canonicalize(headers, records, { ...COLUMNS, PROCESSED: 'Nope' }), /for PROCESSED/);
});

test('a missing optional column is tolerated and left empty', () => {
  const { records: [row], missing } = canonicalize(headers, records, { ...COLUMNS, DURATION: 'Absent' });
  assert.equal(row.DURATION, undefined, 'no canonical DURATION key is produced');
  assert.deepEqual(missing.map((m) => m.field), ['DURATION']);
});

test('the default configuration is an identity mapping', () => {
  const plain = [{ NAME: 'a', VERSION: 'v1', PROCESSED: '2026-01-01 00:00:00', DURATION: '', FILENAME: 'a.mov' }];
  const { records: [row] } = canonicalize(
    ['NAME', 'VERSION', 'PROCESSED', 'DURATION', 'FILENAME'], plain,
    { NAME: 'NAME', VERSION: 'VERSION', PROCESSED: 'PROCESSED', DURATION: 'DURATION', FILENAME: 'FILENAME' },
  );
  assert.deepEqual(row, plain[0]);
});
