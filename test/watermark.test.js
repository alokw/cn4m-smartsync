import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualWatermark } from '../src/store.js';

const state = {
  initialized: true,
  watermark: '2026-08-27 13:49:43',
  seenAtWatermark: ['a|b|c|d'],
  lastRunAt: '2026-08-27T13:50:00Z',
};

test('backfill clears the watermark so every row re-syncs', () => {
  const next = manualWatermark('backfill', state);
  assert.equal(next.watermark, null);
  assert.deepEqual(next.seenAtWatermark, []);
  assert.equal(next.initialized, true, 'stays initialized, so the next pass really writes');
});

test('arm clears the watermark and re-arms first-run protection', () => {
  const next = manualWatermark('arm', state);
  assert.equal(next.watermark, null);
  assert.equal(next.initialized, false, 'next pass only re-records, writes nothing');
});

test('set accepts a timestamp and normalises it', () => {
  assert.equal(manualWatermark('set', state, '2026-01-02 03:04:05').watermark, '2026-01-02 03:04:05');
  assert.equal(manualWatermark('set', state, '2026-01-02T03:04:05').watermark, '2026-01-02 03:04:05');
});

test('set rejects anything that is not a timestamp', () => {
  assert.throws(() => manualWatermark('set', state, 'yesterday'), /not a valid timestamp/);
  assert.throws(() => manualWatermark('set', state, ''), /not a valid timestamp/);
  assert.throws(() => manualWatermark('set', state, undefined), /not a valid timestamp/);
});

test('an unknown mode is rejected rather than silently ignored', () => {
  assert.throws(() => manualWatermark('nonsense', state), /unknown mode "nonsense"/);
  assert.throws(() => manualWatermark('', state), /unknown mode/);
});

test('overrides never mutate the state passed in', () => {
  const before = JSON.stringify(state);
  manualWatermark('backfill', state);
  manualWatermark('set', state, '2020-01-01 00:00:00');
  assert.equal(JSON.stringify(state), before);
});

test('unrelated state fields survive an override', () => {
  assert.equal(manualWatermark('backfill', state).lastRunAt, state.lastRunAt);
});
