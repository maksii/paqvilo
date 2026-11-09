// @test-kind tooling: Invented fresh-store inputs exercise source inference and runtime literal guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyzeRecordsFixtureSlice, assertRecordsFixtureLiterals } from '../scripts/parity-records-fixture-slice.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const read = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
const source = `import test from 'node:test'; import assert from 'node:assert/strict'; import { randomUUID } from 'node:crypto'; import { emptyState, Store, seed } from './sut.mjs';
const ORG='invented'; const SETTINGS={organizationId:ORG, users:[{name:'sample'}]}; const lookup={type:'reference'}; const text={type:'text'};
function fixtureState(){const state=emptyState(); state.mappings={label:text,owner:lookup}; return state;}
async function setup(){const store=new Store({state:fixtureState()}); await seed(store,SETTINGS); return {store};}
async function create(runtime){return runtime.store.add('invented');}
async function failure(value){return value;}
test('selected', async () => { const runtime=await setup(); const id=await create(runtime); const result=await failure(id); assert.equal(result,'ok'); });
test('other', async () => { const id=randomUUID(); assert.ok(id); });`;
function selected(ast) {
  const node = ast.body.find(
    (n) => n.type === 'ExpressionStatement' && n.expression?.arguments?.[0]?.value === 'selected',
  ).expression;
  return { node, callback: node.arguments[1] };
}
function run(current = source, baseline = source) {
  const baselineAst = read(baseline),
    currentAst = read(current);
  return analyzeRecordsFixtureSlice({
    baselineAst,
    currentAst,
    selected: [{ old: selected(baselineAst), current: selected(currentAst) }],
    implementationSources: ['./sut.mjs'],
  });
}
const values = (descriptor) =>
  Object.fromEntries(descriptor.inputs.map((item) => [item.name, JSON.parse(JSON.stringify(item.expected))]));
test('derives fresh fixture closure, authored literal values and only the unrelated UUID import', () => {
  const result = run();
  assert.deepEqual(
    result.descriptor.inputs.map((x) => x.name),
    ['lookup', 'ORG', 'SETTINGS', 'text'],
  );
  assert.deepEqual(
    result.descriptor.closure.map((x) => x.name),
    ['create', 'failure', 'fixtureState', 'setup'],
  );
  assert.equal(result.descriptor.uuidSites.length, 1);
  assert.equal(result.current.recognizedBuiltinImports.size, 1);
  assert.equal(result.descriptor.requiresFullModuleContext, true);
  assertRecordsFixtureLiterals(values(result.descriptor), result.descriptor);
});
test('rejects changed values, keys, accessors, prototypes and property descriptors', () => {
  const { descriptor } = run();
  for (const mutate of [
    (v) => {
      v.SETTINGS.organizationId = 'other';
    },
    (v) => {
      delete v.lookup.type;
    },
    (v) => {
      Object.defineProperty(v.text, 'type', { get: () => 'text', enumerable: true, configurable: true });
    },
    (v) => {
      Object.setPrototypeOf(v.SETTINGS, null);
    },
    (v) => {
      v.lookup[Symbol('extra')] = 1;
    },
    (v) => {
      Object.freeze(v.text);
    },
    (v) => {
      v.SETTINGS = { users: v.SETTINGS.users, organizationId: v.SETTINGS.organizationId };
    },
    (v) => {
      Object.defineProperty(v, 'SETTINGS', { get: () => ({}), enumerable: true, configurable: true });
    },
  ]) {
    const v = values(descriptor);
    mutate(v);
    assert.throws(() => assertRecordsFixtureLiterals(v, descriptor), /changed-records-fixture-input/u);
  }
});
test('rejects reachable, top-level, or changed random use and ambient input', () => {
  for (const edit of [
    (s) => s.replace('const runtime=await setup();', 'randomUUID(); const runtime=await setup();'),
    (s) => s.replace('const state=emptyState();', 'randomUUID(); const state=emptyState();'),
    (s) => s.replace("const ORG='invented';", "randomUUID(); const ORG='invented';"),
    (s) => s.replace('const id=randomUUID();', 'const id=randomUUID(1);'),
    (s) =>
      s
        .replace("test('other', async", 'test(randomUUID(), async')
        .replace('const id=randomUUID();', "const id='invented';"),
    (s) => s.replace('const state=emptyState();', 'const state=emptyState(); process.env.EXTERNAL;'),
  ]) {
    const altered = edit(source);
    assert.notEqual(altered, source);
    assert.throws(() => run(altered, altered), /unsupported-records-fixture-slice/u);
  }
});
test('rejects mutated closure, nonliteral shared inputs, and unreviewed registration options', () => {
  assert.throws(
    () => run(source.replace('return {store};', 'return {store, extra:true};')),
    /unsupported-records-fixture-slice/u,
  );
  for (const edit of [
    (s) => s.replace('const SETTINGS=', 'let SETTINGS='),
    (s) =>
      s
        .replace('const SETTINGS=', "const SHARED={value:'x'}; const SETTINGS=")
        .replace('organizationId:ORG', 'organizationId:ORG, alias:SHARED'),
    (s) => s.replace("users:[{name:'sample'}]", "users:[,{name:'sample'}]"),

    (s) => s.replace('return {store};', 'return {store, ...other};'),
    (s) => s.replace('state.mappings={label:text,owner:lookup};', "for (const [key] of ['xy']) state.tables[key]=[];"),
    (s) => s.replace('organizationId:ORG', 'organizationId:process.env.EXTERNAL'),
    (s) => s.replace("test('other', async", "test('other', { concurrency:true }, async"),
  ]) {
    const altered = edit(source);
    assert.throws(() => run(altered, altered), /unsupported-records-fixture-slice/u);
  }
});

test('accepts bounded awaited work and rejects authored background scheduling', () => {
  const awaited = source.replace('const id=randomUUID();', 'await Promise.resolve(); const id=randomUUID();');
  assert.equal(run(awaited, awaited).descriptor.scheduling.current.awaitedPromiseResolutions.length, 1);
  const subtest = source.replace(
    "test('other', async () => {",
    "test('other', async (t) => { await t.test('child', async () => {});",
  );
  assert.equal(run(subtest, subtest).descriptor.scheduling.current.awaitedSubtests.length, 1);
  for (const injected of [
    'setTimeout(() => {}, 0);',
    'queueMicrotask(() => {});',
    'setImmediate(() => {});',
    'Promise.resolve();',
    'Promise.resolve().then(() => {});',
    'await Promise.all([]);',
    'process.nextTick(() => {});',
    'globalThis.setTimeout(() => {}, 0);',
    'const fire = async () => { await Promise.resolve(); }; fire();',
    'const runtime = await setup(); runtime.send();',
    "const runtime = await setup(); const escaped = runtime['se' + 'nd'];",
  ]) {
    const changed = source.replace('const id=randomUUID();', injected + ' const id=randomUUID();');
    assert.throws(() => run(changed, changed), /unsupported-records-fixture-slice/u);
  }
  const unawaited = source.replace(
    "test('other', async () => {",
    "test('other', async (t) => { t.test('child', async () => {});",
  );
  assert.throws(() => run(unawaited, unawaited), /unsupported-records-fixture-slice/u);
  const options = source.replace(
    "test('other', async () => {",
    "test('other', async (t) => { await t.test('child', { concurrency: true }, async () => {});",
  );
  assert.throws(() => run(options, options), /unsupported-records-fixture-slice/u);
});

test('accepts only the direct response key projection and rejects altered producers or callbacks', () => {
  const projection = source
    .replace('return {store};', 'const send=async()=>({}); return {store,send};')
    .replace(
      'const result=await failure(id);',
      "const result=await failure(id); const narrow=await runtime.send('GET','/'); const keys=Object.keys(narrow.body).filter((key)=>!key.startsWith('@')).sort();",
    );
  assert.doesNotThrow(() => run(projection, projection));
  for (const edit of [
    (s) => s.replace("startsWith('@')", 'startsWith(process.env.EXTERNAL)'),
    (s) => s.replace("startsWith('@')", "startsWith('#')"),
    (s) => s.replace('.sort()', '.sort((a,b)=>external(a,b))'),
    (s) => s.replace('Object.keys(narrow.body)', 'Object.keys(SETTINGS)'),
    (s) => s.replace('Object.keys(narrow.body)', 'Object.keys(runtime.store)'),
    (s) => s.replace('const narrow=await runtime.send', 'const narrow=await other.send'),
    (s) => s.replace('const narrow=await runtime.send', 'let narrow=await runtime.send'),
    (s) => s.replace('const keys=Object.keys', 'narrow={body:{}}; const keys=Object.keys'),
    (s) => s.replace("(key)=>!key.startsWith('@')", "(key)=>{ leak(key); return !key.startsWith('@'); }"),
  ]) {
    const changed = edit(projection);
    assert.notEqual(changed, projection);
    assert.throws(() => run(changed, changed), /unsupported-records-fixture-slice/u);
  }
});
