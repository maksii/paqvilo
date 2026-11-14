import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeySorter, compareKeyPair } from '../lib/record-key-sort.mjs';

test('bounded key runs merge Unicode, escaped keys, duplicates and multiple levels without temporary residue', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-key-sort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pairs = Array.from({ length: 1003 }, (_, i) => ['Δ\n日本語-' + ((i * 127) % 91), i + 1]);
  pairs.push(pairs[0]);
  const sorter = new KeySorter(root, { entries: 7, bytes: 1024, fanIn: 3 });
  for (const pair of pairs) sorter.add(pair);
  assert.deepEqual([...sorter.sorted()], [...pairs].sort(compareKeyPair));
  assert.ok(sorter.peakEntries <= 7);
  assert.ok(sorter.peakBytes <= 1024);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('abandoned and failed key-run consumption closes handles and deletes all temporary runs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-key-sort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = () => {
    const sorter = new KeySorter(root, { entries: 2, fanIn: 2 });
    for (let i = 12; i > 0; i--) sorter.add(['key-' + i, i]);
    return sorter;
  };
  const sorter = make(),
    iterator = sorter.sorted();
  iterator.next();
  iterator.return();
  assert.deepEqual(fs.readdirSync(root), []);
  const failed = make();
  fs.writeFileSync(failed.runs[0], 'invalid\n');
  assert.throws(() => [...failed.sorted()], SyntaxError);
  assert.deepEqual(fs.readdirSync(root), []);
});
