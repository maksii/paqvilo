// @test-kind parity: native-r2 sdkSurface plug-in Execute(CreateMultiple) and Execute(UpdateMultiple) (6202-6207, 6177/6192): Entity.Id allocated before PreValidation; CreateMultiple/20 and the record's Create/20 Targets carry the key, state, audit stamps and organizationid; UpdateMultiple/20 Targets the key and the modification stamps
// SDK bulk requests a plug-in issues, on an organization with its records layer. Invented tables and users only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';

const EMPTY = '00000000-0000-0000-0000-000000000000';
const step = (n, message, stage) => ({
  id: `77000000-0000-0000-0000-0000000000${n}`,
  name: `Invented ${message} ${stage}`,
  entity: 'x_part',
  message,
  enabled: true,
  stage,
  rank: 1,
  mode: 0,
  assemblyId: 'invented-sdk-bulk',
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.BulkObserver',
});

async function organization(t) {
  const state = emptyState();
  // An organization-owned table with a state.
  state.mappings.x_part = {
    entitySet: 'x_parts',
    idColumn: 'x_partid',
    ownership: 'OrganizationOwned',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      statecode: { dataverseType: 'state', options: [{ value: 0, label: 'Active' }] },
      statuscode: { dataverseType: 'status', options: [{ value: 1, label: 'Active', state: 0 }] },
    },
  };
  state.tables.x_part = [];
  const store = await new DataStore({ state }).init();
  const runtime = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({
      enabled: true,
      users: [
        {
          objectId: '77000000-0000-0000-0000-000000000001',
          domainname: 'admin@invented.test',
          fullname: 'Invented admin',
          roles: ['System Administrator'],
        },
      ],
    }),
  });
  t.after(() => runtime.close());
  const admin = store.tableRows('systemuser').find((row) => row.fullname === 'Invented admin').systemuserid;
  const profile = {
    userId: admin,
    evidence: 'Invented SDK bulk step',
    grants: [],
    bulkTables: [
      {
        entity: 'x_part',
        tableType: 'standard',
        evidence: 'Invented bulk message availability',
        messages: ['CreateMultiple', 'UpdateMultiple'],
      },
    ],
  };
  const seen = [];
  const steps = [
    step(10, 'CreateMultiple', 10),
    step(20, 'CreateMultiple', 20),
    step(21, 'Create', 20),
    step(30, 'UpdateMultiple', 10),
    step(31, 'UpdateMultiple', 20),
  ];
  const handlers = new Map([
    [
      'Invented.BulkObserver',
      ({ context }) => {
        seen.push({
          at: `${context.MessageName}/${context.Stage}`,
          targets: structuredClone(context.InputParameters.Targets ?? null),
          target: structuredClone(context.InputParameters.Target ?? null),
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  const execute = (requestName, entities) =>
    store.withOperationContext(() =>
      dispatchSdkCall({
        store,
        profile,
        invokingUserId: admin,
        initiatingUserId: admin,
        message: {
          method: 'Execute',
          userId: EMPTY,
          arguments: [
            {
              $type: 'OrganizationRequest',
              requestName,
              parameters: {
                $type: 'ParameterCollection',
                values: { Targets: { $type: 'EntityCollection', entityName: 'x_part', entities } },
              },
            },
          ],
        },
      }),
    );
  return { store, seen, execute };
}

const part = (id, attributes) => ({ $type: 'Entity', logicalName: 'x_part', id, attributes });
const keysOf = (entity) => Object.keys(entity?.attributes ?? entity ?? {}).sort();

test('a plug-in CreateMultiple allocates the ids and stamps every record at PreOperation', async (t) => {
  const { store, seen, execute } = await organization(t);
  await execute('CreateMultiple', [part(EMPTY, { x_name: 'one' }), part(EMPTY, { x_name: 'two' })]);
  const at = (label) => seen.filter((entry) => entry.at === label);
  const validation = at('CreateMultiple/10')[0].targets;
  for (const entity of validation) {
    assert.notEqual(entity.id, EMPTY, 'Entity.Id is allocated before PreValidation');
    assert.deepEqual(keysOf(entity), ['x_name']);
  }
  const expected = [
    'createdby',
    'createdon',
    'modifiedby',
    'modifiedon',
    'modifiedonbehalfby',
    'organizationid',
    'statecode',
    'statuscode',
    'x_name',
    'x_partid',
  ];
  const pre = at('CreateMultiple/20')[0].targets;
  for (const [index, entity] of pre.entries()) {
    assert.deepEqual(keysOf(entity), expected);
    assert.equal(entity.id, validation[index].id);
    assert.equal(entity.attributes.x_partid.value, entity.id);
    assert.match(String(entity.attributes.createdon.value), /:\d\dZ$/);
  }
  for (const entry of at('Create/20')) assert.deepEqual(keysOf(entry.target), expected);
  assert.deepEqual(
    store.tableRows('x_part').map((row) => row.x_partid),
    validation.map((entity) => entity.id),
  );
});

test('a plug-in UpdateMultiple shows the key and the modification stamps at PreOperation', async (t) => {
  const { store, seen, execute } = await organization(t);
  await execute('CreateMultiple', [part(EMPTY, { x_name: 'one' })]);
  const id = store.tableRows('x_part')[0].x_partid;
  seen.length = 0;
  await execute('UpdateMultiple', [part(id, { x_name: 'renamed' })]);
  const at = (label) => seen.find((entry) => entry.at === label).targets[0];
  assert.deepEqual(keysOf(at('UpdateMultiple/10')), ['x_name']);
  assert.deepEqual(keysOf(at('UpdateMultiple/20')), [
    'modifiedby',
    'modifiedon',
    'modifiedonbehalfby',
    'x_name',
    'x_partid',
  ]);
  assert.equal(store.tableRows('x_part')[0].x_name, 'renamed');
});
