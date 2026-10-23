// Enhanced Power Pages authorization at run time (portal-authorization.mjs). Learn: security/unify-pages-security-with-dataverse,
// security/column-security-profile, powerpagesite enhancedauthorization 0-3. Invented site, tables and data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { platformChangeDiagnostics } from '../lib/platform-changes.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { portalAuthorizationModel } from '../lib/portal-authorization.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const text = { dataverseType: 'nvarchar' };
const files = (state) => ({
  'website.yml': `adx_websiteid: 77777777-7777-4777-8777-777777777777\nadx_name: Invented\nadx_enhancedauthorization: ${state}`,
  'webrole.yml': '- adx_webroleid: 77777777-7777-4777-8777-777777777701\n  adx_name: Member\n- adx_webroleid: 77777777-7777-4777-8777-777777777702\n  adx_name: Reviewer',
  'sitesetting.yml': [['x_item', 'x_name,x_contactid,x_secret'], ['x_order', 'x_name,x_accountid'], ['x_line', 'x_name,x_orderid']].flatMap(([table, fields], index) => [
    `- adx_sitesettingid: 77777777-7777-4777-8777-7777777778${index}0\n  adx_name: Webapi/${table}/enabled\n  adx_value: true`,
    `- adx_sitesettingid: 77777777-7777-4777-8777-7777777778${index}1\n  adx_name: Webapi/${table}/fields\n  adx_value: ${fields}`]).join('\n'),
  'sample.serverlogic.yml': 'adx_serverlogicid: sample\nadx_name: sample\nadx_serverlogic_adx_webrole:\n- 77777777-7777-4777-8777-777777777701',
  'sample.js': "function put(){ return Server.Connector.Dataverse.UpdateRecord('x_items', Server.Context.QueryParameters.id, Server.Context.Body); }",
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': '{% fetchxml rows %}<fetch><entity name="x_item"><attribute name="x_name"/><attribute name="x_secret"/><order attribute="x_name"/></entity></fetch>{% endfetchxml %}<ul>{% for row in rows.results.entities %}<li>{{ row.x_name }}={{ row.x_secret }}</li>{% endfor %}</ul>',
});
const MEMBER = '77777777-7777-4777-8777-777777777701', SITE = '77777777-7777-4777-8777-777777777777', TASK = '77777777-7777-4777-8777-777777777731';
const initial = () => ({
  version: 1,
  mappings: {
    contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    account: { entitySet: 'accounts', idColumn: 'accountid' },
    x_item: { entitySet: 'x_items', idColumn: 'x_itemid', fields: { x_name: text, x_contactid: text, x_secret: { ...text, columnMetadata: { isSecured: true } } } },
    x_order: { entitySet: 'x_orders', idColumn: 'x_orderid', fields: { x_name: text, x_accountid: text } },
    x_line: { entitySet: 'x_lines', idColumn: 'x_lineid', fields: { x_name: text, x_orderid: text } },
    x_task: { entitySet: 'x_tasks', idColumn: 'x_taskid', fields: { x_name: text } },
  },
  tables: {
    account: [{ accountid: 'acme', name: 'Acme' }, { accountid: 'other', name: 'Other' }],
    contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0, parentcustomerid: { id: 'acme', logical_name: 'account' } },
      { contactid: 'bea', fullname: 'Bea Other', statecode: 0 }],
    x_item: [{ x_itemid: 'i1', x_name: 'Own', x_contactid: 'alex', x_secret: 's1' }, { x_itemid: 'i2', x_name: 'Foreign', x_contactid: 'bea', x_secret: 's2' }],
    x_order: [{ x_orderid: 'o1', x_name: 'Acme order', x_accountid: 'acme' }, { x_orderid: 'o2', x_name: 'Other order', x_accountid: 'other' }],
    x_line: [{ x_lineid: 'l1', x_name: 'Acme line', x_orderid: 'o1' }, { x_lineid: 'l2', x_name: 'Other line', x_orderid: 'o2' }],
    x_task: [{ x_taskid: TASK, x_name: 'Task', statecode: 0, statuscode: 1 }],
  },
  permissions: [
    { id: 'items-read', name: 'Items read', entity: 'x_item', roles: ['Member'], operations: ['read', 'create'], scope: 'global' },
    { id: 'items-own', name: 'Items own', entity: 'x_item', roles: ['Member'], operations: ['update'], scope: 'contact', field: 'x_contactid' },
    { id: 'orders', name: 'Orders', entity: 'x_order', roles: ['Member'], operations: ['read', 'update'], scope: 'account', field: 'x_accountid' },
    { id: 'tasks', name: 'Tasks', entity: 'x_task', roles: ['Member'], operations: ['read', 'update'], scope: 'global' },
    { id: 'lines', name: 'Lines', entity: 'x_line', roles: ['Member'], operations: ['read'], scope: 'parent', parentPermissionId: 'orders', relationship: { entity: 'x_order', from: 'x_orderid', to: 'x_orderid' } },
  ],
  simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', live: { allowWrites: false }, endpoints: [], contactRoles: [{ contactId: 'alex', roleId: MEMBER }] },
});

async function site(t, state) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-authorization-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files(state))) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const sim = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), port: 0, watch: false, initial: initial() });
  ownedFixture(t).add(() => sim.close());
  const alex = signInHeaders(sim, 'alex');
  const call = (method, route, body, headers = alex) => fetch(sim.url + route, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json', __RequestVerificationToken: sim.state().csrf } : method === 'GET' ? {} : { __RequestVerificationToken: sim.state().csrf }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const ids = async (route, headers) => { const response = await call('GET', route, undefined, headers); return response.status === 200 ? (await response.json()).value.map(row => Object.values(row).find(value => /^[iol]\d$/.test(value))).sort() : response.status; };
  return { sim, call, ids, alex };
}
const mappedUser = (sim) => sim.store.tableRows('systemuser').find(row => row.fullname === 'Alex Local' && row.systemmanagedusertype === 1);

// What the visitor may read and write, as the portal answers it.
async function matrix({ call, ids }) {
  return {
    items: await ids('/_api/x_items?$select=x_name'),
    orders: await ids('/_api/x_orders?$select=x_name'),
    lines: await ids('/_api/x_lines?$select=x_name'),
    anonymous: await ids('/_api/x_items?$select=x_name', {}),
    patchOwn: (await call('PATCH', '/_api/x_items(i1)', { x_name: 'Own edited' })).status,
    patchForeign: (await call('PATCH', '/_api/x_items(i2)', { x_name: 'Foreign edited' })).status,
    patchOrder: (await call('PATCH', '/_api/x_orders(o2)', { x_name: 'Other edited' })).status,
    deleteOwn: (await call('DELETE', '/_api/x_items(i1)')).status,
  };
}

test('the same site grants exactly what its table permissions allow in states 0, 1, 2 and 3, and the models agree', async t => {
  const expected = { items: ['i1', 'i2'], orders: ['o1'], lines: ['l1'], anonymous: 403, patchOwn: 204, patchForeign: 403, patchOrder: 403, deleteOwn: 403 };
  for (const state of [0, 1, 2, 3]) {
    const fixture = await site(t, state);
    assert.deepEqual(await matrix(fixture), expected, `state ${state}`);
    const model = state ? 'enhanced' : 'standard';
    const diagnostics = fixture.sim.state().diagnostics;
    assert.deepEqual(diagnostics.filter(item => item.code === 'PORTAL_AUTHORIZATION_MODEL').map(item => [item.state, item.model]), [[state, model]]);
    const denied = diagnostics.find(item => item.code === 'TABLE_PERMISSION_DENIED');
    assert.equal(denied?.model, model, `state ${state}: the denial names the model`);
    // Enhanced: the visitor is a mapped Dataverse user holding the security role mapped to its web role; standard maps nobody.
    const user = mappedUser(fixture.sim);
    assert.equal(Boolean(user), state !== 0);
    if (user) {
      const roles = fixture.sim.store.tableRows('systemuserroles').filter(row => row.systemuserid.id === user.systemuserid).map(row => row.roleid.name);
      assert.deepEqual(roles, ['Member']);
      const own = fixture.sim.store.tableRows('x_item').find(row => row.x_itemid === 'i1');
      assert.equal(own.modifiedby?.id, user.systemuserid, 'the write runs as the mapped user (impersonation)');
    }
  }
});

test('a secured column is masked through the Dataverse column security profile in the enhanced states only', async t => {
  for (const state of [0, 3]) {
    const fixture = await site(t, state);
    const read = async () => (await (await fixture.call('GET', '/_api/x_items(i1)?$select=x_secret')).json()).x_secret;
    const page = async () => (await (await fetch(fixture.sim.url + '/', { headers: fixture.alex })).text()).match(/<li>.*?<\/li>/g);
    if (state === 0) {
      assert.equal(await read(), 's1');
      assert.deepEqual(await page(), ['<li>Foreign=s2</li>', '<li>Own=s1</li>']);
      assert.equal((await fixture.call('PATCH', '/_api/x_items(i1)', { x_secret: 'changed' })).status, 204);
      continue;
    }
    // No profile: Liquid and the Web API read null; a write of the column is refused.
    assert.equal(await read(), null);
    assert.deepEqual(await page(), ['<li>Foreign=</li>', '<li>Own=</li>']);
    assert.equal((await fixture.call('PATCH', '/_api/x_items(i1)', { x_secret: 'changed' })).status, 403);
    // A profile granting read (not update) assigned to the mapped user unmasks it; the write stays refused.
    const user = mappedUser(fixture.sim);
    await fixture.sim.store.transact(() => {
      const tables = fixture.sim.store.state.tables;
      const profile = { id: '77777777-7777-4777-8777-777777777720', logical_name: 'fieldsecurityprofile' };
      tables.fieldsecurityprofile.push({ fieldsecurityprofileid: profile.id, name: 'Invented readers' });
      tables.fieldpermission.push({ fieldpermissionid: '77777777-7777-4777-8777-777777777721', fieldsecurityprofileid: profile, entityname: 'x_item', attributelogicalname: 'x_secret', canread: 4, cancreate: 0, canupdate: 0, canreadunmasked: 0 });
      tables.systemuserprofiles.push({ systemuserprofileid: '77777777-7777-4777-8777-777777777722', systemuserid: { id: user.systemuserid, logical_name: 'systemuser' }, fieldsecurityprofileid: profile });
    });
    assert.equal(await read(), 's1');
    assert.deepEqual(await page(), ['<li>Foreign=s2</li>', '<li>Own=s1</li>']);
    assert.equal((await fixture.call('PATCH', '/_api/x_items(i1)', { x_secret: 'changed' })).status, 403);
  }
});

test('the Dataverse privilege of the mapped security role decides an enhanced grant', async t => {
  const fixture = await site(t, 3);
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  const role = fixture.sim.store.tableRows('role').find(row => row.name === 'Member');
  const read = fixture.sim.store.tableRows('privilege').find(row => /^prvRead/i.test(row.name) && /x_item$/i.test(row.name));
  // An administrator removes the read privilege from the mapped role in Dataverse: the table permission no longer grants.
  await fixture.sim.store.transact(() => {
    const rows = fixture.sim.store.state.tables.roleprivileges;
    rows.splice(rows.findIndex(row => row.roleid.id === role.roleid && row.privilegeid.id === read.privilegeid), 1);
  });
  assert.equal(await fixture.ids('/_api/x_items?$select=x_name'), 403);
});

test('Web API column permissions apply in the standard model and are bypassed in the enhanced model', async t => {
  for (const [state, status] of [[0, 403], [3, 200]]) {
    const fixture = await site(t, state);
    fixture.sim.portal.records.push(
      { kind: 'columnpermissionprofile', id: 'cpp', adx_name: 'Items', adx_tablename: 'x_item', adx_columnpermissionprofile_webrole: [MEMBER], adx_allcolumnpermissions: [746610001] },
      { kind: 'columnpermission', id: 'cp1', adx_columnpermissionprofileid: 'cpp', adx_columnname: 'x_name', adx_permissions: [746610002] });
    assert.equal((await fixture.call('GET', '/_api/x_items?$select=x_name')).status, status, `state ${state}`);
  }
});

test('an observed application user name never renames the mapped user in enhanced audit columns', async t => {
  for (const state of [0, 3]) {
    const fixture = await site(t, state);
    fixture.sim.store.setObserved({ ...fixture.sim.store.observed, portalApplicationUser: '# Portals-Invented' });
    assert.equal((await fixture.call('PATCH', '/_api/x_items(i1)', { x_name: 'Own edited' })).status, 204);
    const modified = fixture.sim.store.tableRows('x_item').find(row => row.x_itemid === 'i1').modifiedby;
    assert.equal(modified.name, state ? 'Alex Local' : '# Portals-Invented', `state ${state}`);
    if (state) assert.equal(modified.id, mappedUser(fixture.sim).systemuserid);
  }
});

test('the derived security roles mirror the current web roles', async t => {
  const fixture = await site(t, 3);
  await fixture.ids('/_api/x_items?$select=x_name');
  const roles = () => fixture.sim.store.tableRows('role').filter(row => ['Member', 'Reviewer'].includes(row.name)).map(row => row.name).sort();
  assert.deepEqual(roles(), ['Member', 'Reviewer']);
  const reviewer = fixture.sim.store.tableRows('role').find(row => row.name === 'Reviewer').roleid;
  const records = fixture.sim.portal.records;
  records.splice(records.findIndex(record => record.kind === 'webrole' && record.name === 'Reviewer'), 1);
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  assert.deepEqual(roles(), ['Member'], 'the role of a removed web role is removed');
  assert.ok(!fixture.sim.store.tableRows('roleprivileges').some(row => row.roleid.id === reviewer));
});

// RC2-01: every portal write runs through form-service.mjs portalRecordWrites (the mapped user, column security).
test('server logic and list action writes run as the mapped user under column security', async t => {
  for (const state of [0, 3]) {
    const fixture = await site(t, state), { sim } = fixture;
    for (const item of (await (await fetch(sim.url + '/__sim/api/operations')).json()).items.filter(entry => entry.kind === 'server-logic'))
      await fetch(sim.url + '/__sim/api/operations/' + encodeURIComponent(item.key), { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf }, body: '{"mode":"exported"}' });
    const logic = async (body) => JSON.parse((await (await fixture.call('PUT', '/_api/serverlogics/sample?id=i1', body)).json()).data);
    const secret = await logic({ x_secret: 'by logic' });
    assert.equal(secret.StatusCode, state ? 403 : 204, `state ${state}: a secured column through server logic`);
    assert.equal((await logic({ x_name: 'by logic' })).StatusCode, 204);
    const deactivated = await fetch(`${sim.url}/_services/action-deactivate/${SITE}`, { method: 'POST',
      headers: { ...fixture.alex, 'content-type': 'application/json', __RequestVerificationToken: sim.state().csrf }, body: JSON.stringify({ LogicalName: 'x_task', Id: TASK }) });
    assert.equal(deactivated.status, 204, await deactivated.text());
    const task = sim.store.tableRows('x_task')[0], item = sim.store.tableRows('x_item').find(row => row.x_itemid === 'i1');
    assert.equal(task.statecode, 1);
    assert.equal(item.x_secret, state ? 's1' : 'by logic');
    if (state) for (const row of [task, item]) assert.equal(row.modifiedby?.id, mappedUser(sim).systemuserid);
  }
});

// Guard: no portal module writes the store directly; the one write path is portalRecordWrites (and its no-organization fallback).
test('portal modules write only through portalRecordWrites', async () => {
  const lib = new URL('../lib/', import.meta.url);
  const modules = (await fs.readdir(lib)).filter(name => /^(?:portal-|native-|form-|liquid|platform|webapi-|sharepoint-|exported-operations|server-logic)[\w-]*\.mjs$/.test(name));
  const direct = /\b(?:store|provider)\.(?:create|update|remove|upsert|createRecord|updateRecord|removeRecord|upsertRecord)\(/;
  const offenders = [];
  for (const name of modules)
    (await fs.readFile(new URL(name, lib), 'utf8')).split('\n').forEach((line, index, lines) => {
      // Allowed: the store write of a store without an organization (no record pipeline, so no enhanced model).
      const fallback = /if \(!records\)/.test(line) || /recordPipeline/.test(lines.slice(Math.max(0, index - 2), index).join('\n'));
      if (direct.test(line) && !fallback) offenders.push(`${name}:${index + 1}`);
    });
  assert.deepEqual(offenders, []);
});

// RC2-08: a failed role sync denies the visitor until a sync succeeds, whatever role links it still has.
test('a failed role sync fails closed until the next successful sync', async t => {
  const fixture = await site(t, 3), { sim } = fixture;
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  const units = sim.store.state.tables.businessunit.slice();
  await sim.store.transact(() => {
    sim.store.state.tables.businessunit.splice(0);
    sim.store.state.permissions.push({ id: 'orders-create', name: 'Orders create', entity: 'x_order', roles: ['Member'], operations: ['create'], scope: 'global' });
  });
  assert.equal(await fixture.ids('/_api/x_items?$select=x_name'), 403);
  assert.ok(sim.state().diagnostics.some(item => item.code === 'PORTAL_AUTHORIZATION_SYNC_FAILED'));
  await sim.store.transact(() => { sim.store.state.tables.businessunit.push(...units); });
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
});

// Q1: the derived roles are platform-managed; a permission change rewrites a manually changed role and reports it once.
test('a table-permission change rewrites a manually changed mapped role and reports it once', async t => {
  const fixture = await site(t, 3), { sim } = fixture;
  await fixture.ids('/_api/x_items?$select=x_name');
  const role = sim.store.tableRows('role').find(row => row.name === 'Member');
  const read = sim.store.tableRows('privilege').find(row => /^prvRead/i.test(row.name) && /x_item$/i.test(row.name));
  await sim.store.transact(() => {
    const rows = sim.store.state.tables.roleprivileges;
    rows.splice(rows.findIndex(row => row.roleid.id === role.roleid && row.privilegeid.id === read.privilegeid), 1);
  });
  assert.equal(await fixture.ids('/_api/x_items?$select=x_name'), 403, 'the manual change holds until the permissions change');
  await sim.store.transact(() => { sim.store.state.permissions.push({ id: 'orders-create', name: 'Orders create', entity: 'x_order', roles: ['Member'], operations: ['create'], scope: 'global' }); });
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  await fixture.ids('/_api/x_items?$select=x_name');
  assert.deepEqual(sim.state().diagnostics.filter(item => item.code === 'PORTAL_AUTHORIZATION_ROLE_RESYNCED').map(item => item.role), ['Member']);
});

// Q2: a wildcard table permission expands to every table at sync.
test('a wildcard table permission grants every table in both models', async t => {
  for (const state of [0, 3]) {
    const fixture = await site(t, state);
    await fixture.sim.store.transact(() => { fixture.sim.store.state.permissions.push({ id: 'all', name: 'All tables', entity: '*', roles: ['Member'], operations: ['read'], scope: 'global' }); });
    assert.deepEqual(await fixture.ids('/_api/x_lines?$select=x_name'), ['l1', 'l2'], `state ${state}`);
  }
});

// Q4: an undocumented value reads as the standard model and is reported.
test('an undocumented enhanced authorization value runs the standard model and is reported', async t => {
  const fixture = await site(t, 9);
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  const diagnostics = fixture.sim.state().diagnostics;
  assert.deepEqual(diagnostics.filter(item => item.code === 'PORTAL_AUTHORIZATION_MODEL').map(item => [item.model, item.label]), [['standard', 'Unknown (9)']]);
  assert.ok(diagnostics.some(item => item.code === 'PORTAL_AUTHORIZATION_STATE_UNKNOWN' && item.state === 9));
  assert.equal(mappedUser(fixture.sim), undefined);
});

test('the preflight row of every enhanced state is satisfied with a fidelity note', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(state => portalAuthorizationModel({ enhancedauthorization: state }).model), ['standard', 'enhanced', 'enhanced', 'enhanced', 'standard']);
  assert.deepEqual([0, 9].map(state => portalAuthorizationModel({ enhancedauthorization: state }).label), ['Disabled', 'Unknown (9)']);
  for (const state of [1, 2, 3]) {
    const [row] = buildSourceGraph({ portal: { diagnostics: platformChangeDiagnostics({ website: { adx_enhancedauthorization: state } }) } }).requirements();
    assert.deepEqual([row.id, row.status, row.level], ['portal:enhanced-authorization', 'satisfied', 'behaviour']);
    assert.match(row.message, /Fidelity: the privilege depth each table permission scope maps to/);
  }
});
