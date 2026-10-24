import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';

test('large component XML is not serialized again for unchanged record-field lookups', (t) => {
  const formId = 'ce2c038d-6679-4a77-8e49-9f9de6e539bf';
  const xml = `<form><tabs>${'<!-- invented form payload -->'.repeat(40_000)}</tabs></form>`;
  const base = {
    forms: [{ id: formId, entity: 'new_item', name: 'Original', xml }],
    views: [],
    entities: {},
    modelDrivenApps: [],
  };
  const state = {
    tables: {
      systemform: [{ formid: formId, name: 'Original', formxml: xml, versionnumber: 1, settings: { label: 'First' } }],
    },
    dataverse: { sourceSolutionComponents: { baseline: { [`systemform/${formId}`]: {} } } },
  };
  const overlay = createSolutionMetadataOverlay();
  const first = overlay(base, state);
  const stringify = JSON.stringify;
  let serializedBytes = 0;
  const mock = t.mock.method(JSON, 'stringify', (...args) => {
    const result = stringify(...args);
    serializedBytes += result?.length ?? 0;
    return result;
  });
  for (let index = 0; index < 100; index++) assert.equal(overlay(base, state), first);
  mock.mock.restore();
  assert.ok(serializedBytes < 100_000, `Unchanged metadata lookups serialized ${serializedBytes} bytes.`);
  assert.equal(
    overlay(base, structuredClone(state)),
    first,
    'Equivalent transaction snapshots reuse the effective metadata.',
  );
  const row = state.tables.systemform[0];
  row.name = 'Changed directly';
  const renamed = overlay(base, state);
  assert.notEqual(renamed, first);
  assert.equal(renamed.forms[0].name, 'Changed directly');
  assert.equal(row.versionnumber, 1, 'Invalidation does not depend on a row-version increment.');
  row.formxml = '<form><tabs><tab name="changed" /></tabs></form>';
  const changedXml = overlay(base, state);
  assert.equal(changedXml.forms[0].xml, row.formxml);
  row.settings.label = 'Nested direct edit';
  const nestedEdit = overlay(base, state);
  assert.notEqual(nestedEdit, changedXml, 'In-place structured metadata edits also invalidate the cache.');
  row.settings = stringify(row.settings);
  assert.notEqual(
    overlay(base, state),
    nestedEdit,
    'A structured value and an equivalent JSON string are different metadata.',
  );
  state.tables.systemform = [];
  assert.deepEqual(overlay(base, state).forms, [], 'Source tombstones still remove effective components.');
  assert.equal(base.forms[0].name, 'Original');
  assert.equal(base.forms[0].xml, xml, 'Source metadata remains immutable.');
});
