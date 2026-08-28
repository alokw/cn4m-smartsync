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
