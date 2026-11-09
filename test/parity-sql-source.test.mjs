// @test-kind tooling: Typed universe extraction fails closed on unsafe source changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../scripts/parity-sql-source.mjs';
const loop =
  "for (const [name, args, expected, ctx] of cases) {\n  test(`${name}(${args.map((a) => (a instanceof Date ? a.toISOString() : typeof a === 'bigint' ? `${a}n` : JSON.stringify(a))).join(', ')})${ctx ? ` ${JSON.stringify(ctx)}` : ''}`, () => {\n    assert.deepStrictEqual(call(name, args, ctx), expected);\n  });\n}";
const source =
  `import test from 'node:test';
const utc = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
const dec = (decimal) => ({ decimal });
const cases = [['LEN', [null], null], ['ROUND', [dec('1.5'), null], null], ['DATEADD', ['day', null, utc(2026, 1, 1)], null]];
` + loop;
test('extracts ordered typed source and registration titles without executing callbacks', () => {
  const x = extract(source);
  assert.equal(x.rows.length, 3);
  assert.equal(x.titles.length, 3);
  assert.deepEqual(x.rows[1].value[1].value[0], {
    type: 'object',
    value: { decimal: { type: 'string', value: '1.5' } },
  });
});
test('rejects matrix, constructor, registration and effect tampering', () => {
  for (const [text, reason] of [
    [source + '\ncases.push([]);', /shared-or-mutated-case-array|unsafe-registration-call/],
    [source + '\nutc=()=>1;', /mutated-helper/],
    [
      source.replace('const dec = (decimal) => ({ decimal });', "const dec = (decimal) => ({ decimal: '0' });"),
      /unsafe-helper/,
    ],
    [source.replace('args.map((a) =>', 'args.filter((a) =>'), /unsupported-registration-shape/],
    [source + '\nglobalThis.flag = true;', /unsafe-registration-effect/],
  ])
    assert.throws(() => extract(text), reason);
});
