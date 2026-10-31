// @test-kind compatibility: Microsoft Learn bypass custom business logic (CustomSync, CustomAsync, step ids) applied to the Update a 1:N associate implies
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const id = (n) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const controls = {
  none: {},
  sync: { bypassCustomPlugins: true },
  async: { bypassCustomAsync: true },
  both: { bypassCustomPlugins: true, bypassCustomAsync: true },
  selective: { bypassStepIds: [id(10), id(13)] },
};
const schema = () => ({
  owner: {
    entitySet: 'owners',
    idColumn: 'ownerid',
    relationships: {
      members: {
        schemaName: 'owner_member',
        entity: 'member',
        from: 'ownerid',
        to: 'ownerref',
        many: true,
        partner: 'owner',
      },
    },
  },
  member: {
    entitySet: 'members',
    idColumn: 'memberid',
    relationships: {
      owner: {
        schemaName: 'owner_member',
        entity: 'owner',
        from: 'ownerref',
        to: 'ownerid',
        many: false,
        partner: 'members',
      },
    },
  },
});
const policyHeaders = ({ bypassCustomPlugins, bypassCustomAsync, bypassStepIds }) => ({
  ...(bypassCustomPlugins || bypassCustomAsync
    ? {
        'MSCRM.BypassBusinessLogicExecution': [bypassCustomPlugins && 'CustomSync', bypassCustomAsync && 'CustomAsync']
          .filter(Boolean)
          .join(','),
      }
    : {}),
  ...(bypassStepIds ? { 'MSCRM.BypassBusinessLogicExecutionStepIds': bypassStepIds.join(',') } : {}),
});

async function attach(t, store) {
  const seen = [];
  const steps = [
    [10, 'First', 0, false],
    [11, 'Second', 0, false],
    [12, 'Protected', 0, true],
    [13, 'Deferred', 1, false],
    [14, 'ProtectedDeferred', 1, true],
  ].map(([key, label, mode, protectedStep]) => ({
    id: id(key),
    entity: 'member',
    message: 'Update',
    enabled: true,
    typeName: 'Invented.' + label,
    assemblyId: 'invented',
    stage: mode ? 40 : 20,
    mode,
    rank: key,
    supportedDeployment: 0,
    images: [],
    filteringAttributes: [],
    ...(protectedStep
      ? { bypassOwnership: { kind: 'system', evidence: 'Invented protected source registration' } }
      : {}),
  }));
  const handlers = new Map(
    steps.map((step) => [
      step.typeName,
      () => {
        seen.push(step.typeName);
      },
    ]),
  );
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store, items: () => items, handlers });
  t.after(() => backend.close());
  return { seen, backend };
}

for (const drive of [
  'raw-sync',
  'raw-async',
  'sdk-sync',
  'sdk-async',
  'organization-sdk-sync',
  'organization-sdk-async',
  'http',
])
  for (const associate of [true, false])
    for (const [policy, options] of Object.entries(controls))
      test(`${drive} ${associate ? 'Associate' : 'Disassociate'} forwards ${policy} controls to the implicit Update only`, async (t) => {
        const mappings = schema(),
          tables = { owner: [{ ownerid: id(1) }], member: [{ memberid: id(2), ownerref: associate ? null : id(1) }] };
        let store, f;
        if (drive.startsWith('organization') || drive === 'http') {
          f = await contractModuleFixture(t, {
            mappings,
            tables,
            extension: { name: 'association-policy', install() {} },
          });
          store = f.store;
        } else {
          const state = emptyState();
          Object.assign(state.mappings, mappings);
          Object.assign(state.tables, tables);
          store = new DataStore({ state });
          t.after(() => store.close());
        }
        const { seen, backend } = await attach(t, store);
        if (drive.startsWith('raw')) {
          const operation = drive.endsWith('async') ? 'changeAssociationRecordAsync' : 'changeAssociationRecord';
          await store.transact(() =>
            store[operation]('owner', id(1), 'members', id(2), { admin: true }, associate, options),
          );
        } else if (drive === 'http') {
          const path = `/owners(${id(1)})/members${associate ? '' : '(' + id(2) + ')'}/$ref`;
          await f.json(
            await f.request(
              associate ? 'POST' : 'DELETE',
              path,
              associate ? { '@odata.id': `${f.server.origin}/api/data/v9.2/members(${id(2)})` } : undefined,
              policyHeaders(options),
            ),
            204,
          );
        } else {
          const service = localOrganizationService(
            store,
            {
              userId: id(1),
              evidence: 'Invented association policy',
              grants: [
                { entity: 'owner', operations: ['associate', 'disassociate'] },
                { entity: 'member', operations: ['associate', 'disassociate', 'update'] },
              ],
            },
            undefined,
            { requestOptions: options },
          );
          const relationship = { $type: 'Relationship', schemaName: 'owner_member' };
          const related = {
            $type: 'EntityReferenceCollection',
            values: [{ $type: 'EntityReference', logicalName: 'member', id: id(2) }],
          };
          await store.transact(() =>
            drive.endsWith('async')
              ? service[associate ? 'associateAsync' : 'disassociateAsync']('owner', id(1), relationship, related)
              : service.associate('owner', id(1), relationship, related, associate),
          );
        }
        await backend.settle();
        const expected = ['Protected', 'ProtectedDeferred'];
        if (!options.bypassCustomPlugins) {
          if (!options.bypassStepIds?.includes(id(10))) expected.push('First');
          expected.push('Second');
        }
        if (!options.bypassCustomAsync && !options.bypassStepIds?.includes(id(13))) expected.push('Deferred');
        assert.deepEqual(seen.sort(), expected.map((value) => 'Invented.' + value).sort());
        assert.equal(store.tableRows('member')[0].ownerref, associate ? id(1) : null);
      });

test('Create collection binding carries bypass controls without reusing its consumed parent authorization capability', async (t) => {
  const state = emptyState();
  Object.assign(state.mappings, schema());
  Object.assign(state.tables, { owner: [], member: [{ memberid: id(2), ownerref: null }] });
  const store = new DataStore({ state });
  t.after(() => store.close());
  const { seen, backend } = await attach(t, store);
  const checked = [];
  await store.create(
    'owner',
    { ownerid: id(1), 'members@odata.bind': [`/members(${id(2)})`] },
    { admin: true },
    {
      bypassCustomPlugins: true,
      bypassCustomAsync: true,
      authorizeEffectiveWrite(entity, operation) {
        assert.deepEqual([entity, operation], ['owner', 'create']);
        checked.push(entity);
        assert.equal(checked.length, 1);
      },
    },
  );
  await backend.settle();
  assert.deepEqual(checked, ['owner']);
  assert.deepEqual(seen.sort(), ['Invented.Protected', 'Invented.ProtectedDeferred']);
  assert.equal(store.tableRows('member')[0].ownerref, id(1));
});
