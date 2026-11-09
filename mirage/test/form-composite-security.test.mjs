// @test-kind contract+security: address editor presentation cannot relax immutable-column writes or admit fields outside the declared form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';

test('computed address trigger is read-only while source-disabled state governs its editor and backend immutability remains enforced', async () => {
  const id = 'aaaaaaaa-1111-4111-8111-111111111111';
  const store = await new DataStore({
    state: {
      mappings: { x_sample: { entitySet: 'x_samples', idColumn: 'x_sampleid', inferred: false } },
      tables: { x_sample: [{ x_sampleid: id, home_composite: 'Stored address' }] },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const field = {
    name: 'home_composite',
    label: 'Invented address',
    type: 'textarea',
    dataverseType: 'memo',
    validForCreate: false,
    validForUpdate: false,
  };
  const portal = {
    forms: [{ id: 'create', name: 'Invented', mode: 100000000, metadata: { adx_entityname: 'x_sample' } }],
    records: [],
    website: { id: 'invented-site' },
    pages: [],
  };
  const schemas = {
    create: {
      entity: 'x_sample',
      fields: [field],
      layout: [{ name: 'main', columns: [{ sections: [{ name: 'details', rows: [[{ name: 'home_composite' }]] }] }] }],
    },
  };
  const render = () => renderComponent('entityform', 'create', {}, { portal, store, schemas });
  const editable = await render();
  assert.match(editable, /<textarea[^>]*id="home_composite"[^>]*data-editable="True"[^>]*readonly="readonly"/);
  assert.match(editable, /<input[^>]*id="home_composite_city"[^>]*onchange="setIsDirty\(this\.id\);">/);
  field.readOnly = true;
  const disabled = await render();
  assert.match(disabled, /<textarea[^>]*id="home_composite"[^>]*data-editable="False"[^>]*readonly="readonly"/);
  assert.match(disabled, /<input[^>]*id="home_composite_city"[^>]*readonly="readonly"/);
  field.readOnly = false;
  const before = store.snapshot();
  await assert.rejects(
    submitPortalForm('entityform', 'create', { values: { home_composite: 'Tampered' } }, { portal, schemas, store }),
    (error) => error.code === 'FormFieldReadOnly',
  );
  await assert.rejects(
    submitPortalForm('entityform', 'create', { values: { x_unbound: 'Tampered' } }, { portal, schemas, store }),
    (error) => error.code === 'FormFieldNotBound' && error.status === 403,
  );
  assert.deepEqual(store.snapshot(), before);
});
