// @test-kind contract: Mirage diagnostic context for absent and unmapped form layouts using invented solution records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySolutionMetadata } from '../lib/solution-metadata.mjs';
import { approximateAdvancedFormSchema, approximateFormSchema } from '../lib/form-schema-fallback.mjs';

const systemForm = {
  id: 'selected-main',
  entity: 'sample',
  name: 'Main',
  active: true,
  systemFormType: 2,
  xml: '<form><tabs/></form>',
};
const metadata = {
  entities: {
    sample: { primaryNameAttribute: 'title', fields: { title: { dataverseType: 'nvarchar' } } },
  },
  forms: [systemForm],
  views: [],
  diagnostics: [],
};

test('missing basic form reports its requested systemform ID even when a same-named form exists', () => {
  const definition = {
    id: 'basic',
    name: 'Sample form',
    entityName: 'sample',
    formName: 'Main',
    metadata: { adx_formid: '{MISSING-MAIN}' },
  };
  const portal = { forms: [definition], lists: [], records: [] };
  const built = applySolutionMetadata(portal, metadata);
  assert.equal(built.componentSchemas.basic, undefined);
  assert.ok(built.diagnostics.some(({ code, id }) => code === 'SYSTEMFORM_UNRESOLVED' && id === 'basic'));

  const diagnostics = [];
  const layout = approximateFormSchema({
    definition,
    portal,
    metadata,
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.equal(layout.approximated, true);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'COMPONENT_SCHEMA_REQUIRED');
  assert.equal(diagnostics[0].reason, 'SYSTEMFORM_UNRESOLVED');
  assert.equal(diagnostics[0].systemFormId, 'missing-main');
  assert.match(diagnostics[0].message, /missing-main.*does not match an active systemform/);
});

test('an advanced step reports an exported layout mapping gap when its selected systemform exists', () => {
  const definition = { id: 'wizard', name: 'Sample wizard', metadata: { adx_startstep: 'edit' } };
  const portal = {
    forms: [],
    lists: [],
    advancedForms: [definition],
    records: [
      {
        id: 'edit',
        kind: 'advancedformstep',
        name: 'Edit',
        adx_webform: 'wizard',
        adx_targetentitylogicalname: 'sample',
        adx_formname: 'Main',
      },
      {
        id: 'missing-save-field',
        kind: 'advancedformmetadata',
        adx_webformstep: 'edit',
        adx_attributelogicalname: 'absent',
        adx_setvalueonsave: true,
      },
    ],
  };
  const built = applySolutionMetadata(portal, metadata);
  assert.equal(built.componentSchemas.edit, undefined);
  assert.ok(built.diagnostics.some(({ code, id }) => code === 'ADVANCEDFORM_STEP_MAPPING_ERROR' && id === 'edit'));

  const diagnostics = [];
  const layout = approximateAdvancedFormSchema({
    definition,
    portal,
    metadata,
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.equal(layout.steps[0].approximated, true);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'COMPONENT_SCHEMA_REQUIRED');
  assert.equal(diagnostics[0].reason, 'SYSTEMFORM_MAPPING_UNRESOLVED');
  assert.equal(diagnostics[0].step, 'Edit');
  assert.equal(diagnostics[0].systemFormId, systemForm.id);
  assert.match(diagnostics[0].message, /selected-main.*exported systemform.*layout could not be mapped/);
});
