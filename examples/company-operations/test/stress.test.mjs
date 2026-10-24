import test from 'node:test';
import assert from 'node:assert/strict';
import { readCatalogue, readManifest } from 'paqvilo/dataverse';
const data = await readCatalogue(new URL('../data/stress-catalogue.json', import.meta.url)),
  schema = await readManifest(new URL('../dataverse/manifest.json', import.meta.url));
const byKey = new Map(data.records.map((r) => [r.key, r]));
test('stress persona has all twelve independent active scope anchors and three simultaneous engagement kinds', () => {
  const p = data.personas.find((p) => p.key === 'P-STRESS');
  assert.equal(p.webRoles.length, 12);
  assert.equal(p.grants.length, 12);
  assert.deepEqual(
    p.webRoleVariants.map((v) => v.roles.length),
    [0, 1, 2, 4, 8, 12],
  );
  for (const key of p.grants) {
    const g = byKey.get(key),
      role = byKey.get(g.refs.pqvd_roleid);
    assert.equal(g.refs[role.fields.pqvd_principalcolumn], p.key);
    assert.equal(Object.entries(g.refs).filter(([k, v]) => k.endsWith('principalid') && v).length, 1);
    assert.ok(
      data.associations.filter((a) => a.from === key).every((a) => !a.to.includes('B') && !a.to.includes('B-LAKE')),
    );
  }
  const jobs = data.records.filter(
    (r) => r.table === 'pqvd_employment' && r.refs.pqvd_orgcontactid === 'MEM-P-STRESS-A-RIV',
  );
  assert.equal(jobs.length, 3);
  assert.equal(new Set(jobs.map((r) => r.fields.pqvd_engagementkind)).size, 3);
  assert.equal(
    jobs.reduce((n, r) => n + r.fields.pqvd_ftefraction, 0),
    1,
  );
  assert.ok(data.records.length >= 842);
  assert.equal(data.personas.length, 25);
});
test('team equipment projections contain exactly issued custody of the projected employments', () => {
  const issued = schema.choices
    .find((c) => c.name === 'pqvd_assignmentstate')
    .options.find((o) => o.label === 'Issued').value;
  const leaders = data.records.filter((r) => r.table === 'pqvd_accesspermission' && r.refs.pqvd_teamleaderprincipalid);
  assert.equal(leaders.length, 3);
  for (const g of leaders) {
    const jobs = data.associations.find((a) => a.from === g.key && a.relationship === 'pqvd_access_employments').to;
    const expected = [
      ...new Set(
        data.records
          .filter(
            (r) =>
              r.table === 'pqvd_assignment' &&
              r.fields.pqvd_assignmentstate === issued &&
              jobs.includes(r.refs.pqvd_employmentid),
          )
          .map((r) => r.refs.pqvd_equipmentid),
      ),
    ].sort();
    assert.deepEqual(
      [...data.associations.find((a) => a.from === g.key && a.relationship === 'pqvd_access_equipments').to].sort(),
      expected,
    );
  }
});
test('reference leaves remain separate from organisation scope and never survive inactive principal', () => {
  const grants = data.records.filter((r) => r.table === 'pqvd_accesspermission');
  assert.equal(
    grants.filter((g) => !Object.entries(g.refs).some(([k, v]) => k.endsWith('principalid') && v)).length,
    4,
  );
  for (const g of grants) {
    const refs = data.associations.filter(
      (a) => a.from === g.key && ['pqvd_access_currencies', 'pqvd_access_referenceaccounts'].includes(a.relationship),
    );
    assert.equal(refs.length, 2);
    const op = data.associations.find((a) => a.from === g.key && a.relationship === 'pqvd_access_accounts').to;
    for (const group of refs)
      for (const key of group.to) {
        assert.ok(!op.includes(key));
        assert.equal(
          byKey.get(key).table,
          group.relationship === 'pqvd_access_currencies' ? 'transactioncurrency' : 'account',
        );
      }
    if (!Object.entries(g.refs).some(([k, v]) => k.endsWith('principalid') && v))
      assert.ok(refs.every((a) => a.to.length === 0));
  }
});
