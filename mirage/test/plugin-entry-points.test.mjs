// @test-kind parity: native dev-environment plug-in recorder corpus 2026-10-30 (customApi: a bound custom API's target load runs no Retrieve pipeline; associate: a self-referencing N:N $ref through the relationship-named navigation passes PrimaryEntityRole Referencing; upsert: a Delete by alternate key names it in its PreValidation and main-operation Targets)
// @parity-evidence: native recorder corpus 2026-10-30, associate (a self-referencing N:N $ref through its relationship-named navigation: Relationship.PrimaryEntityRole Referencing) and upsert (DELETE by alternate key: PreValidation and Delete/30 Target keyAttributes), replayed by the local recorder harness; the edited lines only add these tests and their fixture
// Web API entry points of named messages and bound operations. Invented tables, identities and messages only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { clrContext } from '../lib/plugin-clr.mjs';
import { install as installCustomApis } from '../lib/dataverse-customapi.mjs';

const row = '20000000-0000-0000-0000-0000000000c1';
const peer = '20000000-0000-0000-0000-0000000000c2';
// A self-referencing many-to-many relationship: Entity1 navigation named as the relationship, Entity2 its partner.
const peers = (from, to, navigation, partner) => ({
  [navigation]: {
    entity: 'x_item',
    from: 'x_itemid',
    to: 'x_itemid',
    many: true,
    schemaName: 'x_item_peers',
    partner,
    intersect: { entity: 'x_item_peers', from, to },
  },
});
const apiId = '40000000-0000-0000-0000-0000000000c1';
const step = (n, message, stage, extra = {}) => ({
  id: `30000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`,
  name: `Invented ${message} ${stage}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Recorder',
  assemblyId: 'invented',
  ...extra,
});

async function fixture(t, steps) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_code: { dataverseType: 'nvarchar' } },
        alternateKeys: [{ name: 'x_code_key', attributes: ['x_code'] }],
        relationships: {
          ...peers('x_itemidone', 'x_itemidtwo', 'x_item_peers', 'x_item_peers_referenced'),
          ...peers('x_itemidtwo', 'x_itemidone', 'x_item_peers_referenced', 'x_item_peers'),
        },
      },
      x_item_peers: {
        logicalName: 'x_item_peers',
        entitySet: 'x_item_peersset',
        idColumn: 'x_item_peersid',
        fields: {
          x_itemidone: { dataverseType: 'lookup', targets: ['x_item'] },
          x_itemidtwo: { dataverseType: 'lookup', targets: ['x_item'] },
        },
      },
    },
    tables: {
      x_item: [
        { x_itemid: row, x_name: 'First', x_code: 'first' },
        { x_itemid: peer, x_name: 'Peer', x_code: 'peer' },
      ],
      x_item_peers: [],
      customapi: [
        {
          customapiid: apiId,
          uniquename: 'x_Bound',
          bindingtype: 1,
          boundentitylogicalname: 'x_item',
          isfunction: false,
          allowedcustomprocessingsteptype: 2,
        },
      ],
      customapirequestparameter: [
        { customapirequestparameterid: apiId, customapiid: apiId, uniquename: 'Text', type: 10, isoptional: true },
      ],
      customapiresponseproperty: [],
    },
    extension: {
      name: 'customapi',
      install: (api) =>
        installCustomApis(
          { ...api, change: (fn) => fn() },
          { handlers: new Map([['x_bound', { handler: () => ({}) }]]) },
        ).ready,
    },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Recorder',
      ({ context }) => {
        seen.push({
          at: `${context.MessageName}/${context.Stage}`,
          inputs: structuredClone(context.InputParameters),
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen, backend };
}

test('a bound custom API loads its target without running the Retrieve pipeline', async (t) => {
  const customApi = { name: 'x_Bound', bindingType: 1, allowedCustomProcessingStepType: 2 };
  const f = await fixture(t, [
    step(1, 'Retrieve', 10),
    step(2, 'Retrieve', 20),
    step(3, 'Retrieve', 40),
    step(4, 'x_Bound', 20, { customApi }),
  ]);
  const answer = await f.request('POST', `/x_items(${row})/Microsoft.Dynamics.CRM.x_Bound`, { Text: 'hello' });
  assert(answer.status < 300, await answer.text());
  assert.deepEqual(
    f.seen.map((entry) => entry.at),
    ['x_Bound/20'],
  );
});

const roles = (seen) =>
  seen.map(
    (entry) =>
      `${entry.at}:${entry.inputs.Relationship?.PrimaryEntityRole ?? entry.inputs.Relationship?.primaryEntityRole ?? null}`,
  );

test('a self-referencing N:N $ref through the relationship-named navigation passes PrimaryEntityRole Referencing', async (t) => {
  const f = await fixture(t, [
    step(5, 'Associate', 20, { entity: null, unfiltered: true }),
    step(6, 'Disassociate', 20, { entity: null, unfiltered: true }),
  ]);
  const base = new URL(f.server.origin + '/api/data/v9.2/').href;
  const added = await f.request('POST', `/x_items(${row})/x_item_peers/$ref`, {
    '@odata.id': `${base}x_items(${peer})`,
  });
  assert(added.status < 300, await added.text());
  const removed = await f.request('DELETE', `/x_items(${row})/x_item_peers(${peer})/$ref`);
  assert(removed.status < 300, await removed.text());
  assert.deepEqual(roles(f.seen), ['Associate/20:Referencing', 'Disassociate/20:Referencing']);
});

// @test-kind unproven: the partner (Entity2) navigation of a self-referencing N:N has no native capture; Referenced is the local model
test('a self-referencing N:N $ref through the partner navigation passes PrimaryEntityRole Referenced', async (t) => {
  const f = await fixture(t, [step(5, 'Associate', 20, { entity: null, unfiltered: true })]);
  const base = new URL(f.server.origin + '/api/data/v9.2/').href;
  const added = await f.request('POST', `/x_items(${row})/x_item_peers_referenced/$ref`, {
    '@odata.id': `${base}x_items(${peer})`,
  });
  assert(added.status < 300, await added.text());
  assert.deepEqual(roles(f.seen), ['Associate/20:Referenced']);
});

// A Delete addressed by an alternate key (DELETE <set>(<key>='<value>')): its PreValidation Target and the main
// operation's Target name the key; PreOperation and PostOperation Targets do not (recorded native upsert).
test('a Delete by alternate key names the key in its PreValidation and main-operation Targets only', async (t) => {
  const f = await fixture(t, []);
  const caller = '10000000-0000-0000-0000-0000000000c9';
  const runtime = {
    descriptor: {
      context: { executionUserId: caller, initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
      serviceProfile: { userId: caller, evidence: 'Invented alternate-key Delete', grants: [] },
    },
  };
  const record = f.store.tableRows('x_item')[0];
  const keyed = { x_code: 'first' };
  const contextAt = (stage, frame) =>
    clrContext({
      runtime,
      store: f.store,
      step: { id: '30000000-0000-0000-0000-0000000000c9', name: 'Invented Delete', images: [], contract: { mode: 0 } },
      entity: 'x_item',
      operation: 'delete',
      stage,
      target: { x_itemid: row },
      record,
      previous: { ...record },
      frame,
      depth: 1,
    });
  const phase = (stage) =>
    runPluginPhase({
      items: [],
      handlers: new Map(),
      store: f.store,
      entity: 'x_item',
      operation: 'delete',
      stage,
      target: { x_itemid: row },
      record,
      previous: { ...record },
      identity: {},
      targetKeyAttributes: keyed,
    });
  const preValidation = contextAt(10, phase(10));
  assert.deepEqual(preValidation.inputParameters.values.Target.keyAttributes, keyed);
  const preOperation = contextAt(20, phase(20));
  assert.equal(preOperation.inputParameters.values.Target.keyAttributes, undefined);
  assert.deepEqual(preOperation.context.ParentContext.values.InputParameters.values.Target.keyAttributes, keyed);
});
