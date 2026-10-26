// jsonChunks (state-stream.mjs) streams state for checkpoints, journals and digests. Persisted digests and journal
// fragments depend on its exact text and chunk boundaries, so they stay JSON.stringify-compatible at any depth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonChunks } from '../lib/state-stream.mjs';

const CHUNK = 65536;

test('streamed state text equals JSON.stringify and splits after the token that reaches 64 KiB', () => {
  const row = (n) => ({
    id: `row-${n}`,
    name: 'Invented "quoted" \\ name \nሴ😀',
    amount: n / 3,
    flags: [true, false, null, undefined, () => n, Symbol('skipped'), new Number(n), new String('boxed')],
    skipped: undefined,
    method() {},
    created: new Date(n),
    custom: { toJSON: () => ({ restored: [n, undefined] }) },
    toJSON: n % 2 ? 'an ordinary column named toJSON' : undefined,
  });
  const state = { tables: { item: Array.from({ length: 3000 }, (_, n) => row(n)) }, long: 'x'.repeat(3 * CHUNK) };
  state.tables.item[5] = [, 1, , 2]; // eslint-disable-line no-sparse-arrays -- holes serialize as null
  const chunks = [...jsonChunks(state)];
  assert.equal(chunks.join(''), JSON.stringify(state));
  assert.ok(chunks.length > 3);
  // Every chunk but the last stops at the first token that reaches the limit; the long string is a single token.
  assert.equal(chunks.filter((chunk) => chunk.length > 3 * CHUNK).length, 1);
  for (const chunk of chunks.slice(0, -1))
    assert.ok(chunk.length >= CHUNK && (chunk.length < CHUNK + 200 || chunk.endsWith('x'.repeat(3 * CHUNK) + '"')));
  for (const scalar of [null, 1, 'text', false, new Date(0)])
    assert.deepEqual([...jsonChunks(scalar)], [JSON.stringify(scalar)]);
});

test('streamed state handles nesting deeper than the call stack and still rejects cycles', () => {
  let deep = 'leaf';
  for (let depth = 0; depth < 50_000; depth++) deep = depth % 2 ? [deep] : { child: deep };
  assert.equal([...jsonChunks(deep)].join(''), '[{"child":'.repeat(25_000) + '"leaf"' + '}]'.repeat(25_000));
  const shared = { reused: true };
  assert.equal([...jsonChunks([shared, { again: shared }])].join(''), '[{"reused":true},{"again":{"reused":true}}]');
  const cycle = { rows: [] };
  cycle.rows.push({ parent: cycle });
  assert.throws(() => [...jsonChunks(cycle)], { name: 'TypeError', message: 'Cannot persist circular state' });
});
