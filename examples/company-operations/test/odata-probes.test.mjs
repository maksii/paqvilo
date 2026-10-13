import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sourceODataSelection, compilePositiveODataProbes, positiveODataRequest } from '../portal-harness/odata-probes.mjs';
import { canonicalRows } from '../portal-harness/core.mjs';
import { compilePlans } from '../portal-harness/compile.mjs';
import { buildBlueprint } from '../portal-security/blueprint.mjs';
import { buildQualificationDomain } from '../portal-security/qualification-domain.mjs';

const schema = JSON.parse(await readFile(new URL('../dataverse/manifest.json', import.meta.url)));
const catalogue = JSON.parse(await readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
const manifest = compilePlans(catalogue, schema);
const operation = { pqvd_testoperationid: 'abcdef12-0000-0000-0000-000000000001',
  pqvd_markeroperation: 'CO-OP:abcdef12-0000-0000-0000-000000000001', pqvd_markerutc: 'CO-UTC:2026-10-13T00:00:00.000Z' };

test('root selection derives native lookup properties and rejects aggregate or linked-only aliases', () => {
  const selected = sourceODataSelection({ schema, table: 'pqvd_equipment', fields: [
    { name: 'asset', source: 'pqvd_equipmentid' }, { name: 'organisation', source: 'pqvd_accountid' },
    { name: 'count', source: 'pqvd_equipmentid', aggregate: 'count' }, { name: 'engagementid', source: 'pqvd_employmentid' },
  ] });
  assert.deepEqual(selected.select, ['pqvd_equipmentid', '_pqvd_accountid_value']);
  assert.deepEqual(selected.rejected.map(field => field.reason), ['aggregate-expression', 'not-a-root-entity-column']);
  assert.deepEqual(canonicalRows([{ pqvd_equipmentid: operation.pqvd_testoperationid,
    _pqvd_accountid_value: 'ABCDEF12-0000-0000-0000-000000000002' }], selected), [
    { pqvd_equipmentid: operation.pqvd_testoperationid, _pqvd_accountid_value: 'abcdef12-0000-0000-0000-000000000002' },
  ]);
});

test('eight additional probes preserve original intents and use bounded actual entity properties with both server markers', () => {
  const before = JSON.stringify(manifest), probes = compilePositiveODataProbes({ manifest, schema, catalogue });
  assert.equal(probes.length, 8); assert.equal(new Set(probes.map(probe => probe.id)).size, 8);
  assert.equal(JSON.stringify(manifest), before);
  for (const plan of probes) {
    assert.ok(plan.id.endsWith('-odata-positive')); assert.equal(plan.fixtureIds.length, 1);
    assert.equal(plan.nativeQualified, false); assert.equal(plan.expectedNativeOutcome, 'requires-native-evidence');
    const request = new URL(positiveODataRequest(plan, operation), 'https://fixture.invalid');
    assert.equal(request.searchParams.get('$top'), '10'); assert.equal(request.searchParams.get('$count'), 'true');
    assert.match(request.searchParams.get('$filter'), /CO-UTC:/); assert.match(request.searchParams.get('$filter'), /CO-OP:/);
    assert.ok(request.href.length < 2000);
    assert.equal(request.searchParams.get('$select'), plan.fields.map(field => field.name).join(','));
    assert.ok(plan.requiredLogicalWebApiFields.includes(plan.primaryName));
    assert.deepEqual(plan.requiredWireWebApiFields, plan.fields.map(field=>field.source));
    assert.ok(plan.requiredWireWebApiFields.some(field=>/^_.*_value$/.test(field)));
    assert.ok(plan.fields.every(field => !field.aggregate));
  }
});

test('additional OData authoring adds 32768 actual proof cells without replacing the original eight-case domain', () => {
  const positive = compilePositiveODataProbes({ manifest, schema, catalogue });
  const equipment = manifest.cases.find(plan => plan.id === 'R09');
  const stressCases = Array.from({ length: 17 }, (_, index) => ({ ...equipment, id: `S01-J${index}`, variant: 'query-budget' }));
  const blueprint = buildBlueprint(schema, catalogue);
  const before = buildQualificationDomain({ blueprint, schema, catalogue, manifest: { ...manifest, stressCases } });
  const after = buildQualificationDomain({ blueprint, schema, catalogue, manifest: { ...manifest, stressCases, odataPositiveVariants: positive } });
  assert.equal(before.readDomain.denominator, 475136); assert.equal(after.readDomain.denominator, 507904);
  assert.equal(after.readDomain.denominator - before.readDomain.denominator, 32768);
  assert.equal(after.readDomain.originalODataVariants, 8); assert.equal(after.readDomain.additionalWellFormedODataVariants, 8);
  assert.equal(after.readDomain.queryVariants, 70); assert.notEqual(before.domainHash, after.domainHash);
});
