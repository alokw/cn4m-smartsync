import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncMessage, backoffMs } from '../src/status.js';

const result = (over = {}) => ({
  ok: true, target: 'a report', mode: 'reconcile',
  newRows: 200, updated: 5, unchanged: 20, unmatched: 0, ambiguous: 0, locked: 0, ...over,
});

test('a pass that changed something reports it in one line', () => {
  assert.equal(syncMessage(result()), 'Synced 5 items to smartsheet');
  assert.equal(syncMessage(result({ updated: 1 })), 'Synced 1 item to smartsheet', 'singular');
});

// The endpoint should see traffic when there is news, not once a tick forever.
test('a quiet pass says nothing at all', () => {
  assert.equal(syncMessage(result({ updated: 0 })), null, 'nothing written');
  assert.equal(syncMessage(result({ ok: false, reason: 'boom' })), null, 'failures have their own message');
  assert.equal(syncMessage(result({ dryRun: true })), null, 'a dry run did not really do anything');
  assert.equal(syncMessage(result({ firstRun: true, updated: 0 })), null);
  assert.equal(syncMessage(undefined), null);
});

test('rows that could not be written are mentioned, briefly', () => {
  assert.equal(syncMessage(result({ unmatched: 3 })), 'Synced 5 items to smartsheet (3 unmatched)');
  assert.equal(syncMessage(result({ locked: 1 })), 'Synced 5 items to smartsheet (1 locked)');
  assert.equal(
    syncMessage(result({ unmatched: 3, locked: 1 })),
    'Synced 5 items to smartsheet (3 unmatched, 1 locked)',
  );
});

test('backoff climbs to a half-hour ceiling and stays there', () => {
  assert.equal(backoffMs(1), 60_000, 'one minute after the first failure');
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(3), 240_000);
  assert.equal(backoffMs(6), 1_800_000, 'half an hour');
  assert.equal(backoffMs(99), 1_800_000, 'and no further');
});
