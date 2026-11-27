// @test-kind security: portal identities, table grants and column profiles cannot broaden access or bypass write authorization.
// Enhanced Power Pages authorization at run time (portal-authorization.mjs), powerpagesite enhancedauthorization 0-3.
import test from 'node:test';
import { simulatorFixture } from './fixtures/source-site.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { signInHeaders } from '../testing.mjs';
import { platformChangeDiagnostics } from '../lib/platform-changes.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { portalAuthorizationModel } from '../lib/portal-authorization.mjs';
import { runExportedServerLogic } from '../lib/exported-operations.mjs';
import { createPrincipals } from '../lib/dataverse-security.mjs';
import { recordFilterAdmits } from '../lib/record-filter.mjs';

const text = { dataverseType: 'nvarchar' };
const files = (state) => ({
  'website.yml': `adx_websiteid: 77777777-7777-4777-8777-777777777777\nadx_name: Invented\nadx_enhancedauthorization: ${state}`,
  'webrole.yml':
    '- adx_webroleid: 77777777-7777-4777-8777-777777777701\n  adx_name: Member\n- adx_webroleid: 77777777-7777-4777-8777-777777777702\n  adx_name: Reviewer',
  'sitesetting.yml': [
    ['x_item', 'x_name,x_contactid,x_secret'],
    ['x_order', 'x_name,x_accountid'],
    ['x_line', 'x_name,x_orderid'],
  ]
    .flatMap(([table, fields], index) => [
      `- adx_sitesettingid: 77777777-7777-4777-8777-7777777778${index}0\n  adx_name: Webapi/${table}/enabled\n  adx_value: true`,
      `- adx_sitesettingid: 77777777-7777-4777-8777-7777777778${index}1\n  adx_name: Webapi/${table}/fields\n  adx_value: ${fields}`,
    ])
    .join('\n'),
  'sample.serverlogic.yml':
    'adx_serverlogicid: sample\nadx_name: sample\nadx_serverlogic_adx_webrole:\n- 77777777-7777-4777-8777-777777777701',
  'sample.js':
    "function put(){ return Server.Connector.Dataverse.UpdateRecord('x_items', Server.Context.QueryParameters.id, Server.Context.Body); }",
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html':
    '{% fetchxml rows %}<fetch><entity name="x_item"><attribute name="x_name"/><attribute name="x_secret"/><order attribute="x_name"/></entity></fetch>{% endfetchxml %}<ul>{% for row in rows.results.entities %}<li>{{ row.x_name }}={{ row.x_secret }}</li>{% endfor %}</ul>',
});
const MEMBER = '77777777-7777-4777-8777-777777777701',
  SITE = '77777777-7777-4777-8777-777777777777',
  TASK = '77777777-7777-4777-8777-777777777731';
const initial = () => ({
  version: 1,
  mappings: {
    contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    account: { entitySet: 'accounts', idColumn: 'accountid' },
    x_item: {
      entitySet: 'x_items',
      idColumn: 'x_itemid',
      fields: { x_name: text, x_contactid: text, x_secret: { ...text, columnMetadata: { isSecured: true } } },
    },
    x_order: { entitySet: 'x_orders', idColumn: 'x_orderid', fields: { x_name: text, x_accountid: text } },
    x_line: { entitySet: 'x_lines', idColumn: 'x_lineid', fields: { x_name: text, x_orderid: text } },
    x_task: { entitySet: 'x_tasks', idColumn: 'x_taskid', fields: { x_name: text } },
  },
  tables: {
    account: [
      { accountid: 'acme', name: 'Acme' },
      { accountid: 'other', name: 'Other' },
    ],
    contact: [
      {
        contactid: 'alex',
        fullname: 'Alex Local',
        statecode: 0,
        parentcustomerid: { id: 'acme', logical_name: 'account' },
      },
      { contactid: 'bea', fullname: 'Bea Other', statecode: 0 },
    ],
    x_item: [
      { x_itemid: 'i1', x_name: 'Own', x_contactid: 'alex', x_secret: 's1' },
      { x_itemid: 'i2', x_name: 'Foreign', x_contactid: 'bea', x_secret: 's2' },
    ],
    x_order: [
      { x_orderid: 'o1', x_name: 'Acme order', x_accountid: 'acme' },
      { x_orderid: 'o2', x_name: 'Other order', x_accountid: 'other' },
    ],
    x_line: [
      { x_lineid: 'l1', x_name: 'Acme line', x_orderid: 'o1' },
      { x_lineid: 'l2', x_name: 'Other line', x_orderid: 'o2' },
    ],
    x_task: [{ x_taskid: TASK, x_name: 'Task', statecode: 0, statuscode: 1 }],
  },
  permissions: [
    {
      id: 'items-read',
      name: 'Items read',
      entity: 'x_item',
      roles: ['Member'],
      operations: ['read', 'create'],
      scope: 'global',
    },
    {
      id: 'items-own',
      name: 'Items own',
      entity: 'x_item',
      roles: ['Member'],
      operations: ['update'],
      scope: 'contact',
      field: 'x_contactid',
    },
    {
      id: 'orders',
      name: 'Orders',
      entity: 'x_order',
      roles: ['Member'],
      operations: ['read', 'update'],
      scope: 'account',
      field: 'x_accountid',
    },
    {
      id: 'tasks',
      name: 'Tasks',
      entity: 'x_task',
      roles: ['Member'],
      operations: ['read', 'update'],
      scope: 'global',
    },
    {
      id: 'lines',
      name: 'Lines',
      entity: 'x_line',
      roles: ['Member'],
      operations: ['read'],
      scope: 'parent',
      parentPermissionId: 'orders',
      relationship: { entity: 'x_order', from: 'x_orderid', to: 'x_orderid' },
    },
  ],
  simulator: {
    mode: 'local',
    pageMode: 'local',
    permissionSource: 'configured',
    live: { allowWrites: false },
    endpoints: [],
    contactRoles: [{ contactId: 'alex', roleId: MEMBER }],
  },
});

async function site(t, state, overrides = {}, permissionSource = 'configured') {
  const input = initial();
  input.simulator.permissionSource = permissionSource;
  const sim = await simulatorFixture(t, {
    prefix: 'portal-authorization-',
    files: { ...files(state), ...overrides },
    port: 0,
    watch: false,
    initial: input,
  });
  const alex = signInHeaders(sim, 'alex');
  const call = (method, route, body, headers = alex) =>
    fetch(sim.url + route, {
      method,
      headers: {
        ...headers,
        ...(body
          ? { 'content-type': 'application/json', __RequestVerificationToken: sim.csrf }
          : method === 'GET'
            ? {}
            : { __RequestVerificationToken: sim.csrf }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const ids = async (route, headers) => {
    const response = await call('GET', route, undefined, headers);
    return response.status === 200
      ? (await response.json()).value.map((row) => Object.values(row).find((value) => /^[iol]\d$/.test(value))).sort()
      : response.status;
  };
  return { sim, call, ids, alex };
}
const mappedUser = (sim) =>
  sim.store.tableRows('systemuser').find((row) => row.fullname === 'Alex Local' && row.systemmanagedusertype === 1);

test('enhanced Dataverse role links distinguish source web role IDs that share a name', async (t) => {
  const { sim, ids } = await site(t, 3, {
    'webrole.yml': files(3)['webrole.yml'].replace('adx_name: Reviewer', 'adx_name: Member'),
  });
  const items = '/_api/x_items?$select=x_name';
  assert.deepEqual(await ids(items), ['i1', 'i2']);
  const userId = mappedUser(sim).systemuserid;
  const candidates = sim.store.tableRows('role').filter((row) => row.name === 'Member');
  assert.equal(candidates.length, 2, 'both source web roles must have separate Dataverse roles');
  const candidateIds = new Set(candidates.map((row) => row.roleid));
  const linked = () =>
    sim.store
      .tableRows('systemuserroles')
      .filter((row) => row.systemuserid.id === userId && candidateIds.has(row.roleid.id))
      .map((row) => row.roleid.id);

  const primary = linked();
  assert.equal(primary.length, 1, 'the same-name role is not an implicit membership');
  await sim.store.transact(() => {
    sim.store.state.simulator.contactRoles = [{ contactId: 'alex', roleId: '77777777-7777-4777-8777-777777777702' }];
  });
  assert.deepEqual(await ids(items), ['i1', 'i2']);
  assert.deepEqual(
    linked(),
    [...candidateIds].filter((roleId) => roleId !== primary[0]),
  );
});

async function grantSecretRead(sim) {
  const user = mappedUser(sim);
  await sim.store.transact(() => {
    const tables = sim.store.state.tables;
    const profile = { id: '77777777-7777-4777-8777-777777777720', logical_name: 'fieldsecurityprofile' };
    tables.fieldsecurityprofile.push({ fieldsecurityprofileid: profile.id, name: 'Invented readers' });
    tables.fieldpermission.push({
      fieldpermissionid: '77777777-7777-4777-8777-777777777721',
      fieldsecurityprofileid: profile,
      entityname: 'x_item',
      attributelogicalname: 'x_secret',
      canread: 4,
      cancreate: 0,
      canupdate: 0,
      canreadunmasked: 0,
    });
    tables.systemuserprofiles.push({
      systemuserprofileid: '77777777-7777-4777-8777-777777777722',
      systemuserid: { id: user.systemuserid, logical_name: 'systemuser' },
      fieldsecurityprofileid: profile,
    });
  });
}

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

// States 1 and 2 select the same enhanced model as 3 (portalAuthorizationModel, last test), so 0 and 3 cover both runtimes.
test('the same site grants exactly what its table permissions allow in the standard and enhanced states, and the models agree', async (t) => {
  const expected = {
    items: ['i1', 'i2'],
    orders: ['o1'],
    lines: ['l1'],
    anonymous: 403,
    patchOwn: 204,
    patchForeign: 403,
    patchOrder: 403,
    deleteOwn: 403,
  };
  for (const state of [0, 3]) {
    const fixture = await site(t, state);
    assert.deepEqual(await matrix(fixture), expected, `state ${state}`);
    const model = state ? 'enhanced' : 'standard';
    const diagnostics = fixture.sim.state().diagnostics;
    assert.deepEqual(
      diagnostics.filter((item) => item.code === 'PORTAL_AUTHORIZATION_MODEL').map((item) => [item.state, item.model]),
      [[state, model]],
    );
    const denied = diagnostics.find((item) => item.code === 'TABLE_PERMISSION_DENIED');
    assert.equal(denied?.model, model, `state ${state}: the denial names the model`);
    // Enhanced: the visitor is a mapped Dataverse user holding the security role mapped to its web role; standard maps nobody.
    const user = mappedUser(fixture.sim);
    assert.equal(Boolean(user), state !== 0);
    if (user) {
      const roles = fixture.sim.store
        .tableRows('systemuserroles')
        .filter((row) => row.systemuserid.id === user.systemuserid)
        .map((row) => row.roleid.name);
      assert.deepEqual(roles, ['Member']);
      const own = fixture.sim.store.tableRows('x_item').find((row) => row.x_itemid === 'i1');
      assert.equal(own.modifiedby?.id, user.systemuserid, 'the write runs as the mapped user (impersonation)');
    }
  }
});

const customAccess = (fetchXml) => ({
  'table-permissions/Filtered.tablepermission.yml': [
    'adx_entitypermissionid: 77777777-7777-4777-8777-777777777772',
    'adx_name: Filtered access',
    'adx_entitylogicalname: x_item',
    'adx_scope: 756150005',
    'adx_create: true',
    'adx_read: true',
    'adx_write: true',
    'adx_delete: true',
    'adx_entitypermission_webrole:',
    `- ${MEMBER}`,
    'mspp_permissionfetchxml: >-',
    `  ${fetchXml}`,
  ].join('\n'),
});

// @test-kind security+contract: documented Custom Access source shape uses the same restrictive predicate for portal reads and writes.
test('enabled enhanced Custom Access filters Liquid, API and mutations through a source root predicate', async (t) => {
  const source = customAccess(
    '<fetch top="1"><entity name="x_item"><attribute name="x_secret"/><filter type="and"><condition attribute="x_contactid" operator="eq" value="alex"/><filter type="or"><condition attribute="x_name" operator="in"><value>Own</value><value>Own edited</value></condition><condition attribute="x_name" operator="eq" value="Own created"/></filter></filter></entity></fetch>',
  );
  const { sim, call, ids } = await site(t, 3, source, 'exported');
  assert.deepEqual(await ids('/_api/x_items?$select=x_name'), ['i1']);
  assert.equal((await call('GET', '/_api/x_items(i2)')).status, 403);
  const fetchXml = '<fetch><entity name="x_item"><attribute name="x_name"/></entity></fetch>';
  const fetched = await (await call('GET', '/_api/x_items?fetchXml=' + encodeURIComponent(fetchXml))).json();
  assert.deepEqual(
    fetched.value.map((row) => row.x_name),
    ['Own'],
  );
  const liquid = await (await call('GET', '/')).text();
  assert.match(liquid, /<li>Own=/);
  assert.doesNotMatch(liquid, /<li>Foreign=/);
  assert.equal((await call('PATCH', '/_api/x_items(i1)', { x_name: 'Own edited' })).status, 204);
  assert.equal((await call('PATCH', '/_api/x_items(i1)', { x_contactid: 'bea' })).status, 403);
  assert.equal((await call('PATCH', '/_api/x_items(i2)', { x_name: 'Own' })).status, 403);
  assert.equal((await call('POST', '/_api/x_items', { x_name: 'Own created', x_contactid: 'alex' })).status, 204);
  assert.equal((await call('POST', '/_api/x_items', { x_name: 'Own created', x_contactid: 'bea' })).status, 403);
  const all = await (await call('GET', '/_api/x_items?$select=x_name')).json();
  assert.deepEqual(all.value.map((row) => row.x_name).sort(), ['Own created', 'Own edited'], 'only root filters apply');
  assert.equal((await call('DELETE', '/_api/x_items(i2)')).status, 403);
  assert.equal((await call('DELETE', '/_api/x_items(i1)')).status, 204);
  assert.deepEqual(
    sim.store
      .tableRows('x_item')
      .map((row) => row.x_name)
      .sort(),
    ['Foreign', 'Own created'],
  );
});

// @test-kind security: disabled enhanced states, unknown fields and unsupported filter structure fail closed.
test('unqualified Custom Access source never becomes a blanket grant', async (t) => {
  const scope =
    '<fetch><entity name="x_item"><filter><condition attribute="x_contactid" operator="eq" value="alex"/></filter></entity></fetch>';
  for (const [state, filter, code] of [
    ...[0, 1, 2].map((state) => [state, scope, 'PERMISSION_CUSTOM_ACCESS_REQUIRES_ENABLED_AUTHORIZATION']),
    [3, scope.replace('x_contactid', 'unknown_column'), 'PERMISSION_CUSTOM_ACCESS_FILTER_UNSUPPORTED'],
    [3, scope.replace('<filter>', '<filter><filter/>'), 'PERMISSION_CUSTOM_ACCESS_FILTER_UNSUPPORTED'],
    [3, scope.replace('name="x_item"', 'name="x_order"'), 'PERMISSION_CUSTOM_ACCESS_FILTER_UNSUPPORTED'],
    // A linked-table filter is refused rather than dropped, which would grant every root-filter match.
    [
      3,
      scope.replace(
        '</entity>',
        '<link-entity name="contact" from="contactid" to="x_contactid"><filter><condition attribute="lastname" operator="eq" value="Only"/></filter></link-entity></entity>',
      ),
      'PERMISSION_CUSTOM_ACCESS_FILTER_UNSUPPORTED',
    ],
  ]) {
    const { sim, call } = await site(t, state, customAccess(filter), 'exported');
    assert.equal((await call('GET', '/_api/x_items')).status, 403);
    assert.ok(sim.state().diagnostics.some((item) => item.code === code));
  }
});

// @test-kind security+observation: hosted session F1 (summary-F1.md AUTH-02e, a disposable site and a partially migrated one): the generated record filter keeps only the root filter of a Custom Access rule and an empty filter for a link-only rule; Mirage keeps the refusal and states what the live site grants.
test('a Custom Access join refusal states that the hosted site drops the join and widens the grant', async (t) => {
  const link =
    '<link-entity name="contact" from="contactid" to="x_contactid"><filter><condition attribute="lastname" operator="eq" value="Only"/></filter></link-entity>';
  for (const [fetchXml, grants] of [
    [
      `<fetch><entity name="x_item"><filter><condition attribute="x_name" operator="eq" value="Own"/></filter>${link}</entity></fetch>`,
      'root-filter',
    ],
    [`<fetch><entity name="x_item">${link}</entity></fetch>`, 'every-row'],
  ]) {
    const { sim, call } = await site(t, 3, customAccess(fetchXml), 'exported');
    assert.equal((await call('GET', '/_api/x_items')).status, 403, grants);
    const diagnostics = sim.state().diagnostics;
    assert.ok(diagnostics.some((item) => item.code === 'PERMISSION_CUSTOM_ACCESS_FILTER_UNSUPPORTED'));
    const dropped = diagnostics.filter((item) => item.code === 'PERMISSION_CUSTOM_ACCESS_HOSTED_JOIN_DROPPED');
    assert.deepEqual(
      dropped.map((item) => [item.entity, item.hostedGrants, item.severity]),
      [['x_item', grants, 'warning']],
    );
    assert.match(dropped[0].message, grants === 'every-row' ? /every x_item row/ : /every row the root filter matches/);
  }
});

// @test-kind security: current column-read profiles mask or expose protected values without granting column writes.
test('a secured column is masked through the Dataverse column security profile in the enhanced states only', async (t) => {
  for (const state of [0, 3]) {
    const fixture = await site(t, state);
    const read = async () => (await (await fixture.call('GET', '/_api/x_items(i1)?$select=x_secret')).json()).x_secret;
    const page = async () =>
      (await (await fetch(fixture.sim.url + '/', { headers: fixture.alex })).text()).match(/<li>.*?<\/li>/g);
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
    await grantSecretRead(fixture.sim);
    assert.equal(await read(), 's1');
    assert.deepEqual(await page(), ['<li>Foreign=s2</li>', '<li>Own=s1</li>']);
    assert.equal((await fixture.call('PATCH', '/_api/x_items(i1)', { x_secret: 'changed' })).status, 403);
  }
});

// @test-kind security: connector create responses project plug-in-generated secured values under the current reader without changing stored data.
test('server logic create responses mask protected plugin defaults and observe newly granted read access', async (t) => {
  const { sim, call } = await site(t, 3, {
    'sample.js': "function post(){return Server.Connector.Dataverse.CreateRecord('x_items',Server.Context.Body);}",
  });
  await call('GET', '/_api/x_items?$select=x_name');
  sim.store.setPluginPipeline(({ stage, target }) => {
    if (stage === 20 && target) target.x_secret = 'Protected fixture';
  });
  const create = async () => {
    const reply = JSON.parse(
      await runExportedServerLogic({
        record: sim.portal.serverLogics[0],
        portal: sim.portal,
        store: sim.store,
        identity: { id: 'alex', contactId: 'alex', roles: ['Member'], roleIds: [MEMBER] },
        method: 'POST',
        body: JSON.stringify({ x_name: 'Created' }),
      }),
    );
    assert.equal(reply.StatusCode, 201, JSON.stringify(reply));
    const body = JSON.parse(reply.Body);
    const stored = sim.store.tableRows('x_item').find((row) => row.x_itemid === body.x_itemid);
    assert.equal(stored.x_secret, 'Protected fixture');
    assert.equal(body.x_name, 'Created');
    return body;
  };
  assert.equal((await create()).x_secret, null);
  await grantSecretRead(sim);
  assert.equal((await create()).x_secret, 'Protected fixture');
});

test('the Dataverse privilege of the mapped security role decides an enhanced grant', async (t) => {
  const fixture = await site(t, 3);
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  const role = fixture.sim.store.tableRows('role').find((row) => row.name === 'Member');
  const read = fixture.sim.store
    .tableRows('privilege')
    .find((row) => /^prvRead/i.test(row.name) && /x_item$/i.test(row.name));
  // An administrator removes the read privilege from the mapped role in Dataverse: the table permission no longer grants.
  await fixture.sim.store.transact(() => {
    const rows = fixture.sim.store.state.tables.roleprivileges;
    rows.splice(
      rows.findIndex((row) => row.roleid.id === role.roleid && row.privilegeid.id === read.privilegeid),
      1,
    );
  });
  assert.equal(await fixture.ids('/_api/x_items?$select=x_name'), 403);
});

test('Web API column permissions apply in the standard model and are bypassed in the enhanced model', async (t) => {
  for (const [state, status] of [
    [0, 403],
    [3, 200],
  ]) {
    const fixture = await site(t, state);
    fixture.sim.portal.records.push(
      {
        kind: 'columnpermissionprofile',
        id: 'cpp',
        adx_name: 'Items',
        adx_tablename: 'x_item',
        adx_columnpermissionprofile_webrole: [MEMBER],
        adx_allcolumnpermissions: [746610001],
      },
      {
        kind: 'columnpermission',
        id: 'cp1',
        adx_columnpermissionprofileid: 'cpp',
        adx_columnname: 'x_name',
        adx_permissions: [746610002],
      },
    );
    assert.equal((await fixture.call('GET', '/_api/x_items?$select=x_name')).status, status, `state ${state}`);
  }
});

test('an observed application user name never renames the mapped user in enhanced audit columns', async (t) => {
  for (const state of [0, 3]) {
    const fixture = await site(t, state);
    fixture.sim.store.setObserved({ ...fixture.sim.store.observed, portalApplicationUser: '# Portals-Invented' });
    assert.equal((await fixture.call('PATCH', '/_api/x_items(i1)', { x_name: 'Own edited' })).status, 204);
    const modified = fixture.sim.store.tableRows('x_item').find((row) => row.x_itemid === 'i1').modifiedby;
    assert.equal(modified.name, state ? 'Alex Local' : '# Portals-Invented', `state ${state}`);
    if (state) assert.equal(modified.id, mappedUser(fixture.sim).systemuserid);
  }
});

test('the derived security roles mirror the current web roles', async (t) => {
  const fixture = await site(t, 3);
  await fixture.ids('/_api/x_items?$select=x_name');
  const roles = () =>
    fixture.sim.store
      .tableRows('role')
      .filter((row) => ['Member', 'Reviewer'].includes(row.name))
      .map((row) => row.name)
      .sort();
  assert.deepEqual(roles(), ['Member', 'Reviewer']);
  const reviewer = fixture.sim.store.tableRows('role').find((row) => row.name === 'Reviewer').roleid;
  const records = fixture.sim.portal.records;
  records.splice(
    records.findIndex((record) => record.kind === 'webrole' && record.name === 'Reviewer'),
    1,
  );
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  assert.deepEqual(roles(), ['Member'], 'the role of a removed web role is removed');
  assert.ok(!fixture.sim.store.tableRows('roleprivileges').some((row) => row.roleid.id === reviewer));
});

// Every portal write runs through form-service.mjs portalRecordWrites (the mapped user, column security).
test('server logic and list action writes run as the mapped user under column security', async (t) => {
  for (const state of [0, 3]) {
    const fixture = await site(t, state),
      { sim } = fixture;
    for (const item of (await (await fetch(sim.url + '/__sim/api/operations')).json()).items.filter(
      (entry) => entry.kind === 'server-logic',
    ))
      await fetch(sim.url + '/__sim/api/operations/' + encodeURIComponent(item.key), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
        body: '{"mode":"exported"}',
      });
    const logic = async (body) =>
      JSON.parse((await (await fixture.call('PUT', '/_api/serverlogics/sample?id=i1', body)).json()).data);
    const secret = await logic({ x_secret: 'by logic' });
    assert.equal(secret.StatusCode, state ? 403 : 204, `state ${state}: a secured column through server logic`);
    assert.equal((await logic({ x_name: 'by logic' })).StatusCode, 204);
    const deactivated = await fetch(`${sim.url}/_services/action-deactivate/${SITE}`, {
      method: 'POST',
      headers: { ...fixture.alex, 'content-type': 'application/json', __RequestVerificationToken: sim.csrf },
      body: JSON.stringify({ LogicalName: 'x_task', Id: TASK }),
    });
    assert.equal(deactivated.status, 204, await deactivated.text());
    const task = sim.store.tableRows('x_task')[0],
      item = sim.store.tableRows('x_item').find((row) => row.x_itemid === 'i1');
    assert.equal(task.statecode, 1);
    assert.equal(item.x_secret, state ? 's1' : 'by logic');
    if (state) for (const row of [task, item]) assert.equal(row.modifiedby?.id, mappedUser(sim).systemuserid);
  }
});

// Guard: no portal module writes the store directly; the one write path is portalRecordWrites (and its no-organization fallback).
// @test-kind tooling+security: portal write callers must use the shared authorization and plug-in pipeline boundary.
test('portal modules write only through portalRecordWrites', async () => {
  const lib = new URL('../lib/', import.meta.url);
  const modules = (await fs.readdir(lib)).filter((name) =>
    /^(?:portal-|native-|form-|liquid|platform|webapi-|sharepoint-|exported-operations|server-logic)[\w-]*\.mjs$/.test(
      name,
    ),
  );
  const direct =
    /\b(?:store|provider)\.(?:create|update|remove|upsert|createRecord|updateRecord|removeRecord|upsertRecord)\(/;
  const offenders = [];
  for (const name of modules)
    (await fs.readFile(new URL(name, lib), 'utf8')).split('\n').forEach((line, index, lines) => {
      // Allowed: the store write of a store without an organization (no record pipeline, so no enhanced model).
      const fallback =
        /if \(!records\)/.test(line) || /recordPipeline/.test(lines.slice(Math.max(0, index - 2), index).join('\n'));
      if (direct.test(line) && !fallback) offenders.push(`${name}:${index + 1}`);
    });
  assert.deepEqual(offenders, []);
});

// A failed role sync denies the visitor until a sync succeeds, whatever role links it still has.
test('a failed role sync fails closed until the next successful sync', async (t) => {
  const fixture = await site(t, 3),
    { sim } = fixture;
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  const units = sim.store.state.tables.businessunit.slice();
  await sim.store.transact(() => {
    sim.store.state.tables.businessunit.splice(0);
    sim.store.state.permissions.push({
      id: 'orders-create',
      name: 'Orders create',
      entity: 'x_order',
      roles: ['Member'],
      operations: ['create'],
      scope: 'global',
    });
  });
  assert.equal(await fixture.ids('/_api/x_items?$select=x_name'), 403);
  assert.ok(sim.state().diagnostics.some((item) => item.code === 'PORTAL_AUTHORIZATION_SYNC_FAILED'));
  await sim.store.transact(() => {
    sim.store.state.tables.businessunit.push(...units);
  });
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
});

// The derived roles are platform-managed; a permission change rewrites a manually changed role and reports it once.
test('a table-permission change rewrites a manually changed mapped role and reports it once', async (t) => {
  const fixture = await site(t, 3),
    { sim } = fixture;
  await fixture.ids('/_api/x_items?$select=x_name');
  const role = sim.store.tableRows('role').find((row) => row.name === 'Member');
  const read = sim.store.tableRows('privilege').find((row) => /^prvRead/i.test(row.name) && /x_item$/i.test(row.name));
  await sim.store.transact(() => {
    const rows = sim.store.state.tables.roleprivileges;
    rows.splice(
      rows.findIndex((row) => row.roleid.id === role.roleid && row.privilegeid.id === read.privilegeid),
      1,
    );
  });
  assert.equal(
    await fixture.ids('/_api/x_items?$select=x_name'),
    403,
    'the manual change holds until the permissions change',
  );
  await sim.store.transact(() => {
    sim.store.state.permissions.push({
      id: 'orders-create',
      name: 'Orders create',
      entity: 'x_order',
      roles: ['Member'],
      operations: ['create'],
      scope: 'global',
    });
  });
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  await fixture.ids('/_api/x_items?$select=x_name');
  assert.deepEqual(
    sim
      .state()
      .diagnostics.filter((item) => item.code === 'PORTAL_AUTHORIZATION_ROLE_RESYNCED')
      .map((item) => item.role),
    ['Member'],
  );
});

// A wildcard table permission expands to every table at sync.
test('a wildcard table permission grants every table in both models', async (t) => {
  for (const state of [0, 3]) {
    const fixture = await site(t, state);
    await fixture.sim.store.transact(() => {
      fixture.sim.store.state.permissions.push({
        id: 'all',
        name: 'All tables',
        entity: '*',
        roles: ['Member'],
        operations: ['read'],
        scope: 'global',
      });
    });
    assert.deepEqual(await fixture.ids('/_api/x_lines?$select=x_name'), ['l1', 'l2'], `state ${state}`);
  }
});

// An undocumented value reads as the standard model and is reported.
test('an undocumented enhanced authorization value runs the standard model and is reported', async (t) => {
  const fixture = await site(t, 9);
  assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2']);
  const diagnostics = fixture.sim.state().diagnostics;
  assert.deepEqual(
    diagnostics.filter((item) => item.code === 'PORTAL_AUTHORIZATION_MODEL').map((item) => [item.model, item.label]),
    [['standard', 'Unknown (9)']],
  );
  assert.ok(diagnostics.some((item) => item.code === 'PORTAL_AUTHORIZATION_STATE_UNKNOWN' && item.state === 9));
  assert.equal(mappedUser(fixture.sim), undefined);
});

// @test-kind observation: hosted session F1 (2026-11-26, summary-F1.md AUTH-02c): a site in enhancedauthorization 1 or 2 queried as its application user with the standard permission FetchXML (two runs each); only 3 used the generated security roles.
test('only the enabled state selects the enhanced model; the migration states keep the standard model', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 9].map((state) => portalAuthorizationModel({ enhancedauthorization: state }).model),
    ['standard', 'standard', 'standard', 'enhanced', 'standard'],
  );
  assert.deepEqual(
    [0, 1, 2, 9].map((state) => portalAuthorizationModel({ enhancedauthorization: state }).label),
    ['Disabled', 'Migration in progress', 'Migration Failed', 'Unknown (9)'],
  );
});

// @test-kind contract: preflight describes the selected local authorization model without claiming native parity.
test('the preflight row of every enhanced state is satisfied with a fidelity note', () => {
  for (const state of [1, 2, 3]) {
    const diagnostics = platformChangeDiagnostics({ website: { adx_enhancedauthorization: state } });
    const [row] = buildSourceGraph({ portal: { diagnostics } }).requirements();
    assert.deepEqual([row.id, row.status, row.level], ['portal:enhanced-authorization', 'satisfied', 'behaviour']);
    assert.equal(diagnostics[0].model, state === 3 ? 'enhanced' : 'standard');
    assert.match(
      row.message,
      state === 3
        ? /Fidelity: the privilege depth \(16, record filter\)/
        : /Fidelity: states 1 and 2 keep the standard/,
    );
  }
});

// @test-kind observation: hosted session F1 (summary-F1.md AUTH-02c): in states 1 and 2 the hosted portal ignored Custom Access and served the standard model's grants.
test('a migration state serves the standard model to a visitor and maps nobody', async (t) => {
  for (const state of [1, 2]) {
    const fixture = await site(t, state);
    assert.deepEqual(await fixture.ids('/_api/x_items?$select=x_name'), ['i1', 'i2'], `state ${state}`);
    const diagnostics = fixture.sim.state().diagnostics;
    assert.deepEqual(
      diagnostics.filter((item) => item.code === 'PORTAL_AUTHORIZATION_MODEL').map((item) => [item.state, item.model]),
      [[state, 'standard']],
    );
    assert.equal(mappedUser(fixture.sim), undefined, `state ${state}`);
  }
});

const MAPPING_INNER =
  '<link-entity name="powerpagesusermapping" from="contact" to="contactid" link-type="inner"><filter><condition attribute="systemuser" operator="eq-userid" /></filter></link-entity>';
const recordFilters = (sim, roleName) => {
  const role = sim.store.tableRows('role').find((row) => row.name === roleName);
  const names = new Map(sim.store.tableRows('privilege').map((row) => [row.privilegeid, row.name]));
  const filters = new Map(sim.store.tableRows('recordfilter').map((row) => [row.recordfilterid, row]));
  return new Map(
    sim.store
      .tableRows('roleprivileges')
      .filter((row) => row.roleid.id === role.roleid)
      .map((row) => [
        names.get(row.privilegeid.id),
        { mask: row.privilegedepthmask, fetchxml: filters.get(row.recordfilterid?.id)?.fetchxml ?? null },
      ]),
  );
};

// @test-kind observation: hosted session F1 (2026-11-26, summary-F1.md AUTH-02d; enhanced-snapshot-trial-enabled, a disposable site with one web role per scope read back from roleprivileges and recordfilter): every scope is depth 16 with a record filter joining powerpagesusermapping through eq-userid, Global is unfiltered, and every role reads its own contact, parent account and the user mappings.
test('generated security roles grant every scope at depth 16 through the record filter a hosted site writes', async (t) => {
  const fixture = await site(t, 3);
  await fixture.ids('/_api/x_items?$select=x_name');
  const grants = recordFilters(fixture.sim, 'Member');
  const filtered = (root, branches) =>
    `<fetch mapping="logical"><entity name="${root}"><filter type="and"><filter type="or">${branches}</filter></filter></entity></fetch>`;
  const contactBranch = (to) =>
    `<link-entity name="contact" from="contactid" to="${to}" link-type="any">${MAPPING_INNER}</link-entity>`;
  const accountBranch = (to) =>
    `<link-entity name="account" from="accountid" to="${to}" link-type="any"><link-entity name="powerpagesusermapping" from="parentcustomerid" to="accountid" link-type="inner"><filter><condition attribute="systemuser" operator="eq-userid" /></filter></link-entity></link-entity>`;
  assert.deepEqual(grants.get('prvReadX_item'), {
    mask: 16,
    fetchxml: '<fetch mapping="logical"><entity name="x_item" /></fetch>',
  });
  assert.deepEqual(grants.get('prvWriteX_item'), {
    mask: 16,
    fetchxml: filtered('x_item', contactBranch('x_contactid')),
  });
  assert.deepEqual(grants.get('prvReadX_order'), {
    mask: 16,
    fetchxml: filtered('x_order', accountBranch('x_accountid')),
  });
  assert.deepEqual(grants.get('prvReadX_line'), {
    mask: 16,
    fetchxml: filtered(
      'x_line',
      `<filter type="and"><link-entity name="x_order" from="x_orderid" to="x_orderid" link-type="any">${accountBranch('x_accountid')}</link-entity></filter>`,
    ),
  });
  assert.deepEqual(grants.get('prvReadContact'), {
    mask: 16,
    fetchxml: filtered(
      'contact',
      '<link-entity name="powerpagesusermapping" from="contact" to="contactid" link-type="any"><filter><condition attribute="systemuser" operator="eq-userid" /></filter></link-entity>',
    ),
  });
  assert.deepEqual(grants.get('prvReadAccount'), {
    mask: 16,
    fetchxml: filtered(
      'account',
      `<link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any">${MAPPING_INNER}</link-entity>`,
    ),
  });
  for (const [name, grant] of grants)
    if (grant.mask !== 16) assert.equal(grant.mask, 8, `${name}: the other implicit grants are Global metadata reads`);
  // The visitor's user mapping row, which the filters join through.
  const user = mappedUser(fixture.sim);
  assert.deepEqual(
    fixture.sim.store
      .tableRows('powerpagesusermapping')
      .map((row) => [row.contact.id, row.systemuser.id, row.parentcustomerid?.id ?? null]),
    [['alex', user.systemuserid, 'acme']],
  );
});

// @test-kind observation: hosted session F1 (summary-F1.md AUTH-02d): Global on a custom activity generated the activity privileges with an unfiltered record filter on activitypointer, so it reaches every activity type.
test('an activity table permission maps to the shared activity privileges rooted at activitypointer', async (t) => {
  const fixture = await site(t, 3);
  await fixture.sim.store.transact(() => {
    fixture.sim.store.state.mappings.x_task.idColumn = 'activityid';
    fixture.sim.store.state.tables.x_task[0].activityid = fixture.sim.store.state.tables.x_task[0].x_taskid;
  });
  await fixture.ids('/_api/x_items?$select=x_name');
  const grants = recordFilters(fixture.sim, 'Member');
  assert.deepEqual(grants.get('prvReadActivity'), {
    mask: 16,
    fetchxml: '<fetch mapping="logical"><entity name="activitypointer" /></fetch>',
  });
  assert.equal(grants.has('prvReadX_task'), false);
});

// @test-kind security: a record-filter grant (depth 16) reaches only the rows its filter selects for the mapped user, never all rows as a Global grant would; a grant whose filter is missing or unreadable reaches nothing.
test('the mapped user reaches through Dataverse only the rows its record filters select', async (t) => {
  const fixture = await site(t, 3),
    { sim } = fixture;
  await fixture.ids('/_api/x_items?$select=x_name');
  const principals = createPrincipals(sim.store);
  const user = principals.byId(mappedUser(sim).systemuserid);
  const reads = (entity) => {
    const filter = principals.readFilter({ user, entity });
    return sim.store
      .tableRows(entity)
      .filter((row) => (filter ? filter(row) : true))
      .map((row) => row[`${entity}id`])
      .sort();
  };
  assert.deepEqual(reads('x_order'), ['o1'], 'Account scope: the parent account only');
  assert.deepEqual(reads('x_line'), ['l1'], 'Parent scope: through the parent permission');
  assert.deepEqual(reads('contact'), ['alex'], 'every role reads its own contact');
  assert.deepEqual(reads('account'), ['acme'], 'and its parent account');
  const writable = (entity, id) =>
    principals
      .principalAccess({ user, entity, row: sim.store.tableRows(entity).find((row) => row[`${entity}id`] === id) })
      .includes('WriteAccess');
  assert.deepEqual([writable('x_item', 'i1'), writable('x_item', 'i2')], [true, false], 'Contact scope');
  // A record filter that is gone, or whose FetchXML cannot be read, admits nothing.
  await sim.store.transact(() => {
    for (const row of sim.store.state.tables.recordfilter)
      if (row.fetchxml.includes('<entity name="x_order">')) row.fetchxml = '<fetch><entity name="x_order"><filter';
    sim.store.state.tables.recordfilter = sim.store.state.tables.recordfilter.filter(
      (row) => !row.fetchxml.includes('<entity name="x_line">'),
    );
  });
  const fresh = createPrincipals(sim.store);
  const freshUser = fresh.byId(user.systemuserid);
  for (const entity of ['x_order', 'x_line']) {
    const filter = fresh.readFilter({ user: freshUser, entity });
    assert.ok(filter, `${entity}: a record filter grant is never read as Global`);
    assert.deepEqual(sim.store.tableRows(entity).filter(filter), [], entity);
  }
});

// @test-kind security: the record filter evaluator never widens: unsupported joins, operators and roots admit nothing, an empty filter adds no condition (the hosted shape), and eq-userid matches only the calling user.
test('record filters admit nothing they cannot evaluate', () => {
  const rows = { mapping: [{ contact: 'c1', systemuser: 'u1' }] };
  const store = { tableRows: (name) => rows[name] ?? [], resolveMapping: () => ({ fields: {} }) };
  const linked = (type) =>
    `<fetch><entity name="contact"><link-entity name="mapping" from="contact" to="contactid" link-type="${type}"><filter><condition attribute="systemuser" operator="eq-userid" /></filter></link-entity></entity></fetch>`;
  const admits = (xml, userId, row = { contactid: 'c1' }, logical = 'contact') =>
    recordFilterAdmits(xml, { store, userId, logical }, row);
  assert.equal(admits(linked('any'), 'u1'), true);
  assert.equal(admits(linked('any'), 'u2'), false);
  assert.equal(admits(linked('any'), null), false);
  assert.equal(admits(linked('outer'), 'u1'), false);
  assert.equal(admits(linked('all'), 'u1'), false);
  assert.equal(admits(linked('not any'), 'u2'), true);
  assert.equal(admits('<fetch><entity name="contact"><filter type="or" /></entity></fetch>', null), true);
  assert.equal(admits('<fetch><entity name="account" /></fetch>', 'u1'), false, 'another root');
  assert.equal(admits('<fetch><entity name="contact"', 'u1'), false, 'unreadable');
  assert.equal(
    admits(
      '<fetch><entity name="contact"><filter><condition attribute="x" operator="invented" value="1" /></filter></entity></fetch>',
      'u1',
    ),
    false,
  );
});

// @test-kind security: a record-filter role held by a team reaches only what its filter selects without a user (an unfiltered filter), never every row of an organization-owned table.
test('a team holding a generated role reaches rows only through filters that need no user', async (t) => {
  const fixture = await site(t, 3),
    { sim } = fixture;
  await fixture.ids('/_api/x_items?$select=x_name');
  const role = sim.store.tableRows('role').find((row) => row.name === 'Member');
  const root = sim.store.tableRows('businessunit').find((row) => !row.parentbusinessunitid);
  const teamid = '77777777-7777-4777-8777-777777777790';
  await sim.store.transact(() => {
    sim.store.state.tables.team.push({
      teamid,
      name: 'Invented team',
      businessunitid: { id: root.businessunitid, logical_name: 'businessunit' },
    });
    sim.store.state.tables.teamroles.push({
      teamroleid: '77777777-7777-4777-8777-777777777791',
      teamid: { id: teamid, logical_name: 'team', name: 'Invented team' },
      roleid: { id: role.roleid, logical_name: 'role', name: 'Member' },
    });
  });
  const principals = createPrincipals(sim.store);
  const access = (entity, id) =>
    principals.teamAccess({
      team: { teamid },
      entity,
      row: sim.store.tableRows(entity).find((row) => row[`${entity}id`] === id),
    });
  assert.match(access('x_item', 'i2'), /ReadAccess/, 'Global: the unfiltered record filter');
  assert.doesNotMatch(access('x_order', 'o1'), /ReadAccess/, 'Account: the filter needs the visitor');
  assert.doesNotMatch(access('x_item', 'i1'), /WriteAccess/, 'Contact: the filter needs the visitor');
});
