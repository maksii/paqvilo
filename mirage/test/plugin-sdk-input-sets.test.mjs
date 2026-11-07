// @test-kind parity: native recorder corpus sdkSurface, sdkMessages, soapMessages and crud web hook payloads (native and native-r2): FromSandbox, ConcurrencyBehavior and DefaultsAddedFlag presence per stage on SDK bulk requests, a main operation's own Update and asynchronous web hook parents
// Invented tables, identities and messages only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { remoteExecutionContext } from '../lib/dataverse-webhooks.mjs';

const user = '10000000-0000-4000-8000-0000000000a1',
  row = '20000000-0000-4000-8000-0000000000a1',
  empty = '00000000-0000-0000-0000-000000000000';
const step = (n, message, stage, mode = 0) => ({
  id: `30000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  name: `Invented ${message} ${stage} ${mode}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.InputSets',
  assemblyId: 'invented',
});

async function fixture(t, steps) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        ownership: 'UserOwned',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [{ x_itemid: row, x_name: 'Existing' }] },
    extension: { name: 'sdk-input-sets', install: () => {} },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.InputSets',
      ({ context }) =>
        void seen.push({
          at: `${context.MessageName}/${context.Stage}/${context.Mode}`,
          inputs: Object.keys(context.InputParameters ?? {}).sort(),
          shared: Object.keys(context.SharedVariables ?? {}),
        }),
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  const caller = f.store.tableRows('systemuser').find((item) => item.applicationid).systemuserid;
  const sdk = (requestName, values, messages = []) =>
    f.store.transact(() =>
      dispatchSdkCall({
        store: f.store,
        sdkFromSandbox: true,
        profile: {
          userId: caller,
          evidence: 'Invented SDK input sets',
          grants: [{ entity: 'x_item', operations: ['create', 'read', 'update'] }],
          ...(messages.length
            ? {
                bulkTables: [
                  { entity: 'x_item', tableType: 'standard', evidence: 'Invented source capability', messages },
                ],
              }
            : {}),
        },
        message: {
          method: 'Execute',
          userId: caller,
          arguments: [
            { $type: 'OrganizationRequest', requestName, parameters: { $type: 'ParameterCollection', values } },
          ],
        },
      }),
    );
  return { ...f, seen, backend, sdk, caller };
}
const entities = (attributes) => ({
  $type: 'EntityCollection',
  entities: attributes.map((values) => ({ $type: 'Entity', logicalName: 'x_item', id: empty, attributes: values })),
});
const at = (seen, label) => seen.find((entry) => entry.at === label);

test('a plug-in CreateMultiple is marked FromSandbox and carries no DefaultsAddedFlag; its records do', async (t) => {
  const f = await fixture(t, [
    step(1, 'CreateMultiple', 10),
    step(2, 'CreateMultiple', 20),
    step(3, 'CreateMultiple', 40),
    step(4, 'Create', 10),
  ]);
  await f.sdk('CreateMultiple', { Targets: entities([{ x_name: 'A' }]) }, ['CreateMultiple']);
  assert.deepEqual(at(f.seen, 'CreateMultiple/10/0').inputs, ['FromSandbox', 'Targets']);
  for (const stage of [10, 20, 40])
    assert.equal(at(f.seen, `CreateMultiple/${stage}/0`).shared.includes('DefaultsAddedFlag'), false);
  assert.deepEqual(at(f.seen, 'CreateMultiple/20/0').inputs, ['Targets']);
  assert.deepEqual(at(f.seen, 'Create/10/0').inputs, ['Target']);
  assert.ok(at(f.seen, 'Create/10/0').shared.includes('DefaultsAddedFlag'));
});

test('a plug-in UpdateMultiple carries FromSandbox at PreValidation and ConcurrencyBehavior at every stage', async (t) => {
  const f = await fixture(t, [
    step(5, 'UpdateMultiple', 10),
    step(6, 'UpdateMultiple', 20),
    step(7, 'UpdateMultiple', 40),
    step(8, 'Update', 20),
  ]);
  const target = { $type: 'Entity', logicalName: 'x_item', id: row, attributes: { x_name: 'Changed' } };
  await f.sdk('UpdateMultiple', { Targets: { $type: 'EntityCollection', entities: [target] } }, ['UpdateMultiple']);
  assert.deepEqual(at(f.seen, 'UpdateMultiple/10/0').inputs, ['ConcurrencyBehavior', 'FromSandbox', 'Targets']);
  assert.deepEqual(at(f.seen, 'UpdateMultiple/20/0').inputs, ['ConcurrencyBehavior', 'Targets']);
  assert.deepEqual(at(f.seen, 'UpdateMultiple/40/0').inputs, ['ConcurrencyBehavior', 'Targets']);
  assert.deepEqual(at(f.seen, 'Update/20/0').inputs, ['Target']);
});

test("an Assign's owner Update and its asynchronous job carry no ConcurrencyBehavior", async (t) => {
  const f = await fixture(t, [step(9, 'Update', 40), step(10, 'Update', 40, 1)]);
  const assignee = f.store.tableRows('systemuser').find((item) => item.fullname !== 'SYSTEM').systemuserid;
  await f.sdk('Assign', {
    Target: { $type: 'EntityReference', logicalName: 'x_item', id: row, name: null },
    Assignee: { $type: 'EntityReference', logicalName: 'systemuser', id: assignee, name: null },
  });
  await f.backend.settle();
  assert.equal(at(f.seen, 'Update/40/0').inputs.includes('ConcurrencyBehavior'), false);
  assert.equal(at(f.seen, 'Update/40/1').inputs.includes('ConcurrencyBehavior'), false);
});

test('an asynchronous web hook names no ConcurrencyBehavior in its ParentContext frames', async (t) => {
  const f = await fixture(t, []);
  const concurrency = { $type: 'ConcurrencyBehavior', value: 0 };
  const job = '40000000-0000-4000-8000-0000000000a1';
  const context = remoteExecutionContext(f.store, {
    item: { ...step(11, 'Update', 40, 1), contract: { mode: 1 } },
    entity: 'x_item',
    operation: 'update',
    stage: 40,
    target: { x_name: 'Changed' },
    record: f.store.tableRows('x_item')[0],
    previous: f.store.tableRows('x_item')[0],
    identity: { id: user, systemUserId: user },
    depth: 1,
    correlationId: job,
    asyncExecution: true,
    initialFrame: {
      requestId: job,
      operationId: job,
      createdOn: '2026-10-30T10:00:00.000Z',
      createdOnWire: { $type: 'DateTime', value: '2026-10-30T10:00:00.000' },
      asyncOperation: { id: job, createdOn: '2026-10-30T10:00:00.000Z', depth: 1 },
      inputParameters: { $type: 'ParameterCollection', values: { ConcurrencyBehavior: concurrency } },
      mainOperationInputs: { ConcurrencyBehavior: concurrency },
      mainOperationTarget: { x_name: 'Changed' },
    },
  });
  const keys = [];
  for (let frame = context; frame; frame = frame.ParentContext) keys.push(...frame.InputParameters.map((p) => p.key));
  assert.ok(context.ParentContext, 'the job has its main-operation parent');
  assert.equal(keys.includes('ConcurrencyBehavior'), false);
});
