// @test-kind tooling: invented source exercises bounded fixed-clock host-slice inference and rejection paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyzePowerFxHostSlice } from '../scripts/parity-powerfx-host-slice.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const source = `import test from 'node:test';
import assert from 'node:assert/strict';
import { powerFxEngine } from '../lib/power-fx.mjs';
const NOW = Date.UTC(2013, 6, 15, 20, 2);
const hostOf = (extra = {}) => ({ now: () => NOW, timeZone: 'America/Los_Angeles', variables: {}, context: {}, ...extra });
const run = (formula, host = hostOf(), values = {}) => powerFxEngine.evaluateSync(formula, { host, values }).value;
test('chosen', () => { const local = hostOf({ timeZone: 'Europe/Amsterdam' }); assert.equal(run('1+1', local), 2); assert.equal(run('2+2', local), 4); });`;
function probe(input, sources = ['../lib/power-fx.mjs']) {
  const ast = parse(input, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const row = ast.body.find((x) => x.type === 'ExpressionStatement' && x.expression.arguments?.[0]?.value === 'chosen')
    .expression.arguments[1];
  return analyzePowerFxHostSlice({
    ast,
    selected: [{ old: { id: 'invented:1:0', callback: row } }],
    root: 'invented',
    filePath: 'invented.test.mjs',
    implementationSources: sources,
  });
}
test('accepts exactly the immutable helpers and literal selected source', () => {
  const result = probe(source);
  assert.equal(result.fixtures.length, 1);
  assert.equal(result.requiresAllRegistrations, true);
  assert.equal(result.recognizedBuiltinImports.size, 0);
  assert.equal(result.isolatedIdentifiers.size, 0);
});
test('rejects host changes, escaped bindings, indirect calls, nonliteral inputs and unsupported IUT', () => {
  for (const changed of [
    source.replace('2013, 6, 15', '2014, 6, 15'),
    source + `\nconst leaked = hostOf;`,
    source + `\nconst leaked = run;`,
    source + `\ntest('other',()=>powerFxEngine.evaluateSync.call(null,'1'));`,
    source.replace("run('1+1', local)", 'run(String(1), local)'),
    source.replace("{ timeZone: 'Europe/Amsterdam' }", '{ timeZone: process.env.TZ }'),
  ])
    assert.equal(probe(changed).fixtures.length, 0);
  assert.equal(probe(source, []).fixtures.length, 0);
});
test('rejects cross-callback global, prototype, computed alias, async and hook mutations', () => {
  for (const extra of [
    `Date.UTC = () => 0;`,
    `const a = 'constructor', b = 'prototype'; const local = []; local[a][b].push(1);`,
    `const { constructor: ctor } = {}; const { prototype: proto } = ctor; proto.x = 1;`,
    `test.before(() => {});`,
    `test('other', { concurrency: true }, () => {});`,
    `test.concurrent('other', () => {});`,
    `const otherTest = test; otherTest('other', () => {});`,
    `test('other', async () => {});`,
    `const captured = Date;`,
    `test('other',()=>{ let x = {}; x.changed = true; });`,
  ])
    assert.equal(probe(source + '\n' + extra).fixtures.length, 0, extra);
});
