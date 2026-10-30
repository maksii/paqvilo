// @test-kind contract: Paqvilo capability inventory classifies bulk message availability by evidence source and reports the unqualified diagnostic
import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkMessageAvailabilityRecord } from '../lib/bulk-message-availability.mjs';
import { createCapabilityRegistry } from '../lib/capability-registry.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { composeOrganizationHost } from '../lib/organization-host.mjs';

test('bulk availability inventory distinguishes exported filter evidence, project assertions and synthetic local support', () => {
  const store = {
    state: {
      mappings: { x_one: {}, x_two: {}, x_elastic: { tableType: 'Elastic' } },
      tables: {
        sdkmessagefilter: [{ primaryobjecttypecode: 'x_two', sdkmessagefilterid: 'invented-synthetic-filter' }],
      },
    },
  };
  const plugins = {
    steps: [
      { entity: 'x_one', message: 'CreateMultiple', messageFilterId: 'imported-native-filter' },
      { entity: 'x_two', message: 'UpdateMultiple', messageFilterId: null },
    ],
  };
  const profiles = [
    {
      bulkTables: [
        {
          entity: 'x_one',
          tableType: 'standard',
          evidence: 'Invented captured availability metadata',
          messages: ['UpdateMultiple'],
        },
        { entity: 'x_two', tableType: 'standard', evidence: '', messages: ['CreateMultiple'] },
      ],
    },
  ];
  const record = bulkMessageAvailabilityRecord({ store, plugins, profiles });
  assert.equal(record.level, 'contract');
  assert.equal(record.seams.diagnostic, 'BULK_MESSAGE_AVAILABILITY_UNQUALIFIED');
  assert.equal(record.seams.availability.qualified, 2);
  assert.equal(record.seams.availability.unqualified, 2);
  assert.deepEqual(
    record.seams.availability.tables.map((table) => [table.entity, ...table.messages.map((message) => message.source)]),
    [
      ['x_one', 'solution-registration-filter', 'evidenced-service-profile'],
      ['x_two', 'synthetic-local-support', 'synthetic-local-support'],
    ],
  );
  const registry = createCapabilityRegistry();
  registry.add(record);
  assert.equal(registry.list()[0].seams.diagnostic, 'BULK_MESSAGE_AVAILABILITY_UNQUALIFIED');
});

test('the existing host capability inventory reports unqualified table/message availability', async (t) => {
  const state = emptyState();
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
  state.tables.x_item = [];
  const store = await new DataStore({ state }).init();
  const host = await composeOrganizationHost({
    store,
    sources: { plugins: () => ({ assemblies: [], types: [], steps: [] }), workflows: () => [], layers: () => [] },
  });
  t.after(() => host.close());
  const record = host
    .capabilities()
    .list()
    .find((item) => item.name === 'dataverse-standard-bulk-availability');
  assert.equal(record.level, 'contract');
  assert.equal(record.seams.diagnostic, 'BULK_MESSAGE_AVAILABILITY_UNQUALIFIED');
  assert.equal(
    record.seams.availability.tables.find((table) => table.entity === 'x_item').messages[0].availability,
    'unqualified',
  );
});

test('captured filter availability qualifies inventory without mistaking generic generated filter rows for evidence', () => {
  const record = bulkMessageAvailabilityRecord({
    store: { state: { mappings: { x_item: {} } } },
    plugins: {
      messages: [
        { id: 'invented-source-message', name: 'CreateMultiple', availability: 2, filterAvailability: { x_item: 0 } },
      ],
    },
  });
  const [create, update] = record.seams.availability.tables[0].messages;
  assert.equal(create.source, 'observed-message-filter');
  assert.equal(create.availability, 'qualified-metadata');
  assert.equal(update.availability, 'unqualified');
});
