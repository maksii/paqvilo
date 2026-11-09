// @test-kind tooling: source-derived loop evidence and typed runtime guards reject altered invented fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  analyzeAssertionLoop,
  assertAssertionLoopValue,
  assertAssertionLoopCompletion,
  assertAssertionTailXml,
} from '../scripts/parity-assertion-loop.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = (v) =>
  Array.isArray(v)
    ? v.map(normalize)
    : !v || typeof v !== 'object'
      ? v
      : Object.fromEntries(
          Object.entries(v)
            .filter(([k]) => !['loc', 'range', 'start', 'end', 'raw'].includes(k))
            .map(([k, x]) => [k, normalize(x)]),
        );
const astHash = (value) => hash(normalize(value));
const parseSource = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
function fixture() {
  const input = Array.from({ length: 27 }, (_, i) => `{type:'string',value:'v${i}'}`);
  input[5] = "{type:'double',value:Infinity}";
  input[11] = "{type:'map',value:new Map([['key',text('invented')]])}";
  const source = `import test from 'node:test'; import assert from 'node:assert/strict'; const text=(value)=>({type:'string',value}); const renamed=(xml)=>xml.replace(/xmlns:([a-z0-9]+)=/g,'xmlns:p$1=').replace(/(?<=[<\\s"/])(?!xmlns:|xml:|https?:)([a-z0-9]+)(?=:)/g,'p$1'); const decodeFrom=(xml)=>decodeValue(parseEnvelope(xml).request); const VALUES=[${input.join(',')}]; test('sample',()=>{for(const value of VALUES){const xml=envelope(encodeValue('v',value));assert.deepStrictEqual(decodeFrom(xml),value,\`direct \${value.type}\`);assert.deepStrictEqual(decodeFrom(renamed(xml)),value,\`renamed \${value.type}\`);}assert.equal(decodeFrom(envelope(encodeValue('v',null))),null);assert.deepStrictEqual(decodeFrom(envelope(encodeValue('v','plain'))),text('plain'));});`;
  const ast = parseSource(source),
    call = ast.body.at(-1).expression,
    callback = call.arguments[1],
    body = callback.body.body,
    assertions = body[0].body.body.slice(1).map((x) => astHash(x.expression)),
    tails = body.slice(1).map((x) => astHash(x.expression));
  const values = Array.from({ length: 27 }, (_, i) => ({ type: 'string', value: `v${i}` }));
  values[5] = { type: 'double', value: Infinity };
  values[11] = { type: 'map', value: new Map([['key', { type: 'string', value: 'invented' }]]) };
  const expected = values.map((v, i) =>
    i === 5
      ? { type: 'double', value: { $number: 'Infinity' } }
      : i === 11
        ? { type: 'map', value: { $map: [['key', { type: 'string', value: 'invented' }]] } }
        : v,
  );
  const cases = expected.map((v, id) => ({ id, expected: v, xmlDirect: '<v/>', xmlRenamed: '<v/>' }));
  cases.push(
    { id: 'null', expected: null, xmlDirect: '<null/>' },
    { id: 'plain', expected: { type: 'string', value: 'plain' }, xmlDirect: '<plain/>' },
  );
  const results = cases.map((c) => ({
      id: c.id,
      direct: { phase: 'value', canonical: c.expected },
      renamed: { phase: 'value', canonical: c.expected },
    })),
    capsule = {
      cases,
      runs: [
        { processId: 1, rawSha256: '1'.repeat(64), results: structuredClone(results) },
        { processId: 2, rawSha256: '2'.repeat(64), results: structuredClone(results) },
      ],
    };
  const selectedValueIndices = Array.from({ length: 21 }, (_, i) => i),
    heldValueIndices = [21, 22, 23, 24, 25, 26],
    instanceBindings = [],
    facts = [];
  function add(index, variant, assertionAstSha256, originalValueIndex = index) {
    const id = `fact-${facts.length}`,
      p = `/runs/0/results/${index}/${variant}`;
    facts.push({
      id,
      pointer: p,
      sha256: hash(capsule.runs[0].results[index][variant]),
      replicatedPointers: [p, `/runs/1/results/${index}/${variant}`],
    });
    instanceBindings.push({ originalValueIndex, caseIndex: index, variant, assertionAstSha256, factIds: [id] });
  }
  for (const i of selectedValueIndices) {
    add(i, 'direct', assertions[0]);
    add(i, 'renamed', assertions[1]);
  }
  add(27, 'direct', tails[0], null);
  add(28, 'direct', tails[1], null);
  capsule.heldIds = heldValueIndices.slice();
  capsule.selectedAssertions = instanceBindings.map(({ factIds, ...rest }) => rest);
  const selection = {
      sourceBinding: 'VALUES',
      originalLoopRows: 27,
      selectedValueIndices,
      heldValueIndices,
      instanceBindings,
      preserveUnselectedExecution: true,
      preserveAssertionSites: true,
    },
    proof = { facts, capturePointers: ['/runs/0/rawSha256', '/runs/1/rawSha256'] };
  return { source, ast, selected: { old: { callback }, current: { callback } }, values, capsule, selection, proof };
}
function analyze(f) {
  return analyzeAssertionLoop({
    baselineAst: f.ast,
    currentAst: f.ast,
    selected: f.selected,
    selection: f.selection,
    proof: f.proof,
    capsule: f.capsule,
  });
}
test('binds the entire authored universe, original assertions and two capture facts', () => {
  const f = fixture(),
    r = analyze(f);
  assert.equal(r.descriptor.universe.length, 27);
  assert.equal(r.descriptor.instances.length, 44);
  assert.equal(r.descriptor.heldIndices.length, 6);
  for (let i = 0; i < 27; i++)
    assert.doesNotThrow(() => assertAssertionLoopValue(f.values, i, f.values[i], '<v/>', r.descriptor));
  assert.doesNotThrow(() => assertAssertionLoopCompletion(27, r.descriptor));
  assert.equal(assertAssertionTailXml('<null/>', 0, r.descriptor), '<null/>');
  assert.throws(() => assertAssertionTailXml('<other/>', 0, r.descriptor), /unsupported-assertion-loop/);
});
test('rejects altered map entries, infinity, descriptors, index and incomplete iteration', () => {
  const f = fixture(),
    d = analyze(f).descriptor;
  for (const mutate of [
    (v) => v[11].value.clear(),
    (v) => {
      v[5].value = null;
    },
    (v) => {
      v[0].value = undefined;
    },
    (v) => Object.defineProperty(v[0], 'value', { get: () => 'v0' }),
    (v) => Object.setPrototypeOf(v[0], null),
  ]) {
    const values = structuredClone(f.values);
    mutate(values);
    assert.throws(() => assertAssertionLoopValue(values, 0, values[0], '<v/>', d), /unsupported-assertion-loop/);
  }
  assert.throws(() => assertAssertionLoopValue(f.values, 1, f.values[0], '<v/>', d), /unsupported-assertion-loop/);
  assert.throws(() => assertAssertionLoopValue(f.values, 0, f.values[0], '<other/>', d), /unsupported-assertion-loop/);
  assert.throws(() => assertAssertionLoopCompletion(26, d), /unsupported-assertion-loop/);
});
test('rejects changed masks, duplicated or missing evidence and capture disagreement', () => {
  for (const change of [
    (f) => f.selection.selectedValueIndices.pop(),
    (f) => {
      f.selection.instanceBindings[1].factIds = f.selection.instanceBindings[0].factIds;
    },
    (f) => {
      f.proof.facts[0].sha256 = '0'.repeat(64);
    },
    (f) => {
      f.capsule.runs[1].results[0].direct.canonical.value = 'other';
    },
    (f) => f.capsule.cases.pop(),
    (f) => {
      f.capsule.runs[1].processId = 1;
    },
    (f) => {
      f.capsule.cases[0].xmlRenamed = '<altered/>';
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => analyze(f), /unsupported-assertion-loop/);
  }
});
test('rejects source producer and assertion changes even when current matches baseline', () => {
  for (const replacement of [
    ["text('invented')", "text('other')"],
    ['value:Infinity', 'value:null'],
    ['decodeFrom(xml),value', 'decodeFrom(renamed(xml)),value'],
    ['const xml=envelope', 'const xml=process.env.UNRELATED||envelope'],
  ]) {
    const f = fixture();
    assert.ok(f.source.includes(replacement[0]));
    f.source = f.source.replace(...replacement);
    f.ast = parseSource(f.source);
    f.selected = {
      old: { callback: f.ast.body.at(-1).expression.arguments[1] },
      current: { callback: f.ast.body.at(-1).expression.arguments[1] },
    };
    assert.throws(() => analyze(f), /unsupported-assertion-loop/);
  }
});
