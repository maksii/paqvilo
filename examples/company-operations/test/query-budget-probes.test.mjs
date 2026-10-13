import test from 'node:test';
import assert from 'node:assert/strict';
import { compileQueryBudgetProbes, budgetProbeRequest, queryLinkFeatures, queryTransportMetrics,
  assertBudgetProbeSourceBinding, materializeBudgetGlobalControl, compileScalarTransportControls,
  scalarTransportRequest } from '../portal-harness/query-budget-probes.mjs';
import fs from 'node:fs/promises';

const basePlan = { id: 'INVENTED-ROOT', table: 'invented_asset', entitySet: 'invented_assets',
  primaryId: 'invented_assetid', primaryName: 'invented_name', fixtureIds: ['00000000-0000-0000-0000-000000000001'] };
const operation = { pqvd_testoperationid: '00000000-0000-0000-0000-000000000002',
  pqvd_markeroperation: 'CO-OP:00000000-0000-0000-0000-000000000002', pqvd_markerutc: 'CO-UTC:2026-10-13T00:00:00.000Z' };

test('finite native admission discriminator retains existing domain and never credits generated controls', () => {
  const domain = compileQueryBudgetProbes({ basePlan, scopedRoleMask: 64 });
  assert.equal(domain.denominator, 172); assert.equal(domain.cells.length, 172);
  assert.equal(domain.physicalRepeatedCellsRequired, 344); assert.equal(domain.plans.length, 79);
  assert.equal(domain.nativeQualifiedCells, 0); assert.equal(domain.universalPermissionParity, false);
  assert.equal(domain.originalDenominatorsPreserved, true);
  assert.equal(new Set(domain.cells.map(cell => cell.id)).size, domain.cells.length);
  assert.ok(domain.cells.every(cell => cell.nativeQualification === 'unrecorded'));
  for (const type of ['any', 'not any', 'all', 'not all']) {
    const plans = domain.plans.filter(plan => plan.dimensions.quantifierType === type);
    assert.equal(plans.length, 7);
    const siblings = plans.find(plan => plan.dimensions.shape === 'quantifier-siblings-total-16');
    assert.equal(siblings.authoredFeatures.total, 16); assert.equal(siblings.authoredFeatures.ordinary, 0);
    const descendants = plans.find(plan => plan.dimensions.shape === 'ordinary-descendants-15');
    assert.equal(descendants.authoredFeatures.total, 16); assert.equal(descendants.authoredFeatures.ordinaryUnderQuantifier, 15);
    const nested = plans.find(plan => plan.dimensions.nested);
    assert.equal(nested.authoredFeatures.total, 16); assert.equal(nested.authoredFeatures.nestedQuantifiers, 1);
    assert.equal(nested.authoredFeatures.ordinary, 14);
  }
});

test('transport probes vary wire encoding and harmless whitespace independently of link shape', () => {
  const domain = compileQueryBudgetProbes({ basePlan, scopedRoleMask: 64 });
  const plans = domain.plans.filter(plan => plan.variant === 'query-transport' && plan.dimensions.ordinarySiblings === 3);
  const percent = plans.find(plan => plan.dimensions.paddingCharacters === 1024 && plan.dimensions.encoding === 'percent-space');
  const form = plans.find(plan => plan.dimensions.paddingCharacters === 1024 && plan.dimensions.encoding === 'form-space');
  const left = budgetProbeRequest(percent, operation), right = budgetProbeRequest(form, operation);
  assert.equal(new URL(left.url, 'https://invented.invalid').searchParams.get('fetchXml'),
    new URL(right.url, 'https://invented.invalid').searchParams.get('fetchXml'));
  assert.equal(left.authoredFetchXml, right.authoredFetchXml);
  assert.ok(left.metrics.requestCharacters > right.metrics.requestCharacters);
  assert.deepEqual(queryLinkFeatures(left.authoredFetchXml), queryLinkFeatures(right.authoredFetchXml));
  assert.equal(left.metrics.receivedXmlCharacters, undefined);
  const metrics = queryTransportMetrics({ url: left.url, authoredXml: left.authoredFetchXml, receivedXml: left.authoredFetchXml });
  assert.equal(metrics.receivedLinkFeatures.total, 3);
  assert.ok(metrics.receivedDoublePercentEncodedCharacters > metrics.receivedPercentEncodedCharacters);
  assert.throws(() => budgetProbeRequest(percent, { ...operation, pqvd_markeroperation: 'bad' }), /markers/);
});

test('qualification requires independent native source receipts and positive runtime evidence', () => {
  const fields = ['schema', 'permissionGraph', 'memberships', 'actorFields', 'fixtures', 'siteSource', 'settings', 'registrations'];
  const before = Object.fromEntries(fields.map(field => [field, 'a'.repeat(64)]));
  const binding = { before, after: { ...before }, bothCacheClearReceipt: 'b'.repeat(64),
    positiveControl: { fixtureCount: 1, actualQueryArtifacts: 1 }, actualOperationId: operation.pqvd_testoperationid, nativeReplay: true };
  assert.match(assertBudgetProbeSourceBinding(binding), /^[a-f0-9]{64}$/);
  assert.throws(() => assertBudgetProbeSourceBinding({ ...binding, after: { ...before, memberships: 'b'.repeat(64) } }), /unchanged/);
  assert.throws(() => assertBudgetProbeSourceBinding({ ...binding, positiveControl: { fixtureCount: 0, actualQueryArtifacts: 1 } }), /positive control/);
  assert.throws(() => assertBudgetProbeSourceBinding({ ...binding, positiveControl: {} }), /positive control/);
  assert.throws(() => assertBudgetProbeSourceBinding({ ...binding, nativeReplay: false }), /Actual native/);
});

test('Global control is a separate reversible source graph with a Read-only metadata-bound root', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../dataverse/manifest.json', import.meta.url))),
    catalogue = JSON.parse(await fs.readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
  const table = schema.tables.find(table => table.name === 'pqvd_equipment');
  const control = materializeBudgetGlobalControl({ schema, catalogue,
    basePlan: { ...basePlan, table: table.name, entitySet: table.entitySetName, primaryId: table.name + 'id', primaryName: table.primaryName.name } });
  assert.equal(control.permissions.length, 1); assert.equal(control.permissions[0].scope, 'Global');
  assert.equal(control.permissions[0].privileges, 1); assert.equal(control.permissions[0].table, table.name);
  const permissionComponent = control.components.find(component => component.type === 18);
  assert.equal(permissionComponent.content.create, false); assert.equal(permissionComponent.content.write, false);
  assert.equal(permissionComponent.content.append, false); assert.equal(permissionComponent.content.delete, false);
  assert.equal(control.fixtureRequirements[0].fixtureMutation, false);
  assert.equal(control.nativeQualifiedCells, 0); assert.equal(control.nativeExecution, false);
  assert.throws(() => materializeBudgetGlobalControl({ schema, catalogue, basePlan }), /logical metadata/);
});

test('scalar controls distinguish OData wire lengths without silently replacing the original cases', () => {
  const domain = compileScalarTransportControls({ positivePlan: { ...basePlan,
    fields: [{ name: basePlan.primaryId, source: basePlan.primaryId, type: 'guid' }],
    pageSize: 10, fetchXml: '<fetch/>', authoringQualification: 'schema-valid-bounded-request' } });
  assert.equal(domain.denominator, 8); assert.equal(domain.physicalRepeatedCellsRequired, 16);
  assert.equal(domain.nativeQualifiedCells, 0); assert.equal(domain.budgetDomainPreserved, true);
  const requests = domain.plans.map(plan => scalarTransportRequest(plan, operation));
  assert.equal(new Set(requests.map(request => request.metrics.decodedFilterHash)).size, 1);
  assert.ok(Math.max(...requests.map(request => request.metrics.requestCharacters)) > 3072);
  assert.ok(requests.every(request => new URL(request.url, 'https://invented.invalid').searchParams.get('$top') === '10'));
  assert.throws(() => compileScalarTransportControls({ positivePlan: basePlan }), /source-metadata/);
});
