// jsonChunks (state-stream.mjs) streams state for checkpoints, journals and digests. Persisted digests and journal
// fragments depend on its exact text and chunk boundaries, so they stay JSON.stringify-compatible at any depth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonChunks } from '../lib/state-stream.mjs';

const CHUNK = 65536;

test('streamed hooks receive native keys once, omit unsupported results and snapshot array length', () => {
  const make = () => {
    const callable = () => {};
    callable.toJSON = (key) => 'callable:' + key;
    const array = [
      {
        toJSON(key) {
          array.push('not visited');
          return key;
        },
      },
      'second',
    ];
    return {
      rootKey: { toJSON: (key) => key },
      missing: { toJSON: () => undefined },
      list: [{ toJSON: (key) => key }, { toJSON: () => undefined }],
      callable,
      array,
    };
  };
  assert.equal([...jsonChunks(make())].join(''), JSON.stringify(make()));
  for (const value of [undefined, () => {}, Symbol('omitted'), { toJSON: () => undefined }])
    assert.equal([...jsonChunks(value)].join(''), '');
  let reads = 0;
  const child = Object.defineProperty({}, 'toJSON', {
    get() {
      reads++;
      return (key) => key;
    },
  });
  assert.equal([...jsonChunks({ child })].join(''), '{"child":"child"}');
  assert.equal(reads, 1);
  assert.equal([...jsonChunks({ child }, { sortKeys: true })].join(''), '{"child":"child"}');
  assert.equal(reads, 2);
});

test('streamed boxed primitives retain native coercion and BigInt errors', () => {
  const number = new Number(1),
    string = new String('first'),
    boolean = new Boolean(true);
  number.valueOf = () => 7;
  string.toString = () => 'second';
  boolean.valueOf = () => false;
  const value = { number, string, boolean };
  assert.equal([...jsonChunks(value)].join(''), JSON.stringify(value));
  for (const item of [Object(1n), Object.assign(new Number(1), { [Symbol.toPrimitive]: () => 1n })]) {
    assert.throws(() => JSON.stringify(item), TypeError);
    assert.throws(() => [...jsonChunks(item)], TypeError);
  }
});

test('canonical digest encoding sorts scalar records and nested sections without changing ordinary JSON bytes', () => {
  const state = { z: [{ 2: 'two', 10: 'ten', z: false, a: 'Δ', skipped: undefined }], a: { z: null, a: 1 } };
  const canonical = '{"a":{"a":1,"z":null},"z":[{"10":"ten","2":"two","a":"Δ","z":false}]}';
  assert.equal([...jsonChunks(state, { sortKeys: true })].join(''), canonical);
  assert.equal([...jsonChunks(state)].join(''), JSON.stringify(state));
});

test('raw exact JSON scalars retain their numeric bytes in ordinary and canonical state encoding', () => {
  const raw = JSON.rawJSON('12345678901234567890.1234');
  const value = { z: raw, a: [raw] };
  assert.equal([...jsonChunks(value)].join(''), JSON.stringify(value));
  assert.equal(
    [...jsonChunks(value, { sortKeys: true })].join(''),
    '{"a":[12345678901234567890.1234],"z":12345678901234567890.1234}',
  );
});

test('bounded record leaves retain scalar encoding, getters, aliases and chunk limits', () => {
  let reads = 0;
  const guarded = {
    get value() {
      reads++;
      return 'read once';
    },
  };
  const shared = { __proto__: null, text: '"\\\nΔ 日本語', quantity: -0, missing: undefined, nan: NaN };
  Object.defineProperty(shared, '__proto__', { enumerable: true, value: 'ordinary column' });
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: String(i), ...shared }));
  const value = { rows, guarded, shared, again: shared, huge: { text: 'x'.repeat(3 * CHUNK) } };
  const expected = JSON.stringify(value);
  reads = 0;
  const chunks = [...jsonChunks(value)];
  assert.equal(chunks.join(''), expected);
  assert.equal(reads, 1);
  for (const chunk of chunks.slice(0, -1))
    assert.ok(chunk.length >= CHUNK && (chunk.length < CHUNK + 200 || chunk.endsWith('x'.repeat(3 * CHUNK) + '"')));
  assert.throws(() => [...jsonChunks({ value: 1n })], TypeError);
});

test('canonical scalar shape reuse retains omissions, property identity, rotations and independent encoders', () => {
  const rows = Array.from({ length: 6000 }, (_, index) => {
    const row = Object.create(index % 2 ? null : Object.prototype);
    for (const [name, value] of [
      ['z', index],
      ['a', 'Δ " \\'],
      ['shape' + (index % 23), index % 3 ? null : false],
      ['omitted', undefined],
    ])
      Object.defineProperty(row, name, { value, enumerable: true });
    Object.defineProperty(row, '__proto__', { value: 'an ordinary scalar', enumerable: true });
    return row;
  });
  const canonical = (value) =>
    Array.isArray(value)
      ? '[' + value.map(canonical).join(',') + ']'
      : value && typeof value === 'object'
        ? '{' +
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
            .join(',') +
          '}'
        : JSON.stringify(value);
  const other = rows.map((row) => ({ a: 'Another encoder', z: row.z }));
  const left = jsonChunks(rows, { sortKeys: true }),
    right = jsonChunks(other, { sortKeys: true });
  const output = ['', ''];
  while (true) {
    const a = left.next(),
      b = right.next();
    if (!a.done) output[0] += a.value;
    if (!b.done) output[1] += b.value;
    if (a.done && b.done) break;
  }
  assert.equal(output[0], canonical(rows));
  assert.equal(output[1], canonical(other));
  let reads = 0;
  const guarded = {
    get a() {
      reads++;
      return 'one read';
    },
    z: 1,
  };
  assert.equal([...jsonChunks([guarded], { sortKeys: true })].join(''), '[{"a":"one read","z":1}]');
  assert.equal(reads, 1);
});

test('canonical scalar scratch storage does not invoke inherited numeric array setters', () => {
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let writes = 0,
    actual = '';
  try {
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set() {
        writes++;
      },
    });
    for (const text of jsonChunks({ z: 'last', a: 'first' }, { sortKeys: true })) actual += text;
  } finally {
    if (previous) Object.defineProperty(Array.prototype, '0', previous);
    else delete Array.prototype[0];
  }
  assert.equal(actual, '{"a":"first","z":"last"}');
  assert.equal(writes, 0);
});

test('wide ordinary text encodes as one bounded leaf and escape-heavy leaves fall back without byte changes', () => {
  const row = Object.fromEntries(
    Array.from({ length: 257 }, (_, i) => [
      'field' + String(i).padStart(3, '0'),
      '11111111-1111-4111-8111-111111111111',
    ]),
  );
  const stringify = JSON.stringify,
    expected = stringify([row]);
  let leaves = 0;
  try {
    JSON.stringify = (value, ...args) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 257) leaves++;
      return stringify(value, ...args);
    };
    for (const sortKeys of [false, true]) assert.equal([...jsonChunks([row], { sortKeys })].join(''), expected);
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(leaves, 2, 'Both encoders use one native leaf instead of a token per field.');
  const escaped = { a: '\u0000'.repeat(5000), z: 'after escaped value' };
  for (const sortKeys of [false, true])
    assert.equal([...jsonChunks(escaped, { sortKeys })].join(''), stringify(escaped));
});

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
