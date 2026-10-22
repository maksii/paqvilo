import test from 'node:test';
import assert from 'node:assert/strict';
import { operationHandlers } from '../lib/exported-operations.mjs';
import { customApiHandlers } from '../lib/dataverse-customapi.mjs';
import { addonHandlers } from '../lib/dataverse-addon-common.mjs';
import { pluginRuntimeDescriptors } from '../lib/plugin-clr.mjs';

const STEP = '77777777-7777-4777-8777-777777777777';
const FLOW = '66666666-6666-4666-8666-666666666666';
const handler = () => ({});
const profile = { userId: STEP, evidence: 'Invented flow owner', grants: [{ entity: 'x_item', operations: ['read'] }] };

test('two packs with the same key fail with the single collision message', () => {
  assert.throws(() => customApiHandlers([{ id: 'fx-a', customApis: { x_Echo: handler } }, { id: 'fx-b', customApis: { X_ECHO: handler } }]),
    /^Error: Ambiguous customApis registration for x_echo in packs fx-a and fx-b$/);
  assert.throws(() => operationHandlers([{ id: 'fx-a', serverLogics: { Sample: handler } }, { id: 'fx-b', serverLogics: { sample: handler } }]),
    /^Error: Ambiguous serverLogics registration for sample in packs fx-a and fx-b$/);
  assert.throws(() => addonHandlers([{ id: 'fx-a', dataverseMessages: { x_Run: handler } }, { id: 'fx-b', dataverseMessages: { x_Run: handler } }]),
    /^Error: Ambiguous dataverseMessages registration for x_Run in packs fx-a and fx-b$/);
  assert.throws(() => pluginRuntimeDescriptors([{ id: 'fx-a', pluginRuntimes: { [`{${STEP.toUpperCase()}}`]: {} } }, { id: 'fx-b', pluginRuntimes: { [STEP]: {} } }]),
    error => error.code === 'LocalPluginClrConfiguration' && error.message === `Ambiguous pluginRuntimes registration for ${STEP} in packs fx-a and fx-b`);
});

test('a single pack keeps the public collector shapes', () => {
  const operations = operationHandlers([{ id: 'fx-a', serverLogics: { Sample: handler }, cloudFlows: { Notify: handler }, flowIdentities: { [`{${FLOW}}`]: profile } }]);
  assert.deepEqual(Object.keys(operations), ['serverLogics', 'cloudFlows', 'flowIdentities']);
  assert.equal(operations.serverLogics.get('sample'), handler);
  assert.equal(operations.cloudFlows.get('notify'), handler);
  assert.equal(operations.flowIdentities.get(FLOW), profile);

  const apis = customApiHandlers([{ id: 'fx-a', customApis: { x_Echo: handler, x_Typed: { handler, pluginType: 'Invented.Plugins.Typed' } } }]);
  assert.deepEqual([...apis], [['x_echo', { handler, pluginType: null }], ['x_typed', { handler, pluginType: 'Invented.Plugins.Typed' }]]);

  assert.deepEqual([...addonHandlers([{ id: 'fx-a', dataverseMessages: { x_Run: handler } }])], [['x_Run', { handler, pack: 'fx-a' }]]);
  assert.deepEqual([...addonHandlers([{ dataverseMessages: { x_Run: handler } }])], [['x_Run', { handler, pack: null }]]);

  const descriptor = { assembly: 'Invented.dll' };
  assert.deepEqual([...pluginRuntimeDescriptors([{ id: 'fx-a', pluginRuntimes: { [`{${STEP.toUpperCase()}}`]: descriptor } }])], [[STEP, descriptor]]);
  assert.throws(() => pluginRuntimeDescriptors([{ id: 'fx-a', pluginRuntimes: { 'not-a-guid': descriptor } }]), error => error.code === 'LocalPluginClrConfiguration');
});
