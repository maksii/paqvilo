// @test-kind contract: generic write observers resolve unchanged whole metadata a bounded number of times, retaining fresh metadata and rollback.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';
import { portalRecordWrites } from '../lib/form-service.mjs';

test('a write scans component metadata independently of unrelated table count and sees later structured edits', async (t) => {
  const state = emptyState();
  for (let i = 0; i < 64; i++) {
    state.mappings['x_table' + i] = {
      entitySet: `x_table${i}s`,
      idColumn: `x_table${i}id`,
      fields: { x_name: { dataverseType: 'nvarchar' } },
    };
    state.tables['x_table' + i] = [];
  }
  state.tables.systemform = Array.from({ length: 32 }, (_, i) => ({
    formid: 'f' + i,
    settings: { marker: 'scan-probe', label: 'First' },
  }));
  state.dataverse = { sourceSolutionComponents: { baseline: { 'systemform/f0': {} } } };
  const store = new DataStore({ state }),
    overlay = createSolutionMetadataOverlay();
  const base = {
    entities: {},
    forms: state.tables.systemform.map((row) => ({ id: row.formid, entity: 'x_table0', xml: '<form/>' })),
  };
  const metadata = () => overlay(base, store.state);
  const core = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({ enabled: false }),
    metadataFields: (logical) => metadata().entities?.[logical]?.fields,
    metadataSnapshot: () => metadata().entities,
  });
  ownedFixture(t).add(() => core.close());
  let scans = 0;
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value?.marker === 'scan-probe') scans++;
    return stringify(value, ...args);
  });
  const create = () =>
    core.runOwned(() =>
      core.runAtomic(() =>
        portalRecordWrites(store).create('x_table0', { x_name: 'Invented operation' }, { admin: true }),
      ),
    );
  const created = await create();
  assert.ok(scans <= 32 * 20, `${scans} component stamps for 64 tables`);
  const bounded = scans,
    snapshot = core.api.metadataSnapshot;
  core.api.metadataSnapshot = undefined;
  scans = 0;
  await create();
  assert.ok(scans > bounded * 2, 'The legacy per-table path reproduces redundant whole-metadata work.');
  core.api.metadataSnapshot = snapshot;
  assert.ok(created.x_table0id);
  await store.transact(() => {
    store.state.tables.systemform[0].settings.label = 'Changed';
  });
  const before = metadata();
  await store.transact(() => {
    store.state.tables.systemform[0].settings.label = 'Changed again';
  });
  await create();
  assert.notEqual(metadata(), before);
  const count = store.tableRows('x_table0').length;
  await assert.rejects(
    core.runOwned(() =>
      core.runAtomic(async () => {
        await portalRecordWrites(store).create('x_table0', { x_name: 'Rollback' }, { admin: true });
        throw new Error('Rollback');
      }),
    ),
    /Rollback/,
  );
  assert.equal(store.tableRows('x_table0').length, count);
});
