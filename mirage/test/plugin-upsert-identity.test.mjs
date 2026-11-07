// @test-kind parity: native recorder parity corpus crud (a bare Web API PATCH): the Upsert's existence RetrieveMultiple and its Update share one RequestId, OperationId and CorrelationId
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';

const id = '20000000-0000-0000-0000-000000000001';
const step = (message, stage, n) => ({
  id: `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Identity',
  assemblyId: 'invented',
});

test('a Web API PATCH upsert runs its existence read and its write under one request identity', async (t) => {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [{ x_itemid: id, x_name: 'Existing' }] },
    extension: { name: 'upsert-identity-probe', install: () => {} },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Identity',
      ({ context }) => {
        seen.push([context.MessageName, context.Stage, context.RequestId, context.OperationId, context.CorrelationId]);
      },
    ],
  ]);
  const steps = [step('RetrieveMultiple', 20, 1), step('Update', 10, 2), step('Update', 40, 3)];
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  assert.equal((await f.request('PATCH', `/x_items(${id})`, { x_name: 'Upserted' })).status < 300, true);
  assert.deepEqual(
    seen.map(([message, stage]) => `${message}/${stage}`),
    ['RetrieveMultiple/20', 'Update/10', 'Update/40'],
  );
  for (const index of [2, 3, 4]) assert.equal(new Set(seen.map((entry) => entry[index])).size, 1, String(index));
  assert.equal(seen[0][2], seen[0][3]);
  // A second request has its own identity.
  assert.equal((await f.request('PATCH', `/x_items(${id})`, { x_name: 'Again' })).status < 300, true);
  assert.notEqual(seen[3][2], seen[0][2]);
  assert.notEqual(seen[3][4], seen[0][4]);
});
