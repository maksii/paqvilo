import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { DataStore } from '../lib/data.mjs';

test('native saved numeric controls retain exported display precision without changing data', async () => {
  const record = {
    sampleid: '10000000-0000-4000-8000-000000000001',
    amount: 12.5,
    ratio: 99.5,
    estimate: 12.5,
    count: 12,
    unspecified: 12.5,
  };
  const fields = [
    { name: 'amount', dataverseType: 'money', precision: 2 },
    { name: 'ratio', dataverseType: 'decimal', precision: 3 },
    { name: 'estimate', dataverseType: 'float', precision: 4 },
    { name: 'count', dataverseType: 'int', precision: 2 },
    { name: 'unspecified', dataverseType: 'decimal' },
  ];
  const before = structuredClone(record);
  const html = await renderComponent(
    'entityform',
    'edit',
    { request: { params: { id: record.sampleid } } },
    {
      portal: {
        forms: [{ id: 'edit', name: 'Edit sample', mode: 100000001 }],
        records: [],
        pages: [],
        website: { id: 'site' },
      },
      schemas: { edit: { entity: 'sample', fields } },
      store: {
        resolveMapping: () => ({ entitySet: 'samples', idColumn: 'sampleid' }),
        get: () => record,
        query: () => ({ value: [] }),
      },
    },
  );
  for (const [field, value] of [
    ['amount', '12.50'],
    ['ratio', '99.500'],
    ['estimate', '12.5000'],
    ['count', '12'],
    ['unspecified', '12.5'],
  ])
    // The platform renders the value before the id.
    assert.match(html, new RegExp(`<input [^>]*value="${value.replace('.', '\\.')}"[^>]*id="${field}"`));
  assert.deepEqual(record, before);
});

test('native choice event validation rejects forged options before creating a record', async () => {
  const store = await new DataStore({
    state: {
      mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid' } },
      tables: { sample: [] },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const options = {
    portal: { forms: [{ id: 'create', name: 'Create sample', mode: 100000000 }], records: [], pages: [] },
    schemas: {
      create: {
        entity: 'sample',
        fields: [
          {
            name: 'kind',
            type: 'number',
            dataverseType: 'picklist',
            options: [
              { value: 1, label: 'First' },
              { value: 2, label: 'Second' },
            ],
          },
        ],
      },
    },
    store,
    identity: {},
  };
  await assert.rejects(
    submitPortalForm('entityform', 'create', { values: { kind: 999 } }, options),
    (error) => error.code === 'FormEventValidationInvalid' && error.status === 500,
  );
  assert.equal(store.snapshot().tables.sample.length, 0);
  await submitPortalForm('entityform', 'create', { values: { kind: 2 } }, options);
  assert.equal(store.snapshot().tables.sample[0].kind, 2);
});
