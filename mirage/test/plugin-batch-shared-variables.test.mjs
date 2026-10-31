// @test-kind parity: native recorder corpus batch (two captures): changeset contexts start SharedVariables with IsODataTransaction true and ODataChangesetRequestCount (2 for POST+PATCH, 1 for one PATCH); the non-changeset part has neither
// Invented x_item rows in a JSON $batch: each changeset member's plug-in contexts start with the batch's transaction facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';

const existing = '10000000-0000-4000-8000-000000000001',
  second = '10000000-0000-4000-8000-000000000002';
const step = (n, message, stage, mode = 0) => ({
  id: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Batch',
  assemblyId: 'invented',
});
const steps = [
  step(1, 'Create', 10),
  step(2, 'Create', 20),
  step(3, 'Create', 40),
  step(4, 'Update', 10),
  step(5, 'Update', 20),
  step(6, 'Update', 40),
  step(7, 'Update', 40, 1),
];

async function batchFixture(t) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: {
      x_item: [
        { x_itemid: existing, x_name: 'Existing' },
        { x_itemid: second, x_name: 'Second' },
      ],
    },
    extension: { name: 'batch-shared-variables-probe', install: () => {} },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Batch',
      ({ context }) => {
        seen.push({
          at: `${context.MessageName}/${context.Stage}`,
          mode: context.Mode,
          shared: { ...context.SharedVariables },
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen, backend };
}

// The transaction facts a context starts with: the changeset's request count, or plain for a request outside a changeset.
const transaction = (entry) =>
  entry.shared.IsODataTransaction === true ? `changeset:${entry.shared.ODataChangesetRequestCount}` : 'plain';

test('a $batch changeset starts each member context with its transaction facts, a request outside a changeset has neither', async (t) => {
  const f = await batchFixture(t);
  const base = '/api/data/v9.2/x_items';
  const json = { 'content-type': 'application/json' };
  const response = await f.request('POST', '/$batch', {
    requests: [
      { id: 'a1', method: 'POST', url: base, headers: json, body: { x_name: 'Created' }, atomicityGroup: 'a' },
      {
        id: 'a2',
        method: 'PATCH',
        url: `${base}(${existing})`,
        headers: json,
        body: { x_name: 'Updated' },
        atomicityGroup: 'a',
      },
      {
        id: 'b1',
        method: 'PATCH',
        url: `${base}(${second})`,
        headers: json,
        body: { x_name: 'Second updated' },
        atomicityGroup: 'b',
      },
      { id: 'p1', method: 'POST', url: base, headers: json, body: { x_name: 'Plain' } },
    ],
  });
  assert.equal(response.status, 200, await response.text());
  await f.backend.settle();
  const synchronous = f.seen.filter((entry) => entry.mode === 0);
  assert.deepEqual(
    synchronous.map((entry) => `${entry.at}:${transaction(entry)}`),
    [
      'Create/10:changeset:2',
      'Create/20:changeset:2',
      'Create/40:changeset:2',
      'Update/10:changeset:2',
      'Update/20:changeset:2',
      'Update/40:changeset:2',
      'Update/10:changeset:1',
      'Update/20:changeset:1',
      'Update/40:changeset:1',
      'Create/10:plain',
      'Create/20:plain',
      'Create/40:plain',
    ],
  );
  // The asynchronous Update jobs of both changesets copy their synchronous collection.
  assert.deepEqual(
    f.seen.filter((entry) => entry.mode === 1).map((entry) => `${entry.at}:${transaction(entry)}`),
    ['Update/40:changeset:2', 'Update/40:changeset:1'],
  );
  for (const entry of f.seen.filter((item) => transaction(item) !== 'plain'))
    assert.deepEqual(Object.keys(entry.shared).slice(0, 2), ['IsODataTransaction', 'ODataChangesetRequestCount']);
  for (const entry of f.seen.filter((item) => transaction(item) === 'plain'))
    assert.equal(Object.hasOwn(entry.shared, 'ODataChangesetRequestCount'), false);
});
