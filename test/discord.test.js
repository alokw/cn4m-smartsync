import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchLines, unmatchedLines, multipleMatchLines } from '../src/discord.js';

test('batchLines keeps everything in one message when it fits', () => {
  const batches = batchLines(['a', 'b', 'c'], 100);
  assert.equal(batches.length, 1);
  assert.equal(batches[0], 'a\nb\nc');
});

test('batchLines splits rather than exceeding the limit', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`.padEnd(20, 'x'));
  const batches = batchLines(lines, 50);
  assert.ok(batches.length > 1, 'should split');
  for (const b of batches) assert.ok(b.length <= 50, `batch too long: ${b.length}`);
  assert.equal(batches.join('\n').split('\n').length, 10, 'no lines lost');
});

test('batchLines truncates a single oversized line instead of dropping it', () => {
  const [only] = batchLines(['x'.repeat(500)], 100);
  assert.equal(only.length, 100);
  assert.ok(only.endsWith('…'));
});

test('batchLines returns nothing for no input', () => {
  assert.deepEqual(batchLines([], 100), []);
});

test('unmatched lines name the file', () => {
  assert.deepEqual(unmatchedLines(['a.mov']), ['**a.mov**: no match found in smartsheet']);
});

test('ambiguous lines name the NAME and the count', () => {
  assert.deepEqual(
    multipleMatchLines([{ name: '1740_A1_Vis_Film', count: 5 }]),
    ['**1740_A1_Vis_Film**: matched 5 rows in smartsheet, all updated'],
  );
});

test('a realistic flood of unmatched rows batches without exceeding the limit', () => {
  const lines = unmatchedLines(Array.from({ length: 107 }, (_, i) => `asset_${i}_v001_hap.mov`));
  const batches = batchLines(lines);
  for (const b of batches) assert.ok(b.length <= 1900);
  assert.equal(batches.join('\n').split('\n').length, 107);
});

import { lockedLines, failureLines, recoveryLines } from '../src/discord.js';

test('locked lines say the row was skipped, not that it was missing', () => {
  assert.deepEqual(
    lockedLines([{ name: '1445_B1_Snapchat_Spotlight', count: 1 }]),
    ['**1445_B1_Snapchat_Spotlight**: matched 1 locked row in smartsheet, not updated'],
  );
  assert.deepEqual(
    lockedLines([{ name: 'clip_a', count: 3 }]),
    ['**clip_a**: matched 3 locked rows in smartsheet, not updated'],
  );
});

const FAILED_AT = '2026-08-28T19:55:42.657Z';

test('the first failure alert carries the error itself', () => {
  const [line] = failureLines({ message: 'sync failed: boom', since: FAILED_AT, count: 1 });
  assert.match(line, /sync failed/);
  assert.match(line, /boom/);
  assert.ok(!line.includes('attempts since'), 'no repeat wording on the first alert');
});

test('a repeat alert leads with how long it has been going', () => {
  const [line] = failureLines({ message: 'sync failed: boom', since: FAILED_AT, count: 36 });
  assert.match(line, /still failing/);
  assert.match(line, /36 attempts since 2026-08-28 19:55:42 UTC/, 'readable timestamp, no ISO T or millis');
});

test('a long error is truncated so the alert still fits Discord', () => {
  const [line] = failureLines({ message: 'x'.repeat(9000), since: FAILED_AT, count: 1 });
  assert.ok(line.length <= 1900, `alert too long: ${line.length}`);
  assert.equal(batchLines([line]).length, 1, 'still a single message');
});

test('recovery names the incident it closes', () => {
  assert.deepEqual(
    recoveryLines({ since: FAILED_AT, count: 36 }),
    ['✅ **sync recovered** — back to normal after 36 failed attempts since 2026-08-28 19:55:42 UTC'],
  );
  assert.match(recoveryLines({ since: FAILED_AT, count: 1 })[0], /1 failed attempt since/, 'singular');
});
