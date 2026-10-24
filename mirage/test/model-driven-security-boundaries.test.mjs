import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSimulator } from '../server.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const guid = number => `${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const A = guid(1), B = guid(2), ROLE = guid(3), PERMISSION = guid(4), FIELDS = guid(5), APP = guid(6);
const STAFF_A = guid(7), STAFF_B = guid(8);
const field = (name, type = 'nvarchar', extra = '') => `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type>${extra}</attribute>`;

async function fixture(t, enabled = true, presets, unflaggedCore = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-staff-boundary-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, 'portal'), solution = path.join(directory, 'solution');
  const files = {
    'portal/website.yml': `adx_websiteid: ${guid(10)}\nadx_name: Invented security portal`,
    'portal/web-pages/Home.webpage.yml': `adx_webpageid: ${guid(11)}\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: ${guid(12)}`,
    'portal/page-templates/Main.pagetemplate.yml': `adx_pagetemplateid: ${guid(12)}\nadx_name: Main\nadx_webtemplateid: ${guid(13)}`,
    'portal/web-templates/Main.webtemplate.yml': `adx_webtemplateid: ${guid(13)}\nadx_name: Main`,
    'portal/web-templates/Main.webtemplate.source.html': '<p id="who">{{ user.fullname | default: "anonymous" }}</p>{% fetchxml records %}<fetch><entity name="new_business"><attribute name="new_name"/></entity></fetch>{% endfetchxml %}{% for row in records.results.entities %}<p>{{ row.new_name }}</p>{% endfor %}',
    'portal/webrole.yml': `adx_webroleid: ${ROLE}\nadx_name: Reader`,
    'portal/Own.tablepermission.yml': `adx_entitypermissionid: ${PERMISSION}\nadx_name: Own contact records\nadx_entitylogicalname: new_business\nadx_scope: 756150001\nadx_contactrelationship: new_business_contact\nadx_read: true\nadx_write: true\nadx_entitypermission_webrole:\n- ${ROLE}`,
    'portal/sitesetting.yml': `- adx_sitesettingid: ${guid(14)}\n  adx_name: Webapi/new_business/enabled\n  adx_value: "true"\n- adx_sitesettingid: ${FIELDS}\n  adx_name: Webapi/new_business/fields\n  adx_value: new_name,new_contactid`,
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedSecurity</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/new_business/Entity.xml': `<Entity><Name>new_business</Name><EntityInfo><entity Name="new_business"><EntitySetName>new_businesses</EntitySetName><OwnershipTypeMask>UserOwned</OwnershipTypeMask><PrimaryIdAttribute>new_businessid</PrimaryIdAttribute><PrimaryNameAttribute>new_name</PrimaryNameAttribute><attributes>${field('new_businessid', 'primarykey')}${field('new_name')}${field('new_secret', 'nvarchar', '<IsSecured>1</IsSecured>')}${field('new_contactid', 'lookup')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Other/Relationships.xml': '<EntityRelationships><EntityRelationship Name="new_business_contact"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencedEntityName>contact</ReferencedEntityName><ReferencedAttributeName>contactid</ReferencedAttributeName><ReferencingEntityName>new_business</ReferencingEntityName><ReferencingAttributeName>new_contactid</ReferencingAttributeName><EntityRelationshipRoles><EntityRelationshipRole><RelationshipRoleType>1</RelationshipRoleType><NavigationPropertyName>new_contactid</NavigationPropertyName></EntityRelationshipRole><EntityRelationshipRole><RelationshipRoleType>0</RelationshipRoleType><NavigationPropertyName>new_businesses</NavigationPropertyName></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship></EntityRelationships>',
  };
  for (const [name, content] of Object.entries(files)) { const file = path.join(directory, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const variable = `PAQVILO_STAFF_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  process.env[variable] = 'invented-secret'; ownedFixture(t).add(() => { delete process.env[variable]; });
  const sim = await createSimulator({ sourceDir, solutionRoots: [solution], watch: false, dataverse: { enabled,
    applications: [{ appId: APP, displayName: 'Invented boundary client', secretEnvironmentVariable: variable, roles: ['System Administrator'] }],
    users: [{ objectId: STAFF_A, domainname: 'staff-a@example.test', fullname: 'Staff A', roles: ['Basic User'] }, { objectId: STAFF_B, domainname: 'staff-b@example.test', fullname: 'Staff B', roles: ['Basic User'] }] },
    initial: { ...(presets ? { presets } : {}), mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
      ...(unflaggedCore ? Object.fromEntries(['organization', 'systemuser', 'role', 'customapi'].map(name => [name, { entitySet: name === 'customapi' ? 'customapis' : `${name}s`, idColumn: `${name}id`, userConfigured: true, metadataSources: ['invented-configured-core'] }])) : {}) }, tables: { contact: [{ contactid: A, fullname: 'Contact A', statecode: 0 }, { contactid: B, fullname: 'Contact B', statecode: 0 }] },
      settings: { permissionMode: 'enforce' }, simulator: { mode: 'local', pageMode: 'local', permissionSource: 'exported', identity: { roles: [] }, contactRoles: [{ contactId: A, roleId: ROLE }, { contactId: B, roleId: ROLE }] } } });
  ownedFixture(t).add(() => sim.close());
  const request = (route, { method = 'GET', body, cookie, etag, bearer } = {}) => fetch(sim.url + route, { method,
    headers: { 'x-sim-csrf': sim.csrf, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(etag ? { 'if-match': etag } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = async (response, expected = 200) => { const text = await response.text(); assert.equal(response.status, expected, text); return text ? JSON.parse(text) : null; };
  const select = async id => { const response = await request('/_sim/api/dataverse/session', { method: 'POST', body: { userId: id } }); await json(response); return response.headers.get('set-cookie').split(';')[0]; };
  return { sim, request, json, select, files, directory };
}

test('portal MDA keeps canonical staff security and source record versions with HTTP disabled', async t => {
  const { sim, request, json, select } = await fixture(t, false);
  assert.equal(sim.dataverse, null);
  const staff = (await json(await request('/_sim/api/dataverse/session'))).users;
  const one = await select(staff.find(user => user.name === 'Staff A').id), two = await select(staff.find(user => user.name === 'Staff B').id);
  const made = await json(await request('/_apps/api/tables/new_business', { method: 'POST', cookie: one, body: { new_name: 'Headless owned record' } }), 201);
  assert.equal((await json(await request(`/_apps/api/tables/new_business/${made.id}`, { cookie: one }))).row.new_name, 'Headless owned record');
  assert.equal((await json(await request(`/_apps/api/tables/new_business/${made.id}`, { cookie: two }), 403)).error.code, 'AccessDenied');
  await json(await request(`/_apps/api/tables/new_business/${made.id}`, { method: 'PATCH', etag: made.etag, body: { new_secret: 'Invented protected value' } }));
  const query = '/_apps/api/tables/new_business?query=' + encodeURIComponent(JSON.stringify({ scope: 'odata', options: '?$select=new_name,new_secret&$filter=contains(new_name,\'owned\')' }));
  const ownerQuery = await json(await request(query, { cookie: one }));
  assert.deepEqual(ownerQuery.entities.map(row => row.new_name), ['Headless owned record']);
  assert.equal(ownerQuery.entities[0].new_secret ?? null, null);
  assert.deepEqual((await json(await request(query, { cookie: two }))).entities, [], 'canonical script queries retain staff row access');
  const setting = await json(await request('/_apps/api/tables/adx_sitesetting', { method: 'POST', body: { adx_name: 'Example/Created', adx_value: 'Created', adx_websiteid: guid(10) } }), 201);
  await json(await request(`/_apps/api/tables/adx_sitesetting/${setting.id}`, { method: 'DELETE', etag: setting.etag }));
});

test('business presets preserve omitted organization users, credentials, roles and browser staff sessions', async t => {
  const presets = { emptyBusiness: { name: 'Empty invented business', userConfigured: true,
    mappings: { new_business: { entitySet: 'new_businesses', idColumn: 'new_businessid', nameColumn: 'new_name' } }, tables: { new_business: [] } } };
  const { sim, request, json, select } = await fixture(t, true, presets, true);
  for (const name of ['organization', 'systemuser', 'role', 'customapi']) assert.equal(sim.store.state.mappings[name].dataverseOnly, undefined);
  const user = await json(await request('/_sim/api/dataverse/users', { method: 'POST', body: { fullname: 'Preset staff', domainname: 'preset@example.test', roles: ['Basic User'] } }), 201);
  const staffCookie = await select(user.systemuserid);
  await json(await request('/_apps/api/tables/new_business', { method: 'POST', cookie: staffCookie, body: { new_name: 'Before preset' } }), 201);
  const application = await json(await request('/_sim/api/dataverse/applications', { method: 'POST', body: { appId: guid(90), displayName: 'Preset integration', roles: ['System Administrator'] } }), 201);
  const token = async () => json(await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: application.appId, client_secret: application.secret, scope: sim.dataverse.origin + '/.default' }) }));
  const before = structuredClone({ applications: sim.store.state.dataverse.applications, roles: sim.store.tableRows('role'), grants: sim.store.tableRows('systemuserroles') });
  await sim.store.transact(() => sim.store.state.tables.customapi.push({ customapiid: guid(91), uniquename: 'new_PresetOperation', name: 'Preserved operation', bindingtype: 0, isfunction: false }));
  await token();
  await json(await request('/_sim/api/presets/emptyBusiness/apply', { method: 'POST', body: {} }));
  assert.deepEqual(sim.store.tableRows('new_business'), [], 'The explicitly authored business table is replaced.');
  assert.deepEqual(sim.store.state.dataverse.applications, before.applications);
  assert.deepEqual(sim.store.tableRows('role'), before.roles);
  assert.deepEqual(sim.store.tableRows('systemuserroles'), before.grants);
  assert.ok(sim.store.tableRows('customapi').some(row => row.customapiid === guid(91)));
  assert.ok(sim.store.tableRows('organization').some(row => row.organizationid === sim.store.state.dataverse.organizationId));
  const session = await json(await request('/_sim/api/dataverse/session', { cookie: staffCookie }));
  assert.equal(session.current.principalId, user.systemuserid); assert.ok(session.current.roles.includes('Basic User'));
  const renewed = await token();
  await json(await fetch(sim.dataverse.origin + '/api/data/v9.2/WhoAmI', { headers: { authorization: `Bearer ${renewed.access_token}` } }));
  await json(await request('/_apps/api/tables/new_business', { method: 'POST', cookie: staffCookie, body: { new_name: 'Staff remains authorized' } }), 201);
});

test('API, model app and contact portal share records while preserving each security boundary', async t => {
  const { sim, request, json, select, files, directory } = await fixture(t);
  const tokenResponse = await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: APP, client_secret: 'invented-secret', scope: sim.dataverse.origin + '/.default' }) });
  const token = (await json(tokenResponse)).access_token;
  const api = (route, { method = 'GET', body, cookie, staffId } = {}) => fetch(sim.dataverse.origin + '/api/data/v9.2/' + route, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(staffId ? { mscrmcallerid: staffId } : {}), prefer: 'return=representation' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const staff = (await json(await request('/_sim/api/dataverse/session'))).users;
  const staffA = staff.find(user => user.name === 'Staff A'), staffB = staff.find(user => user.name === 'Staff B');
  const one = await select(staffA.id), two = await select(staffB.id);
  const portalA = sim.signIn(A).cookieHeader, portalB = sim.signIn(B).cookieHeader;
  const persona = structuredClone(sim.store.state.simulator.identity);
  const made = await json(await api('new_businesses', { method: 'POST', staffId: staffA.id, body: { new_name: 'Shared boundary record' } }), 201);
  const id = made.new_businessid;
  assert.equal(sim.store.state.mappings.new_business.fieldMetadata.new_secret.isSecured, true);
  await json(await api(`new_businesses(${id})`, { method: 'PATCH', body: { new_secret: 'Privileged value', 'new_contactid@odata.bind': `/contacts(${A})` } }));
  const mda = await json(await request(`/_apps/api/tables/new_business/${id}`, { cookie: one }));
  assert.equal(mda.row.new_secret, null); assert.equal(mda.capabilities.fields.new_secret.update, false);
  assert.equal((await json(await request(`/_apps/api/tables/new_business/${id}`, { cookie: two }), 403)).error.code, 'AccessDenied');
  await json(await request(`/_apps/api/tables/new_business/${id}`, { cookie: one, method: 'PATCH', etag: mda.etag, body: { new_name: 'Changed by staff' } }));
  assert.equal((await json(await api(`new_businesses(${id})`))).new_name, 'Changed by staff');
  const portalRoute = '/_api/new_businesses?$select=new_name';
  assert.ok(sim.store.state.permissions.find(rule => rule.id === PERMISSION), JSON.stringify(sim.store.state.permissions));
  assert.equal(sim.store.state.permissions.find(rule => rule.id === PERMISSION)?.disabledReason, undefined, JSON.stringify(sim.store.state.permissions));
  assert.deepEqual((await json(await request(portalRoute, { cookie: portalA }))).value.map(row => row.new_name), ['Changed by staff']);
  assert.deepEqual((await json(await request(portalRoute, { cookie: portalB }))).value, []);
  assert.equal((await request(portalRoute)).status, 403);
  assert.match(await (await request('/', { cookie: portalA })).text(), /Changed by staff/);
  assert.doesNotMatch(await (await request('/', { cookie: portalB })).text(), /Changed by staff/);
  assert.doesNotMatch(await (await request('/')).text(), /Changed by staff/);
  assert.equal((await fetch(sim.dataverse.origin + '/api/data/v9.2/new_businesses', { headers: { cookie: portalA } })).status, 401);
  assert.equal((await request(portalRoute, { bearer: token })).status, 403);
  assert.deepEqual(sim.store.state.simulator.identity, persona);
  assert.match(await (await request('/', { cookie: `${portalA}; ${two}` })).text(), /Changed by staff/, 'Staff choice cannot replace the contact session.');
  const allowlist = await json(await request(`/_apps/api/tables/adx_sitesetting/${FIELDS}`));
  await json(await request(`/_apps/api/tables/adx_sitesetting/${FIELDS}`, { method: 'PATCH', etag: allowlist.etag, body: { adx_value: 'new_businessid' } }));
  assert.deepEqual((await json(await request(portalRoute, { cookie: portalA }), 403)).error, { code: '90040101', message: 'Attribute new_name in table new_business is not enabled for Web Api.' });
  await json(await api(`adx_sitesettings(${FIELDS})`, { method: 'PATCH', body: { adx_value: 'new_name,new_contactid' } }));
  assert.equal((await request(portalRoute, { cookie: portalA })).status, 200);
  const ledger = structuredClone(sim.store.state.permissions);
  const failed = await api('$batch', { method: 'POST', body: { requests: [
    { id: 'permission', atomicityGroup: 'failed-policy', method: 'PATCH', url: `/api/data/v9.2/adx_entitypermissions(${PERMISSION})`, body: { adx_read: false } },
    { id: 'invalid', atomicityGroup: 'failed-policy', dependsOn: ['permission'], method: 'POST', url: '/api/data/v9.2/new_businesses', body: { unknown_field: 'refused' } },
  ] } });
  assert.equal(failed.status, 400, await failed.text());
  assert.deepEqual(sim.store.state.permissions, ledger);
  assert.equal((await request(portalRoute, { cookie: portalA })).status, 200);
  const permission = await json(await request(`/_apps/api/tables/adx_entitypermission/${PERMISSION}`));
  await json(await request(`/_apps/api/tables/adx_entitypermission/${PERMISSION}`, { method: 'PATCH', etag: permission.etag, body: { adx_read: false } }));
  assert.equal((await request(portalRoute, { cookie: portalA })).status, 403);
  assert.doesNotMatch(await (await request('/', { cookie: portalA })).text(), /Changed by staff/);
  await json(await api(`adx_entitypermissions(${PERMISSION})`, { method: 'PATCH', body: { adx_read: true } }));
  assert.equal((await request(portalRoute, { cookie: portalA })).status, 200);
  for (const [name, source] of Object.entries(files)) assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), source, 'Exported source bytes remain immutable.');
});
