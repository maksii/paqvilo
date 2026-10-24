import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { createModelDrivenRecordService } from '../lib/dataverse-model-driven.mjs';
import { createStaffSessions, createStaffSessionHandler } from '../lib/staff-session.mjs';
import { createModelDrivenData } from '../lib/model-driven/data.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { organizationPrincipalContext } from '../lib/dataverse-principal-context.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { createSimulator } from '../server.mjs';

const ids = [
  '31111111-1111-4111-8111-111111111111',
  '32222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
async function fixture(t, options = {}) {
  const state = emptyState();
  state.mappings.new_staffitem = {
    logicalName: 'new_staffitem',
    entitySet: 'new_staffitems',
    idColumn: 'new_staffitemid',
    nameColumn: 'new_name',
    ownership: 'UserOwned',
    fields: {
      new_name: { dataverseType: 'nvarchar' },
      new_secret: { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } },
    },
  };
  state.tables.new_staffitem = [];
  state.mappings.new_staffitem.fields.new_targetid = { dataverseType: 'lookup', targets: ['new_stafftarget'] };
  state.mappings.new_staffitem.relationships = {
    new_targetid: { entity: 'new_stafftarget', from: 'new_targetid', to: 'new_stafftargetid', many: false },
  };
  state.mappings.new_stafftarget = {
    logicalName: 'new_stafftarget',
    entitySet: 'new_stafftargets',
    idColumn: 'new_stafftargetid',
    nameColumn: 'new_name',
    ownership: 'UserOwned',
    fields: { new_name: { dataverseType: 'nvarchar' }, new_secret: { dataverseType: 'nvarchar', isSecured: true } },
  };
  state.tables.new_stafftarget = [];
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({
    enabled: false,
    users: [
      { objectId: ids[0], domainname: 'one@example.test', fullname: 'One', roles: ['Basic User'] },
      { objectId: ids[1], domainname: 'two@example.test', fullname: 'Two', roles: ['Basic User'] },
      {
        objectId: ids[2],
        domainname: 'admin@example.test',
        fullname: 'Administrator',
        roles: ['System Administrator'],
      },
    ],
  });
  const core = await createOrganizationRuntime({
    store,
    settings,
    extensions: await sourceOrganizationExtensions(),
    ...options,
  });
  t.after(() => core.close());
  const service = createModelDrivenRecordService({ organization: core });
  const users = ids.map((id) => core.principals.byObjectId(id));
  return { store, core, service, users, actor: (index) => ({ principalId: users[index].systemuserid }) };
}

test('headless organization installs the full platform without opening a network listener', async (t) => {
  const listen = t.mock.method(net.Server.prototype, 'listen', () => {
    throw Error('Headless organization opened a listener');
  });
  const { core, store } = await fixture(t);
  assert.equal(listen.mock.callCount(), 0);
  assert.ok(core.api.fieldSecurity);
  assert.ok(core.registry.has('ExecuteWorkflow'));
  assert.ok(store.state.mappings.systemform);
  const order = [];
  const custom = await fixture(t, {
    extensions: [
      {
        name: 'probe',
        install() {
          order.push('install');
        },
        reset() {
          order.push('reset');
        },
        close() {
          order.push('close');
        },
      },
    ],
  });
  await custom.core.reseed();
  await custom.core.close();
  await custom.core.close();
  assert.deepEqual(order, ['install', 'reset', 'close']);
});

test('staff MDA queries, record reads and writes use row privileges, FLS and canonical versions', async (t) => {
  const { core, store, service, users, actor } = await fixture(t);
  await assert.rejects(service.get('new_staffitem', ids[0], { principalId: '' }), (error) => error.status === 401);
  const first = await service.write({ entity: 'new_staffitem', values: { new_name: 'Owned by One' }, ...actor(0) });
  const second = await service.write({ entity: 'new_staffitem', values: { new_name: 'Owned by Two' }, ...actor(1) });
  const admin = await service.write({
    entity: 'new_staffitem',
    id: first.id,
    etag: first.etag,
    values: { new_secret: 'Classified fixture' },
    ...actor(2),
  });
  const fetch = '<fetch returntotalrecordcount="true"><entity name="new_staffitem"><all-attributes /></entity></fetch>';
  const own = await service.query('new_staffitem', fetch, actor(0));
  assert.deepEqual(
    own.rows.map((row) => row.new_staffitemid),
    [first.id],
  );
  assert.equal(own.rows[0].new_secret, undefined, 'FetchXML omits masked null fields.');
  const deniedField = await service.get('new_staffitem', first.id, actor(0));
  assert.equal(deniedField.row.new_secret, null);
  assert.equal((await service.get('new_staffitem', first.id, actor(2))).row.new_secret, 'Classified fixture');
  await assert.rejects(service.get('new_staffitem', second.id, actor(0)), { status: 403, code: 'AccessDenied' });
  await assert.rejects(
    service.write({
      entity: 'new_staffitem',
      id: first.id,
      etag: admin.etag,
      values: { new_secret: 'Denied' },
      ...actor(0),
    }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    service.write({
      entity: 'new_staffitem',
      id: first.id,
      etag: first.etag,
      values: { new_name: 'Stale' },
      ...actor(0),
    }),
    (error) => error.status === 412,
  );
  const changed = await service.write({
    entity: 'new_staffitem',
    id: first.id,
    etag: admin.etag,
    values: { new_name: 'Changed' },
    ...actor(0),
  });
  assert.equal(changed.row.modifiedby, users[0].systemuserid);
  const table = {
    entity: 'new_staffitem',
    fields: { new_name: { name: 'new_name', type: 'text' } },
    nameColumn: 'new_name',
    idColumn: 'new_staffitemid',
    views: [{ id: 'all', fields: [{ name: 'new_name' }], fetchXml: fetch }],
    forms: [],
  };
  const data = createModelDrivenData({
    store,
    catalogue: () => ({ tables: { new_staffitem: table } }),
    recordService: service,
  });
  const [one, two] = await Promise.all([
    data.list('new_staffitem', {}, actor(0)),
    data.list('new_staffitem', {}, actor(1)),
  ]);
  assert.deepEqual(
    one.rows.map((row) => row.new_staffitemid),
    [first.id],
  );
  assert.deepEqual(
    two.rows.map((row) => row.new_staffitemid),
    [second.id],
  );
  const fields = store.state.mappings.new_staffitem.fields;
  const ownRights = service.capabilities('new_staffitem', actor(0), { id: first.id, fields });
  assert.equal(ownRights.update, true);
  assert.equal(ownRights.fields.new_secret.read, false);
  assert.equal(ownRights.fields.new_secret.update, false);
  assert.equal(service.capabilities('new_staffitem', actor(0), { id: second.id }).delete, false);
  const previousAdapter = store.storageAdapter;
  store.storageAdapter = {
    recordCapabilities: (logical) => ({
      create: logical !== 'new_staffitem',
      update: false,
      delete: false,
      reason: 'Declared file is read-only.',
    }),
  };
  const limited = service.capabilities('new_staffitem', actor(2), { id: first.id, fields });
  assert.deepEqual([limited.read, limited.create, limited.update, limited.delete], [true, false, false, false]);
  assert.equal(limited.reason, 'Declared file is read-only.');
  assert.equal(limited.fields.new_name.update, false);
  store.storageAdapter = previousAdapter;
  assert.equal(core.principals.byId(users[0].systemuserid).fullname, 'One');
});

test('HTTP transport can reuse a headless organization without owning its lifecycle', async (t) => {
  const calls = [];
  const { core, service } = await fixture(t, {
    extensions: [
      {
        name: 'lifecycle',
        install() {
          calls.push('install');
        },
        close() {
          calls.push('close');
        },
      },
    ],
  });
  let activated = false;
  const transport = await startDataverseApi({
    organization: core,
    beforeListen() {
      activated = true;
    },
  });
  assert.equal(activated, true);
  assert.equal(transport.organization, core);
  await Promise.all([transport.close(), transport.close()]);
  assert.deepEqual(calls, ['install']);
  const made = await service.write({ entity: 'new_staffitem', values: { new_name: 'Still running' } });
  assert.equal(made.row.new_name, 'Still running');
  await core.close();
  assert.deepEqual(calls, ['install', 'close']);
});

test('polymorphic MDA writes preserve the selected target and reject ambiguous id-only changes', async (t) => {
  const { store, service } = await fixture(t);
  await store.transact(() => {
    store.state.mappings.new_staffitem.fields.new_targetid.targets = ['new_stafftarget', 'new_staffitem'];
    store.state.mappings.new_staffitem.relationships.new_targetid_item = {
      entity: 'new_staffitem',
      from: 'new_targetid',
      to: 'new_staffitemid',
      many: false,
    };
  });
  const target = await service.write({ entity: 'new_staffitem', values: { new_name: 'Second table target' } });
  await assert.rejects(
    service.write({ entity: 'new_staffitem', values: { new_name: 'Ambiguous', new_targetid: target.id } }),
    (error) => error.status === 400 && error.code === 'InvalidLookup',
  );
  const made = await service.write({
    entity: 'new_staffitem',
    values: {
      new_name: 'Typed source',
      new_targetid: { id: target.id, entity: 'new_staffitem', name: 'Second table target' },
    },
  });
  const raw = () => store.tableRows('new_staffitem').find((row) => row.new_staffitemid === made.id);
  assert.equal(raw().new_targetid.logical_name, 'new_staffitem');
  const saved = await service.write({
    entity: 'new_staffitem',
    id: made.id,
    etag: made.etag,
    values: { new_name: 'Unrelated edit', new_targetid: target.id },
  });
  assert.equal(
    raw().new_targetid.logical_name,
    'new_staffitem',
    'An unchanged legacy id reuses its stored canonical target.',
  );
  await assert.rejects(
    service.write({ entity: 'new_staffitem', id: made.id, etag: saved.etag, values: { new_targetid: ids[1] } }),
    (error) => error.status === 400 && error.code === 'InvalidLookup',
  );
});

test('readable lookup labels retain the native contract while target candidates, links and expansions enforce row security', async (t) => {
  const { core, service, actor, users } = await fixture(t);
  const target = await service.write({
    entity: 'new_stafftarget',
    values: { new_name: 'Referenced primary name' },
    ...actor(1),
  });
  const source = await service.write({ entity: 'new_staffitem', values: { new_name: 'Readable source' }, ...actor(0) });
  await service.write({
    entity: 'new_staffitem',
    id: source.id,
    etag: source.etag,
    values: { new_targetid: target.id },
    ...actor(2),
  });
  // A readable lookup carries its target primary name even if that related row
  // is unreadable. It does not grant access to querying or expanding the target:
  // https://learn.microsoft.com/en-us/power-apps/maker/data-platform/types-of-fields
  const own = await service.get('new_staffitem', source.id, actor(0));
  assert.equal(own.row['new_targetid@OData.Community.Display.V1.FormattedValue'], 'Referenced primary name');
  const nameOnly = await service.write({
    entity: 'new_staffitem',
    id: source.id,
    etag: own.etag,
    values: { new_name: 'Unrelated field changed' },
    ...actor(0),
  });
  assert.equal(
    nameOnly.row.new_name,
    'Unrelated field changed',
    'Updating the source does not require AppendTo on an untouched lookup.',
  );
  await assert.rejects(
    service.write({
      entity: 'new_staffitem',
      id: source.id,
      etag: nameOnly.etag,
      values: { new_targetid: { id: target.id, entity: 'new_stafftarget' } },
      ...actor(0),
    }),
    (error) => error.status === 403,
    'Rebinding that lookup still checks target AppendTo.',
  );
  assert.deepEqual(
    (
      await service.query(
        'new_stafftarget',
        '<fetch><entity name="new_stafftarget"><all-attributes/></entity></fetch>',
        actor(0),
      )
    ).rows,
    [],
  );
  const linked = await service.query(
    'new_staffitem',
    '<fetch><entity name="new_staffitem"><attribute name="new_name"/><link-entity name="new_stafftarget" from="new_stafftargetid" to="new_targetid" alias="target" link-type="outer"><attribute name="new_name"/></link-entity></entity></fetch>',
    actor(0),
  );
  assert.equal(linked.rows.length, 1);
  assert.equal(linked.rows[0]['target.new_name'], undefined);
  const url = new URL(`http://organization.local/api/data/v9.2/new_staffitems(${source.id})?$expand=new_targetid`);
  const expanded = await core.read(() =>
    core.records.handle({
      method: 'GET',
      url,
      origin: url.origin,
      version: 'v9.2',
      route: parseDataverseRoute(url.pathname),
      prefer: parsePrefer('odata.include-annotations="*"'),
      headers: {},
      ...organizationPrincipalContext(core.store, users[0]),
    }),
  );
  assert.equal(expanded.body.new_targetid, null);
  await service.write({
    entity: 'new_stafftarget',
    id: target.id,
    etag: target.etag,
    values: { new_secret: 'Restricted linked value' },
    ...actor(2),
  });
  const visible = await service.write({
    entity: 'new_staffitem',
    values: { new_name: 'Visible linked source' },
    ...actor(1),
  });
  await service.write({
    entity: 'new_staffitem',
    id: visible.id,
    etag: visible.etag,
    values: { new_targetid: target.id },
    ...actor(2),
  });
  const securedLink = await service.query(
    'new_staffitem',
    '<fetch><entity name="new_staffitem"><attribute name="new_name"/><link-entity name="new_stafftarget" from="new_stafftargetid" to="new_targetid" alias="target"><attribute name="new_name"/><attribute name="new_secret"/><attribute name="new_secret" alias="hidden_alias"/></link-entity></entity></fetch>',
    actor(1),
  );
  assert.equal(securedLink.rows.length, 1);
  assert.equal(securedLink.rows[0]['target.new_name'], 'Referenced primary name');
  assert.equal(securedLink.rows[0]['target.new_secret'], undefined);
  assert.equal(securedLink.rows[0].hidden_alias, undefined);
  assert.ok(!JSON.stringify(securedLink).includes('Restricted linked value'));
});

test('failed organization bootstrap closes partial and prior installers exactly once', async () => {
  const store = await new DataStore({ state: emptyState() }).init(),
    calls = [];
  const failure = Error('Invented installer failure');
  await assert.rejects(
    createOrganizationRuntime({
      store,
      settings: dataverseSettings({ enabled: false }),
      extensions: [
        {
          install() {
            calls.push('first install');
          },
          close() {
            calls.push('first close');
            throw Error('Cleanup probe');
          },
        },
        {
          install() {
            calls.push('second install');
            throw failure;
          },
          close() {
            calls.push('second close');
          },
        },
        {
          install() {
            calls.push('never install');
          },
          close() {
            calls.push('never close');
          },
        },
      ],
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ['first install', 'second install', 'first close', 'second close']);
});

test('failed transport startup releases opened listeners and honors organization ownership', async (t) => {
  const opened = [],
    listen = net.Server.prototype.listen;
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    opened.push(this);
    return listen.apply(this, args);
  });
  const { core, service } = await fixture(t);
  // Invalid TLS data fails only after HTTP has successfully begun listening.
  await assert.rejects(
    startDataverseApi({
      organization: core,
      tls: { key: 'Invented invalid key', cert: 'Invented invalid certificate' },
    }),
    { code: 'ERR_OSSL_PEM_NO_START_LINE' },
  );
  assert.ok(opened.length);
  assert.ok(opened.every((server) => !server.listening));
  assert.equal(
    (await service.write({ entity: 'new_staffitem', values: { new_name: 'External core survives startup failure' } }))
      .row.new_name,
    'External core survives startup failure',
  );
  const calls = [];
  const store = await new DataStore({ state: emptyState() }).init();
  await assert.rejects(
    startDataverseApi({
      store,
      settings: dataverseSettings({ enabled: true }),
      extensions: [
        {
          install() {
            calls.push('install');
          },
          close() {
            calls.push('close');
          },
        },
      ],
      beforeListen() {
        throw Error('Invented policy admission failure');
      },
    }),
    /policy admission/,
  );
  assert.deepEqual(calls, ['install', 'close']);
});

test('portal listener admission failure closes the API and every earlier listener', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-listener-cleanup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, 'website.yml'),
    'adx_name: Invented cleanup portal\nadx_websiteid: 34444444-4444-4444-8444-444444444444',
  );
  const opened = [],
    listen = net.Server.prototype.listen,
    failure = Object.assign(Error('Invented portal listen failure'), { code: 'EADDRINUSE' });
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    opened.push(this);
    if (typeof args[0] === 'object' && args[0].host) {
      queueMicrotask(() => this.emit('error', failure));
      return this;
    }
    return listen.apply(this, args);
  });
  await assert.rejects(
    createSimulator({ sourceDir: directory, watch: false, dataverse: { enabled: true } }),
    (error) => error === failure,
  );
  assert.ok(opened.length >= 2, 'The API had already begun listening before portal admission failed.');
  assert.ok(
    opened.every((server) => !server.listening),
    'All owned listeners are closed after failed construction.',
  );
});

test('staff sessions are signed, per browser and independent of portal contact cookies', async (t) => {
  const { core, service, users, actor } = await fixture(t);
  const sessions = createStaffSessions({ organization: core, port: () => 4001 });
  const one = sessions.select({}, users[0].systemuserid).split(';')[0],
    two = sessions.select({}, users[1].systemuserid).split(';')[0];
  assert.equal(sessions.resolve({ headers: {} }).kind, 'local-admin');
  assert.equal(sessions.resolve({ headers: { cookie: one } }).principalId, users[0].systemuserid);
  assert.equal(sessions.resolve({ headers: { cookie: two } }).principalId, users[1].systemuserid);
  assert.equal(
    sessions.resolve({ headers: { cookie: `paqvilo-mirage-auth-4001=unrelated; ${one}` } }).principalId,
    users[0].systemuserid,
  );
  assert.equal(sessions.resolve({ headers: { cookie: 'paqvilo-mirage-auth-4001=unrelated' } }).kind, 'local-admin');
  assert.ok(sessions.describe({ headers: { cookie: one } }).current.roles.includes('Basic User'));
  assert.ok(
    sessions
      .describe({ headers: {} })
      .users.every(
        (user) =>
          user.id !== core.store.state.tables.systemuser.find((user) => user.fullname === 'SYSTEM').systemuserid,
      ),
  );
  assert.throws(
    () => sessions.resolve({ headers: { cookie: one.slice(0, -1) + 'x' } }),
    (error) => error.status === 401,
  );
  const restarted = createStaffSessions({ organization: core, port: () => 4001 });
  assert.throws(
    () => restarted.resolve({ headers: { cookie: one } }),
    (error) => error.status === 401,
  );
  await core.store.transact(() => {
    core.principals.byId(users[0].systemuserid).isdisabled = true;
  });
  assert.throws(
    () => sessions.resolve({ headers: { cookie: one } }),
    (error) => error.status === 401,
  );
  await core.store.transact(() => {
    core.principals.byId(users[0].systemuserid).isdisabled = false;
    core.principals.byId(users[0].systemuserid).applicationid = ids[2];
  });
  assert.throws(
    () => sessions.resolve({ headers: { cookie: one } }),
    (error) => error.status === 401,
  );
  await assert.rejects(
    service.get('new_staffitem', ids[0], actor(0)),
    (error) => error.status === 401,
    'A previously admitted actor is checked again against current account facts.',
  );
  await core.store.transact(() => {
    core.store.state.tables.systemuser = core.store
      .tableRows('systemuser')
      .filter((user) => user.systemuserid !== users[0].systemuserid);
  });
  assert.throws(
    () => sessions.resolve({ headers: { cookie: one } }),
    (error) => error.status === 401,
  );
  let result;
  const handler = createStaffSessionHandler({
    sessions,
    csrf: () => 'expected',
    json: (_res, status, body) => {
      result = { status, body };
    },
    readBody: async () => ({ userId: users[1].systemuserid }),
  });
  await handler(
    { method: 'POST', headers: {} },
    { setHeader() {} },
    new URL('http://localhost/_sim/api/dataverse/session'),
  );
  assert.equal(result.status, 403);
  let cookie;
  await handler(
    { method: 'POST', headers: { 'x-sim-csrf': 'expected' } },
    {
      setHeader(_name, value) {
        cookie = value;
      },
    },
    new URL('http://localhost/_sim/api/dataverse/session'),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.current.id, users[1].systemuserid);
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
});
