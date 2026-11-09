// @test-kind tooling: Literal query-matrix evaluation is tested only with invented inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { queryUniverse } from '../scripts/parity-query-universe.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const prefix = Array.from({ length: 60 }, (_, index) => `['q', '${index}', 400, 'm'],`).join('\n');
const expression = (suffix) =>
  parse(`const cases = [${prefix}${suffix}];`, { ecmaVersion: 'latest', sourceType: 'module', loc: true }).body[0]
    .declarations[0].init;

test('expands only literal maps and binds each result to its source entry', () => {
  const rows = queryUniverse(expression("...['a','b','c'].map((value) => ['q', value, 400, `m ${value}`])"));
  assert.equal(rows.length, 63);
  assert.deepEqual(rows[61].binding, ['q', 'b', 400, 'm b']);
  assert.equal(rows[61].source.value, 'b');
  assert.throws(
    () => queryUniverse(expression("...external.map((value) => ['q', value, 400, 'm'])")),
    /unsupported-query-universe/,
  );
  assert.throws(
    () => queryUniverse(expression("...['a','b','c'].map((value) => ['q', value, 400, sideEffect()])")),
    /unsupported-query-universe/,
  );
});
