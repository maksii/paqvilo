import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectFlowExpression,
  resolveFlowValue,
  executeFlowDefinition,
  evaluateFlowTriggerConditions,
  runTrackedFlow,
  inspectFlowTrigger,
} from '../lib/flow-runtime.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { runExportedCloudFlow } from '../lib/exported-operations.mjs';
import { stringifyExactJson } from '../lib/exact-numeric.mjs';

const state = () => ({ input: {}, variables: {}, parameters: {}, results: {}, items: [] });
const definition = (conditions) => ({
  triggers: { request: { type: 'Request', kind: 'Http', conditions } },
  actions: { Reply: { type: 'Response', inputs: { body: 'accepted' } } },
});

test('pure expression diagnostics validate syntax, known functions and arity without evaluating dynamic inputs', () => {
  for (const expression of [
    "@contains(triggerBody()?['unknown'], 'x')",
    "StArTsWiTh('A','a')",
    "@substring('abc', 1)",
    "@ticks(parameters('captured'))",
  ])
    assert.deepEqual(inspectFlowExpression(expression), { supported: true, diagnostics: [] });
  for (const [expression, pattern] of [
    ["@concat('x',)", /argument is missing/],
    ['@unknownProvider()', /Unsupported local flow function/],
    ["@endsWith('x')", /argument count/],
    ['@constructor()', /Unsupported|Unsafe/],
    [null, /must be a string/],
    ['@triggerBody()' + '.x'.repeat(6000), /nesting/],
  ]) {
    const result = inspectFlowExpression(expression);
    assert.equal(result.supported, false);
    assert.match(result.diagnostics[0].message, pattern);
    assert.equal(result.diagnostics[0].code, 'LocalFlowUnsupported');
  }
});

test('ticks retains seven fractional digits and the exact .NET epoch across the supported UTC ISO range', () => {
  const ticks = (value) => resolveFlowValue(`@ticks('${value}')`, state());
  for (const [value, expected] of [
    ['0001-01-01T00:00:00Z', '0'],
    ['0001-01-01T00:00:00.0000001Z', '1'],
    ['1970-01-01T00:00:00Z', '621355968000000000'],
    ['1970-01-01T00:00:00.1234567Z', '621355968001234567'],
    ['9999-12-31T23:59:59.9999999Z', '3155378975999999999'],
  ])
    assert.equal(stringifyExactJson(ticks(value)), expected);
  assert.equal(
    resolveFlowValue("@sub(ticks('2026-01-01T00:00:00.0000002Z'), ticks('2026-01-01T00:00:00.0000001Z'))", state()),
    1,
  );
  assert.equal(resolveFlowValue("@div(ticks('0001-01-01T00:00:00.0000003Z'),2)", state()), 1);
  assert.equal(
    resolveFlowValue("@greater(ticks('2024-02-29T00:00:00Z'),ticks('2024-02-28T23:59:59.9999999Z'))", state()),
    true,
  );
});

test('ticks rejects normalized calendar overflows and explicitly refuses unevidenced non-UTC formats', () => {
  for (const value of [
    '0000-01-01T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-01-01T24:00:00Z',
  ])
    assert.throws(
      () => resolveFlowValue(`@ticks('${value}')`, state()),
      (error) => error.code === 'LocalFlowExpression',
    );
  for (const value of [
    '2026-01-01',
    '2026-01-01T00:00:00',
    '2026-01-01T00:00:00+00:00',
    '2026-01-01T00:00:00.12345678Z',
  ])
    assert.throws(
      () => resolveFlowValue(`@ticks('${value}')`, state()),
      (error) => error.code === 'LocalFlowUnsupported',
    );
  assert.throws(() => resolveFlowValue('@ticks(0)', state()), /UTC ISO/);
});

test('all trigger conditions must be boolean true; malformed or unsupported conditions are never silently false', () => {
  const accepted = definition([{ expression: "@equals(triggerBody()?['enabled'],true)" }, { expression: '@true' }]);
  assert.equal(inspectFlowTrigger(accepted).supported, true);
  assert.equal(evaluateFlowTriggerConditions(accepted, { input: { enabled: true } }), true);
  assert.equal(evaluateFlowTriggerConditions(accepted, { input: { enabled: false } }), false);
  for (const conditions of [
    null,
    ['@true'],
    [{ expression: 'true' }],
    [{ expression: '@unknown()' }],
    [{ expression: '@{true}' }],
    [{ expression: '@true', extra: true }],
    Array(101).fill({ expression: '@true' }),
  ])
    assert.equal(inspectFlowTrigger(definition(conditions)).supported, false);
  assert.throws(
    () =>
      evaluateFlowTriggerConditions(
        definition([{ expression: '@false' }, { expression: "@triggerBody()['missing']" }]),
        { input: {} },
      ),
    /property is absent/,
  );
  assert.throws(
    () => evaluateFlowTriggerConditions(definition([{ expression: "@'true'" }]), { input: {} }),
    /boolean results/,
  );
});

test('false conditions create no tracked run, action response, provider call or identity callback', async () => {
  let starts = 0,
    callbacks = 0,
    wrapped = 0;
  const d = definition([{ expression: '@false' }]);
  const result = await runTrackedFlow({
    runs: {
      start: () => {
        starts++;
        throw Error('must not start');
      },
    },
    processId: 'invented',
    definition: d,
    input: {},
    onRun: () => callbacks++,
    wrap: () => wrapped++,
  });
  assert.deepEqual(result, { status: 'Skipped', reason: 'TriggerConditionFalse' });
  assert.deepEqual([starts, callbacks, wrapped], [0, 0, 0]);
  assert.deepEqual(executeFlowDefinition({ definition: d, input: {} }), result);
  d.triggers.request.conditions = [{ expression: "@equals('a')" }];
  await assert.rejects(runTrackedFlow({ runs: { start: () => starts++ }, definition: d, input: {} }), /argument count/);
  assert.equal(starts, 0);
});

test('whole flow date comparisons distinguish adjacent ticks and preserve exact response JSON', async () => {
  const d = definition([
    { expression: "@greater(ticks(triggerBody()['instant']),ticks('2026-01-01T00:00:00.0000001Z'))" },
  ]);
  d.actions.Reply.inputs.body = "@ticks(triggerBody()['instant'])";
  const response = await executeFlowDefinition({ definition: d, input: { instant: '2026-01-01T00:00:00.0000002Z' } });
  assert.equal(response.status, 200);
  assert.equal(stringifyExactJson(response.body), '639028224000000002');
  assert.equal(
    executeFlowDefinition({ definition: d, input: { instant: '2026-01-01T00:00:00.0000001Z' } }).status,
    'Skipped',
  );
});

test('Power Pages condition false remains a valid HTTP acknowledgement with and without tracked history', async (t) => {
  for (const tracked of [false, true]) {
    const store = await new DataStore({ state: emptyState() }).init();
    const runs = tracked ? createHostFlowRuns({ store }) : null;
    if (runs) {
      runs.attach({ store });
      t.after(() => runs.close());
    }
    const id = '10000000-0000-4000-8000-000000000001';
    const d = definition([{ expression: '@false' }]);
    d.triggers.request.kind = 'powerpages';
    const result = await runExportedCloudFlow({
      record: { processId: id },
      workflows: new Map([[id, { definition: { properties: { definition: d } } }]]),
      store,
      input: {},
    });
    assert.deepEqual(result, { status: 202, body: { status: 'Skipped', reason: 'TriggerConditionFalse' } });
    assert.equal(runs?.list().length ?? 0, 0);
  }
});
