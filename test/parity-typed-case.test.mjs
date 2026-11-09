// @test-kind tooling: Typed case guards preserve input identity and reject dynamic values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTyped, encodeCase, typedCaseIndex } from '../scripts/parity-typed-case.mjs';
test('preserves distinctions JSON serialization loses', () => {
  assert.deepEqual(
    encodeCase([new Date('2026-01-02Z'), 1n, undefined, { decimal: '1.20' }], ['date', 'bigint', 'ctx', 'decimal']),
    {
      date: { type: 'date', value: '2026-01-02T00:00:00.000Z' },
      bigint: { type: 'bigint', value: '1' },
      ctx: { type: 'undefined' },
      decimal: { type: 'object', value: { decimal: { type: 'string', value: '1.20' } } },
    },
  );
  assert.notDeepEqual(encodeTyped(-0), encodeTyped(0));
  assert.notDeepEqual(encodeTyped(new Date(0)), encodeTyped('1970-01-01T00:00:00.000Z'));
});
test('rejects getters, sparse arrays, symbols, cycles and foreign prototypes', () => {
  for (const value of [
    Object.defineProperty({}, 'x', {
      get() {
        throw Error('must not execute');
      },
      enumerable: true,
    }),
    Array(1),
    { [Symbol('x')]: 1 },
    Object.create(null),
    NaN,
    Infinity,
  ])
    assert.throws(() => encodeTyped(value));
  const arr = [1];
  Object.defineProperty(arr, '0', {
    get() {
      throw Error('must not execute');
    },
    enumerable: true,
  });
  assert.throws(() => encodeTyped(arr), /unsafe-array/);
  const alteredDate = new Date(0);
  Object.defineProperty(alteredDate, Symbol('extra'), { value: 1 });
  assert.throws(() => encodeTyped(alteredDate), /unsafe-date/);
  const hiddenDate = new Date(0);
  Object.defineProperty(hiddenDate, 'extra', { value: 1 });
  assert.throws(() => encodeTyped(hiddenDate), /unsafe-date/);
  assert.throws(() => encodeTyped(Object.freeze([1, 2])), /unsafe-array/);
  assert.throws(() => encodeTyped(Object.freeze({ x: 1 })), /unsafe-object/);
  assert.throws(() => encodeTyped(Object.preventExtensions(new Date(0))), /unsafe-date/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => encodeTyped(cyclic));
});

test('case matching pins complete ordered typed universe and permits trailing undefined', () => {
  const cases = [
      ['x', [new Date(0)], 1],
      ['y', [1n], 2, { s: true }],
    ],
    names = ['name', 'args', 'expected', 'ctx'];
  const bindings = cases.map((x) => encodeCase(x, names));
  assert.equal(
    typedCaseIndex(cases, names, bindings, { name: 'x', args: [new Date(0)], expected: 1, ctx: undefined }),
    0,
  );
  assert.throws(
    () => typedCaseIndex([...cases].reverse(), names, bindings, { name: 'x', args: [new Date(0)], expected: 1 }),
    /changed-typed-case-universe/,
  );
  assert.throws(
    () =>
      typedCaseIndex(cases, names, bindings, {
        name: 'x',
        args: ['1970-01-01T00:00:00.000Z'],
        expected: 1,
        ctx: undefined,
      }),
    /unknown-typed-case/,
  );
});
