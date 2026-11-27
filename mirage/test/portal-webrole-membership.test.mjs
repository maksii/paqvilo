// @test-kind security: a portal $ref changes a contact's web role membership only with the association grants, Write on the request's row and a listed navigation; a refused request leaves the memberships as they were.
// The web role memberships of an enhanced data model site (site-tables.mjs, data.mjs storeSiteMembership) through the
// portal Web API: an invented export whose contact holds one web role and whose table permissions are exported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

const G = (n) => `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CONTACT = G(1),
  RUNNER = G(2),
  TARGET = G(3);
const MEMBERSHIP = '/_api/contacts(' + CONTACT + ')/powerpagecomponent_mspp_webrole_contact';

const xmlText = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const component = (id, type, name, content) =>
  `<powerpagecomponent powerpagecomponentid="${id}"><name>${xmlText(name)}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><content>${xmlText(JSON.stringify(content))}</content><statecode>0</statecode></powerpagecomponent>`;
const permission = (id, table, scope, rights, role = RUNNER) =>
  component(id, 18, `Invented ${table}`, {
    entitylogicalname: table,
    entityname: `Invented ${table}`,
    scope,
    read: rights.includes('read'),
    write: rights.includes('write'),
    create: false,
    delete: false,
    append: rights.includes('append'),
    appendto: rights.includes('appendto'),
    adx_entitypermission_webrole: [role],
  });

// contactRights: the Self-scope rights on contact; listed: whether contact lists the membership navigation.
function files({ contactRights = ['read', 'append', 'appendto', 'write'], componentRights, listed = true } = {}) {
  const settings = [
    ['Webapi/contact/enabled', 'true'],
    ['Webapi/contact/fields', `contactid,fullname${listed ? ',powerpagecomponent_mspp_webrole_contact' : ''}`],
    ['Webapi/powerpagecomponent/enabled', 'true'],
    ['Webapi/powerpagecomponent/fields', 'powerpagecomponentid,name'],
  ];
  return {
    'powerpagecomponents/runner/powerpagecomponent.xml': component(RUNNER, 11, 'Runner', { adx_name: 'Runner' }),
    'powerpagecomponents/target/powerpagecomponent.xml': component(TARGET, 11, 'Target', { adx_name: 'Target' }),
    'powerpagecomponents/home/powerpagecomponent.xml': component(G(4), 2, 'Home', {
      adx_webpageid: G(4),
      adx_name: 'Home',
      adx_partialurl: '/',
      adx_copy: '<p id="roles">{{ user.roles | join: "," }}</p>',
    }),
    'powerpagecomponents/contact/powerpagecomponent.xml': permission(G(10), 'contact', 756150004, contactRights),
    // The target role reads every contact.
    'powerpagecomponents/target-contacts/powerpagecomponent.xml': permission(
      G(12),
      'contact',
      756150000,
      ['read'],
      TARGET,
    ),
    'powerpagecomponents/components/powerpagecomponent.xml': permission(
      G(11),
      'powerpagecomponent',
      756150000,
      componentRights ?? ['read', 'append', 'appendto'],
    ),
    ...Object.fromEntries(
      settings.map(([name, value], index) => [
        `powerpagecomponents/setting-${index}/powerpagecomponent.xml`,
        component(G(100 + index), 9, name, { value, source: 0 }),
      ]),
    ),
  };
}

async function site(t, options = {}, { directory = null, stateFile = null } = {}) {
  let sourceDir = directory;
  if (!sourceDir) {
    sourceDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-webrole-membership-'));
    ownedFixture(t).remove(() => fs.rm(sourceDir, { recursive: true, force: true }));
    for (const [file, content] of Object.entries(files(options))) {
      await fs.mkdir(path.dirname(path.join(sourceDir, file)), { recursive: true });
      await fs.writeFile(path.join(sourceDir, file), content);
    }
  }
  const app = await createSimulator({
    sourceDir,
    dataModel: 'enhanced',
    watch: false,
    port: 0,
    ...(stateFile ? { stateFile } : {}),
    initial: {
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
      tables: {
        contact: [
          { contactid: CONTACT, fullname: 'Invented contact', statecode: 0 },
          { contactid: G(5), fullname: 'Other contact', statecode: 0 },
        ],
      },
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'exported',
        contactRoles: [{ contactId: CONTACT, roleId: RUNNER }],
        live: {},
        endpoints: [],
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const session = app.signIn(CONTACT);
  const call = async (method, address, body) => {
    const response = await fetch(app.url + address, {
      method,
      headers: {
        accept: 'application/json',
        cookie: session.cookieHeader,
        ...(method === 'GET' ? {} : { __RequestVerificationToken: app.portalToken }),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    return { status: response.status, error: data?.error ?? null, value: data?.value };
  };
  const associate = () =>
    call('POST', `${MEMBERSHIP}/$ref`, { '@odata.id': `${app.url}/_api/powerpagecomponents(${TARGET})` });
  const disassociate = () => call('DELETE', `${MEMBERSHIP}(${TARGET})/$ref`);
  const roles = async () =>
    /<p id="roles">([^<]*)<\/p>/
      .exec(await (await fetch(app.url + '/', { headers: { cookie: session.cookieHeader } })).text())?.[1]
      .split(',')
      .filter(Boolean)
      .sort();
  // What the visitor sees: the contacts the Web API reads (the target role's permission) and the roles Liquid shows. The
  // membership navigation itself is no read route of the hosted portal (hosted session F1 AUTH-03c, replay cases
  // portal-webrole-refs: read-contact-roles-nav answered 403 in both configurations), so it stays refused here.
  const reads = async () => {
    const navigation = await call('GET', `${MEMBERSHIP}?$select=name`);
    assert.equal(navigation.status, 403, 'the membership navigation is no read route');
    return {
      contacts: (await call('GET', '/_api/contacts?$select=fullname')).value?.map((row) => row.fullname).sort(),
      roles: await roles(),
    };
  };
  return { app, call, associate, disassociate, roles, reads, sourceDir };
}

test('a refused membership $ref leaves the memberships unchanged', async (t) => {
  for (const [options, status, code] of [
    [{ componentRights: ['read', 'appendto'] }, 403, '90040106'],
    [{ contactRights: ['read', 'append', 'appendto'] }, 403, '90040103'],
    [{ listed: false }, 403, '90040101'],
  ]) {
    const fixture = await site(t, options);
    const label = JSON.stringify(options);
    assert.deepEqual(await fixture.roles(), ['Runner'], label);
    const answer = await fixture.associate();
    assert.deepEqual([answer.status, answer.error?.code], [status, code], label);
    assert.deepEqual(await fixture.roles(), ['Runner'], label);
    assert.equal(fixture.app.store.state.tables.powerpagecomponent_mspp_webrole_contact, undefined, label);
  }
  // The intersect itself is never a writable table of the portal Web API.
  const fixture = await site(t);
  const direct = await fixture.call('POST', '/_api/powerpagecomponent_mspp_webrole_contacts', {
    contactid: CONTACT,
    powerpagecomponentid: TARGET,
  });
  assert.notEqual(direct.status, 204);
  assert.deepEqual(await fixture.roles(), ['Runner']);
});

// @test-kind contract+observation: the refusals before the change are the hosted ones (hosted session F1, summary-F1.md AUTH-03c, replay cases portal-webrole-refs); the stored change itself is Paqvilo's local model of a permitted association, which the hosted runs did not reach.
test('a permitted membership $ref changes the roles every portal surface reads and survives a restart', async (t) => {
  const stateDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-webrole-membership-state-'));
  ownedFixture(t).remove(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const stateFile = path.join(stateDirectory, 'state.json');
  const first = await site(t, {}, { stateFile });
  assert.deepEqual(await first.reads(), { contacts: ['Invented contact'], roles: ['Runner'] });
  assert.equal((await first.associate()).status, 204);
  assert.deepEqual(await first.roles(), ['Runner', 'Target'], 'Liquid user.roles');
  assert.deepEqual(
    await first.reads(),
    { contacts: ['Invented contact', 'Other contact'], roles: ['Runner', 'Target'] },
    'the table permissions of the new role and the roles Liquid shows',
  );
  assert.equal((await first.associate()).status, 204, 'associating again keeps one link');
  const links = () =>
    first.app.store
      .tableRows('powerpagecomponent_mspp_webrole_contact')
      .filter((row) => row.contactid === CONTACT)
      .map((row) => row.powerpagecomponentid)
      .sort();
  assert.deepEqual(links(), [RUNNER, TARGET]);
  await first.app.close();

  const second = await site(t, {}, { directory: first.sourceDir, stateFile });
  assert.deepEqual(await second.roles(), ['Runner', 'Target'], 'the stored membership after a restart');
  assert.equal((await second.disassociate()).status, 204);
  assert.deepEqual(await second.roles(), ['Runner']);
  assert.deepEqual(await second.reads(), { contacts: ['Invented contact'], roles: ['Runner'] });
  assert.equal((await second.disassociate()).status, 204, 'removing an absent link changes nothing');
  assert.deepEqual(await second.roles(), ['Runner']);
});
