// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Tracing of the Dataverse pipeline (docs/design/tracing.md): dataverse spans per internal entry, store spans for reads no
// Dataverse span covers, commit facts, permission decisions as events (a denial without a span gets its own permission
// span), the staging span on committed events, and secret spans that never hold the value. Invented schemas only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { seed as seedStandard } from '../lib/dataverse-standard.mjs';
import { ensureSecurityModel, createPrincipals } from '../lib/dataverse-security.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { createRecordHandlers } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { runAtomic } from '../lib/dataverse-api.mjs';
import { install } from '../lib/dataverse-org-messages.mjs';
import { createSecretResolver } from '../lib/secret-resolver.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const READER_OID = 'aaaaaaaa-0000-4000-8000-000000000002';
const VALUE = 'invented-secret-value-71be';
const REFERENCE = 'https://fx-vault.vault.azure.net/secrets/func-key';
const SETTINGS = {
  organizationId: '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
    { objectId: READER_OID, upn: 'reader@example.test', displayName: 'Reader', roles: [] },
  ],
};
const MAPPING = {
  logicalName: 'fx_gadget',
  entitySet: 'fx_gadgets',
  idColumn: 'fx_gadgetid',
  nameColumn: 'fx_name',
  userConfigured: true,
  fields: { fx_name: { dataverseType: 'nvarchar' } },
  relationships: {},
};

async function organization(level = 'full') {
  const state = emptyState();
  state.mappings.fx_gadget = structuredClone(MAPPING);
  state.tables.fx_gadget = [];
  const store = new DataStore({ state });
  await store.transact(() => seedStandard(store));
  await ensureSecurityModel(store, SETTINGS);
  store.traces = createTraceStore({ settings: { level } });
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const records = createRecordHandlers({ store, change: (fn) => fn(), principals, changes });
  const api = {
    store,
    change: (fn) => fn(),
    registry: createOperationRegistry(),
    principals,
    metadata: null,
    metadataFields: () => undefined,
    records,
    changes,
    settings: SETTINGS,
    clock: () => 0,
    log: () => {},
  };
  api.runAtomic = (fn) => runAtomic(api, fn);
  install(api);
  return {
    store,
    api,
    records,
    traces: store.traces,
    admin: principals.byObjectId(ADMIN_OID),
    reader: principals.byObjectId(READER_OID),
  };
}
const spansOf = (traces, traceId) => traces.tree(traceId).spans;
const childrenOf = (spans, span) => spans.filter((item) => item.parentSpanId === span.spanId);

test('an internal create is one dataverse span with its actor, a permission allow event and its output at level full', async () => {
  const { store, records, traces, admin } = await organization();
  const root = traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
  const row = await traces.run(root, () =>
    store.transact(() =>
      records.createInternal({ user: admin, method: 'POST', identity: { admin: true } }, 'fx_gadget', {
        fx_name: 'One',
      }),
    ),
  );
  root.end();
  const spans = spansOf(traces, root.traceId);
  const [create] = childrenOf(
    spans,
    spans.find((span) => span.spanId === root.spanId),
  );
  assert.equal(create.kind, 'dataverse');
  assert.equal(create.name, 'Create fx_gadget');
  assert.equal(create.operation, 'create');
  assert.equal(create.entity, 'fx_gadget');
  assert.equal(create.status, 'ok');
  assert.deepEqual(create.actor, { kind: 'staff', id: admin.systemuserid, name: admin.fullname ?? null });
  assert.equal(create.attributes.method, 'POST');
  assert.deepEqual(create.input, { fx_name: 'One' });
  assert.deepEqual(create.output, { id: row.fx_gadgetid });
  // Two decisions, one event each: the Dataverse privilege check and the store's table permission check.
  const [allow, table] = create.events.filter((event) => event.type === 'permission');
  assert.equal(allow.attributes.result, 'allow');
  assert.equal(allow.attributes.table, 'fx_gadget');
  assert.equal(allow.attributes.operation, 'create');
  assert.equal(allow.attributes.model, 'dataverse');
  assert.equal(typeof allow.attributes.depth, 'number');
  assert.ok(allow.attributes.privilege, 'the privilege the decision checked');
  assert.equal('entity' in allow.attributes, false, 'the shared vocabulary names the table');
  assert.deepEqual(
    { table: table.attributes.table, operation: table.attributes.operation, result: table.attributes.result },
    { table: 'fx_gadget', operation: 'create', result: 'allow' },
  );
  const commit = spans.find((span) => span.spanId === root.spanId).events.find((e) => e.type === 'commit');
  assert.ok(commit, 'the commit is an event on the current span');
  assert.equal(commit.attributes.eventsStaged, 1);
  assert.ok('saveMs' in commit.attributes && 'saveMode' in commit.attributes);
});

test('a privilege denial is a deny event and a denied dataverse span; the decision never becomes a span of its own', async () => {
  const { store, records, traces, reader } = await organization();
  const root = traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
  await assert.rejects(
    traces.run(root, () =>
      store.transact(() =>
        records.createInternal({ user: reader, method: 'POST', identity: { admin: true } }, 'fx_gadget', {
          fx_name: 'No',
        }),
      ),
    ),
    (error) => error.code === 'PrivilegeDenied',
  );
  root.end();
  const spans = spansOf(traces, root.traceId);
  const create = spans.find((span) => span.kind === 'dataverse');
  assert.equal(create.status, 'denied');
  assert.equal(create.error.code, 'PrivilegeDenied');
  const deny = create.events.find((event) => event.type === 'permission');
  assert.equal(deny.attributes.result, 'deny');
  assert.equal(deny.attributes.code, 'PrivilegeDenied');
  assert.equal(deny.attributes.table, 'fx_gadget');
  assert.equal(deny.attributes.depth, null);
  assert.equal(
    spans.some((span) => span.kind === 'permission'),
    false,
  );
});

test('a table permission denial without a current span opens a denied permission span; with one it is an event', async () => {
  const store = new DataStore({
    state: {
      version: 1,
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
      tables: { widget: [{ widgetid: 'w1', title: 'Invented' }] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  const traces = store.traces;
  const row = store.tableRows('widget')[0];
  assert.throws(() => store.assertAllowed('widget', 'read', row, { id: 'visitor' }), /Table permission denies read/);
  const [lone] = traces.query({ kind: 'permission' }).items;
  assert.equal(lone.root.kind, 'permission');
  assert.equal(lone.root.status, 'denied');
  assert.equal(lone.root.module, 'security');
  const denial = lone.root.events.find((event) => event.attributes?.code === 'TABLE_PERMISSION_DENIED');
  assert.deepEqual(
    { table: denial.attributes.table, operation: denial.attributes.operation, result: denial.attributes.result },
    { table: 'widget', operation: 'read', result: 'deny' },
  );

  traces.clear();
  const root = traces.start({ kind: 'http', name: 'GET /invented' });
  assert.throws(() => traces.run(root, () => store.get('widget', 'w1', { id: 'visitor' })));
  root.end();
  const spans = spansOf(traces, root.traceId);
  assert.equal(
    spans.some((span) => span.kind === 'permission'),
    false,
  );
  // The store read span carries the decision once: the denial, with no earlier rules-evaluation event.
  const read = spans.find((span) => span.kind === 'store');
  assert.equal(read.status, 'denied');
  assert.deepEqual(
    read.events.filter((event) => event.type === 'permission').map((event) => event.attributes.result),
    ['deny'],
  );
});

test('a store read is one span with its row count, and a read inside a dataverse span opens none', async () => {
  const { store, records, traces, admin } = await organization('summary');
  await store.transact(() =>
    records.createInternal({ user: admin, identity: { admin: true } }, 'fx_gadget', { fx_name: 'Read me' }),
  );
  traces.clear();
  const answer = store.query('fx_gadget', {}, { admin: true });
  assert.equal(answer.value.length, 1);
  const [read] = traces.spans({ kind: 'store', operation: 'retrievemultiple' }).items;
  assert.equal(read.entity, 'fx_gadget');
  assert.equal(read.attributes.rowCount, 1);
  assert.equal(read.input, undefined, 'summary captures no query');

  traces.clear();
  const id = store.tableRows('fx_gadget')[0].fx_gadgetid;
  records.readInternal({ user: admin, identity: { admin: true } }, 'fx_gadget', id);
  const spans = traces.spans({}).items;
  assert.deepEqual(
    spans.map((span) => span.kind),
    ['dataverse'],
    'the dataverse retrieve covers its store read',
  );
});

test('a committed event names its staging span and its commit is an event; a commit with no current span opens no span', async () => {
  const store = new DataStore({
    state: {
      version: 1,
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
      tables: { widget: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  const traces = store.traces;
  const staged = [];
  store.addCommitStager((events) => {
    staged.push(...events);
  });
  const root = traces.start({ kind: 'http', name: 'POST /invented' });
  await traces.run(root, () => store.create('widget', { title: 'Staged' }, { admin: true }));
  root.end();
  assert.equal(staged.length, 1);
  // The staging span is kept beside the event, never in it (the event is persisted in asyncoperation.data).
  assert.equal('traceId' in staged[0] || 'parentSpanId' in staged[0], false);
  assert.equal(store.stagingSpan(staged[0]).spanId, root.spanId);
  const commit = traces.span(root.spanId).events.find((event) => event.type === 'commit');
  assert.equal(commit.attributes.eventsStaged, 1);

  traces.clear();
  await store.create('widget', { title: 'Unscoped' }, { admin: true });
  assert.equal(store.stagingSpan(staged.at(-1)), null, 'no span, no staging span');
  assert.equal(traces.status().spans, 0, 'a commit outside any span records nothing');
});

// @test-kind contract+security: a secret span never holds the secret value
test('RetrieveEnvironmentVariableSecretValue nests a secret span holding the key and status, never the value', async () => {
  const { api, traces, admin } = await organization();
  await api.registry.find({ name: 'UpsertEnvironmentVariable', kind: 'action', binding: 'unbound' }).handle({
    user: admin,
    caller: null,
    body: { SchemaName: 'fx_Key', Type: 100000005, SecretStore: 0, Value: REFERENCE },
    identity: { admin: true },
    origin: ORIGIN,
    version: 'v9.2',
    url: new URL(`${ORIGIN}/api/data/v9.2/UpsertEnvironmentVariable`),
  });
  api.secrets = createSecretResolver({
    secrets: { 'fx-vault/func-key': { variable: 'FX_FUNC_KEY', allow: [admin.systemuserid] } },
    env: { FX_FUNC_KEY: VALUE },
    traces: () => api.store.traces,
  });
  traces.clear();
  const root = traces.start({ kind: 'http', name: 'POST /api/data/v9.2/RetrieveEnvironmentVariableSecretValue' });
  const answer = await traces.run(root, () =>
    api.registry.find({ name: 'RetrieveEnvironmentVariableSecretValue', kind: 'action', binding: 'unbound' }).handle({
      user: admin,
      caller: null,
      body: { EnvironmentVariableName: 'fx_Key' },
      identity: { admin: true },
      origin: ORIGIN,
      version: 'v9.2',
      url: new URL(`${ORIGIN}/api/data/v9.2/RetrieveEnvironmentVariableSecretValue`),
    }),
  );
  root.end();
  assert.equal(answer.body.EnvironmentVariableSecretValue, VALUE);
  const spans = spansOf(traces, root.traceId);
  const secret = spans.find((span) => span.kind === 'secret');
  assert.equal(secret.parentSpanId, root.spanId);
  assert.equal(secret.name, 'Secret fx-vault/func-key');
  assert.equal(secret.status, 'ok');
  assert.deepEqual(
    { key: secret.attributes.key, status: secret.attributes.status, principalId: secret.attributes.principalId },
    { key: 'fx-vault/func-key', status: 'resolved', principalId: admin.systemuserid },
  );
  assert.equal(JSON.stringify(traces.export({})).includes(VALUE), false, 'the value is in no span');

  api.secrets = createSecretResolver({
    secrets: { 'fx-vault/func-key': { variable: 'FX_FUNC_KEY', allow: [] } },
    env: { FX_FUNC_KEY: VALUE },
    traces: api.store.traces,
  });
  await api.secrets.resolve(REFERENCE, { principalId: admin.systemuserid, purpose: 'test' });
  const [denied] = traces.query({ kind: 'secret', status: 'denied' }).items;
  assert.equal(denied.root.attributes.status, 'denied');
  assert.equal(JSON.stringify(traces.export({})).includes(VALUE), false);
});

test('level off records nothing and summary records no payloads', async () => {
  const off = await organization('off');
  await off.store.transact(() =>
    off.records.createInternal({ user: off.admin, identity: { admin: true } }, 'fx_gadget', { fx_name: 'Off' }),
  );
  off.store.query('fx_gadget', {}, { admin: true });
  assert.equal(off.traces.status().spans, 0);

  const summary = await organization('summary');
  await summary.store.transact(() =>
    summary.records.createInternal({ user: summary.admin, identity: { admin: true } }, 'fx_gadget', {
      fx_name: 'Summary',
    }),
  );
  const [create] = summary.traces.spans({ kind: 'dataverse' }).items;
  assert.equal(create.input, undefined);
  assert.equal(create.output, undefined);
});

// A contact-scoped grant over 50 rows: one permission event per decision and one per filtering call, with counts.
function contactScoped() {
  const state = emptyState();
  state.mappings.fx_item = {
    logicalName: 'fx_item',
    entitySet: 'fx_items',
    idColumn: 'fx_itemid',
    nameColumn: 'fx_name',
    userConfigured: true,
    fields: { fx_name: {}, fx_contact: {} },
    relationships: {},
  };
  state.tables.fx_item = Array.from({ length: 50 }, (_, index) => ({
    fx_itemid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    fx_name: `Item ${index}`,
    fx_contact: index < 10 ? 'c1' : 'c2',
  }));
  state.permissions = [
    {
      id: 'p1',
      name: 'Own items',
      entity: 'fx_item',
      operations: ['read', 'update'],
      scope: 'contact',
      field: 'fx_contact',
    },
  ];
  const store = new DataStore({ state });
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  return { store, traces: store.traces, identity: { id: 'c1', contactId: 'c1' } };
}
const permissionEvents = (traces, span) =>
  traces.span(span.spanId).events.filter((event) => event.type === 'permission');

test('a denied decision is exactly one deny event, an allowed one exactly one allow event', () => {
  const { store, traces, identity } = contactScoped();
  const [mine, other] = [store.tableRows('fx_item')[0], store.tableRows('fx_item')[20]];
  const root = traces.start({ kind: 'http', name: 'PATCH /invented' });
  traces.run(root, () => {
    assert.throws(() => store.assertAllowed('fx_item', 'update', other, identity), /Table permission denies update/);
    store.assertAllowed('fx_item', 'update', mine, identity);
  });
  root.end();
  assert.deepEqual(
    permissionEvents(traces, root).map(({ attributes }) => [attributes.operation, attributes.result, attributes.code]),
    [
      ['update', 'deny', 'TABLE_PERMISSION_DENIED'],
      ['update', 'allow', undefined],
    ],
  );
  const [, allow] = permissionEvents(traces, root);
  assert.deepEqual(
    { table: allow.attributes.table, model: allow.attributes.model, permissions: allow.attributes.permissions },
    { table: 'fx_item', model: 'standard', permissions: ['Own items'] },
  );
});

test('a filtering read of 50 rows is one filtered event with its counts; find and findMany are one each', () => {
  const { store, traces, identity } = contactScoped();
  const root = traces.start({ kind: 'http', name: 'GET /invented' });
  const visible = traces.run(root, () => store.rows('fx_item', identity));
  const one = traces.run(root, () =>
    store.evaluate({ op: 'find', args: ['fx_item'], match: { fx_contact: 'c1' } }, { identity }),
  );
  const many = traces.run(root, () =>
    store.evaluate({ op: 'findMany', args: ['fx_item'], match: { fx_contact: ['c1', 'c2'] } }, { identity }),
  );
  const none = traces.run(root, () =>
    store.evaluate({ op: 'find', args: ['fx_item'], match: { fx_contact: 'c2' } }, { identity }),
  );
  root.end();
  assert.equal(visible.length, 10);
  assert.equal(one.fx_contact, 'c1');
  assert.equal(many.length, 10);
  assert.equal(none, null);
  assert.deepEqual(
    permissionEvents(traces, root).map(({ attributes }) => [
      attributes.table,
      attributes.operation,
      attributes.result,
      attributes.rows,
      attributes.allowed,
    ]),
    [
      ['fx_item', 'read', 'filtered', 50, 10],
      ['fx_item', 'read', 'filtered', 10, 1],
      ['fx_item', 'read', 'filtered', 50, 10],
      ['fx_item', 'read', 'filtered', 40, 0],
    ],
    'never one event per row',
  );

  traces.clear();
  const query = traces.start({ kind: 'http', name: 'GET /_api/fx_items' });
  traces.run(query, () => store.query('fx_item', {}, identity));
  query.end();
  const read = traces.spans({ kind: 'store', traceId: query.traceId }).items[0];
  assert.deepEqual(
    read.events
      .filter((event) => event.type === 'permission')
      .map(({ attributes }) => [attributes.rows, attributes.allowed]),
    [[50, 10]],
    'a query read is one filtered event on its store span',
  );
});

test('a permission-filtered row count is one filtered event per call; admin counts record none', () => {
  const { store, traces, identity } = contactScoped();
  const root = traces.start({ kind: 'http', name: 'GET /invented/$count' });
  const counts = traces.run(root, () => [
    store.rowCount('fx_item', identity),
    store.rowCount('fx_item', { id: 'c9', contactId: 'c9' }),
    store.rowCount('fx_item', { admin: true }),
  ]);
  root.end();
  assert.deepEqual(counts, [10, 0, 50]);
  assert.deepEqual(
    permissionEvents(traces, root).map(({ attributes }) => [
      attributes.table,
      attributes.operation,
      attributes.result,
      attributes.rows,
      attributes.allowed,
    ]),
    [
      ['fx_item', 'read', 'filtered', 50, 10],
      ['fx_item', 'read', 'filtered', 50, 0],
    ],
  );
});

test('a store FetchXML read is a retrievemultiple span with attribute query fetchxml, like every multi-row read', async () => {
  const { store, records, traces, admin } = await organization('summary');
  await store.transact(() =>
    records.createInternal({ user: admin, identity: { admin: true } }, 'fx_gadget', { fx_name: 'Fetched' }),
  );
  traces.clear();
  store.fetchXml('<fetch><entity name="fx_gadget"><attribute name="fx_name"/></entity></fetch>', { admin: true });
  const [read] = traces.spans({ kind: 'store', operation: 'retrievemultiple', entity: 'fx_gadget' }).items;
  assert.ok(read, 'the FetchXML read is found with the other multi-row reads');
  assert.equal(read.name, 'FetchXml fx_gadget');
  assert.equal(read.attributes.query, 'fetchxml');
  assert.equal(traces.spans({ operation: 'fetchxml' }).total, 0);
});
