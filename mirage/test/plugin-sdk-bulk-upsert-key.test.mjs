// @test-kind parity: native recorder corpus sdkSurface (dev environment, captures native and native-r2): a synchronous step's SDK UpdateMultiple and CreateMultiple on custom tables succeed without any caller-supplied capability, an SDK Upsert by alternate key creates the row (RecordCreated, Target), and the step's later Creates still succeed
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { sdkFault } from '../lib/plugin-sdk-messages.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';

const EMPTY = '00000000-0000-0000-0000-000000000000';
const ROW = (n) => `7b000000-0000-0000-0000-00000000000${n}`;

// An x_item Create whose PreOperation step issues SDK requests as SYSTEM, catching each fault, then creates one x_log row.
// Answers each request's answer or fault and the operation's outcome.
async function step(t, requests) {
  const state = emptyState();
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
  state.mappings.x_thing = {
    entitySet: 'x_things',
    idColumn: 'x_thingid',
    alternateKeys: [{ name: 'x_code_key', attributes: ['x_code'] }],
  };
  state.mappings.x_log = { entitySet: 'x_logs', idColumn: 'x_logid' };
  state.tables.x_item = [];
  state.tables.x_log = [];
  state.tables.x_thing = [1, 2].map((n) => ({ x_thingid: ROW(n), x_name: `thing ${n}`, x_code: `C${n}` }));
  const store = await new DataStore({ state }).init();
  const organization = await createOrganizationRuntime({ store, settings: dataverseSettings({ enabled: true }) });
  t.after(() => organization.close());
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  // No bulkTables: availability comes from the organization's message filters.
  const profile = { userId: system, evidence: 'Invented calling step', grants: [] };
  const call = (method, args) =>
    dispatchSdkCall({
      store,
      profile,
      sdkParentContext: { $type: 'ExecutionContext', values: { MessageName: 'Create', Stage: 20, Depth: 1 } },
      message: { method, userId: null, arguments: args },
    });
  const answers = [];
  store.setPluginPipeline(
    (context) => {
      if (context.stage !== 20) return;
      for (const request of requests)
        try {
          answers.push(request(call));
        } catch (error) {
          answers.push(sdkFault(error) ?? { local: error.code, status: error.status });
        }
      call('Create', [entity('x_log', { x_name: 'after' })]);
    },
    (context) => context.entity === 'x_item' && context.operation === 'create',
  );
  const caller = localOrganizationService(store, {
    ...profile,
    grants: [{ entity: 'x_item', operations: ['create'] }],
  });
  const outcome = await store
    .transact(() => store.withOperationContext(() => caller.create('x_item', { x_name: 'trigger' })))
    .then(
      () => 'committed',
      (error) => error.details?.innerCode ?? error.code,
    );
  return { answers, outcome, store };
}
const execute = (requestName, values) => (call) =>
  call('Execute', [
    { $type: 'OrganizationRequest', requestName, parameters: { $type: 'ParameterCollection', values } },
  ]);
const entity = (logicalName, attributes, id = EMPTY, keyAttributes) => ({
  $type: 'Entity',
  logicalName,
  id,
  attributes,
  ...(keyAttributes ? { keyAttributes } : {}),
});
const things = (store) => store.tableRows('x_thing').map((row) => [row.x_code, row.x_name]);

test('a step SDK UpdateMultiple and CreateMultiple run from the table message filters, without bulkTables', async (t) => {
  const { answers, outcome, store } = await step(t, [
    execute('UpdateMultiple', {
      Targets: {
        $type: 'EntityCollection',
        entities: [1, 2].map((n) => entity('x_thing', { x_name: `bulk ${n}` }, ROW(n))),
      },
    }),
    execute('CreateMultiple', {
      Targets: { $type: 'EntityCollection', entities: [1, 2].map((n) => entity('x_log', { x_name: `bulk log ${n}` })) },
    }),
  ]);
  assert.equal(answers[0].responseName, 'UpdateMultiple');
  assert.equal(answers[1].responseName, 'CreateMultiple');
  assert.equal(answers[1].results.Ids.values.length, 2);
  assert.equal(outcome, 'committed');
  assert.deepEqual(things(store), [
    ['C1', 'bulk 1'],
    ['C2', 'bulk 2'],
  ]);
  assert.deepEqual(
    store.tableRows('x_log').map((row) => row.x_name),
    ['bulk log 1', 'bulk log 2', 'after'],
  );
});

test('a step SDK Upsert by alternate key creates the row with the key value', async (t) => {
  const { answers, outcome, store } = await step(t, [
    execute('Upsert', { Target: entity('x_thing', { x_name: 'by key' }, EMPTY, { x_code: 'NEW' }) }),
  ]);
  const created = store.tableRows('x_thing').find((row) => row.x_code === 'NEW');
  assert.equal(created?.x_name, 'by key');
  assert.equal(answers[0].results.RecordCreated, true);
  assert.deepEqual(answers[0].results.Target, {
    $type: 'EntityReference',
    logicalName: 'x_thing',
    id: created.x_thingid,
    name: null,
  });
  assert.equal(outcome, 'committed');
  assert.deepEqual(
    store.tableRows('x_log').map((row) => row.x_name),
    ['after'],
  );
});

// @test-kind unproven: the update path of an SDK Upsert by alternate key follows the Web API upsert (Learn: the server drops the Target values of the key columns); native sdkSurface records only the create path
test('a step SDK Upsert by an existing alternate key updates that row', async (t) => {
  const { answers, outcome, store } = await step(t, [
    execute('Upsert', { Target: entity('x_thing', { x_name: 'updated', x_code: 'C9' }, EMPTY, { x_code: 'C2' }) }),
  ]);
  assert.equal(answers[0].results.RecordCreated, false);
  assert.equal(answers[0].results.Target.id, ROW(2));
  assert.deepEqual(things(store), [
    ['C1', 'thing 1'],
    ['C2', 'updated'],
  ]);
  assert.equal(outcome, 'committed');
});

// @test-kind unproven: a table whose filter catalogue lacks the bulk message refuses it with the platform's MessageProcessor.Empty fault (0x80040800), assumed from the recorded native Merge refusal on a table without its filter; an undeclared Upsert key is refused before any write
test('SDK bulk on a table without the message filter and Upsert by an undeclared key are refused', async (t) => {
  const bulk = await step(t, [
    execute('CreateMultiple', {
      Targets: { $type: 'EntityCollection', entities: [entity('systemuser', { fullname: 'Invented' })] },
    }),
  ]);
  assert.equal(bulk.answers[0].errorCode, 0x80040800 | 0);
  assert.equal(
    bulk.answers[0].message,
    "The 'CreateMultiple' method does not support entities of type 'systemuser'. MessageProcessorCache returned MessageProcessor.Empty. ",
  );
  const upsert = await step(t, [
    execute('Upsert', { Target: entity('x_thing', { x_name: 'bad key' }, EMPTY, { x_name: 'bad key' }) }),
  ]);
  assert.equal(upsert.answers[0].errorCode, 0x80040203 | 0);
  assert.equal(upsert.store.tableRows('x_thing').length, 2);
});

// @test-kind contract: a local limitation (501, delivered to the plug-in as NotSupportedException) caught by the step is not reported as a native transaction abort: the step's later calls and the operation succeed
test('a caught local limitation does not abort the calling transaction', async (t) => {
  const { answers, outcome, store } = await step(t, [
    execute('Upsert', { Target: entity('x_thing', { x_name: 'no key' }) }),
  ]);
  assert.deepEqual(answers, [{ local: 'LocalPluginSdkUnsupported', status: 501 }]);
  assert.equal(outcome, 'committed');
  assert.deepEqual(
    store.tableRows('x_log').map((row) => row.x_name),
    ['after'],
  );
});
