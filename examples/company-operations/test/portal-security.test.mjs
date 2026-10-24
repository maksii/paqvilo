import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBlueprint, validateBlueprint, componentId } from '../portal-security/blueprint.mjs';
import { permissionContent, deploySecurity, nativeActiveOrphans } from '../portal-security/deploy.mjs';
import { auditScenarioOracles, evaluateConfiguredGraph } from '../portal-security/model-audit.mjs';
import { planStressRoleVariant } from '../portal-security/role-variant.mjs';
import { extendReferenceSchema, extendReferenceCatalogue } from '../portal-security/reference-projections.mjs';
import { packagePortal } from '../portal-security/package.mjs';
import { buildTesterOverlay, buildStressTesterOverlay } from '../portal-security/tester-overlay.mjs';
import { applyTesterRecords, resetTesterRecords } from '../portal-security/bind-tester.mjs';
import {
  configureDeepVariant,
  withDeepVariant,
  restoreDeepVariant,
  deepVariantKeys,
  deepVariant,
} from '../portal-security/deep-variant.mjs';
const schema = JSON.parse(await fs.readFile(new URL('../dataverse/manifest.json', import.meta.url))),
  catalogue = JSON.parse(await fs.readFile(new URL('../data/catalogue.json', import.meta.url)));

test('native audit detects unrelated active parent orphans and tolerates inactive archived faults', () => {
  const component = (id, state, parent) => ({
    powerpagecomponentid: id,
    powerpagecomponenttype: 18,
    statecode: state,
    name: id,
    content: JSON.stringify(
      parent === undefined ? { scope: 756150001 } : { scope: 756150003, parententitypermission: parent },
    ),
  });
  const rows = [
    component('root', 0),
    component('valid-child', 0, 'ROOT'),
    component('disabled', 1, 'root'),
    component('leaking-child', 0, 'disabled'),
    component('missing-child', 0, 'absent'),
    component('archived-fault', 1, 'absent'),
  ];
  assert.deepEqual(
    nativeActiveOrphans(rows).map((f) => [f.id, f.reason]),
    [
      ['leaking-child', 'inactive-parent'],
      ['missing-child', 'missing-parent'],
    ],
  );
  rows[2].statecode = 0;
  rows[4].statecode = 1;
  assert.deepEqual(nativeActiveOrphans(rows), []);
});

test('isolated principal roots, exact eleven-node chain, leaf profiles, immutable evidence', () => {
  const b = buildBlueprint(schema, catalogue),
    stats = validateBlueprint(b, schema);
  assert.equal(stats.roles, 13);
  assert.equal(stats.maxWorkforceDepth, 11);
  assert.equal(
    b.nodes.some((n) => n.scope === 'Global'),
    false,
  );
  for (const n of b.nodes.filter((n) => n.table === 'pqvd_accesspermission'))
    assert.equal(n.relationship, `pqvd_contact_access_${n.role.toLowerCase()}`);
  for (const role of ['EMPLOYEE', 'CONTRACTOR', 'TEAMLEADER'])
    for (const table of ['account', 'pqvd_orgcontact']) {
      const leaf = b.nodes.find((n) => n.role === role && n.table === table);
      assert.equal(
        b.nodes.some((n) => n.parent === leaf.key),
        false,
      );
    }
  for (const n of b.nodes.filter((n) => ['pqvd_pluginevent', 'pqvd_chainnode'].includes(n.table)))
    assert.deepEqual(n.privileges, {
      read: true,
      create: false,
      write: false,
      delete: false,
      append: false,
      appendTo: false,
    });
  const runner = b.roles.find((r) => r.code === 'TESTRUNNER');
  assert.equal(runner.id, '4a4e6823-5352-5506-802e-c6f92deffcd9');
  assert.equal(runner.authenticatedDefault, false);
  const mixed = b.assignments.find((a) => a.persona === 'P14');
  assert.deepEqual(mixed.roles, ['HR', 'IT', 'TESTRUNNER']);
});

test('enhanced native content resolves explicit role and parent IDs, privileges and scopes', () => {
  const b = buildBlueprint(schema, catalogue),
    root = b.nodes.find((n) => n.key === 'IT-GRANTS-ACCESSPERMISSION'),
    child = b.nodes.find((n) => n.key === 'IT-WORKFORCE-ACCOUNT');
  const rc = permissionContent(root, b),
    cc = permissionContent(child, b);
  assert.equal(rc.scope, 756150001);
  assert.equal(rc.contactrelationship, 'pqvd_contact_access_it');
  assert.equal(cc.scope, 756150003);
  assert.equal(cc.parententitypermission, root.id);
  assert.equal(cc.parentrelationship, 'pqvd_access_accounts');
  assert.deepEqual(cc.adx_entitypermission_webrole, [componentId('role:IT')]);
  assert.equal(rc.append, false);
  assert.equal(rc.appendto, false);
  assert.equal(cc.delete, false);
  assert.deepEqual(
    { read: cc.read, create: cc.create, write: cc.write, delete: cc.delete, append: cc.append, appendTo: cc.appendto },
    { read: true, create: false, write: false, delete: false, append: true, appendTo: true },
  );
  const probe = permissionContent(
    b.nodes.find((n) => n.table === 'pqvd_crudprobe'),
    b,
  );
  assert.equal(probe.delete, true);
  assert.equal(probe.append, true);
  assert.equal(probe.appendto, true);
});

test('scope multiplication, cross-role parents, endpoint mistakes and cycles reject', () => {
  const b = buildBlueprint(schema, catalogue),
    root = b.nodes.find((n) => n.key === 'IT-GRANTS-ACCESSPERMISSION');
  root.relationship = 'pqvd_contact_access_grantee';
  assert.throws(() => validateBlueprint(b, schema), /Scope multiplication/);
  root.relationship = 'pqvd_contact_access_it';
  const account = b.nodes.find((n) => n.key === 'IT-WORKFORCE-ACCOUNT');
  account.parent = 'HR-GRANTS-ACCESSPERMISSION';
  assert.throws(() => validateBlueprint(b, schema), /Invalid parent role/);
  account.parent = root.key;
  account.relationship = 'pqvd_access_employments';
  assert.throws(() => validateBlueprint(b, schema), /endpoint mismatch/);
  account.relationship = 'pqvd_access_accounts';
  root.parent = account.key;
  assert.throws(() => validateBlueprint(b, schema), /cycle/);
});

test('equipment cleanup is Delete-only through the actor own run, with no business Delete broadening', () => {
  const s = structuredClone(schema),
    c = structuredClone(catalogue);
  if (!s.relationships.some((r) => r.name === 'pqvd_testrun_canaryequipments'))
    s.relationships.push({
      name: 'pqvd_testrun_canaryequipments',
      kind: 'oneToMany',
      parent: 'pqvd_testrun',
      child: 'pqvd_equipment',
      lookup: { name: 'pqvd_canaryrunid' },
    });
  c.records.push(
    {
      key: 'OWN-CANARY',
      id: '11111111-2222-4333-8444-555555555555',
      table: 'pqvd_equipment',
      fields: {},
      refs: { pqvd_canaryrunid: 'RUN-P07' },
    },
    {
      key: 'FOREIGN-CANARY',
      id: '22222222-3333-4444-8555-666666666666',
      table: 'pqvd_equipment',
      fields: {},
      refs: { pqvd_canaryrunid: 'RUN-P01' },
    },
  );
  const b = buildBlueprint(s, c),
    leaf = b.nodes.find((n) => n.key === 'TESTRUNNER-CANARYCLEANUP-EQUIPMENT');
  assert.deepEqual(leaf.privileges, {
    read: false,
    create: false,
    write: false,
    delete: true,
    append: false,
    appendTo: false,
  });
  assert.equal(
    b.nodes.some((n) => n.role !== 'TESTRUNNER' && n.table === 'pqvd_equipment' && n.privileges.delete),
    false,
  );
  const effective = evaluateConfiguredGraph(b, s, c, 'P07');
  assert.equal(effective.get('OWN-CANARY').privileges.has('delete'), true);
  assert.equal(effective.get('OWN-CANARY').privileges.has('read'), false);
  assert.equal(effective.has('FOREIGN-CANARY'), false);
  leaf.privileges.read = true;
  assert.throws(() => validateBlueprint(b, s), /Unexpected Delete/);
});

test('complete-subtree deep lease disables leaves first, restores roots first even when callback fails', async () => {
  const b = buildBlueprint(schema, catalogue),
    v = configureDeepVariant(b);
  assert.equal(b.nodes.find((n) => n.key === 'IT-EQUIPMENT-SERVICEREQUEST').active, true);
  assert.deepEqual(
    v.nodes.filter((n, i) => n.active !== b.nodes[i].active).map((n) => n.key),
    deepVariantKeys,
  );
  assert.equal(validateBlueprint(v, schema).maxWorkforceDepth, 11);
  const site = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    rows = new Map(
      deepVariantKeys.map((key) => {
        const id = componentId('permission:' + key);
        return [
          id,
          {
            powerpagecomponentid: id,
            name: 'CO ' + key,
            powerpagecomponenttype: 18,
            _powerpagesiteid_value: site,
            statecode: 0,
            statuscode: 1,
            content: '{"invented":true}',
            '@odata.etag': 'W/"1"',
          },
        ];
      }),
    ),
    journal = [],
    writes = [];
  const client = {
    get: async (endpoint) => ({ ...rows.get(endpoint.slice(20, -1)) }),
    request: async (endpoint, options) => {
      const row = rows.get(endpoint.slice(20, -1));
      assert.equal(options.ifMatch, row['@odata.etag']);
      assert.ok(
        journal.some(
          (e) =>
            e.id === row.powerpagecomponentid &&
            e.state === (options.body.statecode === 1 ? 'before-node-deactivation' : 'before-restoration'),
        ),
      );
      writes.push({ key: row.name.slice(3), state: options.body.statecode });
      Object.assign(row, options.body);
      row['@odata.etag'] = 'W/"2"';
      const states = deepVariantKeys.map((k) => rows.get(componentId('permission:' + k)).statecode);
      for (let i = 1; i < states.length; i++)
        assert.ok(states[i] === 1 || states[i - 1] === 0, 'no active child under inactive ancestor');
    },
  };
  await assert.rejects(
    () =>
      withDeepVariant(
        client,
        site,
        async () => {
          assert.ok([...rows.values()].every((r) => r.statecode === 1));
          throw new Error('Invented test callback failed');
        },
        { onProgress: (e) => journal.push(e) },
      ),
    /test callback failed/,
  );
  assert.ok([...rows.values()].every((r) => r.statecode === 0 && r.statuscode === 1));
  assert.equal(journal[0].before.content, '{"invented":true}');
  assert.equal(journal.at(-1).state, 'restored');
  assert.deepEqual(
    writes.filter((w) => w.state === 1).map((w) => w.key),
    [...deepVariantKeys].reverse(),
  );
  assert.deepEqual(
    writes.filter((w) => w.state === 0).map((w) => w.key),
    deepVariantKeys,
  );
});

test('default blueprint and deploy reject active orphan permissions before any remote call', async () => {
  const b = buildBlueprint(schema, catalogue);
  b.nodes.find((n) => n.key === 'IT-EQUIPMENT-SERVICEREQUEST').active = false;
  assert.throws(() => validateBlueprint(b, schema), /Active orphan/);
  await assert.rejects(
    () => deploySecurity({}, 'invented', b, { evidenceDirectory: '.paqvilo/invented' }),
    /Active orphan/,
  );
});

test('partial interrupted subtree activation recovery restores root-to-leaf and rejects missing snapshots', async () => {
  const site = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    org = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    records = deepVariantKeys.map((key) => ({
      key,
      id: componentId('permission:' + key),
      before: {
        powerpagecomponentid: componentId('permission:' + key),
        name: 'CO ' + key,
        powerpagecomponenttype: 18,
        _powerpagesiteid_value: site,
        statecode: 0,
        statuscode: 1,
        content: '{"invented":true}',
        '@odata.etag': 'W/"1"',
      },
    })),
    journal = {
      organisationId: org,
      siteId: site,
      variant: deepVariant,
      entries: records.map((r) => ({ state: 'before-activation', ...r })),
    },
    rows = new Map(
      records.map((r, i) => [
        r.id,
        { ...r.before, statecode: i >= 3 ? 1 : 0, statuscode: i >= 3 ? 2 : 1, '@odata.etag': 'W/"9"' },
      ]),
    ),
    writes = [];
  const client = {
    get: async (endpoint) => ({ ...rows.get(endpoint.slice(20, -1)) }),
    request: async (endpoint, options) => {
      const row = rows.get(endpoint.slice(20, -1));
      assert.equal(options.ifMatch, 'W/"9"');
      writes.push(row.name.slice(3));
      Object.assign(row, options.body);
    },
  };
  await restoreDeepVariant(client, journal, { siteId: site, expectedOrganisationId: org });
  assert.deepEqual(writes, deepVariantKeys.slice(3));
  assert.ok([...rows.values()].every((r) => r.statecode === 0));
  const bad = structuredClone(journal);
  bad.entries.pop();
  await assert.rejects(
    () => restoreDeepVariant(client, bad, { siteId: site, expectedOrganisationId: org }),
    /lacks the exact archived/,
  );
});

test('interrupted deep lease recovery validates archived identity, live drift, organisation and conditional restoration', async () => {
  const site = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    org = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    id = componentId('permission:IT-EQUIPMENT-SERVICEREQUEST'),
    before = {
      powerpagecomponentid: id,
      name: 'CO IT-EQUIPMENT-SERVICEREQUEST',
      powerpagecomponenttype: 18,
      _powerpagesiteid_value: site,
      statecode: 0,
      statuscode: 1,
      content: '{"invented":true}',
      '@odata.etag': 'W/"1"',
    },
    journal = {
      organisationId: org,
      siteId: site,
      variant: 'website-it-secondary-service-disabled',
      entries: [{ state: 'before-activation', id, before }],
    },
    writes = [],
    progress = [];
  let row = { ...before, statecode: 1, statuscode: 2, '@odata.etag': 'W/"90"' };
  const client = {
    get: async () => ({ ...row }),
    request: async (endpoint, options) => {
      assert.equal(endpoint, `powerpagecomponents(${id})`);
      assert.equal(options.ifMatch, 'W/"90"');
      writes.push(options.body);
      Object.assign(row, options.body);
    },
  };
  await restoreDeepVariant(client, journal, {
    siteId: site,
    expectedOrganisationId: org,
    onProgress: (e) => progress.push(e),
  });
  assert.equal(row.statecode, 0);
  assert.equal(progress.at(-1).state, 'restored');
  assert.equal(writes.length, 1);
  await restoreDeepVariant(client, journal, { siteId: site, expectedOrganisationId: org });
  assert.equal(writes.length, 1, 'already-restored recovery is read-only');
  await assert.rejects(
    () =>
      restoreDeepVariant(client, journal, {
        siteId: site,
        expectedOrganisationId: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',
      }),
    /organisation\/site\/variant/,
  );
  for (const mutation of [
    { content: 'unexpected' },
    { powerpagecomponenttype: 11 },
    { _powerpagesiteid_value: org },
    { name: 'Unrelated record' },
    { statecode: 2, statuscode: 9 },
  ]) {
    row = { ...before, statecode: 1, statuscode: 2, ...mutation };
    await assert.rejects(
      () => restoreDeepVariant(client, journal, { siteId: site, expectedOrganisationId: org }),
      /identity\/content drift|unqualified live activation/,
    );
    assert.equal(writes.length, 1);
  }
  row = { ...before, statecode: 1, statuscode: 2, '@odata.etag': 'W/"90"' };
  const forged = structuredClone(journal);
  forged.entries[0].before.powerpagecomponentid = org;
  await assert.rejects(
    () => restoreDeepVariant(client, forged, { siteId: site, expectedOrganisationId: org }),
    /baseline identity/,
  );
  await assert.rejects(
    () =>
      restoreDeepVariant({ ...client, request: async () => {} }, journal, {
        siteId: site,
        expectedOrganisationId: org,
      }),
    /restoration verification failed/,
  );
});

test('independent collision oracles and inactive-parent variant match configured graph', () => {
  const b = buildBlueprint(schema, catalogue),
    audit = auditScenarioOracles(b, schema, catalogue);
  assert.equal(audit.passed, true, JSON.stringify(audit.mismatch));
  assert.equal(audit.checked, 55);
  assert.equal(audit.runtimeVerified, false);
  const split = evaluateConfiguredGraph(b, schema, catalogue, 'P14');
  assert.equal(split.get('EQ-A-RIV-00').privileges.has('write'), false);
  assert.equal(split.get('EQ-B-LAKE-00').privileges.has('write'), true);
  assert.equal(split.has('TERM-ENG-P14-B-LAKE-main'), false);
  b.nodes.find((n) => n.key === 'AUDITOR-GRANTS-ACCESSPERMISSION').active = false;
  const revoked = evaluateConfiguredGraph(b, schema, catalogue, 'P17');
  assert.equal(revoked.has('EQ-A-HILL-00'), false);
  assert.equal(revoked.get('EQ-A-RIV-00').privileges.has('write'), true);
});

test('controlled stress role changes preserve recorder and unrelated assignments', () => {
  const b = buildBlueprint(schema, catalogue),
    persona = {
      key: 'P-STRESS',
      stress: true,
      webRoleVariants: [
        { id: 'roles-0', roles: [] },
        { id: 'roles-2', roles: ['HR', 'IT'] },
      ],
    },
    runner = componentId('role:TESTRUNNER'),
    foreign = '11111111-1111-4111-8111-111111111111';
  const p = planStressRoleVariant(b, persona, 0, [runner, componentId('role:HR'), foreign]);
  assert.deepEqual(p.remove, [componentId('role:HR')]);
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.preserved, [foreign]);
  const next = planStressRoleVariant(b, persona, 2, [runner, foreign]);
  assert.deepEqual(next.add, [componentId('role:HR'), componentId('role:IT')]);
  assert.equal(next.remove.length, 0);
  assert.throws(() => planStressRoleVariant(b, { ...persona, key: 'P01' }, 0, []), /isolated stress/);
  assert.throws(() => planStressRoleVariant(b, persona, 3, []), /0\/1\/2/);
});

test('scoped reference projections are idempotent, revoked grants clear, leaves cannot widen business scope', () => {
  const s = extendReferenceSchema(structuredClone(schema)),
    c = extendReferenceCatalogue(structuredClone(catalogue), s),
    original = c.associations.length;
  extendReferenceSchema(s);
  extendReferenceCatalogue(c, s);
  assert.equal(c.associations.length, original);
  const b = buildBlueprint(s, c),
    leaves = b.nodes.filter((n) => n.key.includes('REFERENCE'));
  assert.equal(leaves.length, 18);
  for (const leaf of leaves) {
    assert.equal(
      b.nodes.some((n) => n.parent === leaf.key),
      false,
    );
    assert.equal(leaf.privileges.create, false);
    assert.equal(leaf.privileges.write, false);
    assert.equal(leaf.privileges.delete, false);
  }
  for (const grant of c.records.filter(
    (r) =>
      r.table === 'pqvd_accesspermission' && !Object.keys(r.refs).some((k) => k.endsWith('principalid') && r.refs[k]),
  ))
    assert.equal(
      c.associations
        .filter((a) => a.from === grant.key && a.relationship.startsWith('pqvd_access_reference'))
        .flatMap((a) => a.to).length,
      0,
    );
  const hr = c.personas
    .find((p) => p.key === 'P14')
    .grants.find((key) => c.records.find((r) => r.key === key).refs.pqvd_hrprincipalid);
  assert.ok(c.associations.find((a) => a.from === hr && a.relationship === 'pqvd_access_currencies').to.length);
  const employee = c.personas.find((p) => p.key === 'P04').grants[0];
  assert.equal(
    c.associations.find((a) => a.from === employee && a.relationship === 'pqvd_access_currencies').to.length,
    0,
  );
  assert.equal(auditScenarioOracles(b, s, c).passed, true);
  const itRoom = b.nodes.find((n) => n.role === 'IT' && n.table === 'pqvd_room');
  assert.equal(itRoom.privileges.appendTo, true);
  assert.equal(itRoom.privileges.append, true);
  assert.equal(itRoom.privileges.write, false);
  assert.equal(itRoom.privileges.create, false);
  assert.equal(itRoom.privileges.delete, false);
});

test('portal packaging discovers component types and uses valid non-Entity flags', async () => {
  const siteId = '11111111-1111-4111-8111-111111111111',
    solutionId = '22222222-2222-4222-8222-222222222222',
    publisherId = '33333333-3333-4333-8333-333333333333',
    componentId = '44444444-4444-4444-8444-444444444444',
    requests = [],
    members = [];
  const client = {
    get: async () => ({ name: 'Invented isolated site', datamodelversion: '2.0', enhancedauthorization: 0 }),
    list: async (query) => {
      if (query.startsWith('solutioncomponentdefinitions'))
        return [
          { name: 'powerpagesite', solutioncomponenttype: 90436 },
          { name: 'powerpagecomponent', solutioncomponenttype: 90435 },
          { name: 'powerpagesitelanguage', solutioncomponenttype: 90437 },
        ];
      if (query.startsWith('powerpagecomponents')) {
        assert.ok(query.includes(siteId));
        return [{ name: 'Invented role', powerpagecomponentid: componentId }];
      }
      if (query.startsWith('powerpagesitelanguages')) return [];
      if (query.startsWith('publishers')) return [{ publisherid: publisherId }];
      if (query.startsWith('solutions')) return [{ solutionid: solutionId, _publisherid_value: publisherId }];
      if (query.startsWith('solutioncomponents')) return members;
      throw new Error('Unexpected fixture query ' + query);
    },
    request: async (endpoint, { body }) => {
      assert.equal(endpoint, 'AddSolutionComponent');
      assert.equal(body.DoNotIncludeSubcomponents, false);
      assert.equal(body.AddRequiredComponents, false);
      requests.push(body);
      members.push({ objectid: body.ComponentId, componenttype: body.ComponentType });
    },
  };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'co-security-')),
    dir = path.join(temp, '.paqvilo/portal-security');
  try {
    const result = await packagePortal({ client, siteId, apply: true, evidenceDirectory: dir });
    assert.equal(result.verification.siteCount, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].ComponentType, 90436);
    assert.equal(requests[1].ComponentType, 90435);
  } finally {
    const resolved = path.resolve(temp),
      parent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(parent));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

test('actual tester overlay preserves identity and binds own employment with unique private keys', async () => {
  const stress = JSON.parse(await fs.readFile(new URL('../data/stress-catalogue.json', import.meta.url))),
    contact = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    base = buildTesterOverlay(stress, contact),
    copy = buildTesterOverlay(stress, contact.toUpperCase());
  assert.equal(base.records[1].id, copy.records[1].id);
  assert.deepEqual(base.records[0].fields, {});
  assert.equal(base.records[0].existingOnly, true);
  assert.equal(base.personas[0].webRoles[0], 'IT');
  assert.equal(base.records[1].refs.pqvd_granteecontactid, 'P-ACTUAL');
  const full = buildStressTesterOverlay(stress, base),
    rows = new Map([...stress.records, ...full.records].map((r) => [r.key, r]));
  assert.equal(full.provenance.newGrantKeys.length, 11);
  assert.equal(full.provenance.temporaryRecordKeys.length, 18);
  for (const g of full.records.filter(
    (r) => r.table === 'pqvd_accesspermission' && r.fields.pqvd_scopekey.startsWith('ENG-'),
  )) {
    const job = rows.get(g.refs.pqvd_employmentid),
      member = rows.get(job.refs.pqvd_orgcontactid);
    assert.equal(member.refs.pqvd_contactid, 'P-ACTUAL');
    assert.equal(g.fields.pqvd_scopekey, 'ENG-' + job.id.replaceAll('-', ''));
  }
  const other = buildStressTesterOverlay(stress, buildTesterOverlay(stress, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'));
  assert.notEqual(
    full.records.find((r) => r.key === 'G-P-ACTUAL-STRESS-HR').fields.pqvd_number,
    other.records.find((r) => r.key === 'G-P-ACTUAL-STRESS-HR').fields.pqvd_number,
  );
  assert.throws(() => buildTesterOverlay(stress, stress.personas[0].contactId), /fixture persona/);
  assert.throws(() => buildTesterOverlay(stress, 'not-guid'), /GUID/);
});

test('tester record reconciliation refuses takeover and unexpected projections, explicit reset uses ETag', async () => {
  const actor = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    account = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    grantId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',
    c = {
      tables: [
        { name: 'contact', entitySet: 'contacts', primaryId: 'contactid' },
        { name: 'account', entitySet: 'accounts', primaryId: 'accountid' },
        { name: 'pqvd_accesspermission', entitySet: 'pqvd_accesspermissions', primaryId: 'pqvd_accesspermissionid' },
      ],
      records: [{ key: 'A', table: 'account', id: account }],
    },
    o = {
      records: [
        { key: 'ACTOR', id: actor, table: 'contact', fields: {}, refs: {} },
        {
          key: 'GRANT',
          id: grantId,
          table: 'pqvd_accesspermission',
          fields: { pqvd_name: 'Private grant', pqvd_accessstate: 1 },
          refs: { pqvd_granteecontactid: 'ACTOR', pqvd_itprincipalid: 'ACTOR', pqvd_scopeaccountid: 'A' },
        },
      ],
      personas: [{ key: 'ACTOR', contactId: actor }],
      associations: [{ relationship: 'pqvd_access_accounts', from: 'GRANT', to: ['A'] }],
    },
    requests = [],
    journal = [];
  let row = {
      pqvd_accesspermissionid: grantId,
      pqvd_name: 'Private grant',
      pqvd_accessstate: 4,
      _pqvd_granteecontactid_value: actor,
      _pqvd_itprincipalid_value: null,
      _pqvd_scopeaccountid_value: account,
      '@odata.etag': 'W/"12"',
    },
    extra = false;
  const client = {
    get: async () => ({ contactid: actor }),
    optional: async () => row,
    list: async (query) =>
      query.startsWith('EntityDefinitions')
        ? [
            {
              ReferencingAttribute: 'pqvd_granteecontactid',
              ReferencedEntity: 'contact',
              ReferencingEntityNavigationPropertyName: 'pqvd_granteecontactid',
            },
            {
              ReferencingAttribute: 'pqvd_itprincipalid',
              ReferencedEntity: 'contact',
              ReferencingEntityNavigationPropertyName: 'pqvd_itprincipalid',
            },
            {
              ReferencingAttribute: 'pqvd_scopeaccountid',
              ReferencedEntity: 'account',
              ReferencingEntityNavigationPropertyName: 'pqvd_scopeaccountid',
            },
          ]
        : query.startsWith('RelationshipDefinitions')
          ? [
              {
                Entity1LogicalName: 'pqvd_accesspermission',
                Entity2LogicalName: 'account',
                Entity1NavigationPropertyName: 'pqvd_access_accounts',
              },
            ]
          : extra
            ? [{ accountid: 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb' }]
            : [],
    request: async (endpoint, options) => {
      requests.push({ endpoint, options });
    },
    url: (p) => 'https://invented.example/api/data/v9.2/' + p,
  };
  await assert.rejects(() => applyTesterRecords(client, c, o, { apply: true }), /identity\/value drift/);
  assert.equal(requests.length, 0);
  await applyTesterRecords(client, c, o, {
    apply: true,
    allowManagedReset: true,
    managedRevokedState: 4,
    onProgress: (e) => journal.push(e),
  });
  assert.equal(requests[0].options.ifMatch, 'W/"12"');
  assert.equal(journal[0].before._pqvd_itprincipalid_value, null);
  requests.length = 0;
  row = { ...row, pqvd_accessstate: 1, _pqvd_itprincipalid_value: actor };
  extra = true;
  await assert.rejects(() => applyTesterRecords(client, c, o, { apply: true }), /Unexpected private projection/);
  assert.equal(requests.length, 0);
  extra = false;
  row._pqvd_scopeaccountid_value = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
  await assert.rejects(
    () => applyTesterRecords(client, c, o, { apply: true, allowManagedReset: true, managedRevokedState: 4 }),
    /identity\/value drift/,
  );
  assert.equal(requests.length, 0);
  o.provenance = { newGrantKeys: ['GRANT'] };
  await assert.rejects(
    () => resetTesterRecords(client, c, o, { apply: true, managedRevokedState: 4 }),
    /identity\/value drift/,
  );
  assert.equal(requests.length, 0);
  row._pqvd_scopeaccountid_value = account;
  const resetJournal = [],
    resetClient = {
      ...client,
      get: async (query) => (query.startsWith('contacts') ? { contactid: actor } : row),
      request: async (endpoint, options) => {
        requests.push({ endpoint, options });
        assert.ok(resetJournal.some((e) => e.kind === 'reset-grant' && e.before?.['@odata.etag'] === 'W/"12"'));
        if (options.method === 'PATCH') {
          row.pqvd_accessstate = options.body.pqvd_accessstate;
          row._pqvd_itprincipalid_value = null;
        }
      },
    };
  const reset = await resetTesterRecords(resetClient, c, o, {
    apply: true,
    managedRevokedState: 4,
    onProgress: (e) => resetJournal.push(e),
  });
  assert.equal(reset.plans.length, 1);
  assert.equal(requests[0].options.ifMatch, 'W/"12"');
  assert.equal(requests[0].options.body['pqvd_itprincipalid@odata.bind'], null);
  assert.equal(resetJournal.at(-1).kind, 'reset-grant-verified');
});
