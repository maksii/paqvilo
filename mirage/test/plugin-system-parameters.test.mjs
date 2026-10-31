// @test-kind compatibility: Microsoft Learn MSCRM.BypassCustomPluginExecution and BypassBusinessLogicExecution optional parameters
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { EXTENSION } from '../lib/dataverse-virtual-providers.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';

const user = '10000000-0000-0000-0000-000000000001';
const step = '30000000-0000-0000-0000-000000000001';

test('HTTP and SDK message boundaries preserve validated bypass parameter presence, types and source strings', async (t) => {
  const f = await contractModuleFixture(t, { extension: EXTENSION });
  const name = 'invented_ControlEcho',
    cases = [
      [{}, {}],
      [{ 'MSCRM.BypassCustomPluginExecution': 'false' }, { BypassCustomPluginExecution: false }],
      [{ 'MSCRM.BypassCustomPluginExecution': 'true' }, { BypassCustomPluginExecution: true }],
      [{ 'MSCRM.BypassBusinessLogicExecution': 'CustomSync' }, { BypassBusinessLogicExecution: 'CustomSync' }],
      [
        {
          'MSCRM.BypassBusinessLogicExecution': ' CustomAsync ',
          'MSCRM.BypassBusinessLogicExecutionStepIds': ' invalid, ' + step,
        },
        { BypassBusinessLogicExecution: 'CustomAsync', BypassBusinessLogicExecutionStepIds: 'invalid, ' + step },
      ],
    ];
  // HTTP parsers trim outer header whitespace; preserve each parsed original string.
  f.api.registry.register({
    name,
    kind: 'action',
    binding: 'unbound',
    handle: (c) => {
      assert.deepEqual(c.body, { Text: 'Business input' });
      return { status: 200, body: { Controls: c.systemParameters } };
    },
  });
  for (const [headers, expected] of cases) {
    const result = await f.json(await f.request('POST', '/' + name, { Text: 'Business input' }, headers), 200);
    assert.deepEqual(result.Controls, expected);
  }
  f.store.state.tables.customapi ??= [];
  f.store.state.tables.customapi.push({ customapiid: step, uniquename: name, isfunction: false });
  let expected;
  f.api.records.executeMessageSyncInternal = (request) => {
    assert.deepEqual(request.parameters.values, { Text: 'Business input' });
    assert.deepEqual(request.systemParameters, expected);
    return {
      outputs: { $type: 'ParameterCollection', values: { Controls: JSON.stringify(request.systemParameters) } },
    };
  };
  const profile = {
    userId: user,
    evidence: 'Invented validated system control transport test',
    grants: [{ message: name, operations: ['execute'] }],
    privileges: ['prvBypassCustomPlugins', 'prvBypassCustomBusinessLogic'],
  };
  for (const control of [
    {},
    { BypassCustomPluginExecution: false },
    { BypassCustomPluginExecution: true },
    { BypassBusinessLogicExecution: ' CustomSync ' },
    { BypassBusinessLogicExecutionStepIds: ' invalid, ' + step },
  ]) {
    expected = control;
    const response = await f.store.transact(() =>
      dispatchSdkCall({
        store: f.store,
        profile,
        message: {
          method: 'Execute',
          userId: user,
          arguments: [
            {
              $type: 'OrganizationRequest',
              requestName: name,
              parameters: { $type: 'ParameterCollection', values: { Text: 'Business input', ...control } },
            },
          ],
        },
      }),
    );
    assert.deepEqual(JSON.parse(response.results.Controls), control);
  }
});

const BYPASS_KEYS = [
  'BypassCustomPluginExecution',
  'BypassBusinessLogicExecution',
  'BypassBusinessLogicExecutionStepIds',
];
const probeType = 'Invented.SystemParameterProbe';
const probeStep = (message, stage, index, { mode = 0, entity = 'x_item' } = {}) => ({
  id: `30000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
  name: `Invented probe ${message} ${stage} ${mode}`,
  enabled: true,
  entity,
  message,
  stage,
  rank: 1,
  mode,
  supportedDeployment: 0,
  assemblyId: 'invented',
  typeName: probeType,
  filteringAttributes: [],
  images: [],
});
async function probeFixture(t, steps, seen) {
  const mapping = (logical, entitySet) => ({
    logicalName: logical,
    entitySet,
    idColumn: `${logical}id`,
    fields: { x_name: { dataverseType: 'nvarchar' } },
  });
  const f = await contractModuleFixture(t, {
    mappings: { x_item: mapping('x_item', 'x_items'), x_other: mapping('x_other', 'x_others') },
    tables: { x_item: [], x_other: [] },
    extension: { name: 'system-parameters-probe', install: () => {} },
  });
  const handlers = new Map([
    [
      probeType,
      ({ context }) => {
        seen.push({
          message: context.MessageName,
          stage: context.Stage,
          mode: context.Mode,
          inputs: { ...context.InputParameters },
          shared: { ...context.SharedVariables },
          parent: context.ParentContext?.InputParameters ? { ...context.ParentContext.InputParameters } : null,
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers, overrides: {}, runtimes: new Map() });
  const backend = await createOrganizationBackend({
    store: f.store,
    items: () => items,
    handlers,
    runtimes: new Map(),
    descriptors: new Map(),
  });
  t.after(() => backend.close());
  return { ...f, backend };
}

// @test-kind parity: native recorder corpus bypassHeaders (two captures): record-operation contexts at 10/20/40, their asynchronous jobs and ParentContext frames carry the MSCRM bypass headers as InputParameters with the sent values
test('record operations expose MSCRM bypass headers as InputParameters at every stage, in ParentContext and on asynchronous jobs', async (t) => {
  const seen = [];
  const f = await probeFixture(
    t,
    [
      probeStep('Create', 10, 11),
      probeStep('Create', 20, 12),
      probeStep('Create', 40, 13),
      probeStep('Create', 40, 14, { mode: 1 }),
      probeStep('CreateMultiple', 10, 15),
      probeStep('CreateMultiple', 20, 16),
      probeStep('CreateMultiple', 40, 17),
      probeStep('Create', 20, 18, { entity: 'x_other' }),
    ],
    seen,
  );
  const unrelated = '30000000-0000-0000-0000-000000000018';
  // Runs one Web API write and returns the contexts of its message (synchronous and asynchronous).
  const bypassed = async (message, headers, body) => {
    seen.length = 0;
    const response = await f.request('POST', message, body, headers);
    assert.ok(response.ok, await response.text());
    await f.backend.settle();
    const name = message.includes('CreateMultiple') ? 'CreateMultiple' : 'Create';
    return seen.filter((entry) => entry.message === name);
  };

  // CustomAsync: the synchronous Create contexts (10, 20, 40) and their ParentContext see the header; no asynchronous job runs.
  const custom = await bypassed(
    '/x_items',
    { 'MSCRM.BypassBusinessLogicExecution': 'CustomAsync' },
    { x_name: 'Async only' },
  );
  assert.deepEqual(
    custom.map((entry) => [entry.stage, entry.mode]),
    [
      [10, 0],
      [20, 0],
      [40, 0],
    ],
  );
  for (const entry of custom) {
    assert.equal(entry.inputs.BypassBusinessLogicExecution, 'CustomAsync');
    assert.equal(entry.inputs.BypassCustomPluginExecution, undefined);
    if (entry.mode === 0 && entry.stage !== 10) assert.equal(entry.parent.BypassBusinessLogicExecution, 'CustomAsync');
  }

  // StepIds naming an unrelated step: every synchronous context and the asynchronous job carry the raw string.
  const stepIds = await bypassed(
    '/x_items',
    { 'MSCRM.BypassBusinessLogicExecutionStepIds': unrelated },
    { x_name: 'Ids' },
  );
  assert.deepEqual(
    stepIds.map((entry) => [entry.stage, entry.mode]),
    [
      [10, 0],
      [20, 0],
      [40, 0],
      [40, 1],
    ],
  );
  for (const entry of stepIds) {
    assert.equal(entry.inputs.BypassBusinessLogicExecutionStepIds, unrelated);
    if (entry.mode === 0 && entry.stage !== 10)
      assert.equal(entry.parent.BypassBusinessLogicExecutionStepIds, unrelated);
  }

  // No header: none of the bypass parameters appear on any context.
  const plain = await bypassed('/x_items', {}, { x_name: 'Plain' });
  assert.equal(plain.length, 4);
  assert.ok(plain.every((entry) => BYPASS_KEYS.every((key) => !Object.hasOwn(entry.inputs, key))));
  assert.ok(plain.every((entry) => BYPASS_KEYS.every((key) => !Object.hasOwn(entry.parent ?? {}, key))));

  // A bulk CreateMultiple with CustomAsync: the CreateMultiple contexts at 10, 20 and 40 carry the header.
  const bulk = await bypassed(
    '/x_items/Microsoft.Dynamics.CRM.CreateMultiple',
    { 'MSCRM.BypassBusinessLogicExecution': 'CustomAsync' },
    { Targets: [{ '@odata.type': 'Microsoft.Dynamics.CRM.x_item', x_name: 'A' }] },
  );
  assert.deepEqual(
    bulk.map((entry) => entry.stage),
    [10, 20, 40],
  );
  assert.ok(bulk.every((entry) => entry.inputs.BypassBusinessLogicExecution === 'CustomAsync'));
});

// @test-kind parity: native recorder corpus bypassHeaders (native and native-r2): with MSCRM.BypassCustomPluginExecution true or BypassBusinessLogicExecution CustomSync no synchronous step runs, while each asynchronous Create and CreateMultiple step runs once, inside the request's frame (its tag) and with the header as an InputParameter
// @parity-evidence: native and native-r2 bypassHeaders: 'bypass custom' and 'bypass sync' each run Create/40/m1 and CreateMultiple/40/m1, InputParameters BypassCustomPluginExecution true / BypassBusinessLogicExecution 'CustomSync', SharedVariables tag
test('bypassing synchronous custom logic still runs the asynchronous steps in the request frame', async (t) => {
  const seen = [];
  const f = await probeFixture(
    t,
    [
      probeStep('Create', 10, 61),
      probeStep('Create', 40, 62),
      probeStep('Create', 40, 63, { mode: 1 }),
      probeStep('CreateMultiple', 40, 64, { mode: 1 }),
    ],
    seen,
  );
  const tagged = {};
  for (const [header, value, input] of [
    ['MSCRM.BypassCustomPluginExecution', 'true', ['BypassCustomPluginExecution', true]],
    ['MSCRM.BypassBusinessLogicExecution', 'CustomSync', ['BypassBusinessLogicExecution', 'CustomSync']],
  ]) {
    seen.length = 0;
    const response = await f.request(
      'POST',
      '/x_items?tag=' + encodeURIComponent('run ' + value),
      { x_name: value },
      {
        [header]: value,
      },
    );
    assert(response.status < 300, await response.text());
    await f.backend.settle();
    assert.deepEqual(seen.map((entry) => `${entry.message}/${entry.stage}/${entry.mode}`).sort(), [
      'Create/40/1',
      'CreateMultiple/40/1',
    ]);
    for (const entry of seen) assert.equal(entry.inputs[input[0]], input[1]);
    tagged[value] = seen.map((entry) => entry.shared.tag);
  }
  assert.deepEqual(tagged, { true: ['run true', 'run true'], CustomSync: ['run CustomSync', 'run CustomSync'] });
});
