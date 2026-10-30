// Simulated Dataverse auditing: seeding, enablement, audit actions, impersonation, the
// history functions and their privileges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { AUDIT_ACTION, install, recordUserAccess, reset, writeAudit } from '../lib/dataverse-audit.mjs';
import { DataError } from '../lib/data-error.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const CALLER = 'aaaaaaaa-0000-4000-8000-000000000002';
const CLOCK = Date.UTC(2026, 9, 19, 9, 0, 0);
const IDENTITY = { admin: true, id: USER, systemUserId: USER };
const READ = ['prvReadRecordAuditHistory', 'prvReadAuditSummary'];
const ATTRIBUTE = '#Microsoft.Dynamics.CRM.AttributeAuditDetail';
const RELATIONSHIP = '#Microsoft.Dynamics.CRM.RelationshipAuditDetail';
const text = { dataverseType: 'nvarchar' };
const lookup = { dataverseType: 'lookup' };
const int = { dataverseType: 'int' };
const allowed = (...names) => ({ systemuserid: USER, organizationid: ORG, grants: new Map(names.map((n) => [n, 4])) });

function fixtureState({ org = true, table = true } = {}) {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: 'widget',
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'name',
    dataverseMetadata: { IsAuditEnabled: { Value: table } },
    relationships: { widget_tags: { entity: 'tag', from: 'widgetid', to: 'tagid', many: true } },
    // Field order is the column order: name 1, code 2, statecode 3, ownerid 4.
    fields: { name: text, code: { ...text, IsAuditEnabled: { Value: false } }, statecode: int, ownerid: lookup },
  };
  state.tables.widget = [];
  state.tables.organization = [{ organizationid: ORG, name: 'Test Org', isauditenabled: org }];
  return state;
}

// The schema is keyed by logical name, as buildSolutionSchema returns it.
function apiFor(store, grants, schema = { tables: { widget: { logicalName: 'widget', isAuditEnabled: true } } }) {
  const ops = [],
    hooks = {};
  return {
    store,
    ops,
    hooks,
    schema,
    clock: () => CLOCK,
    change: (fn) => fn(),
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add: (name, fn) => (hooks[name] = fn) },
    principals: { privileges: (user) => user.grants, authorize: () => 1 },
    grants,
  };
}

async function setup(options = {}, grants = allowed(...READ, 'prvDeleteRecordChangeHistory')) {
  const store = new DataStore({ state: fixtureState(options) });
  const api = apiFor(store, grants);
  install(api);
  return api;
}

const op = (api, name) => api.ops.find((o) => o.name === name);
const auditRows = (api) => api.store.state.tables.audit ?? [];
const widgetId = (api) => api.store.state.tables.widget.at(-1).widgetid;
// Audit rows are written by queued transactions after the committed events dispatch, so wait for the queue too.
const flush = async (api) => {
  await api.store.flushCommittedEvents();
  await api.store.queue;
};
const history = (api, id, params = {}) =>
  op(api, 'RetrieveRecordChangeHistory').handle({
    origin: ORIGIN,
    version: VERSION,
    user: allowed(...READ),
    params: { Target: { '@odata.id': `widgets(${id})` }, ...params },
  });

test('seeds the read-only audit mapping once and keeps an existing mapping', async () => {
  const api = await setup();
  const mapping = api.store.state.mappings.audit;
  assert.deepEqual(
    [mapping.entitySet, mapping.idColumn, mapping.userConfigured, mapping.dataverseOnly],
    ['audits', 'auditid', true, true],
  );
  const store = new DataStore({ state: fixtureState() });
  store.state.mappings.audit = { logicalName: 'audit', entitySet: 'custom', dataverseOnly: true, fields: {} };
  install(apiFor(store, allowed()));
  assert.equal(store.state.mappings.audit.entitySet, 'custom');
});

test('audit rows need organization, table and column flags', async () => {
  const cases = [
    ['organization off', { org: false }, { name: 'B' }, 0],
    ['table off', { table: false }, { name: 'B' }, 0],
    ['organization and table on', {}, { name: 'B' }, 2],
    ['unaudited column only', {}, { code: 'y' }, 1],
  ];
  for (const [name, options, change, expected] of cases) {
    const api = await setup(options);
    await api.store.create('widget', { name: 'A', code: 'x' }, IDENTITY);
    await api.store.update('widget', widgetId(api), change, IDENTITY);
    await flush(api);
    assert.equal(auditRows(api).length, expected, name);
  }
});

test('create, update, assign, set state and delete audit with their operation and action', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A', statecode: 0 }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  await api.store.update('widget', id, { name: 'B' }, IDENTITY);
  await api.store.update('widget', id, { ownerid: { id: CALLER, logical_name: 'systemuser', name: '' } }, IDENTITY);
  await api.store.update('widget', id, { statecode: 1 }, IDENTITY);
  await flush(api);
  await api.store.remove('widget', id, IDENTITY);
  await flush(api);
  const pairs = auditRows(api).map((r) => [r.operation, r.action, r.attributemask]);
  assert.deepEqual(pairs, [
    [1, 1, '1,3'],
    [2, 2, '1'],
    [2, 13, '4'],
    [2, 41, '3'],
    [3, 3, null],
  ]);
});

test('impersonated writes record the calling user, direct writes do not', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A' }, { ...IDENTITY, dataverse: { callerId: CALLER } });
  await api.store.create('widget', { name: 'B' }, { ...IDENTITY, dataverse: { callerId: USER } });
  await flush(api);
  const [impersonated, direct] = auditRows(api);
  assert.equal(impersonated.userid.id, USER);
  assert.equal(impersonated.callinguserid.id, CALLER);
  assert.equal(direct.callinguserid, null);
});

test('N:N associate and disassociate audit through the afterWrite hook', async () => {
  const api = await setup();
  const widget = api.store.state.mappings.widget;
  await api.hooks.afterWrite({ identity: IDENTITY }, widget, {
    operation: 'associate',
    id: 'w1',
    relationship: 'widget_tags',
  });
  await api.hooks.afterWrite({ identity: IDENTITY }, widget, {
    operation: 'disassociate',
    id: 'w1',
    relationship: 'widget_tags',
  });
  assert.deepEqual(
    auditRows(api).map((r) => r.action),
    [33, 34],
  );
  const page = await history(api, 'w1');
  assert.equal(page.body.AuditDetailCollection.AuditDetails[0]['@odata.type'], RELATIONSHIP);
});

test("the schema's object-keyed table flag drives auditing when the mapping says nothing, and an association never throws", async () => {
  for (const [isAuditEnabled, expected] of [
    [true, 1],
    [false, 0],
  ]) {
    const store = new DataStore({ state: fixtureState() });
    delete store.state.mappings.widget.dataverseMetadata;
    const api = apiFor(store, allowed(...READ), { tables: { widget: { logicalName: 'widget', isAuditEnabled } } });
    install(api);
    await store.create('widget', { name: 'A' }, IDENTITY);
    await flush(api);
    assert.equal(auditRows(api).length, expected, `isAuditEnabled ${isAuditEnabled}`);
    await assert.doesNotReject(
      api.hooks.afterWrite({ identity: IDENTITY }, store.state.mappings.widget, {
        operation: 'associate',
        id: 'w1',
        relationship: 'widget_tags',
      }),
    );
    assert.equal(auditRows(api).length, expected + (isAuditEnabled ? 1 : 0));
  }
});

test('an association audit joins the open write transaction and rolls back with it', async () => {
  const api = await setup();
  const widget = api.store.state.mappings.widget;
  await assert.rejects(
    api.store.transact(async () => {
      await api.hooks.afterWrite({ identity: IDENTITY }, widget, {
        operation: 'associate',
        id: 'w1',
        relationship: 'widget_tags',
      });
      assert.equal(auditRows(api).length, 1);
      throw new Error('write failed');
    }),
    /write failed/,
  );
  assert.equal(auditRows(api).length, 0);
});

test('a failing audit write is logged and does not fail the association', async () => {
  const api = await setup();
  const logged = [];
  api.log = (error) => logged.push(error);
  api.store.transact = () => {
    throw new Error('audit store unavailable');
  };
  await assert.doesNotReject(
    api.hooks.afterWrite({ identity: IDENTITY }, api.store.state.mappings.widget, {
      operation: 'associate',
      id: 'w1',
      relationship: 'widget_tags',
    }),
  );
  assert.equal(logged.length, 1);
});

test('a column whose columnMetadata says not audited is left out of the mask', async () => {
  const api = await setup();
  api.store.state.mappings.widget.fields.hidden = { ...text, columnMetadata: { isAuditEnabled: false } };
  await api.store.create('widget', { name: 'A', hidden: 'x' }, IDENTITY);
  await flush(api);
  await api.store.update('widget', widgetId(api), { hidden: 'y' }, IDENTITY);
  await flush(api);
  assert.deepEqual(
    auditRows(api).map((r) => r.attributemask),
    ['1'],
  );
});

test('audit rows survive a reload from the store file', async (t) => {
  const dir = await makeTemporaryDirectory(join(tmpdir(), 'audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const store = await new DataStore({ file, state: fixtureState() }).init();
  install(apiFor(store, allowed(...READ)));
  await store.create('widget', { name: 'A' }, IDENTITY);
  await store.flushCommittedEvents();
  await store.queue;
  const reloaded = await new DataStore({ file }).init();
  assert.equal(reloaded.state.tables.audit.length, 1);
});

test('an identity without a systemuser id is audited as the SYSTEM user', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A' }, { admin: true, id: CALLER });
  await flush(api);
  assert.equal(auditRows(api)[0].userid.id, uuidV5(ORG, 'systemuser:SYSTEM'));
});

test('secured columns read as null in change history, and the history carries its @odata.context', async () => {
  const api = await setup();
  api.store.state.mappings.widget.fields.secret = text;
  const masked = [];
  api.fieldSecurity = {
    mask: (user, logical, row) => {
      masked.push(logical);
      return { ...row, secret: undefined };
    },
  };
  await api.store.create('widget', { name: 'A', secret: 'S3CRET' }, IDENTITY);
  await flush(api);
  const page = await history(api, widgetId(api));
  const detail = page.body.AuditDetailCollection.AuditDetails[0];
  assert.deepEqual([detail.NewValue.name, detail.NewValue.secret], ['A', null]);
  assert.equal(
    page.body['@odata.context'],
    `${ORIGIN}/api/data/${VERSION}/$metadata#Microsoft.Dynamics.CRM.RetrieveRecordChangeHistoryResponse`,
  );
  assert.ok(masked.every((logical) => logical === 'widget') && masked.length > 0);
});

test('the audit table refuses writes with 405', async () => {
  const api = await setup();
  const mapping = api.store.state.mappings.audit;
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    assert.throws(
      () => api.hooks.beforeWrite({ method }, mapping, { operation: 'update' }),
      (error) =>
        error.status === 405 &&
        error.message === `The requested resource does not support http method '${method}'.` &&
        error.details.innerCode === '',
    );
  }
});

test('record change history pages with a paging cookie and newest rows first', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'v0' }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  for (const name of ['v1', 'v2', 'v3']) await api.store.update('widget', id, { name }, IDENTITY);
  await flush(api);
  const first = await history(api, id, { PagingInfo: { Count: 2, ReturnTotalRecordCount: true } });
  const page1 = first.body.AuditDetailCollection;
  assert.deepEqual([page1.MoreRecords, page1.TotalRecordCount, page1.AuditDetails.length], [true, 4, 2]);
  const untotalled = (await history(api, id, { PagingInfo: { Count: 2 } })).body.AuditDetailCollection;
  assert.equal(untotalled.TotalRecordCount, -1);
  assert.equal(page1.AuditDetails[0].NewValue.name, 'v3');
  assert.equal(page1.AuditDetails[0]['@odata.type'], ATTRIBUTE);
  const second = await history(api, id, { PagingInfo: { Count: 2, PagingCookie: page1.PagingCookie } });
  const page2 = second.body.AuditDetailCollection;
  assert.deepEqual([page2.MoreRecords, page2.AuditDetails.length, page2.PagingCookie], [false, 2, '']);
  assert.equal(page2.AuditDetails[1].NewValue.name, 'v0');
});

test('attribute change history and audit details return only the matching column', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A', statecode: 0 }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  await api.store.update('widget', id, { statecode: 1 }, IDENTITY);
  await api.store.update('widget', id, { name: 'B' }, IDENTITY);
  await flush(api);
  const statecode = await op(api, 'RetrieveAttributeChangeHistory').handle({
    user: allowed(...READ),
    params: { Target: { '@odata.id': `widgets(${id})` }, AttributeLogicalName: 'statecode' },
  });
  const details = statecode.body.AuditDetailCollection.AuditDetails;
  assert.deepEqual(
    details.map((d) => [d['@odata.type'], d.NewValue.statecode]),
    [
      [ATTRIBUTE, 1],
      [ATTRIBUTE, 0],
    ],
  );
  const latest = auditRows(api).find((r) => r.action === 2 && r.attributemask === '1');
  const bound = await op(api, 'RetrieveAuditDetails').handle({ user: allowed(...READ), target: { row: latest } });
  assert.deepEqual([bound.body.AuditDetail.NewValue.name, bound.body.AuditDetail.OldValue.name], ['B', 'A']);
});

test('history functions need both read privileges', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A' }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  for (const grants of [allowed(), allowed('prvReadRecordAuditHistory')]) {
    await assert.rejects(
      op(api, 'RetrieveRecordChangeHistory').handle({
        user: grants,
        params: { Target: { '@odata.id': `widgets(${id})` } },
      }),
      (error) =>
        error.status === 403 &&
        error.details.innerCode === '0x80040220' &&
        /prvReadAuditSummary|prvReadRecordAuditHistory/.test(error.message),
    );
  }
});

test("delete record change history removes only that record's rows and needs its privilege", async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A' }, IDENTITY);
  await api.store.create('widget', { name: 'B' }, IDENTITY);
  await flush(api);
  const [first, second] = api.store.state.tables.widget;
  const deleteOp = op(api, 'DeleteRecordChangeHistory');
  await assert.rejects(
    deleteOp.handle({ user: allowed(...READ), body: { Target: { '@odata.id': `widgets(${first.widgetid})` } } }),
    (error) => error.status === 403,
  );
  const result = await deleteOp.handle({
    user: allowed('prvDeleteRecordChangeHistory'),
    body: JSON.stringify({ Target: { '@odata.id': `widgets(${first.widgetid})` } }),
  });
  assert.deepEqual(result, { status: 200, body: { DeletedEntriesCount: 1 } });
  assert.deepEqual(
    auditRows(api).map((r) => r.objectid.id),
    [second.widgetid],
  );
});

test('writeAudit records share and role changes by Action value, and skips an unaudited entity', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A' }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  const before = auditRows(api).length;
  for (const action of [
    AUDIT_ACTION.share,
    AUDIT_ACTION.modifyShare,
    AUDIT_ACTION.unshare,
    AUDIT_ACTION.removePrivilegesFromRole,
  ]) {
    await writeAudit(api, { entity: 'widget', id, action, identity: IDENTITY });
  }
  await writeAudit(api, { entity: 'missing', id, action: AUDIT_ACTION.share, identity: IDENTITY });
  assert.deepEqual(
    auditRows(api)
      .slice(before)
      .map((r) => [r.operation, r.action, r.objectid.id]),
    [
      [2, 14, id],
      [2, 48, id],
      [2, 49, id],
      [2, 58, id],
    ],
  );
});

test('user access rows need the organization flags and are written once per interval and channel', async () => {
  const store = new DataStore({ state: fixtureState() });
  Object.assign(store.state.tables.organization[0], { isuseraccessauditenabled: true, useraccessauditinginterval: 4 });
  const api = apiFor(store, allowed());
  install(api);
  const who = { systemUserId: CALLER };
  assert.equal(await recordUserAccess(api, who, 'web'), true);
  assert.equal(await recordUserAccess(api, who, 'web'), false);
  assert.equal(await recordUserAccess(api, who, 'webServices'), true);
  api.clock = () => CLOCK + 4 * 3600000;
  assert.equal(await recordUserAccess(api, who, 'web'), true);
  assert.deepEqual(
    auditRows(api).map((r) => [r.operation, r.action, r.objectid.id]),
    [
      [4, 64, CALLER],
      [4, 65, CALLER],
      [4, 64, CALLER],
    ],
  );
  store.state.tables.organization[0].isuseraccessauditenabled = false;
  assert.equal(await recordUserAccess(api, who, 'web'), false);
});

test('change history checks read on the target row, and a denied row is refused', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A', statecode: 0 }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  const checked = [];
  api.principals.authorize = (options) => {
    checked.push([options.entity, options.operation, options.row.widgetid]);
    if (options.row.widgetid === id) throw new DataError('Privilege denied', 403, 'AccessDenied');
    return 1;
  };
  await assert.rejects(history(api, id), (e) => e.status === 403);
  await assert.rejects(
    op(api, 'RetrieveAttributeChangeHistory').handle({
      user: allowed(...READ),
      params: { Target: { '@odata.id': `widgets(${id})` }, AttributeLogicalName: 'statecode' },
    }),
    (e) => e.status === 403,
  );
  assert.deepEqual(checked, [
    ['widget', 'read', id],
    ['widget', 'read', id],
  ]);
});

test('each audit operation carries CSDL, and each shared complex type is declared once', async () => {
  const api = await setup();
  assert.ok(api.ops.every((o) => typeof o.csdl === 'string' && o.csdl.length > 0));
  const declared = api.ops.flatMap((o) =>
    [...o.csdl.matchAll(/<(?:ComplexType|Function|Action) Name="([^"]+)"/g)].map((m) => m[1]),
  );
  assert.equal(new Set(declared).size, declared.length);
  assert.ok(declared.includes('PagingInfo') && declared.includes('AuditDetailCollection'));
  assert.ok(op(api, 'RetrieveAuditDetails').csdl.includes('<Function Name="RetrieveAuditDetails" IsBound="true">'));
  assert.ok(op(api, 'DeleteRecordChangeHistory').csdl.includes('<Action Name="DeleteRecordChangeHistory">'));
});

test('reset(api) re-seeds the audit table and mapping that a reset wipes', async () => {
  const api = await setup();
  delete api.store.state.tables.audit;
  delete api.store.state.mappings.audit;
  await reset(api);
  assert.deepEqual(api.store.state.tables.audit, []);
  assert.deepEqual(
    [api.store.state.mappings.audit.entitySet, api.store.state.mappings.audit.dataverseOnly],
    ['audits', true],
  );
});

// DeleteAuditData, GetAuditStorageDetails and RetrieveAuditPartitionList. Their privileges and response properties are
// not documented, so the simulator's choices are guesses.
test('DeleteAuditData deletes the audit rows older than EndDate, and a caller without the delete privilege is refused', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A', statecode: 0 }, IDENTITY);
  await flush(api);
  const before = auditRows(api).length;
  assert.ok(before > 0);
  const del = op(api, 'DeleteAuditData');
  assert.ok(del.csdl.includes('<Parameter Name="EndDate" Type="Edm.DateTimeOffset" Nullable="false" />'));
  // The rows were written at CLOCK (2026-10-19T09:00Z): an earlier EndDate deletes nothing.
  const kept = await del.handle({
    origin: ORIGIN,
    version: VERSION,
    user: allowed('prvDeleteRecordChangeHistory'),
    body: { EndDate: '2026-10-18T00:00:00Z' },
  });
  assert.equal(kept.status, 200);
  assert.equal(auditRows(api).length, before);
  await assert.rejects(
    del.handle({ origin: ORIGIN, version: VERSION, user: allowed(...READ), body: { EndDate: '2026-10-20T00:00:00Z' } }),
    (e) => e.status === 403,
  );
  assert.equal(auditRows(api).length, before, 'a refused call leaves the rows');
  await assert.rejects(
    del.handle({ origin: ORIGIN, version: VERSION, user: allowed('prvDeleteRecordChangeHistory'), body: {} }),
    (e) => e.status === 400,
  );
  await del.handle({
    origin: ORIGIN,
    version: VERSION,
    user: allowed('prvDeleteRecordChangeHistory'),
    body: { EndDate: '2026-10-20T00:00:00Z' },
  });
  assert.equal(auditRows(api).length, 0);
});

test('GetAuditStorageDetails answers Completed with the organization and each audited table, and needs the audit read privileges', async () => {
  const api = await setup();
  await api.store.create('widget', { name: 'A', statecode: 0 }, IDENTITY);
  await flush(api);
  const storage = op(api, 'GetAuditStorageDetails');
  const res = await storage.handle({ origin: ORIGIN, version: VERSION, user: allowed(...READ) });
  assert.equal(res.body.Result.Status, 'Completed');
  const details = res.body.Result.AuditStorageDetails;
  assert.deepEqual(details.Keys, ['organization', 'widget']);
  assert.equal(details.Count, 2);
  assert.equal(details.Values.length, 2);
  assert.ok(details.Values[1].SizeInBytes > 0);
  await assert.rejects(storage.handle({ origin: ORIGIN, version: VERSION, user: allowed() }), (e) => e.status === 403);
});

test('RetrieveAuditPartitionList lists one synthetic partition and needs the audit read privileges', async () => {
  const api = await setup();
  const partitions = op(api, 'RetrieveAuditPartitionList');
  const res = await partitions.handle({ origin: ORIGIN, version: VERSION, user: allowed(...READ) });
  assert.equal(res.body.AuditPartitionDetailCollection.length, 1);
  assert.equal(res.body.AuditPartitionDetailCollection[0].PartitionNumber, 1);
  await assert.rejects(
    partitions.handle({ origin: ORIGIN, version: VERSION, user: allowed() }),
    (e) => e.status === 403,
  );
});
