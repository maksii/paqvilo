import test from 'node:test';
import assert from 'node:assert/strict';
import { PersistentKeyTree } from '../lib/record-key-index.mjs';

function memory() {
  const nodes = new Map();
  let count = 0,
    fail = false;
  return {
    nodes,
    get count() {
      return count;
    },
    set fail(value) {
      fail = value;
    },
    write(node) {
      if (fail) throw Error('Invented node write failure');
      const id = ++count;
      nodes.set(id, structuredClone(node));
      return id;
    },
    read(id) {
      const result = nodes.get(id);
      if (!result) throw Error('Missing node');
      return result;
    },
  };
}
const expected = (pairs) => pairs.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));

test('path copies preserve snapshots through splits, duplicate keys, merges and root collapse', () => {
  const store = memory(),
    tree = new PersistentKeyTree(store, { capacity: 4 }),
    pairs = [];
  for (let i = 1; i <= 200; i++) {
    const key = 'key-' + (i % 17);
    pairs.push([key, i]);
    tree.insert(key, i);
  }
  assert.deepEqual([...tree.entries()], expected(pairs));
  const snapshot = tree.fork(),
    root = snapshot.root;
  for (let i = 1; i <= 200; i += 2) assert.equal(tree.delete('key-' + (i % 17), i), true);
  assert.deepEqual([...snapshot.entries()], expected(pairs));
  assert.equal(snapshot.root, root);
  assert.deepEqual(
    tree.lookup('key-2'),
    pairs.filter(([key, token]) => key === 'key-2' && token % 2 === 0).map(([, token]) => token),
  );
  for (let i = 2; i <= 200; i += 2) assert.equal(tree.delete('key-' + (i % 17), i), true);
  assert.equal(tree.root, null);
  assert.deepEqual([...tree.entries()], []);
  assert.equal(tree.delete('missing', 1), false);
});

test('bulk trees and incremental mutations agree for normalized strings and repeated composite entries', () => {
  const store = memory(),
    pairs = Array.from({ length: 999 }, (_, i) => ['k' + String(i % 53).padStart(2, '0'), i + 1]);
  const tree = PersistentKeyTree.fromSorted(store, expected(pairs), { capacity: 8 });
  assert.deepEqual([...tree.entries()], expected(pairs));
  const count = store.count;
  tree.insert(pairs[0][0], pairs[0][1]);
  assert.equal(store.count, count, 'An existing composite key performs no writes.');
  for (let i = 0; i < 200; i++) tree.delete(pairs[i][0], pairs[i][1]);
  const remaining = pairs.slice(200);
  assert.deepEqual([...tree.entries()], expected(remaining));
  for (const key of ['k00', 'k03', 'k52', 'absent'])
    assert.deepEqual(
      tree.lookup(key),
      remaining.filter(([k]) => k === key).map(([, token]) => token),
    );
});

test('a failed append leaves the published root and its readable entries unchanged', () => {
  const store = memory(),
    tree = new PersistentKeyTree(store, { capacity: 4 });
  for (let i = 1; i <= 20; i++) tree.insert('key' + i, i);
  const before = [...tree.entries()],
    root = tree.root;
  store.fail = true;
  assert.throws(() => tree.insert('new', 21), /Invented/);
  assert.equal(tree.root, root);
  assert.deepEqual([...tree.entries()], before);
  assert.throws(() => tree.delete('key1', 1), /Invented/);
  assert.equal(tree.root, root);
  assert.deepEqual([...tree.entries()], before);
});

test('bulk tails and repeated deletions retain balanced occupancy at every level', () => {
  const store = memory(),
    pairs = Array.from({ length: 1025 }, (_, i) => ['key' + String(i).padStart(4, '0'), i + 1]);
  const tree = PersistentKeyTree.fromSorted(store, pairs, { capacity: 8 });
  const check = (ref, root = true) => {
    if (!ref) return;
    const node = tree.node(ref),
      values = node.leaf ? node.pairs : node.children;
    assert.ok(values.length <= 8);
    if (!root) assert.ok(values.length >= 4, 'Non-root nodes retain at least half occupancy.');
    if (!node.leaf) for (const child of values) check(child, false);
  };
  check(tree.root);
  for (let i = 0; i < 1000; i++) {
    tree.delete(pairs[i][0], pairs[i][1]);
    if (i % 31 === 0) check(tree.root);
  }
  check(tree.root);
  assert.deepEqual([...tree.entries()], pairs.slice(1000));
});
