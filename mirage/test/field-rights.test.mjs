import test from 'node:test';
import assert from 'node:assert/strict';
import { immutableColumnRights, immutableFieldRights } from '../lib/field-rights.mjs';

test('private rights reuse preserves every boolean combination and nonboolean extension values', () => {
  for (let mask = 0; mask < 16; mask++) {
    const secured = Boolean(mask & 8),
      read = Boolean(mask & 1),
      create = Boolean(mask & 2),
      update = Boolean(mask & 4);
    const expected = { secured, read, create, update };
    const actual = immutableFieldRights(secured, read, create, update);
    assert.deepEqual(actual, expected);
    assert.equal(immutableFieldRights(secured, read, create, update), actual);
    assert.ok(Object.isFrozen(actual));
    assert.deepEqual(immutableColumnRights(read, create, update), { read, create, update });
  }
  assert.deepEqual(immutableFieldRights(true, undefined, false, undefined), {
    secured: true,
    read: undefined,
    create: false,
    update: undefined,
  });
  assert.deepEqual(immutableColumnRights(undefined, false, true), { read: undefined, create: false, update: true });
});
