// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Tracing of background work (docs/design/tracing.md decision 4, D-R3-6): a BulkDelete job, an api.systemJob, a background
// operation (Prefer: respond-async) with its callback, RunDesktopFlow, a background ExecuteWorkflow, the rollup mass job,
// the elastic TTL purge, cascades and business rules. Each job runs detached under a `job` span parented by the span that
// staged it (staged-by link, triggered link on the staging span), never by the span current when the scheduler runs; a bulk
// delete's per-row deletes are one `rows` event, not spans. Jobs run from a manual task list, so no test waits on time.
// Invented schemas and loopback fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createPrincipals, ensureSecurityModel } from '../lib/dataverse-security.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { install, runInBackground } from '../lib/dataverse-async.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { addonHandlerExtension, addonHandlers } from '../lib/dataverse-addon-common.mjs';
import { workflowExtension, workflowHandlers } from '../lib/dataverse-workflows.mjs';
import { settleCommittedWork } from '../lib/committed-work.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { install as installElastic, close as closeElastic } from '../lib/dataverse-elastic.mjs';
import { EXTENSION as CASCADE } from '../lib/dataverse-cascade.mjs';
import { EXTENSION as BUSINESS_RULES } from '../lib/dataverse-business-rules.mjs';
import { createScheduler, fixedClock } from '../testing.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { cascadeMappings, rollupMappings, systemUserMapping } from './support/parent-child-tables.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const SETTINGS = {
  organizationId: '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4ec1',
  tenantId: 'tenant-trace-jobs',
  uniqueName: 'tracejobs',
  friendlyName: 'Trace jobs',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Invented Admin', roles: ['System Administrator'] },
  ],
};

// The asynchronous service on a real store, record handlers and principals; tasks are kept until run() runs them.
async function asyncWorld({ level = 'summary' } = {}) {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: 'widget',
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'name',
    fields: { name: { dataverseType: 'nvarchar' }, status: { dataverseType: 'int' } },
  };
  state.tables.widget = [];
  const store = new DataStore({ state });
  const tasks = [];
  const recordHooks = createRecordHooks();
  const api = {
    store,
    change: (fn) => fn(),
    registry: createOperationRegistry(),
    recordHooks,
    clock: () => Date.parse('2026-10-30T09:00:00Z'),
    principals: null,
    records: null,
    addRoute: () => {},
  };
  // A postponed task (a recurring occurrence) is kept for later: run() runs only the tasks due now.
  await install(api, { schedule: (task, delayMs = 0) => tasks.push({ task, delayMs }) });
  await ensureSecurityModel(store, SETTINGS);
  api.principals = createPrincipals(store, SETTINGS);
  api.records = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals: api.principals,
    changes: createChangeLog(store),
    hooks: recordHooks,
  });
  const admin = api.principals.byObjectId(ADMIN_OID);
  const context = (method, path, body) => {
    const url = new URL(path, ORIGIN);
    return {
      method,
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(undefined),
      headers: {},
      body,
      params: {},
      user: admin,
      caller: admin,
      identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid },
      requestId: 'trace-jobs',
    };
  };
  store.traces = createTraceStore({ settings: { level } });
  const traces = store.traces;
  // Runs every queued task while an unrelated span is current: a job must never take it as its parent.
  const run = async () => {
    const unrelated = traces.start({ kind: 'http', name: 'GET /unrelated' });
    for (let index; (index = tasks.findIndex((entry) => entry.delayMs <= 0)) >= 0;) {
      const [{ task }] = tasks.splice(index, 1);
      await traces.run(unrelated, () => task());
    }
    unrelated.end();
    return unrelated;
  };
  return { store, api, traces, admin, context, run };
}

const jobOf = (traces, traceId) => traces.tree(traceId).spans.find((span) => span.kind === 'job');
// The staging span keeps a triggered link to the job; the job a staged-by link to the staging span.
function assertLinked(traces, staging, job) {
  assert.equal(job.parentSpanId, staging.spanId);
  assert.equal(job.async, true);
  assert.equal(job.origin.host, 'job');
  assert.deepEqual(job.links, [{ traceId: staging.traceId, spanId: staging.spanId, relation: 'staged-by' }]);
  assert.deepEqual(
    traces.span(staging.spanId).links.filter((link) => link.relation === 'triggered' && link.spanId === job.spanId),
    [{ traceId: job.traceId, spanId: job.spanId, relation: 'triggered' }],
  );
}

test('a BulkDelete job runs under a job span staged by its request; its row deletes are one rows event, not spans', async () => {
  const world = await asyncWorld();
  const { api, traces, context } = world;
  for (const [name, status] of [
    ['Old A', 2],
    ['Old B', 2],
    ['Old C', 2],
    ['Keep', 1],
  ])
    await api.records.handle(context('POST', `/api/data/${VERSION}/widgets`, { name, status }));
  const request = traces.start({ kind: 'http', name: 'POST /api/data/v9.2/BulkDelete' });
  const submitted = await traces.run(request, () =>
    api.registry.find({ name: 'BulkDelete', kind: 'action', binding: 'unbound' }).handle(
      context('POST', `/api/data/${VERSION}/BulkDelete`, {
        JobName: 'Retire invented widgets',
        QuerySet: [
          {
            EntityName: 'widget',
            Criteria: {
              Conditions: [
                { AttributeName: 'status', Operator: 'Equal', Values: [{ Type: 'System.Int32', Value: 2 }] },
              ],
            },
          },
        ],
      }),
    ),
  );
  request.end();
  const jobId = submitted.body.JobId;
  const unrelated = await world.run();

  const staged = traces.span(request.spanId).events.find((event) => event.type === 'job-staged');
  assert.deepEqual(staged.attributes, { kind: 'bulk-delete', asyncOperationId: jobId });
  const job = jobOf(traces, request.traceId);
  assertLinked(traces, request, job);
  assert.equal(job.name, 'Retire invented widgets');
  assert.equal(job.module, 'jobs');
  assert.equal(job.operation, 'run');
  assert.equal(job.entity, 'widget');
  assert.equal(job.status, 'ok');
  assert.equal(job.attributes.kind, 'bulk-delete');
  assert.equal(job.attributes.jobId, jobId);
  assert.equal(job.attributes.deleted, 3);
  assert.deepEqual(job.actor, { kind: 'staff', id: world.admin.systemuserid, name: world.admin.fullname ?? null });
  const { spans } = traces.tree(request.traceId);
  const bulk = spans.find((span) => span.kind === 'bulk');
  assert.equal(bulk.parentSpanId, job.spanId);
  assert.equal(bulk.attributes.message, 'BulkDelete');
  assert.equal(bulk.attributes.targets, 3);
  const rows = bulk.events.filter((event) => event.type === 'rows');
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].attributes.operation, rows[0].attributes.deleted, rows[0].attributes.failed],
    ['delete', 3, 0],
  );
  assert.deepEqual(
    spans.filter((span) => span.operation === 'delete' && span.kind === 'dataverse'),
    [],
    'no span per deleted row',
  );
  assert.equal(traces.tree(unrelated.traceId).spans.length, 1, 'nothing ran under the unrelated span');
  assert.equal(world.store.state.tables.widget.length, 1);
});

test('a recurring BulkDelete occurrence is a new root, not another segment of the submitting trace', async () => {
  const world = await asyncWorld();
  const { api, traces, context } = world;
  await api.records.handle(context('POST', `/api/data/${VERSION}/widgets`, { name: 'Old', status: 2 }));
  const request = traces.start({ kind: 'http', name: 'POST /api/data/v9.2/BulkDelete' });
  await traces.run(request, () =>
    api.registry.find({ name: 'BulkDelete', kind: 'action', binding: 'unbound' }).handle(
      context('POST', `/api/data/${VERSION}/BulkDelete`, {
        RecurrencePattern: 'FREQ=DAILY;INTERVAL=1',
        QuerySet: [{ EntityName: 'widget' }],
      }),
    ),
  );
  request.end();
  await world.run(); // the first occurrence; it queues the next one (postponed a day: it does not run here)
  const rows = world.store.state.tables.asyncoperation;
  assert.equal(rows.length, 2);
  const next = rows.find((row) => row.statecode === 0);
  assert.equal(traces.recall(`job:${next.asyncoperationid}`), null, 'the next occurrence is not staged by the first');
  assert.equal(jobOf(traces, request.traceId).attributes.recurring, true);
});

test('api.systemJob: a job span staged by its caller with the message as output; a failure and a cancel are recorded', async () => {
  const world = await asyncWorld({ level: 'full' });
  const { api, traces } = world;
  const callerId = world.admin.systemuserid;
  const request = traces.start({ kind: 'http', name: 'POST /invented/system-job' });
  const [ok, bad, canceled] = await traces.run(request, async () => [
    await api.systemJob({ name: 'Invented import', operationtype: 8, callerId }, async () => 'Imported 2 rows'),
    await api.systemJob({ name: 'Invented broken', operationtype: 8, callerId }, async () => {
      throw Object.assign(new Error('Invented failure'), { code: 'InventedFailure' });
    }),
    await api.systemJob({ name: 'Invented canceled', operationtype: 8, callerId }, async () => {
      throw Object.assign(new Error('Invented cancel'), { jobStatus: 32 });
    }),
  ]);
  request.end();
  await world.run();
  const jobs = traces.tree(request.traceId).spans.filter((span) => span.kind === 'job');
  const byId = (id) => jobs.find((span) => span.attributes.jobId === id);
  for (const id of [ok, bad, canceled]) assertLinked(traces, request, byId(id));
  assert.equal(byId(ok).name, 'Invented import');
  assert.equal(byId(ok).status, 'ok');
  assert.deepEqual(byId(ok).output, { message: 'Imported 2 rows' });
  assert.equal(byId(ok).attributes.operationType, 8);
  assert.equal(byId(bad).status, 'error');
  assert.deepEqual([byId(bad).error.code, byId(bad).error.message], ['InventedFailure', 'Invented failure']);
  assert.equal(byId(canceled).status, 'cancelled');
  assert.equal(byId(canceled).attributes.jobStatus, 32);
});

test('a background operation runs under its job span and its callback is an http-out span the receiver joins', async (t) => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => receiver.close(resolve)));
  const callback = `http://127.0.0.1:${receiver.address().port}/invented/callback`;
  const world = await asyncWorld({ level: 'full' });
  const { api, traces, context, store } = world;
  (store.state.tables.customapi ??= []).push({ uniquename: 'InventedEcho' });
  const op = { name: 'InventedEcho', kind: 'action', binding: 'unbound' };
  api.registry.register({
    ...op,
    handle: (ctx) => ({ status: 200, body: { '@odata.context': 'ctx', Out: `echo:${ctx.body.Text}` } }),
  });
  const registered = api.registry.find(op);
  const prefer = `respond-async, odata.callback; url="${callback}"`;
  const call = { ...context('POST', `/api/data/${VERSION}/InventedEcho`, { Text: 'hi' }), prefer: parsePrefer(prefer) };
  call.headers = { prefer };
  const request = traces.start({ kind: 'http', name: 'POST /api/data/v9.2/InventedEcho' });
  const accepted = await traces.run(request, () => runInBackground(api, call, registered));
  request.end();
  assert.equal(accepted.status, 202);
  await world.run();
  const id = accepted.headers['x-ms-dyn-backgroundoperationid'];
  const job = jobOf(traces, request.traceId);
  assertLinked(traces, request, job);
  assert.equal(job.attributes.kind, 'background-operation');
  assert.equal(job.attributes.backgroundOperationId, id);
  assert.deepEqual(job.output, { outputParameters: [{ Key: 'Out', Value: 'echo:hi' }] });
  const post = traces.tree(request.traceId).spans.find((span) => span.kind === 'http-out');
  assert.equal(post.parentSpanId, job.spanId);
  assert.equal(post.attributes.status, 204);
  assert.equal(post.input.body.backgroundOperationId, id);
  assert.equal(received.length, 1);
  assert.equal(received[0].headers['x-sim-parent-trace'], post.spanId);
  assert.equal(received[0].headers['x-trace-id'], request.traceId);
});

// One Dataverse listener with a desktop flow pack handler and a background classic workflow, for the HTTP-driven jobs.
async function listenerWorld(t) {
  const SECRET = 'PAQVILO_TRACE_JOBS_SECRET';
  const APP = 'aaaaaaaa-0000-4000-8000-0000000000c2';
  const WORKFLOW = 'aaaaaaaa-0000-4000-8000-0000000000c3';
  const DESKTOP = 'aaaaaaaa-0000-4000-8000-0000000000c4';
  const WIDGET = 'aaaaaaaa-0000-4000-8000-0000000000c5';
  process.env[SECRET] = 'trace-jobs-secret';
  t.after(() => delete process.env[SECRET]);
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'name',
    userConfigured: true,
    fields: { name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.contoso_widget = [{ contoso_widgetid: WIDGET, name: 'Invented widget' }];
  const store = await new DataStore({ state }).init();
  const api = await startDataverseApi({
    store,
    settings: dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP,
          displayName: 'Trace jobs app',
          secretEnvironmentVariable: SECRET,
          roles: ['System Administrator'],
        },
      ],
    }),
    log: () => {},
    extensions: [
      ...EXTENSIONS,
      addonHandlerExtension(
        addonHandlers([
          {
            id: 'invented-desktop',
            dataverseMessages: {
              RunDesktopFlow: async (ctx) => ({ status: 'Succeeded', outputs: { echo: ctx.args.inputs ?? null } }),
            },
          },
        ]),
      ),
      workflowExtension({
        facts: [
          {
            id: WORKFLOW,
            name: 'Invented on-demand workflow',
            uniquename: null,
            category: 0,
            type: 1,
            mode: 0,
            scope: 4,
            ondemand: true,
            subprocess: false,
            triggeroncreate: false,
            triggerondelete: false,
            triggeronupdateattributelist: null,
            primaryentity: 'contoso_widget',
            state: 1,
            runas: 0,
            istransacted: true,
            asyncautodelete: false,
            syncworkflowlogonfailure: false,
            xaml: '<Activity />',
            clientdata: null,
          },
        ],
        handlers: workflowHandlers([
          {
            id: 'invented-workflows',
            workflows: {
              [WORKFLOW]: async ({ trace }) => {
                trace('Invented line one');
                trace('Invented line two');
                return { message: 'Invented result' };
              },
            },
          },
        ]),
        diagnostic: () => {},
      }),
    ],
  });
  t.after(() => api.close());
  await store.transact(() => {
    store.state.tables.workflow.push({
      workflowid: DESKTOP,
      name: 'Invented desktop flow',
      statecode: 1,
      statuscode: 2,
    });
  });
  const token = (
    await (
      await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP,
          client_secret: process.env[SECRET],
          scope: `${api.origin}/.default`,
        }),
      })
    ).json()
  ).access_token;
  store.traces = createTraceStore({ settings: { level: 'full' } });
  const post = (path, body) =>
    fetch(`${api.origin}/api/data/${VERSION}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { api, store, traces: store.traces, post, WORKFLOW, DESKTOP, WIDGET };
}

test('RunDesktopFlow and a background ExecuteWorkflow run under job spans staged by their requests', async (t) => {
  const world = await listenerWorld(t);
  const { traces, store } = world;

  const desktop = await world.post(`workflows(${world.DESKTOP})/Microsoft.Dynamics.CRM.RunDesktopFlow`, {
    inputs: '{"a":1}',
    connectionType: 1,
  });
  assert.equal(desktop.status, 200);
  const { flowsessionId } = await desktop.json();
  const desktopTrace = desktop.headers.get('x-trace-id');
  await store.scheduler.drain();
  const desktopRoot = traces.tree(desktopTrace).root;
  const staging = traces
    .tree(desktopTrace)
    .spans.find((span) => span.events.some((event) => event.type === 'job-staged'));
  const desktopJob = jobOf(traces, desktopTrace);
  assert.ok(desktopRoot && staging && desktopJob, 'the run joined the request trace');
  assertLinked(traces, staging, desktopJob);
  assert.equal(desktopJob.attributes.kind, 'desktop-flow');
  assert.equal(desktopJob.attributes.flowSessionId, flowsessionId);
  assert.equal(desktopJob.recordId, world.DESKTOP);
  assert.deepEqual(desktopJob.output, { statuscode: 4, outputs: { echo: '{"a":1}' } });

  const executed = await world.post(`workflows(${world.WORKFLOW})/Microsoft.Dynamics.CRM.ExecuteWorkflow`, {
    EntityId: world.WIDGET,
  });
  assert.equal(executed.status, 200, await executed.clone().text());
  const executeTrace = executed.headers.get('x-trace-id');
  await settleCommittedWork(store, []);
  const job = jobOf(traces, executeTrace);
  const queued = traces.span(job.parentSpanId);
  assert.ok(queued.events.some((event) => event.type === 'job-staged'));
  assertLinked(traces, queued, job);
  assert.equal(job.name, 'Invented on-demand workflow');
  const workflow = traces.tree(executeTrace).spans.find((span) => span.kind === 'workflow');
  assert.equal(workflow.parentSpanId, job.spanId, 'the workflow run nests in its job span');
  assert.deepEqual(
    workflow.events.filter((event) => event.type === 'trace').map((event) => event.message),
    ['Invented line one', 'Invented line two'],
  );
  assert.deepEqual(workflow.output, { message: 'Invented result' });
  assert.equal(workflow.recordId, world.WIDGET);
});

test('the rollup mass job is a job root that counts the recalculated columns; a run with nothing stale records nothing', async (t) => {
  const clock = fixedClock(Date.parse('2030-01-01T00:00:00.000Z'));
  const scheduler = createScheduler({ clock, manual: true });
  const PARENT = 'aaaaaaaa-0000-4000-8000-0000000000d1';
  const state = emptyState();
  Object.assign(state.mappings, rollupMappings());
  state.tables.x_parent = [{ x_parentid: PARENT, x_name: 'Invented parent', x_total_state: 0, x_total_date: null }];
  state.tables.x_child = [
    {
      x_childid: 'aaaaaaaa-0000-4000-8000-0000000000d2',
      x_amount: 4,
      x_parentid: { id: PARENT, logical_name: 'x_parent' },
    },
  ];
  const store = await new DataStore({ state, clock }).init();
  const organization = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({ enabled: false }),
    scheduler,
  });
  let closed = false;
  t.after(() => closed || organization.close());
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  const traces = store.traces;
  const ambient = traces.start({ kind: 'http', name: 'GET /ambient' });
  await traces.run(ambient, () => scheduler.advance(60 * 60 * 1000));
  ambient.end();
  assert.equal(store.state.tables.x_parent[0].x_total, 4);
  const jobs = traces.spans({ kind: 'job' }).items;
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job.parentSpanId, null, 'a scheduled job is a root, never a child of the ambient span');
  assert.notEqual(job.traceId, ambient.traceId);
  assert.equal(job.name, 'Mass Calculate Rollup Fields');
  assert.equal(job.attributes.kind, 'rollup-mass');
  assert.deepEqual(
    job.events.filter((event) => event.type === 'rows').map((event) => event.attributes),
    [{ operation: 'recalculate', rows: 1 }],
  );
  await scheduler.advance(60 * 60 * 1000);
  assert.equal(traces.spans({ kind: 'job' }).items.length, 1, 'nothing stale: no job span');
  // Closing the organization cancels the re-arming job: nothing of it is left on the scheduler or the event loop.
  const timers = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  await organization.close();
  closed = true;
  assert.deepEqual(
    scheduler.pending().filter((task) => task.name === 'Mass Calculate Rollup Fields'),
    [],
    'no mass job after close',
  );
  await scheduler.advance(60 * 60 * 1000);
  assert.equal(traces.spans({ kind: 'job' }).items.length, 1, 'a closed organization runs no job');
  assert.ok(process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length <= timers);
});

test('the elastic TTL purge the install timer runs is a job root with one rows event for the purged rows', async (t) => {
  const now = Date.parse('2030-01-01T00:10:00.000Z');
  const state = emptyState();
  state.mappings.x_reading = {
    logicalName: 'x_reading',
    entitySet: 'x_readings',
    idColumn: 'x_readingid',
    nameColumn: 'x_name',
    tableType: 'Elastic',
    fields: { x_name: { dataverseType: 'nvarchar' }, ttlinseconds: { dataverseType: 'int' } },
  };
  const expired = (n) => ({
    x_readingid: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
    x_name: `Reading ${n}`,
    ttlinseconds: 60,
    createdon: '2030-01-01T00:00:00.000Z',
  });
  state.tables.x_reading = [expired(1), expired(2), { ...expired(3), ttlinseconds: null }];
  const store = await new DataStore({ state }).init();
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  // The purge timer ticks on a mocked setInterval; the end of the job trace it opens is the gate, never elapsed time.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const failures = [];
  const api = {
    store,
    clock: () => now,
    change: (fn) => fn(),
    registry: createOperationRegistry(),
    log: (message, detail) => failures.push([message, detail]),
  };
  const purged = new Promise((resolve) => {
    const stop = store.traces.subscribe((event) => {
      if (event.type !== 'trace-end' || event.span.kind !== 'job') return;
      stop();
      resolve();
    });
  });
  installElastic(api);
  t.after(() => closeElastic(api));
  t.mock.timers.tick(1000);
  await purged;
  assert.deepEqual(failures, []);
  assert.deepEqual(
    store.state.tables.x_reading.map((row) => row.x_name),
    ['Reading 3'],
    'the two expired rows are purged; the row without a time to live stays',
  );
  const [job] = store.traces.spans({ kind: 'job' }).items;
  assert.equal(job.parentSpanId, null);
  assert.equal(job.attributes.kind, 'elastic-ttl-purge');
  assert.deepEqual(
    job.events.filter((event) => event.type === 'rows').map((event) => event.attributes),
    [{ operation: 'delete', rows: 2 }],
  );
  // The next pass finds nothing expired: once its turn and the microtasks it could queue have run, no job span exists.
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, []);
  assert.equal(store.traces.spans({ kind: 'job' }).items.length, 1, 'nothing expired: no job span');
});

test('a cascaded Assign is one cascade event on the assigning write; each business rule run is a business-rule event', async (t) => {
  const PARENT = 'aaaaaaaa-0000-4000-8000-0000000000e1';
  const USER_ONE = 'aaaaaaaa-0000-4000-8000-0000000000e2';
  const USER_TWO = 'aaaaaaaa-0000-4000-8000-0000000000e3';
  const RULE = 'aaaaaaaa-0000-4000-8000-0000000000e4';
  const owner = (id) => ({ id, logical_name: 'systemuser', name: 'Invented user' });
  const child = (n) => ({
    x_childid: `aaaaaaaa-0000-4000-8000-0000000000f${n}`,
    x_name: `Child ${n}`,
    x_parentid: { id: PARENT, logical_name: 'x_parent' },
    ownerid: owner(USER_ONE),
    statecode: 0,
  });
  const cascade = await contractModuleFixture(t, {
    mappings: { systemuser: systemUserMapping(), ...cascadeMappings({ assign: 'Cascade' }) },
    tables: {
      systemuser: [
        { systemuserid: USER_ONE, fullname: 'Invented one', statecode: 0 },
        { systemuserid: USER_TWO, fullname: 'Invented two', statecode: 0 },
      ],
      x_parent: [{ x_parentid: PARENT, x_name: 'Invented parent', ownerid: owner(USER_ONE), statecode: 0 }],
      x_child: [child(1), child(2)],
    },
    extension: CASCADE,
  });
  cascade.store.traces = createTraceStore({ settings: { level: 'summary' } });
  const assigned = await cascade.request('PATCH', `/x_parents(${PARENT})`, {
    'ownerid@odata.bind': `/systemusers(${USER_TWO})`,
  });
  assert.equal(assigned.status, 200);
  const cascaded = cascade.store.traces
    .tree(assigned.headers.get('x-trace-id'))
    .spans.flatMap((span) => span.events.filter((event) => event.type === 'cascade'));
  assert.deepEqual(
    cascaded.map((event) => event.attributes),
    [{ action: 'assign', table: 'x_parent', recordId: PARENT, rows: 2, previousOwner: USER_ONE, owner: USER_TWO }],
  );

  const rules = await contractModuleFixture(t, {
    mappings: {
      x_order: {
        logicalName: 'x_order',
        entitySet: 'x_orders',
        idColumn: 'x_orderid',
        nameColumn: 'x_name',
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_amount: { dataverseType: 'int' },
          x_priority: { dataverseType: 'int' },
        },
      },
    },
    tables: {
      x_order: [],
      workflow: [
        {
          workflowid: RULE,
          name: 'Invented priority',
          category: 2,
          type: 1,
          statecode: 1,
          statuscode: 2,
          primaryentity: 'x_order',
          processtriggerscope: 2,
          xaml:
            '<Activity><ConditionBranchStep><Condition Attribute="x_amount" Operator="gt" Value="1000"/>' +
            '<Then><SetAttributeValueStep Attribute="x_priority" Value="1"/></Then>' +
            '<Else><SetMessageStep Attribute="x_amount" Message="Invented: too small."/></Else></ConditionBranchStep></Activity>',
        },
      ],
    },
    extension: BUSINESS_RULES,
  });
  rules.store.traces = createTraceStore({ settings: { level: 'summary' } });
  const ruleEvents = (response) =>
    rules.store.traces
      .tree(response.headers.get('x-trace-id'))
      .spans.flatMap((span) => span.events.filter((event) => event.type === 'business-rule'))
      .map((event) => event.attributes);
  const created = await rules.request('POST', '/x_orders', { x_name: 'Big', x_amount: 2000 });
  assert.equal(created.status, 201);
  assert.deepEqual(ruleEvents(created), [
    {
      workflowId: RULE,
      name: 'Invented priority',
      table: 'x_order',
      operation: 'create',
      mode: 'evaluated',
      changed: ['x_priority'],
    },
  ]);
  const refused = await rules.request('POST', '/x_orders', { x_name: 'Small', x_amount: 5 });
  assert.equal(refused.status, 400);
  const [failedRule] = ruleEvents(refused);
  assert.equal(failedRule.mode, 'error');
  assert.equal(failedRule.error, 'Invented: too small.');
});
