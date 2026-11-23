// @test-kind observation: native captures 2026-11-23 on a Power Pages site through /_api (paqvilo-developer feedback-251-252-parity q4-*, q5-*, q6-*, q7-*, q8-* evidence): an association needs AppendTo on the table in the request URL and Append on the related table; either missing is 403 90040106; a collection-valued $ref also needs Write on the URL table (90040103) and both navigations must be Web API fields (90040101)
// Invented tables: pqx_child holds the lookup pqx_probe to pqx_probe (collection pqx_probe_children) and has the N:N
// pqx_child_probe with pqx_probe. Each case states the recorded native outcome on the captured shape (pqwp_child, pqwp_probe).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const G = (n) => '77777777-7777-4777-8777-' + String(n).padStart(12, '0');
const CHILD = G(2),
  PROBE = G(3);

async function site(t, { child, probe, navigations = true }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-association-rights-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const portal = path.join(root, 'portal'),
    solution = path.join(root, 'solution');
  await fs.mkdir(portal, { recursive: true });
  await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
  await fs.writeFile(path.join(portal, 'website.yml'), 'adx_name: Invented\nadx_websiteid: invented\n');
  await fs.writeFile(path.join(portal, 'webrole.yml'), JSON.stringify([{ adx_webroleid: G(1), adx_name: 'Member' }]));
  const grant = (entity, rights, i) => ({
    adx_entitypermissionid: G(10 + i),
    adx_entityname: entity,
    adx_entitylogicalname: entity,
    adx_scope: 756150000,
    adx_entitypermission_webrole: [G(1)],
    ...Object.fromEntries(
      ['read', 'write', 'create', 'delete', 'append', 'appendto'].map((r) => ['adx_' + r, rights.includes(r)]),
    ),
  });
  await fs.writeFile(
    path.join(portal, 'tablepermission.yml'),
    JSON.stringify([grant('pqx_child', child, 0), grant('pqx_probe', probe, 1)]),
  );
  await fs.writeFile(
    path.join(portal, 'sitesetting.yml'),
    JSON.stringify(
      [
        ['pqx_child', 'pqx_childid,pqx_name,pqx_probe' + (navigations ? ',pqx_child_probe' : '')],
        ['pqx_probe', 'pqx_probeid,pqx_name' + (navigations ? ',pqx_probe_children' : '')],
      ].flatMap(([entity, fields]) => [
        { adx_name: `Webapi/${entity}/enabled`, adx_value: 'true' },
        { adx_name: `Webapi/${entity}/fields`, adx_value: fields },
      ]),
    ),
  );
  const attribute = (name, type) =>
    `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type></attribute>`;
  for (const [entity, set, extra] of [
    ['pqx_child', 'pqx_children', attribute('pqx_probe', 'lookup')],
    ['pqx_probe', 'pqx_probes', ''],
  ]) {
    await fs.mkdir(path.join(solution, 'Entities', entity), { recursive: true });
    await fs.writeFile(
      path.join(solution, 'Entities', entity, 'Entity.xml'),
      `<Entity><Name>${entity}</Name><EntityInfo><entity Name="${entity}"><EntitySetName>${set}</EntitySetName><attributes>${attribute(entity + 'id', 'primarykey')}${attribute('pqx_name', 'nvarchar')}${extra}</attributes></entity></EntityInfo></Entity>`,
    );
  }
  await fs.writeFile(
    path.join(solution, 'Other/Relationships.xml'),
    '<EntityRelationships>' +
      '<EntityRelationship Name="pqx_probe_children"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>pqx_child</ReferencingEntityName><ReferencedEntityName>pqx_probe</ReferencedEntityName><ReferencingAttributeName>pqx_probe</ReferencingAttributeName><EntityRelationshipRoles><EntityRelationshipRole><RelationshipRoleType>1</RelationshipRoleType><NavigationPropertyName>pqx_probe</NavigationPropertyName></EntityRelationshipRole><EntityRelationshipRole><RelationshipRoleType>0</RelationshipRoleType><NavigationPropertyName>pqx_probe_children</NavigationPropertyName></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship>' +
      '<EntityRelationship Name="pqx_child_probe"><EntityRelationshipType>ManyToMany</EntityRelationshipType><FirstEntityName>pqx_child</FirstEntityName><SecondEntityName>pqx_probe</SecondEntityName><IntersectEntityName>pqx_child_probe</IntersectEntityName><Entity1IntersectAttribute>pqx_childid</Entity1IntersectAttribute><Entity2IntersectAttribute>pqx_probeid</Entity2IntersectAttribute><EntityRelationshipRoles><EntityRelationshipRole><AssociationRoleOrdinal>1</AssociationRoleOrdinal><NavigationPropertyName>pqx_child_probe</NavigationPropertyName></EntityRelationshipRole><EntityRelationshipRole><AssociationRoleOrdinal>2</AssociationRoleOrdinal><NavigationPropertyName>pqx_child_probe</NavigationPropertyName></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship>' +
      '</EntityRelationships>',
  );
  const sim = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    solutionOrder: 'explicit',
    watch: false,
    port: 0,
  });
  ownedFixture(t).add(() => sim.close());
  await sim.store.transact(() => {
    sim.store.state.tables.pqx_child = [{ pqx_childid: CHILD, pqx_name: 'Before' }];
    sim.store.state.tables.pqx_probe = [{ pqx_probeid: PROBE, pqx_name: 'Probe' }];
    sim.store.state.tables.contact = [{ contactid: G(4), fullname: 'Invented member', statecode: 0 }];
  });
  const cookie = sim.signIn(G(4), { roles: ['Member'] }).cookieHeader;
  const call = async (method, route, body) => {
    const response = await fetch(sim.url + route, {
      method,
      headers: { cookie, __RequestVerificationToken: sim.csrf, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const error = text ? JSON.parse(text).error : undefined;
    return { status: response.status, ...(error ? { code: error.code, message: error.message } : {}) };
  };
  const childRow = () => sim.store.snapshot().tables.pqx_child.find((row) => row.pqx_childid === CHILD);
  const lookup = () => {
    const value = childRow()?.pqx_probe;
    return (value?.id ?? value ?? null) === PROBE;
  };
  const linked = () =>
    (sim.store.snapshot().tables.pqx_child_probe ?? []).some(
      (row) => (row.pqx_childid?.id ?? row.pqx_childid) === CHILD && (row.pqx_probeid?.id ?? row.pqx_probeid) === PROBE,
    );
  return { sim, call, lookup, linked };
}

const NATIVE = { child: ['create', 'read', 'write', 'appendto'], probe: ['read', 'append'] };
const MIRAGE_BEFORE = { child: ['create', 'read', 'write', 'append'], probe: ['read', 'appendto'] };
const denied = (table, related) => ({
  status: 403,
  code: '90040106',
  message: `You don’t have permission to associate or disassociate table ${related} to ${table}`,
});
const bind = { 'pqx_probe@odata.bind': `/pqx_probes(${PROBE})` };

test('a lookup bind on update needs AppendTo on the bound table and Append on the related table (q4/q5/q6)', async (t) => {
  for (const [child, probe, allowed] of [
    [['create', 'read', 'write', 'append'], ['read', 'appendto'], false],
    [['create', 'read', 'write', 'append'], ['read', 'append', 'appendto'], false],
    [['create', 'read', 'write', 'append', 'appendto'], ['read', 'append', 'appendto'], true],
    [['create', 'read', 'write', 'append', 'appendto'], ['read', 'appendto'], false],
    [['create', 'read', 'write', 'append', 'appendto'], ['read', 'append'], true],
    [['create', 'read', 'write', 'appendto'], ['read', 'append'], true],
  ]) {
    const { call, lookup } = await site(t, { child, probe });
    const response = await call('PATCH', `/_api/pqx_children(${CHILD})`, { pqx_name: 'Bound', ...bind });
    const label = `child ${child} / probe ${probe}`;
    if (allowed) assert.deepEqual(response, { status: 204 }, label);
    else assert.deepEqual(response, denied('pqx_child', 'pqx_probe'), label);
    assert.equal(lookup(), allowed, label);
  }
});

test('create with a bind and a single-valued $ref follow the same rule (q6)', async (t) => {
  for (const [rights, allowed] of [
    [NATIVE, true],
    [MIRAGE_BEFORE, false],
  ]) {
    const created = await site(t, rights);
    const response = await created.call('POST', '/_api/pqx_children', { pqx_name: 'Created', ...bind });
    if (allowed) assert.equal(response.status, 204);
    else assert.deepEqual(response, denied('pqx_child', 'pqx_probe'));
    assert.equal(
      created.sim.store.snapshot().tables.pqx_child.some((row) => row.pqx_name === 'Created'),
      allowed,
    );
    const single = await site(t, rights);
    const ref = await single.call('PUT', `/_api/pqx_children(${CHILD})/pqx_probe/$ref`, {
      '@odata.id': `${single.sim.url}/_api/pqx_probes(${PROBE})`,
    });
    if (allowed) assert.equal(ref.status, 204);
    else assert.deepEqual(ref, denied('pqx_child', 'pqx_probe'));
    assert.equal(single.lookup(), allowed);
  }
});

test('a collection-valued $ref needs AppendTo on its own table, Append on the child, Write on its own table and listed navigations (q6/q7/q8)', async (t) => {
  const collection = (s) =>
    s.call('POST', `/_api/pqx_probes(${PROBE})/pqx_probe_children/$ref`, {
      '@odata.id': `${s.sim.url}/_api/pqx_children(${CHILD})`,
    });
  const createDenied = {
    status: 403,
    code: '90040103',
    message: 'You don’t have permission to create records for pqx_probe table.',
  };
  for (const [rights, expected, navigations = true] of [
    [NATIVE, denied('pqx_probe', 'pqx_child')],
    [MIRAGE_BEFORE, createDenied],
    [{ child: MIRAGE_BEFORE.child, probe: ['read', 'appendto', 'create'] }, createDenied],
    [
      { child: MIRAGE_BEFORE.child, probe: ['read', 'appendto', 'write'] },
      {
        status: 403,
        code: '90040101',
        message: 'Attribute pqx_probe_children in table pqx_probe is not enabled for Web Api.',
      },
      false,
    ],
    [{ child: MIRAGE_BEFORE.child, probe: ['read', 'appendto', 'write'] }, { status: 204 }],
  ]) {
    const s = await site(t, { ...rights, navigations });
    const label = JSON.stringify({ ...rights, navigations });
    assert.deepEqual(await collection(s), expected, label);
    assert.equal(s.lookup(), expected.status === 204, label);
  }
});

test('a many-to-many $ref follows the same direction, before the navigation field check (q7/q8)', async (t) => {
  const nn = (s) =>
    s.call('POST', `/_api/pqx_children(${CHILD})/pqx_child_probe/$ref`, {
      '@odata.id': `${s.sim.url}/_api/pqx_probes(${PROBE})`,
    });
  const notEnabled = {
    status: 403,
    code: '90040101',
    message: 'Attribute pqx_child_probe in table pqx_child is not enabled for Web Api.',
  };
  for (const [rights, navigations, expected] of [
    [MIRAGE_BEFORE, false, denied('pqx_child', 'pqx_probe')],
    [NATIVE, false, notEnabled],
    [{ child: [...NATIVE.child, 'append'], probe: [...NATIVE.probe, 'appendto'] }, false, notEnabled],
    [NATIVE, true, { status: 204 }],
  ]) {
    const s = await site(t, { ...rights, navigations });
    const label = JSON.stringify({ ...rights, navigations });
    assert.deepEqual(await nn(s), expected, label);
    assert.equal(s.linked(), expected.status === 204, label);
  }
});
