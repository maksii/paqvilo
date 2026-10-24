import test from 'node:test';
import assert from 'node:assert/strict';
import { readManifest } from '../../../../lense/dataverse/index.mjs';
import { registration, id } from '../registration.mjs';
const manifest = await readManifest(new URL('../../dataverse/manifest.json', import.meta.url));
test('query observer is table-specific and excludes recorder/config tables', () => {
  const r = registration(manifest);
  const steps = r.steps.filter((s) => s.type === 'IncomingQueryObserver');
  assert.equal(steps.length, 92);
  assert.ok(
    steps.every(
      (s) =>
        s.table !== '*' &&
        !s.global &&
        !['pqvd_testrun', 'pqvd_testresult', 'pqvd_crudprobe', 'pqvd_pluginevent', 'pqvd_testoperation'].includes(
          s.table,
        ),
    ),
  );
  assert.deepEqual([...new Set(steps.map((s) => `${s.stage}/${s.order}`))], ['10/10', '20/10', '20/9900', '40/9900']);
  assert.equal(steps.filter((step) => step.table === 'pqvd_currencyreference').length, 4);
  assert.deepEqual(
    r.steps
      .filter((step) => step.table === 'pqvd_currencyreference' && step.type === 'BusinessProjectionGuard')
      .map((step) => step.message),
    ['Create', 'Update', 'Delete'],
  );
});
test('images and chain filters obey message/stage constraints', () => {
  const r = registration(manifest);
  for (const s of r.steps) {
    assert.ok(!(s.stage === 10 && s.images?.length));
    if (s.message === 'Create') assert.ok(!s.images?.includes('Before'));
    if (s.message === 'Delete') assert.ok(!s.images?.includes('After'));
    if (s.images?.length) assert.ok(s.imageColumns.length && !s.imageColumns.includes('*'));
  }
  const a = r.steps.find((s) => s.type === 'ChainA');
  assert.equal(a.runAsWriter, true);
  assert.deepEqual(a.filteringAttributes, ['pqvd_triggernonce']);
  assert.equal(r.steps.find((s) => s.type === 'QueryShapeMutator').disabled, true);
});
test('stable identities and honest cloud readiness', () => {
  const r = registration(manifest);
  assert.equal(id('x'), id('x'));
  assert.notEqual(id('x'), id('y'));
  assert.equal(r.readiness.durableCollector, false);
  assert.equal(r.readiness.flowSecret, false);
  assert.equal(r.readiness.businessProjectionMaintenance, false);
  assert.equal(new Set(r.steps.map((s) => s.key)).size, r.steps.length);
});
test('lookup-control images require an explicitly declared equipment-to-probe relationship', () => {
  const base = registration(manifest);
  assert.ok(
    base.steps
      .filter((step) => step.table === 'pqvd_crudprobe')
      .every((step) => !step.imageColumns?.includes('pqvd_equipmentid')),
  );
  const source5 = registration({
    ...manifest,
    relationships: [
      ...manifest.relationships,
      { kind: 'oneToMany', parent: 'pqvd_equipment', child: 'pqvd_crudprobe', lookup: { name: 'pqvd_equipmentid' } },
    ],
  });
  const probeImages = source5.steps.filter((step) => step.table === 'pqvd_crudprobe' && step.images?.length),
    equipmentImages = source5.steps.filter((step) => step.type === 'EquipmentCrudObserver' && step.images?.length);
  assert.equal(probeImages.length, 11);
  assert.equal(equipmentImages.length, 4);
  for (const step of probeImages) assert.ok(step.imageColumns.includes('pqvd_equipmentid'));
  for (const step of equipmentImages)
    assert.ok(step.imageColumns.includes('pqvd_roomid') && step.imageColumns.includes('pqvd_accountid'));
});
