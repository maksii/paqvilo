// @test-kind compatibility: Learn bypass custom logic: CustomSync/CustomAsync map to sync/async lanes and leave Microsoft/system logic running
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { workflowExtension, workflowHandlers } from '../lib/dataverse-workflows.mjs';
import { settleCommittedWork } from '../lib/committed-work.mjs';

async function fixture(t, facts) {
  const seen = [];
  facts ??= [0, 1].map((mode) => ({
    id: `70000000-0000-0000-0000-00000000000${mode}`,
    name: `Invented workflow ${mode}`,
    uniquename: `InventedWorkflow${mode}`,
    category: 0,
    type: 1,
    mode,
    scope: 4,
    state: 1,
    ondemand: false,
    primaryentity: 'x_item',
    triggeroncreate: true,
    xaml: '<Activity />',
  }));
  const handlers = workflowHandlers([
    {
      id: 'invented-workflows',
      workflows: Object.fromEntries(
        facts.map((fact) => [
          fact.uniquename,
          async () => {
            seen.push(fact.marker ?? fact.mode);
            return { message: 'Invented completion' };
          },
        ]),
      ),
    },
  ]);
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    extension: workflowExtension({ facts, handlers }),
  });
  return { ...f, seen };
}

test('CustomSync and CustomAsync bypass the corresponding classic workflow lanes independently', async (t) => {
  const { seen, ...f } = await fixture(t);
  for (const [header, expected] of [
    [null, [0, 1]],
    ['CustomAsync', [1]],
    ['CustomSync', [0]],
    ['CustomSync,CustomAsync', []],
  ]) {
    seen.length = 0;
    const response = await f.request(
      'POST',
      '/x_items',
      { x_name: header ?? 'Ordinary' },
      header ? { 'MSCRM.BypassBusinessLogicExecution': header } : {},
    );
    assert.equal(response.status, 201, await response.text());
    await settleCommittedWork(f.store, []);
    assert.deepEqual([...seen].sort(), expected, header ?? 'ordinary');
  }
});

test('global bypass retains source-system and evidenced Microsoft workflows in both trigger lanes', async (t) => {
  const facts = [0, 1].flatMap((mode) =>
    ['custom', 'system', 'microsoft'].map((kind, index) => ({
      id: `70000000-0000-0000-0000-0000000000${mode}${index}`,
      name: `${kind} ${mode}`,
      uniquename: `Invented_${kind}_${mode}`,
      marker: `${kind}-${mode}`,
      category: 0,
      type: 1,
      mode,
      scope: 4,
      state: 1,
      ondemand: false,
      primaryentity: 'x_item',
      triggeroncreate: true,
      xaml: '<Activity />',
      ...(kind === 'system' ? { customizationLevel: 0 } : {}),
      ...(kind === 'custom' ? { bypassOwnership: { kind, evidence: 'Invented source ownership witness' } } : {}),
    })),
  );
  const f = await fixture(t, facts);
  f.store.observed = {
    ...f.store.observed,
    businessLogicOwnership: Object.fromEntries(
      facts
        .filter((fact) => !fact.bypassOwnership)
        .map((fact) => [
          fact.id,
          { kind: fact.marker.split('-')[0], evidence: 'Invented project workflow ownership observation' },
        ]),
    ),
  };
  const response = await f.request(
    'POST',
    '/x_items',
    { x_name: 'Protected workflow lanes' },
    { 'MSCRM.BypassBusinessLogicExecution': 'CustomSync,CustomAsync' },
  );
  assert.equal(response.status, 201, await response.text());
  await settleCommittedWork(f.store, []);
  assert.deepEqual([...f.seen].sort(), ['microsoft-0', 'microsoft-1', 'system-0', 'system-1']);
});
