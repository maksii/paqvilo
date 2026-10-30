// Tracing of the Web API record dispatch (docs/design/tracing.md, D-R3-1, D-R3-2, D-R3-13, D-R3-22): the dispatch span names
// its record as soon as it is known (a keyed route at start, a create once the store assigned its id), records the request
// (body, query options, answer-changing headers) and its answer (id, row count, total count, more records, status) at level
// full and the row count, page number and query kind at summary; a bypass header is one bypass event; and the Dataverse
// security decision never reads the current span at level off. Invented schemas and loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { seed as seedStandard } from '../lib/dataverse-standard.mjs';
import { createPrincipals, ensureSecurityModel } from '../lib/dataverse-security.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';

const APP = '55555555-5555-4555-8555-5555555555e1';
const MAPPING = {
  logicalName: 'fx_gadget',
  entitySet: 'fx_gadgets',
  idColumn: 'fx_gadgetid',
  nameColumn: 'fx_name',
  userConfigured: true,
  fields: { fx_name: { dataverseType: 'nvarchar' } },
  relationships: {},
};

let counter = 0;
async function listener(t, level) {
  const variable = `PAQ_TRACE_RECORDS_SECRET_${process.pid}_${++counter}`;
  process.env[variable] = 'invented-secret';
  const state = emptyState();
  state.mappings.fx_gadget = structuredClone(MAPPING);
  state.tables.fx_gadget = [];
  const store = await new DataStore({ state }).init();
  const api = await startDataverseApi({
    store,
    settings: dataverseSettings({
      enabled: true,
      tds: { enabled: false },
      applications: [
        { appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: ['System Administrator'] },
      ],
    }),
    log: () => {},
  });
  t.after(async () => {
    delete process.env[variable];
    await api.close();
  });
  const token = (
    await (
      await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP,
          client_secret: 'invented-secret',
          scope: `${api.origin}/.default`,
        }),
      })
    ).json()
  ).access_token;
  // Set after the API starts, so this trace store is the one every layer reads.
  store.traces = createTraceStore({ settings: { level } });
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${api.origin}/api/data/v9.2${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  };
  // The dispatch span of the request whose answer named trace `traceId`.
  const dispatchOf = (answer) =>
    store.traces
      .tree(answer.headers.get('x-trace-id'))
      .spans.find((span) => span.kind === 'dataverse' && span.attributes.method != null);
  return { store, request, dispatchOf, origin: api.origin };
}

test('a dispatch names its record, records the request and its answer at full, and a bypass header is one event', async (t) => {
  const { request, dispatchOf, origin } = await listener(t, 'full');
  const created = await request('POST', '/fx_gadgets', { fx_name: 'One' }, { prefer: 'return=representation' });
  assert.equal(created.status, 201);
  const id = created.json.fx_gadgetid;
  const create = dispatchOf(created);
  assert.deepEqual([create.name, create.entity, create.recordId], ['Create fx_gadget', 'fx_gadget', id]);
  assert.deepEqual(create.input.body, { fx_name: 'One' });
  assert.deepEqual(create.input.headers, { prefer: 'return=representation' });
  assert.deepEqual(create.output, { id, rowCount: null, statusCode: 201 });

  const read = dispatchOf(await request('GET', `/fx_gadgets(${id})?$select=fx_name`));
  assert.deepEqual([read.operation, read.recordId], ['retrieve', id], 'a keyed route names its record');
  assert.deepEqual(read.input.query, { $select: 'fx_name' });
  assert.equal(read.attributes.query, 'odata');

  for (const name of ['Two', 'Three']) await request('POST', '/fx_gadgets', { fx_name: name });
  const first = await request('GET', '/fx_gadgets?$select=fx_name&$count=true', undefined, {
    prefer: 'odata.maxpagesize=2',
  });
  assert.equal(first.json.value.length, 2);
  const page = dispatchOf(first);
  assert.deepEqual(
    [page.operation, page.recordId, page.attributes.rowCount, page.attributes.pageNumber, page.attributes.query],
    ['retrievemultiple', null, 2, 1, 'odata'],
  );
  assert.deepEqual(page.output, { id: null, rowCount: 2, totalCount: 3, moreRecords: true, statusCode: 200 });
  const next = await request('GET', first.json['@odata.nextLink'].slice(`${origin}/api/data/v9.2`.length), undefined, {
    prefer: 'odata.maxpagesize=2',
  });
  const second = dispatchOf(next);
  assert.deepEqual([second.attributes.rowCount, second.attributes.pageNumber], [1, 2]);
  assert.equal(second.output.moreRecords, false);

  const patched = await request(
    'PATCH',
    `/fx_gadgets(${id})`,
    { fx_name: 'Renamed' },
    {
      'MSCRM.BypassCustomPluginExecution': 'true',
    },
  );
  assert.equal(patched.status, 204);
  const update = dispatchOf(patched);
  assert.equal(update.recordId, id);
  assert.deepEqual(
    update.events.filter((event) => event.type === 'bypass').map((event) => event.attributes),
    [{ header: 'MSCRM.BypassCustomPluginExecution', value: 'true', skipped: ['sync-plugins'] }],
  );
});

test('at summary a dispatch keeps its record, row count, page number and query kind but no payloads', async (t) => {
  const { request, dispatchOf } = await listener(t, 'summary');
  const created = await request('POST', '/fx_gadgets', { fx_name: 'One' });
  const id = created.headers.get('odata-entityid').match(/\(([^)]+)\)/)[1];
  const create = dispatchOf(created);
  assert.deepEqual([create.recordId, create.input, create.output], [id, undefined, undefined]);
  const page = dispatchOf(
    await request('GET', `/fx_gadgets?fetchXml=${encodeURIComponent('<fetch><entity name="fx_gadget" /></fetch>')}`),
  );
  assert.deepEqual(
    [page.attributes.rowCount, page.attributes.pageNumber, page.attributes.query, page.output],
    [1, 1, 'fetchxml', undefined],
  );
});

// A store with the Dataverse security model and one System Administrator.
async function secured() {
  const settings = {
    organizationId: '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4ee1',
    tenantId: 'tenant-test',
    uniqueName: 'testorg',
    friendlyName: 'Test Org',
    version: '9.2.25041.00000',
    users: [
      {
        objectId: 'aaaaaaaa-0000-4000-8000-0000000000e1',
        upn: 'admin@example.test',
        displayName: 'Admin',
        roles: ['System Administrator'],
      },
    ],
  };
  const state = emptyState();
  state.mappings.fx_gadget = structuredClone(MAPPING);
  state.tables.fx_gadget = [];
  const store = new DataStore({ state });
  await store.transact(() => seedStandard(store));
  await ensureSecurityModel(store, settings);
  const principals = createPrincipals(store, settings);
  return { store, principals, user: principals.byObjectId('aaaaaaaa-0000-4000-8000-0000000000e1') };
}

test('at level off the Dataverse security decision never asks the trace store for its current span', async () => {
  const { store, principals, user } = await secured();
  let asked = 0;
  store.traces = {
    enabled: false,
    current: () => {
      asked++;
      return null;
    },
  };
  principals.authorize({ user, entity: 'fx_gadget', operation: 'create', mapping: MAPPING });
  assert.equal(asked, 0);
});

test('under a bulk span 50 row decisions and commits are one permission and one commit event with their counts', async () => {
  const { store, principals, user } = await secured();
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  const traces = store.traces;
  const bulk = traces.start({
    kind: 'bulk',
    name: 'DeleteMultiple fx_gadget',
    module: 'dataverse',
    entity: 'fx_gadget',
  });
  await traces.run(bulk, async () => {
    for (let index = 0; index < 50; index++) {
      principals.authorize({ user, entity: 'fx_gadget', operation: 'delete', mapping: MAPPING });
      await store.transact(() => store.createRecord('fx_gadget', { fx_name: `Row ${index}` }, { admin: true }));
      store.ruleEvaluated({
        rule: 'invented-rule',
        table: 'fx_gadget',
        operation: 'delete',
        result: 'applied',
        changes: [],
      });
    }
  });
  bulk.end();
  const [span] = traces.spans({ kind: 'bulk' }).items;
  const of = (type) => span.events.filter((event) => event.type === type);
  assert.deepEqual(
    of('permission').map((event) => event.attributes),
    [{ result: 'evaluated', table: 'fx_gadget', operation: 'delete', model: 'dataverse', aggregated: true }],
  );
  assert.equal(of('commit').length, 1);
  assert.equal(of('commit')[0].attributes.aggregated, true);
  // Each row is two decisions: the Dataverse privilege check and the store's own create check.
  assert.deepEqual(span.attributes.permissions, {
    evaluated: 100,
    allowed: 100,
    denied: 0,
    filtered: 0,
    tables: ['fx_gadget'],
  });
  assert.equal(span.attributes.commits.count, 50);
  assert.equal(of('rule').length, 1, 'declarative rule evaluations are one event too');
  assert.deepEqual(span.attributes.rules, { count: 50, failed: 0, tables: ['fx_gadget'], ids: [] });
  assert.equal(span.attributes.commits.failed, 0);
  assert.equal(traces.tree(bulk.traceId).spans.length, 1, 'the rows open no spans');

  // Outside a bulk span every decision stays one event.
  const single = traces.start({ kind: 'dataverse', name: 'Delete fx_gadget', module: 'dataverse' });
  traces.run(single, () => {
    for (let index = 0; index < 2; index++)
      principals.authorize({ user, entity: 'fx_gadget', operation: 'delete', mapping: MAPPING });
  });
  single.end();
  assert.equal(traces.tree(single.traceId).root.events.filter((event) => event.type === 'permission').length, 2);
});
