import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, recentEvents, eventCounts, clearEvents } from '../src/events.js';

const at = (n) => `2026-09-03T21:${String(n).padStart(2, '0')}:00.000Z`;

test('the feed reads newest first', () => {
  clearEvents();
  record({ at: at(1), level: 'info', message: 'first', notable: true });
  record({ at: at(2), level: 'info', message: 'second', notable: true });

  assert.deepEqual(recentEvents().map((e) => e.message), ['second', 'first']);
});

// Every pass narrates itself, so the default view has to be the news only.
test('warnings and errors are notable without being marked', () => {
  clearEvents();
  record({ at: at(1), level: 'info', message: 'reconciling all 259 rows', notable: false });
  record({ at: at(2), level: 'info', message: 'updated 5 rows', notable: true });
  record({ at: at(3), level: 'warn', message: 'skipping 1 locked row', notable: false });
  record({ at: at(4), level: 'error', message: 'sync failed', notable: false });

  assert.deepEqual(
    recentEvents().map((e) => e.message),
    ['sync failed', 'skipping 1 locked row', 'updated 5 rows'],
    'the per-pass chatter is left out',
  );
  assert.equal(recentEvents({ notableOnly: false }).length, 4, 'but it is still there when asked for');
  assert.deepEqual(eventCounts(), { total: 4, notable: 3 });
});

test('limit trims from the newest end', () => {
  clearEvents();
  for (let i = 1; i <= 5; i++) record({ at: at(i), level: 'info', message: `e${i}`, notable: true });

  assert.deepEqual(recentEvents({ limit: 2 }).map((e) => e.message), ['e5', 'e4']);
});

// The buffer runs for the life of the process, so it has to be bounded.
test('the ring drops the oldest rather than growing forever', () => {
  clearEvents();
  for (let i = 0; i < 400; i++) record({ at: at(0), level: 'info', message: `e${i}`, notable: true });

  const { total } = eventCounts();
  assert.equal(total, 300, 'capped');
  assert.equal(recentEvents({ limit: 1 })[0].message, 'e399', 'newest kept');
  assert.ok(!recentEvents({ limit: 300 }).some((e) => e.message === 'e99'), 'oldest dropped');
});
