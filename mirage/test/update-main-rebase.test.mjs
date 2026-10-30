import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';

const id = '20000000-0000-0000-0000-000000000001';
const sibling = '20000000-0000-0000-0000-000000000002';
const user = '10000000-0000-0000-0000-000000000001';
async function fixture(t, handler, { message = 'Update', fields = {}, rows } = {}) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_keep: { dataverseType: 'nvarchar' }, ...fields },
      },
    },
    tables: { x_item: rows ?? [{ x_itemid: id, x_name: 'Before', x_keep: 'Original' }] },
    extension: { name: 'update-rebase-probe', install: () => {} },
  });
  const step = {
    id: '30000000-0000-0000-0000-000000000001',
    enabled: true,
    entity: 'x_item',
    message,
    stage: 20,
    rank: 1,
    mode: 0,
    supportedDeployment: 0,
    filteringAttributes: ['x_name'],
    images: [],
    typeName: 'Invented.Rebase',
    assemblyId: 'invented',
  };
  const service = localOrganizationService(f.store, {
    userId: user,
    evidence: 'Invented nested write profile',
    grants: [{ entity: 'x_item', operations: ['read', 'update', 'delete'] }],
  });
  const handlers = new Map([[step.id, (context) => handler({ ...context, service, store: f.store })]]);
  const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, service };
}

test('main Update preserves nested SDK changes to untouched fields while explicit Target values still win', async (t) => {
  for (const message of ['Update', 'UpdateMultiple'])
    for (const bulk of [false, true])
      for (const explicit of [false, true])
        await t.test(`${message}/${bulk ? 'bulk' : 'single'}/${explicit ? 'explicit' : 'untouched'}`, async (t) => {
          const f = await fixture(
            t,
            ({ service }) => {
              service.update('x_item', id, { x_keep: 'Nested SDK value' });
            },
            { message },
          );
          const target = { x_name: 'Outer', ...(explicit ? { x_keep: 'Original' } : {}) };
          const response = bulk
            ? await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpdateMultiple', {
                Targets: [{ x_itemid: id, ...target }],
              })
            : await f.request('PATCH', `/x_items(${id})`, target);
          assert(response.status < 300, await response.text());
          assert.equal(f.store.tableRows('x_item')[0].x_name, 'Outer');
          assert.equal(f.store.tableRows('x_item')[0].x_keep, explicit ? 'Original' : 'Nested SDK value');
        });
});

test('a pre-operation SDK delete of the update target cannot overwrite the following sibling or recreate the deleted target', async (t) => {
  const rows = [
    { x_itemid: id, x_name: 'Before', x_keep: 'Original' },
    { x_itemid: sibling, x_name: 'Sibling', x_keep: 'Sibling keep' },
  ];
  const f = await fixture(
    t,
    ({ service }) => {
      service.remove('x_item', id);
    },
    { rows },
  );
  const response = await f.request('PATCH', `/x_items(${id})`, { x_name: 'Outer' });
  assert(response.status >= 400, 'the target disappeared before the main write');
  assert.deepEqual(
    f.store.tableRows('x_item').map((row) => [row.x_itemid, row.x_name, row.x_keep]),
    rows.map((row) => [row.x_itemid, row.x_name, row.x_keep]),
  );
});

test('the final update version advances after its nested write and declarative rules observe the rebased row', async (t) => {
  let nestedVersion;
  const f = await fixture(
    t,
    ({ service, store }) => {
      service.update('x_item', id, { x_keep: 'Nested SDK value' });
      nestedVersion = store.tableRows('x_item')[0].versionnumber;
    },
    { fields: { x_derived: { dataverseType: 'nvarchar' } } },
  );
  f.store.state.plugins.push({
    entity: 'x_item',
    operations: ['update'],
    when: "x_name eq 'Outer'",
    set: { x_derived: '$record.x_keep' },
  });
  const response = await f.request('PATCH', `/x_items(${id})`, { x_name: 'Outer' });
  assert(response.status < 300, await response.text());
  const row = f.store.tableRows('x_item')[0];
  assert.equal(row.x_derived, 'Nested SDK value');
  assert(
    Number(row.versionnumber) > Number(nestedVersion),
    "a later main write must not restore the nested write's earlier row version",
  );
  assert(row.modifiedby && row.modifiedon, 'system audit stamps survive rebasing');
});

test('a pre-operation SDK delete before the target re-resolves its identity instead of its old array index', async (t) => {
  const rows = [
    { x_itemid: sibling, x_name: 'Sibling', x_keep: 'Sibling keep' },
    { x_itemid: id, x_name: 'Before', x_keep: 'Original' },
  ];
  const f = await fixture(
    t,
    ({ service }) => {
      service.remove('x_item', sibling);
    },
    { rows },
  );
  const response = await f.request('PATCH', `/x_items(${id})`, { x_name: 'Outer' });
  assert(response.status < 300, await response.text());
  assert.equal(f.store.tableRows('x_item').length, 1);
  assert.equal(f.store.tableRows('x_item')[0].x_itemid, id);
  assert.equal(f.store.tableRows('x_item')[0].x_name, 'Outer');
});
