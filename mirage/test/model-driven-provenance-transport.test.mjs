import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeModelDrivenProvenance, decodeModelDrivenProvenance } from '../lib/model-driven/provenance-transport.mjs';

const reference = (index) => ({
  id: `model-source:control-${index}`,
  key: `model-source:control-${index}`,
  sourceKey: `model-source:control-${index}`,
  componentKey: `control:form:${index}`,
  placementKey: `control:form:${index}`,
  kind: 'control',
  ref: 'C:/invented/solution/Entities/fixture_item/FormXml/main.xml',
  sourceRevision: 'render-4',
  contentRevision: 'a'.repeat(64),
  relationship: 'placement',
  region: { start: index * 100, end: index * 100 + 40, line: index + 1, column: 1 },
  fieldPath: ['controls', String(index)],
  recordId: 'invented-form',
  name: `fixture_field_${index}`,
});
test('model source transport roundtrips every cold placement and optional identity without mutating canonical metadata', () => {
  const input = {
    tables: {
      fixture_item: {
        fields: { fixture_name: { type: 'text' } },
        provenanceRefs: Array.from({ length: 1105 }, (_, index) => reference(index)),
      },
    },
    provenanceRefs: [{ ...reference(0), key: 'distinct-key', placementKey: 'distinct-placement' }],
  };
  const before = structuredClone(input);
  const wire = JSON.parse(JSON.stringify(encodeModelDrivenProvenance(input)));
  assert.deepEqual(input, before);
  assert.equal(wire.tables.fixture_item.provenanceOrigins.length, 1);
  assert.ok(JSON.stringify(wire).length < JSON.stringify(input).length * 0.7);
  assert.deepEqual(decodeModelDrivenProvenance(wire), input);
  assert.deepEqual(decodeModelDrivenProvenance(input), input, 'legacy canonical response remains readable');
});
test('unknown source transport or malformed origin refuses all source evidence while retaining form and field functionality', () => {
  const encoded = encodeModelDrivenProvenance({
    forms: [{ id: 'invented-form' }],
    fields: { fixture_name: { type: 'text' } },
    provenanceRefs: [reference(0)],
  });
  for (const mutate of [
    (value) => (value.provenanceFormat = 2),
    (value) => (value.provenanceOrigins = null),
    (value) => (value.provenanceRefs[0].originIndex = 2),
    (value) => (value.provenanceRefs[0].aliasMask = 8),
    (value) => delete value.provenanceOrigins[0].contentRevision,
    (value) => (value.provenanceRefs[0] = null),
  ]) {
    const wire = structuredClone(encoded);
    mutate(wire);
    const result = decodeModelDrivenProvenance(wire);
    assert.deepEqual(result.provenanceRefs, []);
    assert.equal(result.provenanceAvailability[0].reason, 'invalid-provenance-transport');
    assert.deepEqual(result.forms, encoded.forms);
    assert.deepEqual(result.fields, encoded.fields);
    assert.equal(result.provenanceFormat, undefined);
  }
});
