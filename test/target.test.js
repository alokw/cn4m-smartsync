import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocked, describeLocked } from '../src/target.js';

// Smartsheet fails an ENTIRE batch update with 403 CANT_EDIT_LOCKED_ROW if one
// row in it is locked, so getting this predicate wrong either stalls every write
// or silently stops syncing rows that were fine.
test('isLocked keys off lockedForUser, not locked', () => {
  assert.equal(isLocked({ lockedForUser: true, locked: true }), true, 'locked and not editable');
  assert.equal(isLocked({ locked: true }), false, 'an admin can still edit a locked row');
  assert.equal(isLocked({ lockedForUser: false, locked: true }), false);
  assert.equal(isLocked({}), false, 'an ordinary row');
});

test('describeLocked names the rows for the log line', () => {
  assert.equal(
    describeLocked([{ name: '1445_B1_Snapchat_Spotlight', rowId: 8543162000080772 }]),
    '1445_B1_Snapchat_Spotlight',
  );
});

test('describeLocked falls back to the row id when the name cell is empty', () => {
  assert.equal(describeLocked([{ name: '', rowId: 270221771669380 }]), 'row 270221771669380');
  assert.equal(describeLocked([{ name: '   ', rowId: 42 }]), 'row 42', 'whitespace is not a name');
  assert.equal(describeLocked([{ rowId: 42 }]), 'row 42', 'nor is a missing name column');
});

test('describeLocked caps the list so a mass lock stays readable', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ name: `row_${i}`, rowId: i }));
  const described = describeLocked(rows, 3);
  assert.equal(described, 'row_0, row_1, row_2, +22 more');
});
