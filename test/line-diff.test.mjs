import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../lense/line-diff.mjs';

function apply(a, b, hunks) {
  const out = [];
  let at = 0;
  let previousB = 0;
  for (const hunk of hunks) {
    assert.ok(hunk.aStart >= at && hunk.aEnd >= hunk.aStart && hunk.aEnd <= a.length);
    assert.ok(hunk.bStart >= previousB && hunk.bEnd >= hunk.bStart && hunk.bEnd <= b.length);
    assert.deepEqual(a.slice(at, hunk.aStart), b.slice(previousB, hunk.bStart));
    out.push(...a.slice(at, hunk.aStart), ...b.slice(hunk.bStart, hunk.bEnd));
    at = hunk.aEnd;
    previousB = hunk.bEnd;
  }
  return out.concat(a.slice(at));
}

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next[j + 1] = a[i] === b[j] ? row[j] : Math.min(row[j + 1], next[j]) + 1;
    row = next;
  }
  return row[b.length];
}

test('line diffs reconstruct and minimally edit deterministic duplicate-heavy inputs', () => {
  let seed = 47121;
  const random = (max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let i = 0; i < 1500; i++) {
    const a = Array.from({ length: random(25) }, () => `line ${random(6)}`);
    const b = Array.from({ length: random(25) }, () => `line ${random(6)}`);
    const hunks = diffLines(a, b);
    assert.deepEqual(apply(a, b, hunks), b);
    assert.equal(hunks.reduce((sum, h) => sum + h.aEnd - h.aStart + h.bEnd - h.bStart, 0), editDistance(a, b));
  }
});

test('distant edits in a large template remain separate hunks', () => {
  const before = Array.from({ length: 100_000 }, (_, i) => `line ${i}`);
  const after = [...before];
  after[1] = 'first edit';
  after[99_998] = 'last edit';
  const hunks = diffLines(before, after);
  assert.deepEqual(hunks, [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }, { aStart: 99_998, aEnd: 99_999, bStart: 99_998, bEnd: 99_999 }]);
  assert.deepEqual(apply(before, after, hunks), after);
});

test('unrelated dense rewrites use a bounded coarse hunk while preserving shared edges', () => {
  const before = ['prefix', ...Array.from({ length: 20_000 }, (_, i) => `before ${i}`), 'suffix'];
  const after = ['prefix', ...Array.from({ length: 20_000 }, (_, i) => `after ${i}`), 'suffix'];
  const hunks = diffLines(before, after);
  assert.deepEqual(hunks, [{ aStart: 1, aEnd: 20_001, bStart: 1, bEnd: 20_001 }]);
  assert.deepEqual(apply(before, after, hunks), after);
});
