import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { EXTENSION } from '../lib/dataverse-virtual-providers.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';

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
