// Mobile offline end to end (model-driven/offline.mjs): profile parsing, downsync through the records layer as the staff
// user, Xrm.WebApi.offline reads and writes against the session copy, upsync on going online and conflict handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { createModelDrivenWebApi } from '../lib/dataverse-model-driven.mjs';
import { inventoryFacts } from '../lib/solution-inventory.mjs';
import { parseSolutionXml } from '../lib/solution-xml.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { appCatalogue, solutionApps, MODEL_DRIVEN_CAPABILITY_RECORDS } from '../lib/model-driven/catalogue.mjs';
import {
  createOfflineSessions,
  offlineProfileGaps,
  offlineSessionState,
  profileItemFilter,
} from '../lib/model-driven/offline.mjs';
import { DataStore } from '../lib/data.mjs';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const PROFILE = '77777777-7777-4777-8777-777777777791',
  APP = '77777777-7777-4777-8777-777777777790';
const item = (entity, distribution, extra = '') =>
  `<MobileOfflineProfileItem><SelectedEntityTypeCode>${entity}</SelectedEntityTypeCode><RecordDistributionCriteria>${distribution}</RecordDistributionCriteria>${extra}</MobileOfflineProfileItem>`;
const association = (name) =>
  `<MobileOfflineProfileItemAssociations><MobileOfflineProfileItemAssociation><SelectedRelationShipsSchema>${name}</SelectedRelationShipsSchema></MobileOfflineProfileItemAssociation></MobileOfflineProfileItemAssociations>`;
const PROFILE_XML = `<MobileOfflineProfile><MobileOfflineProfileId>{${PROFILE}}</MobileOfflineProfileId><Name>fx_field</Name><MobileOfflineProfileItems>
${item('x_item', 3, `<ProfileItemEntityFilter>&lt;filter&gt;&lt;condition attribute="x_count" operator="ge" value="1"/&gt;&lt;/filter&gt;</ProfileItemEntityFilter><SyncIntervalInMinutes>30</SyncIntervalInMinutes>${association('x_item_notes')}`)}
${item('x_note', 0)}
</MobileOfflineProfileItems></MobileOfflineProfile>`;

test('profiles parse into all-rows, organization-rows, related-only and custom-filter items with relationships and intervals', () => {
  const xml = `<MobileOfflineProfile><Name>fx_parse</Name><MobileOfflineProfileItems>${item('x_all', 1, '<SyncIntervalInMinutes>1440</SyncIntervalInMinutes>')}${item('x_mine', 2, '<RecordsOwnedByMe>1</RecordsOwnedByMe>')}
    ${item('x_related', 0)}${item('x_custom', 3, `<ProfileItemEntityFilter><fetch><entity name="x_custom"><filter><condition attribute="statecode" operator="eq" value="0"/></filter></entity></fetch></ProfileItemEntityFilter>${association('x_custom_related')}`)}</MobileOfflineProfileItems></MobileOfflineProfile>`;
  const [record] = inventoryFacts(parseSolutionXml(xml));
  assert.deepEqual(
    [
      record.component,
      record.level,
      record.items.map((entry) => [entry.entity, entry.distribution, entry.syncIntervalMinutes, entry.relationships]),
    ],
    [
      'mobileofflineprofile',
      'behaviour',
      [
        ['x_all', 1, 1440, []],
        ['x_mine', 2, null, []],
        ['x_related', 0, null, []],
        ['x_custom', 3, null, ['x_custom_related']],
      ],
    ],
  );
  assert.deepEqual(record.items.map(profileItemFilter), [
    { filter: '' },
    { filter: '<filter type="or"><condition attribute="ownerid" operator="eq-userid"/></filter>' },
    { filter: null },
    { filter: '<filter><condition attribute="statecode" operator="eq" value="0"></condition></filter>' },
  ]);
  assert.match(
    profileItemFilter({ entity: 'x_custom', distribution: 3, filter: '<fetch><entity name="x_other"/></fetch>' })
      .reason,
    /not FetchXML for that table/,
  );
  assert.match(profileItemFilter({ entity: 'x_mine', distribution: 2 }).reason, /none of user, team or business unit/);
});

test('model-driven:offline/<profile> rows are satisfied for evaluated profiles and name the items the simulator cannot evaluate', () => {
  const good = {
    component: 'mobileofflineprofile',
    id: PROFILE,
    name: 'fx_good',
    items: [{ entity: 'x_item', distribution: 1, relationships: [] }],
  };
  const bad = {
    component: 'mobileofflineprofile',
    id: null,
    name: 'fx_bad',
    items: [{ entity: 'x_item', distribution: 3, filter: '<not-fetch/>', relationships: [] }],
  };
  const rows = Object.fromEntries(
    buildSourceGraph({
      scan: { inventory: [good, bad] },
      metadata: {
        modelDrivenApps: [
          { uniqueName: 'fx_app', components: [{ type: 161, id: '77777777-7777-4777-8777-777777777799' }] },
        ],
      },
    })
      .requirements()
      .map((row) => [row.id, row]),
  );
  assert.deepEqual(
    [rows['model-driven:offline/fx_good'].status, rows['model-driven:offline/fx_good'].level],
    ['satisfied', 'behaviour'],
  );
  assert.deepEqual(
    [
      rows['model-driven:offline/fx_bad'].status,
      rows['model-driven:offline/fx_bad'].reason,
      rows['model-driven:offline/fx_bad'].items,
    ],
    ['unsupported', 'MD_OFFLINE_FILTER_UNSUPPORTED', ['x_item']],
  );
  assert.deepEqual(
    [rows['model-driven:offline/fx_app'].status, rows['model-driven:offline/fx_app'].reason],
    ['unsupported', 'MD_OFFLINE_PROFILE_MISSING'],
  );
});

test('the catalogue gives an app the offline profile it names and reports offline at behaviour', () => {
  const [record] = inventoryFacts(parseSolutionXml(PROFILE_XML));
  const scan = {
    layers: [
      {
        documents: [
          { file: 'MobileOfflineProfiles/fx_field.xml', facts: { inventory: [record] } },
          {
            file: 'AppModules/x_app.xml',
            facts: {
              apps: [
                { id: APP, uniqueName: 'x_app', components: [{ type: 161, id: PROFILE }], navigation: [] },
                { id: '77777777-7777-4777-8777-777777777789', uniqueName: 'x_plain', components: [], navigation: [] },
              ],
            },
          },
        ],
      },
    ],
  };
  const [withProfile, plain] = solutionApps(scan);
  assert.deepEqual(
    [withProfile.offlineProfiles.map((profile) => profile.name), plain.offlineProfiles],
    [['fx_field'], []],
  );
  const catalogue = appCatalogue({ metadata: { modelDrivenApps: [withProfile], entities: {} }, mappings: {} });
  assert.equal(catalogue.apps[0].offlineProfiles[0].items.length, 2);
  assert.deepEqual(
    [MODEL_DRIVEN_CAPABILITY_RECORDS[0].name, MODEL_DRIVEN_CAPABILITY_RECORDS[0].level, catalogue.capabilities.offline],
    ['model-driven:offline', 'behaviour', true],
  );
});

test('isOffline, getClientState and Xrm.WebApi route by the session mode; Xrm.WebApi.offline uses the offline store in both modes', async () => {
  const table = {
    entity: 'x_item',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    entitySet: 'x_items',
    fields: { x_name: { name: 'x_name', type: 'text' } },
  };
  let mode = 'online';
  const offlineCalls = [],
    onlineCalls = [];
  const { Xrm } = createFormClientRuntime({
    table,
    tables: { x_item: table },
    form: { clientEvents: [], attributes: ['x_name'] },
    record: {},
    read: () => null,
    write() {},
    isDirty: () => false,
    controlNames: (name) => (name ? [name] : ['x_name']),
    controlField: (name) => name,
    controlState() {},
    notification() {},
    request: async (...args) => {
      onlineCalls.push(args);
      return { row: { x_itemid: '77777777-7777-4777-8777-000000000001' } };
    },
    offline: {
      isOffline: () => mode === 'offline',
      tables: () => ['x_item'],
      request: async (body) => {
        offlineCalls.push(body);
        if (mode !== 'offline') throw Object.assign(new Error('offline only'), { code: 'OfflineModeRequired' });
        return { id: '77777777-7777-4777-8777-000000000002', entityType: 'x_item' };
      },
    },
  });
  const client = Xrm.Utility.getGlobalContext().client;
  assert.deepEqual([client.isOffline(), client.getClientState(), client.getClient()], [false, 'Online', 'Web']);
  assert.equal(Xrm.WebApi.offline.isAvailableOffline('x_item'), true);
  assert.equal(Xrm.WebApi.isAvailableOffline('x_other'), false);
  await Xrm.WebApi.createRecord('x_item', { x_name: 'Online' });
  assert.deepEqual([onlineCalls.at(-1)[2].method, offlineCalls.length], ['POST', 0]);
  await assert.rejects(
    Xrm.WebApi.offline.createRecord('x_item', { x_name: 'Refused' }),
    (error) => error.code === 'OfflineModeRequired',
  );
  mode = 'offline';
  assert.deepEqual([client.isOffline(), client.getClientState(), client.getClient()], [true, 'Offline', 'Mobile']);
  const created = await Xrm.WebApi.createRecord('x_item', { x_name: 'Offline' });
  assert.deepEqual(
    [created.id, offlineCalls.at(-1)],
    ['77777777-7777-4777-8777-000000000002', { action: 'create', entity: 'x_item', data: { x_name: 'Offline' } }],
  );
  await Xrm.WebApi.offline.retrieveRecord('x_item', '{77777777-7777-4777-8777-00000000000A}', '?$select=x_name');
  assert.deepEqual(offlineCalls.at(-1), {
    action: 'retrieve',
    entity: 'x_item',
    id: '77777777-7777-4777-8777-00000000000a',
    options: '?$select=x_name',
  });
});

test('the /_sim/ Capabilities view lists the offline sessions on request', async () => {
  const { view } = await import('../admin/view-capabilities.mjs');
  const { HELP } = await import('../admin/help-content.mjs');
  const requested = [],
    data = {},
    refreshed = Promise.withResolvers();
  const ctx = {
    data,
    help: HELP,
    state: () => ({}),
    capabilities: () => ({}),
    docs: () => ({}),
    pager: () => ({ page: 1, size: 10, search: '' }),
    open: () => false,
    refresh: async () => refreshed.resolve(),
    notify() {},
    setButtonPending: () => true,
    request: async (path) => {
      requested.push(path);
      return {
        items: [
          {
            principalId: ID(9),
            kind: 'staff',
            app: APP,
            profile: 'fx_field',
            mode: 'offline',
            lastSync: null,
            tables: 2,
            queue: 3,
            conflicts: 1,
            errors: 0,
          },
        ],
      };
    },
  };
  await view.load(ctx);
  assert.match(view.render(ctx), /data-cap-offline>Show sessions/);
  assert.equal(
    view.handle(ctx, {
      type: 'click',
      target: { closest: (selector) => (selector === '[data-cap-offline]' ? {} : null) },
    }),
    true,
  );
  // The click loads the sessions and then refreshes the view.
  await refreshed.promise;
  const html = view.render(ctx);
  assert.deepEqual(requested, ['/model-driven/offline']);
  assert.match(html, /data-table="cap-offline"/);
  assert.match(html, /fx_field/);
  assert.match(html, /id="help-capabilities-offline"/);
});

// --- End to end against the organization ---
const field = (name, type = 'nvarchar') =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type></attribute>`;
const entity = (name, set, attributes) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${set}</EntitySetName><OwnershipTypeMask>UserOwned</OwnershipTypeMask><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes>${field(`${name}id`, 'primarykey')}${field('x_name')}${attributes}</attributes></entity></EntityInfo></Entity>`;

async function organization(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-offline-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>FxOffline</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml': entity('x_item', 'x_items', field('x_count', 'int')),
    'Entities/x_note/Entity.xml': entity('x_note', 'x_notes', field('x_itemid', 'lookup')),
    'Other/Relationships.xml':
      '<EntityRelationships><EntityRelationship Name="x_item_notes"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>x_note</ReferencingEntityName><ReferencedEntityName>x_item</ReferencedEntityName><ReferencingAttributeName>x_itemid</ReferencingAttributeName><ReferencedAttributeName>x_itemid</ReferencedAttributeName></EntityRelationship></EntityRelationships>',
    'AppModules/x_field/AppModule.xml': `<AppModule><UniqueName>x_field</UniqueName><AppModuleId>{${APP}}</AppModuleId><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/><AppModuleComponent type="161" id="{${PROFILE}}"/></AppModuleComponents></AppModule>`,
    'MobileOfflineProfiles/fx_field.xml': PROFILE_XML,
    'Roles/Fx Reader.xml': `<Role id="{77777777-7777-4777-8777-777777777781}" name="Fx Reader"><RolePrivileges>${['prvReadx_item', 'prvReadx_note'].map((name) => `<RolePrivilege name="${name}" level="Global" />`).join('')}</RolePrivileges></Role>`,
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, 'solution', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const sim = await createSimulator({
    runtime: { kind: 'model-driven' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: {
      enabled: false,
      tds: { enabled: false },
      users: ['a', 'b', 'c'].map((name, index) => ({
        objectId: `77777777-7777-4777-8777-0000000000a${index}`,
        domainname: `${name}@example.test`,
        fullname: `Staff ${name.toUpperCase()}`,
        roles: [name === 'c' ? 'Fx Reader' : 'Basic User'],
      })),
    },
  });
  ownedFixture(t).add(() => sim.close());
  const users = (await (await fetch(sim.url + '/_sim/api/dataverse/session')).json()).users;
  const webApi = createModelDrivenWebApi({ organization: () => sim.organization });
  const principals = {
    A: { principalId: users.find((user) => user.name === 'Staff A').id, kind: 'staff' },
    B: { principalId: users.find((user) => user.name === 'Staff B').id, kind: 'staff' },
    C: { principalId: users.find((user) => user.name === 'Staff C').id, kind: 'staff' },
    admin: {
      principalId: sim.store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid,
      kind: 'local-admin',
    },
  };
  const server = async (who, method, route, body, extra = {}) => {
    const result = await webApi({
      method,
      path: `/api/data/v9.2/${route}`,
      headers: { 'content-type': 'application/json', prefer: 'return=representation', ...extra },
      body: body && JSON.stringify(body),
      principal: principals[who],
      host: '127.0.0.1',
    });
    assert.ok(result.status < 400, result.body);
    return result.body ? JSON.parse(result.body) : null;
  };
  // The /_apps/api/offline handler over the organization's Web API, with the catalogue the Solution's app and profile give
  // (the running host's catalogue keeps folder profiles once the Solution metadata overlay carries offlineProfiles).
  const scan = {
    layers: [
      {
        documents: [
          {
            file: 'MobileOfflineProfiles/fx_field.xml',
            facts: { inventory: inventoryFacts(parseSolutionXml(PROFILE_XML)) },
          },
          {
            file: 'AppModules/x_field/AppModule.xml',
            facts: {
              apps: [{ id: APP, uniqueName: 'x_field', components: [{ type: 161, id: PROFILE }], navigation: [] }],
            },
          },
        ],
      },
    ],
  };
  const catalogue = () =>
    appCatalogue({
      metadata: { modelDrivenApps: solutionApps(scan), entities: {} },
      mappings: { x_item: sim.store.state.mappings.x_item, x_note: sim.store.state.mappings.x_note },
    });
  const handler = createModelDrivenHandler({
    catalogue,
    data: {},
    csrf: () => 'token',
    json: (res, status, body) => {
      res.statusCode = status;
      res.body = body;
    },
    readBody: async (req) => req.body,
    change: (fn) => fn(),
    principal: (req) => req.principal,
    webApi,
  });
  const call = async (who, method, route, body, status) => {
    const res = { setHeader() {}, destroyed: false };
    await handler(
      { method, headers: { 'x-sim-csrf': 'token', host: '127.0.0.1' }, body, principal: principals[who] },
      res,
      new URL(`http://127.0.0.1/_apps/api/offline${route}`),
    );
    assert.equal(res.statusCode, status, JSON.stringify(res.body));
    return res.body;
  };
  const offline = (who, body, status = 200) => call(who, 'POST', '', { app: APP, ...body }, status);
  const state = (who) => call(who, 'GET', `?app=${APP}`, undefined, 200);
  return { sim, server, offline, state, handler, principals };
}
const ID = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;

test('downsync honours staff security and the profile filter; offline writes queue and replay through the Web API on going online', async (t) => {
  const { sim, server, offline, state, handler } = await organization(t);
  await server('A', 'POST', 'x_items', { x_itemid: ID(1), x_name: 'Stocked', x_count: 2 });
  await server('A', 'POST', 'x_items', { x_itemid: ID(2), x_name: 'Empty', x_count: 0 });
  await server('B', 'POST', 'x_items', { x_itemid: ID(3), x_name: 'Other owner', x_count: 9 });
  await server('A', 'POST', 'x_notes', {
    x_noteid: ID(4),
    x_name: 'Note on stocked',
    'x_itemid@odata.bind': `/x_items(${ID(1)})`,
  });
  await server('A', 'POST', 'x_notes', {
    x_noteid: ID(5),
    x_name: 'Note on empty',
    'x_itemid@odata.bind': `/x_items(${ID(2)})`,
  });
  const status = await state('A');
  assert.deepEqual([status.mode, status.profile, status.gaps], ['online', 'fx_field', []]);
  assert.equal(
    (await offline('A', { action: 'create', entity: 'x_item', data: { x_name: 'Too early' } }, 409)).error.code,
    'OfflineModeRequired',
  );

  const down = await offline('A', { action: 'mode', mode: 'offline' });
  // Staff B's row is outside A's read rights; the custom filter drops x_count 0; x_note is related rows only.
  assert.deepEqual(
    [down.mode, down.tables],
    [
      'offline',
      [
        { entity: 'x_item', rows: 1, syncIntervalMinutes: 30 },
        { entity: 'x_note', rows: 1, syncIntervalMinutes: null },
      ],
    ],
  );
  // The next sync follows the shortest profile interval (x_item, 30 minutes) after this download.
  assert.equal(Date.parse(down.nextSync) - Date.parse(down.lastSync), 30 * 60000);
  const list = await offline('A', {
    action: 'retrieveMultiple',
    entity: 'x_item',
    options: '?$select=x_name&$filter=x_count gt 1',
  });
  assert.deepEqual(
    list.entities.map((row) => row.x_name),
    ['Stocked'],
  );
  const fetched = await offline('A', {
    action: 'retrieveMultiple',
    entity: 'x_note',
    options: `?fetchXml=<fetch><entity name="x_note"><attribute name="x_name"/></entity></fetch>`,
  });
  assert.deepEqual(
    fetched.entities.map((row) => row.x_name),
    ['Note on stocked'],
  );
  assert.equal(
    (await offline('A', { action: 'retrieve', entity: 'x_item', id: ID(3) }, 404)).error.code,
    'OfflineRecordNotFound',
  );
  assert.equal(
    (await offline('A', { action: 'create', entity: 'x_item', data: { X_Name: 'Bad case' } }, 400)).error.code,
    'OfflineValidationFailed',
  );
  assert.equal(
    (await offline('A', { action: 'create', entity: 'x_item', data: { x_itemid: ID(1), x_name: 'Duplicate' } }, 400))
      .error.code,
    'OfflineValidationFailed',
  );

  const made = await offline('A', {
    action: 'create',
    entity: 'x_note',
    data: { x_noteid: ID(6), x_name: 'Written offline', 'x_itemid@odata.bind': `/x_items(${ID(1)})` },
  });
  assert.deepEqual(made, { id: ID(6), entityType: 'x_note' });
  await offline('A', { action: 'update', entity: 'x_item', id: ID(1), data: { x_name: 'Renamed offline' } });
  await offline('A', { action: 'delete', entity: 'x_note', id: ID(4) });
  assert.equal(
    (await offline('A', { action: 'retrieve', entity: 'x_item', id: ID(1), options: '?$select=x_name' })).x_name,
    'Renamed offline',
  );
  // Nothing reaches the server while the session is offline, and a sync needs the connection back.
  assert.equal(sim.store.tableRows('x_item').find((row) => row.x_itemid === ID(1)).x_name, 'Stocked');
  assert.equal(
    sim.store.tableRows('x_note').some((row) => row.x_noteid === ID(6)),
    false,
  );
  assert.equal((await offline('A', { action: 'sync' }, 409)).error.code, 'OfflineSyncUnavailable');
  const queued = await state('A');
  assert.deepEqual(
    queued.queue.map((entry) => [entry.operation, entry.entity, entry.id]),
    [
      ['create', 'x_note', ID(6)],
      ['update', 'x_item', ID(1)],
      ['delete', 'x_note', ID(4)],
    ],
  );

  const up = await offline('A', { action: 'mode', mode: 'online' });
  assert.deepEqual([up.mode, up.queue, up.conflicts, up.errors], ['online', [], [], []]);
  assert.equal(sim.store.tableRows('x_item').find((row) => row.x_itemid === ID(1)).x_name, 'Renamed offline');
  assert.equal(sim.store.tableRows('x_note').find((row) => row.x_noteid === ID(6)).x_name, 'Written offline');
  assert.equal(
    sim.store.tableRows('x_note').some((row) => row.x_noteid === ID(4)),
    false,
  );
  assert.deepEqual(
    up.tables.map((table) => table.rows),
    [1, 1],
  );
  assert.deepEqual(
    handler.offlineSessions().map((entry) => [entry.kind, entry.app, entry.mode, entry.queue, entry.tables]),
    [['staff', APP, 'online', 0, 2]],
  );
});

test('without conflict detection the offline change wins; with it the server row wins and the conflict is listed', async (t) => {
  const { sim, server, offline } = await organization(t);
  await server('A', 'POST', 'x_items', { x_itemid: ID(1), x_name: 'Original', x_count: 1 });
  const round = async (offlineName, serverName) => {
    await offline('A', { action: 'mode', mode: 'offline' });
    await offline('A', { action: 'update', entity: 'x_item', id: ID(1), data: { x_name: offlineName } });
    await server('admin', 'PATCH', `x_items(${ID(1)})`, { x_name: serverName });
    return offline('A', { action: 'mode', mode: 'online' });
  };
  const wins = await round('Device edit', 'Server edit');
  assert.deepEqual([wins.conflicts, sim.store.tableRows('x_item')[0].x_name], [[], 'Device edit']);
  const [org] = (await server('admin', 'GET', 'organizations?$select=organizationid')).value;
  await server('admin', 'PATCH', `organizations(${org.organizationid})`, {
    isconflictdetectionenabledformobileclient: true,
  });
  const conflict = await round('Second device edit', 'Second server edit');
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Second server edit');
  assert.deepEqual(
    conflict.conflicts.map((entry) => [entry.operation, entry.entity, entry.id, entry.status, entry.code]),
    [['update', 'x_item', ID(1), 412, '0x80060882']],
  );
  // The running host serves the route: CSRF on POST, an unknown app is refused.
  const post = (headers, body) =>
    fetch(sim.url + '/_apps/api/offline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await post({}, { app: APP, action: 'sync' })).status, 403);
  assert.equal(
    (
      await (
        await post({ 'x-sim-csrf': sim.csrf }, { app: '77777777-7777-4777-8777-777777777700', action: 'sync' })
      ).json()
    ).error.code,
    'ModelDrivenRequestInvalid',
  );
  assert.deepEqual(
    await (await fetch(sim.url + '/_sim/api/model-driven/offline', { headers: { 'x-sim-csrf': sim.csrf } })).json(),
    { items: [] },
  );
  // The device copy is refreshed from the server after the conflict.
  await offline('A', { action: 'mode', mode: 'offline' });
  assert.equal((await offline('A', { action: 'retrieve', entity: 'x_item', id: ID(1) })).x_name, 'Second server edit');
});

// --- Upload and download failures against a fake in-process Web API (no organization) ---
const FAKE_APP = 'app-1',
  STAFF = { kind: 'staff', principalId: 'u-a' };
const fakeTables = {
  x_item: {
    entity: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    fields: { x_itemid: { name: 'x_itemid', isPrimaryId: true }, x_name: { name: 'x_name' } },
    relationships: {},
  },
  x_secret: {
    entity: 'x_secret',
    entitySet: 'x_secrets',
    idColumn: 'x_secretid',
    nameColumn: 'x_name',
    fields: { x_secretid: { name: 'x_secretid', isPrimaryId: true }, x_name: { name: 'x_name' } },
    relationships: {},
  },
};
function fakeOffline({ state = null, privilegeError } = {}) {
  const writes = [],
    fault = { nth: 0, status: 0 };
  const webApi = async ({ method, path, body }) => {
    if (method === 'GET' && path.includes('organizations'))
      return { status: 200, body: JSON.stringify({ value: [{ isconflictdetectionenabledformobileclient: false }] }) };
    if (method === 'GET' && path.startsWith('/api/data/v9.2/x_secrets'))
      return { status: 403, body: JSON.stringify({ error: { code: '0x80040220', message: 'No read privilege' } }) };
    if (method === 'GET')
      return {
        status: 200,
        body: JSON.stringify({ value: [{ x_itemid: ID(1), x_name: 'one', '@odata.etag': 'W/"1"' }] }),
      };
    writes.push({ method, path, body: body ? JSON.parse(body) : null });
    if (fault.nth && writes.length === fault.nth) {
      if (fault.status)
        return {
          status: fault.status,
          body: JSON.stringify({ error: { code: '0x80040217', message: 'Does Not Exist' } }),
        };
      throw new Error('transport broke');
    }
    return { status: method === 'POST' ? 201 : 204, body: '' };
  };
  if (privilegeError) webApi.privilegeError = privilegeError;
  const profile = {
    name: 'fx',
    items: [
      { entity: 'x_item', distribution: 1 },
      { entity: 'x_secret', distribution: 1 },
    ],
  };
  const sessions = createOfflineSessions({
    webApi,
    catalogue: async () => ({ apps: [{ id: FAKE_APP, offlineProfiles: [profile] }], tables: fakeTables }),
    state,
  });
  return { sessions, writes, fault };
}

test('a replay that throws keeps that entry and the rest queued, records the error and keeps the session offline; the next sync sends the rest', async () => {
  const { sessions, writes, fault } = fakeOffline();
  await sessions.setMode(STAFF, FAKE_APP, 'offline');
  for (const n of [3, 4, 5])
    await sessions.execute(STAFF, FAKE_APP, {
      operation: 'create',
      entity: 'x_item',
      data: { x_itemid: ID(n), x_name: `n${n}` },
    });
  fault.nth = 2;
  const failed = await sessions.setMode(STAFF, FAKE_APP, 'online');
  assert.deepEqual([failed.mode, failed.queue.map((entry) => entry.id)], ['offline', [ID(4), ID(5)]]);
  assert.deepEqual(
    failed.errors.map((error) => [error.operation, error.id, error.code, error.queued]),
    [['create', ID(4), 'OfflineSyncFailed', true]],
  );
  assert.match(failed.errors[0].message, /transport broke/);
  assert.equal(writes.length, 2); // the third create was not attempted
  fault.nth = 0;
  const retried = await sessions.setMode(STAFF, FAKE_APP, 'online');
  assert.deepEqual([retried.mode, retried.queue, retried.errors], ['online', [], []]);
  assert.deepEqual(
    writes.slice(2).map((write) => write.body.x_itemid),
    [ID(4), ID(5)],
  );
});

test('an answered sync error stays listed until a later upload of the same record succeeds', async () => {
  const { sessions, fault } = fakeOffline();
  await sessions.setMode(STAFF, FAKE_APP, 'offline');
  await sessions.execute(STAFF, FAKE_APP, {
    operation: 'update',
    entity: 'x_item',
    id: ID(1),
    data: { x_name: 'first' },
  });
  fault.nth = 1;
  fault.status = 404;
  const first = await sessions.setMode(STAFF, FAKE_APP, 'online');
  assert.deepEqual(
    [first.mode, first.queue.length, first.errors.map((error) => [error.id, error.status])],
    ['online', 0, [[ID(1), 404]]],
  );
  fault.nth = 0;
  await sessions.setMode(STAFF, FAKE_APP, 'offline');
  assert.equal((await sessions.status(STAFF, FAKE_APP)).errors.length, 1);
  await sessions.execute(STAFF, FAKE_APP, {
    operation: 'update',
    entity: 'x_item',
    id: ID(1),
    data: { x_name: 'second' },
  });
  assert.deepEqual((await sessions.setMode(STAFF, FAKE_APP, 'online')).errors, []);
});

test('a table whose download fails is not in the offline copy and refuses writes like a table outside the profile', async () => {
  const { sessions } = fakeOffline();
  const down = await sessions.setMode(STAFF, FAKE_APP, 'offline');
  assert.deepEqual(
    [down.tables.map((table) => table.entity), down.gaps],
    [['x_item'], [{ entity: 'x_secret', reason: 'No read privilege' }]],
  );
  const refused = await sessions
    .execute(STAFF, FAKE_APP, { operation: 'create', entity: 'x_secret', data: { x_name: 'made offline' } })
    .then(
      () => null,
      (error) => [error.status, error.code],
    );
  const outside = await sessions.execute(STAFF, FAKE_APP, { operation: 'create', entity: 'x_other', data: {} }).then(
    () => null,
    (error) => [error.status, error.code],
  );
  assert.deepEqual(
    [refused, outside],
    [
      [400, 'OfflineTableUnavailable'],
      [400, 'OfflineTableUnavailable'],
    ],
  );
  const records = sessions.recordsFor(STAFF, FAKE_APP);
  assert.deepEqual([records.capabilities('x_item').create, records.capabilities('x_secret').read], [true, false]);
});

test('profile filters name the condition operators and joins the offline download cannot run', () => {
  const custom = (entity, filter) => ({
    entity,
    distribution: 3,
    filter: `<fetch><entity name="${entity}">${filter}</entity></fetch>`,
  });
  const profile = {
    items: [
      custom(
        'x_item',
        '<filter><condition attribute="x_parentid" operator="under" value="77777777-7777-4777-8777-000000000001"/></filter>',
      ),
      custom('x_note', '<filter><condition attribute="createdon" operator="last-x-days" value="7"/></filter>'),
      custom(
        'x_task',
        '<link-entity name="x_secret" from="x_secretid" to="x_secretid"><filter><condition attribute="x_name" operator="eq" value="a"/></filter></link-entity>',
      ),
      custom(
        'x_link',
        '<link-entity name="x_note" from="x_noteid" to="x_noteid"><filter><condition attribute="ownerid" operator="eq-useroruserhierarchy"/></filter></link-entity>',
      ),
    ],
  };
  const gaps = offlineProfileGaps(profile);
  assert.deepEqual(
    gaps.map((gap) => gap.entity),
    ['x_item', 'x_task'],
  );
  assert.match(gaps[0].reason, /operator under.*hierarchical relationship/);
  assert.match(gaps[1].reason, /joins x_secret, which is not in the offline profile/);
  assert.deepEqual(profileItemFilter(profile.items[1]).reason, undefined);
});

test('the offline queue and copy persist in the private state and survive a restart per staff user and app', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-offline-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const first = await new DataStore({ file }).init();
  const before = fakeOffline({ state: offlineSessionState(first) });
  await before.sessions.setMode(STAFF, FAKE_APP, 'offline');
  await before.sessions.execute(STAFF, FAKE_APP, {
    operation: 'create',
    entity: 'x_item',
    data: { x_itemid: ID(7), x_name: 'queued before restart' },
  });
  const second = await new DataStore({ file }).init();
  const after = fakeOffline({ state: offlineSessionState(second) });
  assert.deepEqual(
    after.sessions.list().map((entry) => [entry.principalId, entry.app, entry.mode, entry.queue]),
    [['u-a', FAKE_APP, 'offline', 1]],
  );
  assert.equal(
    (await after.sessions.recordsFor(STAFF, FAKE_APP).get('x_item', ID(7))).row.x_name,
    'queued before restart',
  );
  const online = await after.sessions.setMode(STAFF, FAKE_APP, 'online');
  assert.deepEqual(
    [online.mode, online.queue, after.writes.map((write) => [write.method, write.body.x_itemid])],
    ['online', [], [['POST', ID(7)]]],
  );
  assert.equal(
    (await new DataStore({ file }).init()).state.simulator.offlineSessions[`staff:u-a|${FAKE_APP}`].queue.length,
    0,
  );
});

test('offline writes follow the privileges downloaded with the copy: a refused write fails at queue time with the privilege error', async () => {
  const denied = {
    status: 403,
    code: 'PrivilegeDenied',
    message: 'Principal user is missing prvCreatex_item privilege.',
    details: { innerCode: '0x80040220' },
  };
  const { sessions } = fakeOffline({
    privilegeError: ({ entity, operation }) => (entity === 'x_item' && operation !== 'update' ? denied : null),
  });
  await sessions.setMode(STAFF, FAKE_APP, 'offline');
  const refused = await sessions
    .execute(STAFF, FAKE_APP, { operation: 'create', entity: 'x_item', data: { x_name: 'no create' } })
    .then(
      () => null,
      (error) => [error.status, error.code, error.message],
    );
  assert.deepEqual(refused, [403, '0x80040220', denied.message]);
  await sessions.execute(STAFF, FAKE_APP, {
    operation: 'update',
    entity: 'x_item',
    id: ID(1),
    data: { x_name: 'may update' },
  });
  assert.equal(
    (
      await sessions
        .execute(STAFF, FAKE_APP, { operation: 'delete', entity: 'x_item', id: ID(1) })
        .catch((error) => error)
    ).code,
    '0x80040220',
  );
  assert.deepEqual(
    (await sessions.status(STAFF, FAKE_APP)).queue.map((entry) => entry.operation),
    ['update'],
  );
  const rights = sessions.recordsFor(STAFF, FAKE_APP).capabilities('x_item');
  assert.deepEqual([rights.read, rights.create, rights.update, rights.delete], [true, false, true, false]);
});

test('a read-only staff user downloads the copy and is refused offline writes with the online privilege error; execute waits for online', async (t) => {
  const { sim, server, offline, state, handler, principals } = await organization(t);
  await server('admin', 'POST', 'x_items', { x_itemid: ID(1), x_name: 'Readable', x_count: 3 });
  const down = await offline('C', { action: 'mode', mode: 'offline' });
  assert.deepEqual(
    down.tables.map((table) => [table.entity, table.rows]),
    [
      ['x_item', 1],
      ['x_note', 0],
    ],
  );
  const refused = await offline('C', { action: 'create', entity: 'x_item', data: { x_name: 'Not allowed' } }, 403);
  assert.equal(refused.error.code, '0x80040220');
  assert.match(refused.error.message, /missing prvCreatex_item privilege/i);
  assert.equal(
    (await offline('C', { action: 'update', entity: 'x_item', id: ID(1), data: { x_name: 'Not allowed' } }, 403)).error
      .code,
    '0x80040220',
  );
  assert.deepEqual((await state('C')).queue, []);
  // Xrm.WebApi.execute is online only: refused while the app's session is offline.
  const execute = async (who) => {
    const res = { setHeader() {}, destroyed: false };
    await handler(
      {
        method: 'POST',
        headers: { 'x-sim-csrf': 'token', host: '127.0.0.1', 'x-mirage-app': APP },
        principal: principals[who],
        body: {
          method: 'POST',
          path: '/api/data/v9.2/x_items',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x_itemid: ID(8), x_name: 'Executed' }),
        },
      },
      res,
      new URL('http://127.0.0.1/_apps/api/webapi'),
    );
    return res;
  };
  await offline('A', { action: 'mode', mode: 'offline' });
  const offlineExecute = await execute('A');
  assert.deepEqual([offlineExecute.statusCode, offlineExecute.body.error.code], [409, 'OfflineModeRequired']);
  assert.equal(
    sim.store.tableRows('x_item').some((row) => row.x_itemid === ID(8)),
    false,
  );
  await offline('A', { action: 'mode', mode: 'online' });
  const onlineExecute = await execute('A');
  assert.deepEqual([onlineExecute.statusCode, onlineExecute.body.status], [200, 204]);
});
