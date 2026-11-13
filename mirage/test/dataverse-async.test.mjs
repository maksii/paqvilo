// @test-kind unproven: local model of the Dataverse asynchronous service (BulkDelete jobs, background operations, recurrence); no native capture cited
// Simulated Dataverse asynchronous service: BulkDelete jobs, background operations, their state transitions and the
// system-table write rules. Jobs are run by a test scheduler on a test clock, so no timers are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { DataStore, emptyState } from '../lib/data.mjs';
import {
  DEPTH,
  applyRoleGrants,
  assignRoles,
  createPrincipals,
  ensureSecurityModel,
  privilegeId,
  uuidV5,
} from '../lib/dataverse-security.mjs';
import { dataverseError, parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { BULK_DUPLICATE_TYPE, install, reset, runInBackground } from '../lib/dataverse-async.mjs';
import * as asyncModule from '../lib/dataverse-async.mjs';
import { DataError } from '../lib/data-error.mjs';
import { install as installDataMessages } from '../lib/dataverse-data-messages.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const BASIC_OID = 'aaaaaaaa-0000-4000-8000-000000000002';
const NONE_OID = 'aaaaaaaa-0000-4000-8000-000000000003';
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
    { objectId: BASIC_OID, upn: 'basic@example.test', displayName: 'Basic', roles: ['Basic User'] },
    { objectId: NONE_OID, upn: 'none@example.test', displayName: 'None', roles: [] },
  ],
};
const BULK_DELETE = { name: 'BulkDelete', kind: 'action', binding: 'unbound' };
// The signed Dataverse error number the errorcode columns hold for an error (as the module stores it).
const dataverseErrorNumber = (error) => {
  const code = dataverseError(error, {}).body?.error?.code;
  return Number.parseInt(code, 16) | 0;
};
const DAY = 86400e3;
const START = Date.parse('2026-10-19T09:00:00Z');

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: 'widget',
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'name',
    fields: { name: { dataverseType: 'nvarchar' }, status: { dataverseType: 'int' } },
  };
  state.tables.widget = [];
  return state;
}

// The api object the extension sees, built from the real store, record handlers and principals. Scheduled tasks are
// queued with their due time; flush() runs the ones due on the test clock (time.now), as the next ticks would.
async function setup({ pageSize, state, retained = false } = {}) {
  const store = new DataStore({ state: state ?? fixtureState() });
  const time = { now: START };
  const tasks = [];
  const posts = [];
  const routes = [];
  const recordHooks = createRecordHooks();
  const api = {
    store,
    change: (fn) => fn(),
    registry: createOperationRegistry(),
    recordHooks,
    clock: () => time.now,
    principals: null,
    records: null,
    addRoute: (match, handler) => routes.push({ match, handler }),
  };
  await install(api, {
    schedule: (task, delayMs = 0) => tasks.push({ task, due: time.now + delayMs }),
    notify: (url, body) => posts.push({ url, body }),
    ...(pageSize ? { pageSize } : {}),
  });
  await ensureSecurityModel(store, SETTINGS); // after the install, as the router does: the system tables get privileges
  const principals = createPrincipals(store, SETTINGS);
  api.principals = principals;
  api.records = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    changes: createChangeLog(store),
    hooks: recordHooks,
  });
  if (retained) installDataMessages(api);
  const admin = principals.byObjectId(ADMIN_OID);
  const basic = principals.byObjectId(BASIC_OID);
  const none = principals.byObjectId(NONE_OID);
  const identityOf = (user) => ({ admin: true, id: user.systemuserid, systemUserId: user.systemuserid });
  const send = (method, path, { user = admin, body } = {}) => {
    const url = new URL(path, ORIGIN);
    return api.records.handle({
      method,
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(undefined),
      headers: {},
      body,
      user,
      caller: user,
      identity: identityOf(user),
      requestId: 'test',
    });
  };
  const submit = (body, { user = admin } = {}) =>
    api.registry.find(BULK_DELETE).handle({
      method: 'POST',
      route: parseDataverseRoute(`/api/data/${VERSION}/BulkDelete`),
      url: new URL(`${ORIGIN}/api/data/${VERSION}/BulkDelete`),
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(undefined),
      headers: {},
      body,
      user,
      caller: user,
      identity: identityOf(user),
      requestId: 'test',
    });
  const flush = async () => {
    for (let i = tasks.findIndex((t) => t.due <= time.now); i >= 0; i = tasks.findIndex((t) => t.due <= time.now)) {
      const [{ task }] = tasks.splice(i, 1);
      await task();
    }
  };
  const widget = async (name, status) => {
    const res = await send('POST', `/api/data/${VERSION}/widgets`, { body: { name, status } });
    assert.equal(res.status, 204);
    return /\(([^()]+)\)$/.exec(res.headers['OData-EntityId'])[1];
  };
  // The call the router builds for a custom API action (runOperation's ctx), from the request's Prefer header.
  const callOf = (op, { user = admin, prefer = 'respond-async', body = { Text: 'hi' } } = {}) => ({
    method: 'POST',
    route: parseDataverseRoute(`/api/data/${VERSION}/${op.name}`),
    url: new URL(`${ORIGIN}/api/data/${VERSION}/${op.name}`),
    origin: ORIGIN,
    version: VERSION,
    prefer: parsePrefer(prefer),
    headers: { prefer },
    body,
    params: {},
    user,
    caller: user,
    identity: identityOf(user),
    requestId: 'test',
  });
  // The status monitor, as the router calls an extension route with the caller it resolved.
  const monitor = (method, id, user = admin) => {
    const path = `/api/backgroundoperation/${id}`;
    const route = routes.find((r) => r.match(path, method));
    return route.handler({ method, url: new URL(`${ORIGIN}${path}`), caller: user, requestId: 'test' });
  };
  return {
    store,
    api,
    send,
    submit,
    flush,
    widget,
    admin,
    basic,
    none,
    time,
    tasks,
    posts,
    callOf,
    monitor,
    identityOf,
  };
}

const failure = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
};

const job = (t, id) => t.store.state.tables.asyncoperation.find((row) => row.asyncoperationid === id);
const operation = (t, id) => t.store.state.tables.bulkdeleteoperation.find((row) => row.asyncoperationid === id);
const widgetNames = (t) => t.store.state.tables.widget.map((row) => row.name).sort();
const retire = (widgets) => ({
  EntityName: 'widget',
  Criteria: {
    Conditions: [{ AttributeName: 'status', Operator: 'Equal', Values: [{ Type: 'System.Int32', Value: widgets }] }],
  },
});
const PATCH_JOB = (id) => `/api/data/${VERSION}/asyncoperations(${id})`;
const bgRow = (t, id) => t.store.state.tables.backgroundoperation.find((row) => row.backgroundoperationid === id);
const bgRows = (t) => t.store.state.tables.backgroundoperation;
const ECHO = { name: 'Echo', kind: 'action', binding: 'unbound' };

// Registers the custom API Echo: its handler answers { Out } from the request's Text, or runs the given handler.
function echoApi(t, handle = (ctx) => ({ status: 200, body: { '@odata.context': 'ctx', Out: ctx.body?.Text ?? '' } })) {
  (t.store.state.tables.customapi ??= []).push({ uniquename: 'Echo' });
  t.api.registry.register({ ...ECHO, handle });
  return t.api.registry.find(ECHO);
}

test('a BulkDelete job is queued, runs on a later tick and deletes only the selected rows', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  await t.widget('Old B', 2);
  await t.widget('Keep', 1);
  const submitted = await t.submit({ QuerySet: [retire(2)], JobName: 'Retire' });
  assert.equal(submitted.status, 200);
  const id = submitted.body.JobId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(job(t, id).statecode, 0);
  assert.equal(job(t, id).statuscode, 0);
  assert.equal(job(t, id).operationtype, 13);
  assert.equal(widgetNames(t).length, 3, 'nothing is deleted before the tick');

  await t.flush();
  assert.equal(job(t, id).statecode, 3);
  assert.equal(job(t, id).statuscode, 30);
  assert.ok(job(t, id).completedon);
  assert.deepEqual(widgetNames(t), ['Keep']);
  assert.equal(operation(t, id).successcount, 2);
  assert.equal(operation(t, id).failurecount, 0);
});

test('a large selection is collected page by page and deleted in full', async () => {
  const t = await setup({ pageSize: 2 });
  for (let i = 0; i < 5; i += 1) await t.widget(`Old ${i}`, 2);
  await t.widget('Keep', 1);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)] })).body;
  await t.flush();
  assert.equal(job(t, JobId).statecode, 3);
  assert.deepEqual(widgetNames(t), ['Keep']);
  assert.equal(operation(t, JobId).successcount, 5);
});

test('unsupported submissions are refused before any job exists', async () => {
  const t = await setup();
  assert.equal((await failure(t.submit({ QuerySet: [] }))).status, 400);
  assert.equal((await failure(t.submit({ QuerySet: [{ ...retire(2), Bogus: 1 }] }))).status, 400);
  assert.equal((await failure(t.submit({ QuerySet: [retire(2)], RecurrencePattern: 'FREQ=YEARLY' }))).status, 501);
  assert.equal(
    (await failure(t.submit({ QuerySet: [retire(2)], RecurrencePattern: 'FREQ=DAILY;COUNT=3' }))).status,
    501,
  );
  assert.equal(
    (await failure(t.submit({ QuerySet: [retire(2)], RecurrencePattern: 'FREQ=WEEKLY;BYDAY=MO' }))).status,
    501,
  );
  assert.equal((await failure(t.submit({ QuerySet: [{ ...retire(2), DataSource: 'archive' }] }))).status, 400);
  assert.equal(t.store.state.tables.asyncoperation.length, 0);
});

test('only statecode, statuscode and postponeuntil change on a job, and a job cannot be created directly', async () => {
  const t = await setup();
  const { JobId } = (await t.submit({ QuerySet: [retire(2)] })).body;
  const field = await failure(t.send('PATCH', PATCH_JOB(JobId), { body: { name: 'Renamed' } }));
  assert.equal(field.status, 400);
  assert.equal(job(t, JobId).name, 'Bulk Delete');
  const create = await failure(
    t.send('POST', `/api/data/${VERSION}/asyncoperations`, { body: { name: 'Made by hand' } }),
  );
  assert.equal(create.status, 400);
  const postponed = await t.send('PATCH', PATCH_JOB(JobId), { body: { postponeuntil: '2026-10-20T00:00:00Z' } });
  assert.equal(postponed.status, 204);
  assert.equal(job(t, JobId).statecode, 0);
});

test('cancel ends a queued job before it runs, and a completed job cannot change state', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)] })).body;
  assert.equal(
    (await failure(t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 3, statuscode: 30 } }))).status,
    400,
  );
  const cancelled = await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 3 } });
  assert.equal(cancelled.status, 204);
  assert.equal(job(t, JobId).statecode, 3);
  assert.equal(job(t, JobId).statuscode, 32);
  await t.flush();
  assert.equal(widgetNames(t).length, 1, 'a cancelled job deletes nothing');
  assert.equal((await failure(t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 0 } }))).status, 400);
});

test('pause and resume: a suspended job waits, then runs to completion when resumed', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  await t.widget('Old B', 2);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)] })).body;
  // Pausing a queued job is not a transition; a job is paused only while Locked (running).
  assert.equal((await failure(t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 1 } }))).status, 400);
  job(t, JobId).statecode = 2; // stands in for a run that is in progress
  job(t, JobId).statuscode = 20;
  const paused = await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 1 } });
  assert.equal(paused.status, 204);
  assert.equal(job(t, JobId).statuscode, 10);
  await t.flush(); // the queued task finds a suspended job and does nothing
  assert.equal(job(t, JobId).statecode, 1);
  assert.equal(widgetNames(t).length, 2);

  const resumed = await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 0 } });
  assert.equal(resumed.status, 204);
  await t.flush();
  assert.equal(job(t, JobId).statecode, 3);
  assert.equal(job(t, JobId).statuscode, 30);
  assert.equal(widgetNames(t).length, 0);
  assert.equal(operation(t, JobId).successcount, 2);
});

test('the operation row is read-only through the Web API', async () => {
  const t = await setup();
  const { JobId } = (await t.submit({ QuerySet: [retire(2)] })).body;
  const row = operation(t, JobId);
  const update = await failure(
    t.send('PATCH', `/api/data/${VERSION}/bulkdeleteoperations(${row.bulkdeleteoperationid})`, {
      body: { successcount: 9 },
    }),
  );
  assert.equal(update.status, 400);
  assert.equal(operation(t, JobId).successcount, 0);
});

test('StartDateTime postpones a job until that time', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  const startAt = new Date(t.time.now + 3600e3).toISOString();
  const { JobId } = (await t.submit({ QuerySet: [retire(2)], StartDateTime: startAt })).body;
  assert.equal(job(t, JobId).postponeuntil, startAt);
  await t.flush();
  assert.equal(job(t, JobId).statecode, 0, 'not before StartDateTime');
  assert.equal(widgetNames(t).length, 1);
  t.time.now += 3600e3;
  await t.flush();
  assert.equal(job(t, JobId).statecode, 3);
  assert.deepEqual(widgetNames(t), []);
});

test('RecurrencePattern queues the next occurrence after each run', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)], RecurrencePattern: 'FREQ=DAILY;INTERVAL=2' })).body;
  await t.flush();
  assert.equal(job(t, JobId).statecode, 3);
  assert.equal(operation(t, JobId).isrecurring, true);
  const nextId = t.store.state.tables.asyncoperation.find((row) => row.asyncoperationid !== JobId).asyncoperationid;
  assert.equal(job(t, nextId).statecode, 0);
  assert.equal(job(t, nextId).postponeuntil, new Date(t.time.now + 2 * DAY).toISOString());
  await t.widget('Old B', 2);
  t.time.now += 2 * DAY;
  await t.flush();
  assert.deepEqual(widgetNames(t), []);
  assert.equal(job(t, nextId).statecode, 3, 'the occurrence ran on its day');
});

test('a row that cannot be deleted is counted and kept as a bulkdeletefailure row', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  await t.widget('Locked', 2);
  t.api.recordHooks.add('beforeWrite', (c, mapping, { operation: op, existing }) => {
    if (mapping.logicalName === 'widget' && op === 'delete' && existing?.name === 'Locked')
      throw new Error('Refused by test hook.');
  });
  const { JobId } = (await t.submit({ QuerySet: [retire(2)] })).body;
  await t.flush();
  assert.equal(job(t, JobId).statecode, 3);
  assert.equal(job(t, JobId).statuscode, 30, 'the job itself succeeds');
  assert.equal(operation(t, JobId).successcount, 1);
  assert.equal(operation(t, JobId).failurecount, 1);
  const [failed] = t.store.state.tables.bulkdeletefailure;
  assert.equal(failed.asyncoperationid, JobId);
  assert.equal(failed.errordescription, 'Refused by test hook.');
  assert.deepEqual(widgetNames(t), ['Locked']);
});

test('after a restart, install resumes a Ready and a Locked job from their rows', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  await t.widget('Later', 3);
  const ready = (await t.submit({ QuerySet: [retire(2)] })).body.JobId;
  const locked = (await t.submit({ QuerySet: [retire(3)] })).body.JobId;
  job(t, locked).statecode = 2; // interrupted while running
  job(t, locked).statuscode = 20;
  // The process stops: its queued tasks are gone. A new api over the same persisted state resumes the jobs.
  const restarted = await setup({ state: t.store.state });
  await restarted.flush();
  assert.equal(job(restarted, ready).statecode, 3);
  assert.equal(job(restarted, locked).statecode, 3);
  assert.deepEqual(widgetNames(restarted), []);
});

test('a respond-async custom API call is answered 202 and its result is read from the status monitor', async () => {
  const t = await setup();
  const op = echoApi(t);
  assert.equal(
    await runInBackground(t.api, t.callOf(op, { prefer: '' }), op),
    null,
    'a call without respond-async runs as usual',
  );
  const accepted = await runInBackground(t.api, t.callOf(op), op);
  const id = accepted.headers['x-ms-dyn-backgroundoperationid'];
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.Location, `${ORIGIN}/api/backgroundoperation/${id}`);
  assert.equal(accepted.headers['Preference-Applied'], 'respond-async');
  assert.equal(accepted.body, undefined);
  assert.equal(bgRow(t, id).backgroundoperationstatecode, 0);
  await t.flush();
  assert.equal(bgRow(t, id).backgroundoperationstatecode, 3);
  const monitored = await t.monitor('GET', id);
  assert.equal(monitored.status, 200);
  assert.deepEqual(monitored.body, { backgroundOperationStateCode: 3, backgroundOperationStatusCode: 30, Out: 'hi' });
});

// @test-kind security: callbacks are posted only to loopback addresses; other hosts are refused before the request is queued
test('a callback is posted only to a loopback address; any other host is refused before the request is queued', async () => {
  const t = await setup();
  const op = echoApi(t);
  const refused = await failure(
    runInBackground(
      t.api,
      t.callOf(op, { prefer: 'respond-async, odata.callback; url="https://example.test/hook"' }),
      op,
    ),
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.details.innerCode, '0x8009732A');
  assert.equal(bgRows(t).length, 0);

  const url = 'http://127.0.0.1:9/hook';
  const accepted = await runInBackground(
    t.api,
    t.callOf(op, { prefer: `respond-async, odata.callback; url="${url}"` }),
    op,
  );
  const id = accepted.headers['x-ms-dyn-backgroundoperationid'];
  const location = `${ORIGIN}/api/backgroundoperation/${id}`;
  assert.equal(accepted.headers['Preference-Applied'], 'callback');
  assert.deepEqual(accepted.body, { backgroundOperationId: id, location });
  await t.flush();
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].url, url);
  assert.deepEqual(t.posts[0].body, {
    location,
    backgroundOperationId: id,
    backgroundOperationStateCode: 3,
    backgroundOperationStatusCode: 30,
  });
});

test('a failed operation is recorded with its error and reported by the monitor', async () => {
  const t = await setup();
  const op = echoApi(t, () => {
    throw new DataError('Plug-in failed.', 500, 'Failed');
  });
  const { headers } = await runInBackground(t.api, t.callOf(op), op);
  // The failure is retried on the backoff (1 s, 2 s, 4 s): the clock advances through each retry until the last attempt fails.
  await t.flush();
  for (const delay of [1000, 2000, 4000]) {
    t.time.now += delay;
    await t.flush();
  }
  const id = headers['x-ms-dyn-backgroundoperationid'];
  assert.equal(bgRow(t, id).backgroundoperationstatuscode, 31);
  assert.equal(
    bgRow(t, id).errorcode,
    -2147220970,
    'the stored errorcode is the Dataverse error number, not the HTTP status',
  );
  const monitored = await t.monitor('GET', id);
  assert.deepEqual(monitored.body, {
    // The Dataverse error number (0x80040216) of the generic failure, as a signed int; never the HTTP status 500.
    backgroundOperationStateCode: 3,
    backgroundOperationStatusCode: 31,
    backgroundOperationErrorCode: -2147220970,
    backgroundOperationErrorMessage: 'Plug-in failed.',
  });
});

test('cancel: DELETE on the monitor or a PATCH stops a queued operation; a finished one cannot be canceled', async () => {
  const t = await setup();
  let ran = 0;
  const op = echoApi(t, () => {
    ran += 1;
    return { status: 200, body: {} };
  });
  const first = (await runInBackground(t.api, t.callOf(op), op)).headers['x-ms-dyn-backgroundoperationid'];
  const cancelled = await t.monitor('DELETE', first);
  assert.deepEqual(cancelled.body, { backgroundOperationStateCode: 2, backgroundOperationStatusCode: 22 });
  await t.flush();
  assert.equal(ran, 0, 'a cancelled operation does not run');
  assert.equal(bgRow(t, first).backgroundoperationstatecode, 3);
  assert.equal(bgRow(t, first).backgroundoperationstatuscode, 32);

  const second = (await runInBackground(t.api, t.callOf(op), op)).headers['x-ms-dyn-backgroundoperationid'];
  const patched = await t.send('PATCH', `/api/data/${VERSION}/backgroundoperations(${second})`, {
    body: { backgroundoperationstatuscode: 22 },
  });
  assert.equal(patched.status, 204);
  await t.flush();
  assert.equal(bgRow(t, second).backgroundoperationstatuscode, 32);
  assert.equal(ran, 0);

  await runInBackground(t.api, t.callOf(op), op);
  await t.flush();
  const done = bgRows(t).find((row) => row.backgroundoperationstatuscode === 30);
  assert.equal((await failure(t.monitor('DELETE', done.backgroundoperationid))).status, 400);
  assert.equal(
    (
      await failure(
        t.send('PATCH', `/api/data/${VERSION}/backgroundoperations(${done.backgroundoperationid})`, {
          body: { backgroundoperationstatuscode: 22 },
        }),
      )
    ).status,
    400,
  );
});

// @test-kind unproven+security: 404 for an unknown id is a local model; the refused caller without privileges is a security boundary
test('the monitor answers 404 for an unknown id, and a caller without the privileges is refused with no row written', async () => {
  const t = await setup();
  const op = echoApi(t);
  assert.equal((await failure(t.monitor('GET', '00000000-0000-4000-8000-000000000000'))).status, 404);
  const refused = await failure(runInBackground(t.api, t.callOf(op, { user: t.none }), op));
  assert.equal(refused.status, 403);
  assert.equal(bgRows(t).length, 0);
});

test('a background operation cannot be created through the Web API, and a restart fails one still in flight', async () => {
  const t = await setup();
  const op = echoApi(t);
  const created = await failure(
    t.send('POST', `/api/data/${VERSION}/backgroundoperations`, { body: { name: 'By hand' } }),
  );
  assert.equal(created.status, 400);
  const { headers } = await runInBackground(t.api, t.callOf(op), op);
  const id = headers['x-ms-dyn-backgroundoperationid'];
  const restarted = await setup({ state: t.store.state });
  assert.equal(bgRow(restarted, id).backgroundoperationstatecode, 3);
  assert.equal(bgRow(restarted, id).backgroundoperationstatuscode, 31);
});

test('reset(api) re-seeds the system job and background operation tables after a wipe', async () => {
  const t = await setup();
  const logicals = ['asyncoperation', 'bulkdeleteoperation', 'bulkdeletefailure', 'backgroundoperation'];
  for (const logical of logicals) {
    delete t.store.state.mappings[logical];
    delete t.store.state.tables[logical];
  }
  await reset(t.api);
  for (const logical of logicals) {
    assert.equal(t.store.state.mappings[logical].dataverseOnly, true, logical);
    assert.deepEqual(t.store.state.tables[logical], [], logical);
  }
});

// Holds the nth DELETE that a run sends until release(): the run has passed its live check and waits before its write.
function holdDelete(t, nth) {
  const records = t.api.records;
  const real = records.handle;
  let count = 0;
  let arrive;
  let open;
  const reached = new Promise((resolve) => {
    arrive = resolve;
  });
  const released = new Promise((resolve) => {
    open = resolve;
  });
  records.handle = async (c) => {
    if (c.method === 'DELETE' && ++count === nth) {
      arrive();
      await released;
    }
    return real.call(records, c);
  };
  return { reached, release: () => open() };
}

test('the documented cancel PATCH (statecode 2 and statuscode 22) cancels a queued operation; other bodies are refused', async () => {
  const t = await setup();
  let ran = 0;
  const op = echoApi(t, () => {
    ran += 1;
    return { status: 200, body: {} };
  });
  const id = (await runInBackground(t.api, t.callOf(op), op)).headers['x-ms-dyn-backgroundoperationid'];
  const patch = (body) => t.send('PATCH', `/api/data/${VERSION}/backgroundoperations(${id})`, { body });
  assert.equal(
    (await failure(patch({ backgroundoperationstatecode: 3, backgroundoperationstatuscode: 22 }))).status,
    400,
  );
  assert.equal((await failure(patch({ backgroundoperationstatecode: 2 }))).status, 400, 'statuscode 22 is required');
  assert.equal((await patch({ backgroundoperationstatecode: 2, backgroundoperationstatuscode: 22 })).status, 204);
  await t.flush();
  assert.equal(ran, 0, 'a cancelled operation does not run');
  assert.equal(bgRow(t, id).backgroundoperationstatecode, 3);
  assert.equal(bgRow(t, id).backgroundoperationstatuscode, 32);
});

test('a failure row carries the Dataverse error number, the operation, the query index and the row', async () => {
  const t = await setup();
  const widgetId = await t.widget('Locked', 2);
  t.api.recordHooks.add('beforeWrite', (c, mapping, { operation: op }) => {
    if (mapping.logicalName === 'widget' && op === 'delete')
      throw new DataError('Access is denied.', 403, 'PrivilegeDenied', { innerCode: '0x80040220' });
  });
  const { JobId } = (await t.submit({ QuerySet: [retire(9), retire(2)] })).body;
  await t.flush();
  const [failed] = t.store.state.tables.bulkdeletefailure;
  assert.equal(failed.errornumber, -2147220960, '0x80040220 as a signed int');
  assert.equal(failed.errordescription, 'Access is denied.');
  assert.equal(failed.asyncoperationid, JobId);
  assert.equal(failed.bulkdeleteoperationid, operation(t, JobId).bulkdeleteoperationid);
  assert.deepEqual(failed.regardingobjectid, { id: widgetId, logical_name: 'widget' });
  assert.equal(failed.orderedqueryindex, 1, 'the second query of the QuerySet');
});

test('a job that fails stores the Dataverse error number in errorcode', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)] })).body;
  t.store.state.tables.systemuser = t.store.state.tables.systemuser.filter(
    (row) => row.systemuserid !== t.admin.systemuserid,
  );
  await t.flush();
  assert.equal(job(t, JobId).statuscode, 31);
  assert.equal(
    job(t, JobId).errorcode,
    dataverseErrorNumber(
      new DataError('The user who submitted this bulk delete no longer exists.', 400, 'InvalidRequest'),
    ),
  );
  assert.ok(job(t, JobId).errorcode < 0, 'a signed Dataverse error number, not the HTTP status 400');
});

test('parameters are stored as Key/Value arrays, the monitor flattens them back, and the row records runas', async () => {
  const t = await setup();
  const op = echoApi(t);
  const id = (await runInBackground(t.api, t.callOf(op), op)).headers['x-ms-dyn-backgroundoperationid'];
  assert.deepEqual(JSON.parse(bgRow(t, id).inputparameters), [{ Key: 'Text', Value: 'hi' }]);
  assert.equal(bgRow(t, id).runas, t.admin.systemuserid);
  await t.flush();
  assert.deepEqual(JSON.parse(bgRow(t, id).outputparameters), [{ Key: 'Out', Value: 'hi' }]);
  assert.equal((await t.monitor('GET', id)).body.Out, 'hi');
});

test('a cancel that arrives while the operation runs does not replace its result', async () => {
  const t = await setup();
  let id;
  const op = echoApi(t, async () => {
    assert.equal((await t.monitor('DELETE', id)).status, 200);
    return { status: 200, body: { '@odata.context': 'ctx', Out: 'done' } };
  });
  id = (await runInBackground(t.api, t.callOf(op), op)).headers['x-ms-dyn-backgroundoperationid'];
  await t.flush();
  assert.equal(bgRow(t, id).backgroundoperationstatecode, 3);
  assert.equal(bgRow(t, id).backgroundoperationstatuscode, 30);
  assert.equal((await t.monitor('GET', id)).body.Out, 'done');
});

// @test-kind security: privilege check: prvBulkDelete is held only by System Administrator and refuses the submit before any job row
test('BulkDelete needs prvBulkDelete, which only System Administrator holds', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  const error = await failure(t.submit({ QuerySet: [retire(2)] }, { user: t.basic }));
  assert.equal(error.status, 403);
  assert.equal(error.details.privilege, 'prvBulkDelete');
  assert.equal(t.store.state.tables.asyncoperation.length, 0, 'no job row for a refused submit');
  assert.ok((await t.submit({ QuerySet: [retire(2)] })).body.JobId, 'the administrator may submit');
});

test('asyncoperation statecode and statuscode are State and Status columns; background states have no Suspended', async () => {
  const t = await setup();
  const jobFields = t.store.state.mappings.asyncoperation.fields;
  assert.equal(jobFields.statecode.dataverseType, 'state');
  assert.deepEqual(
    jobFields.statecode.options.map((option) => option.value),
    [0, 1, 2, 3],
  );
  assert.equal(jobFields.statuscode.dataverseType, 'status');
  assert.equal(jobFields.statuscode.statuses.length, 8);
  const backgroundFields = t.store.state.mappings.backgroundoperation.fields;
  assert.equal(backgroundFields.backgroundoperationstatecode.dataverseType, 'picklist');
  assert.deepEqual(
    backgroundFields.backgroundoperationstatecode.options.map((option) => option.value),
    [0, 2, 3],
  );
  t.store.state.mappings.asyncoperation.fields.statecode = { dataverseType: 'int' };
  await reset(t.api);
  assert.equal(
    t.store.state.mappings.asyncoperation.fields.statecode.dataverseType,
    'state',
    'an earlier int mapping is corrected',
  );
});

test('BulkDelete has a CSDL fragment with its QuerySet parameters and the BulkDeleteResponse return type', async () => {
  const t = await setup();
  const csdl = t.api.registry.csdlFragments();
  assert.match(csdl, /<Action Name="BulkDelete">/);
  assert.match(csdl, /<Parameter Name="QuerySet" Type="Collection\(mscrm\.QueryExpression\)" \/>/);
  assert.match(csdl, /<ReturnType Type="mscrm\.BulkDeleteResponse" Nullable="false" \/>/);
  assert.match(
    csdl,
    /<ComplexType Name="BulkDeleteResponse"><Property Name="JobId" Type="Edm\.Guid" \/><\/ComplexType>/,
  );
});

test('a reset while a run is about to delete a row stops the run; the reseeded row is not deleted', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  await t.widget('Old B', 2);
  const held = holdDelete(t, 2);
  await t.submit({ QuerySet: [retire(2)] });
  const running = t.flush();
  await held.reached;
  // The row still waiting for its delete (the query order is not fixed) is reseeded with the same id, as a reset would.
  const [waiting] = t.store.state.tables.widget;
  await reset(t.api);
  t.store.state.tables.widget = [{ ...waiting }];
  held.release();
  await running;
  assert.deepEqual(widgetNames(t), [waiting.name], 'the reseeded row survives the stale run');
});

test('a Locked bulk delete canceled mid-run ends Canceled (32) and deletes no further rows', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  await t.widget('Old B', 2);
  const held = holdDelete(t, 2);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)] })).body;
  const running = t.flush();
  await held.reached;
  assert.equal(job(t, JobId).statecode, 2);
  const [waiting] = t.store.state.tables.widget; // the row the run has not reached yet (the query order is not fixed)
  assert.equal((await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 3 } })).status, 204);
  held.release();
  await running;
  assert.equal(job(t, JobId).statecode, 3);
  assert.equal(job(t, JobId).statuscode, 32);
  assert.deepEqual(widgetNames(t), [waiting.name]);
});

test('a recurring run paused mid-run stops at its next row, queues no occurrence, and resumes to exactly one follow-up', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)], RecurrencePattern: 'FREQ=DAILY' })).body;
  const held = holdDelete(t, 1);
  const first = t.flush();
  await held.reached;
  // A pause of a running job is written as Locked/Pausing; the run is still going until it reaches its next row.
  assert.equal((await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 1 } })).status, 204);
  assert.equal(job(t, JobId).statecode, 2);
  assert.equal(job(t, JobId).statuscode, 21);
  held.release();
  await first;
  assert.equal(job(t, JobId).statecode, 1, 'the run ends Suspended');
  assert.equal(job(t, JobId).statuscode, 10);
  assert.equal(
    t.store.state.tables.asyncoperation.filter((row) => row.statecode === 0).length,
    0,
    'a paused run queues no occurrence',
  );
  assert.equal(widgetNames(t).length, 1, 'the row the paused run had not reached is kept');
  assert.equal((await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 0 } })).status, 204);
  await t.flush();
  assert.equal(job(t, JobId).statecode, 3);
  assert.equal(
    t.store.state.tables.asyncoperation.filter((row) => row.statecode === 0).length,
    1,
    'exactly one follow-up occurrence',
  );
});

test('RecurrencePattern: FREQ=HOURLY repeats by INTERVAL hours, and RecurrenceStartTime is the submission time when there is no StartDateTime', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)], RecurrencePattern: 'FREQ=HOURLY;INTERVAL=3' })).body;
  assert.equal(job(t, JobId).recurrencestarttime, new Date(START).toISOString());
  await t.flush();
  const next = t.store.state.tables.asyncoperation.find((row) => row.asyncoperationid !== JobId);
  assert.equal(next.postponeuntil, new Date(START + 3 * 3600e3).toISOString());
  assert.equal(next.recurrencestarttime, next.postponeuntil);
});

test('RecurrenceStartTime is the StartDateTime when given, and a late run skips the occurrences already past', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  const startAt = new Date(START + 3600e3).toISOString();
  const { JobId } = (await t.submit({ QuerySet: [retire(2)], RecurrencePattern: 'FREQ=DAILY', StartDateTime: startAt }))
    .body;
  assert.equal(job(t, JobId).recurrencestarttime, startAt);
  t.time.now += 2 * DAY + 5 * 3600e3; // two occurrences have passed before the job first runs
  await t.flush();
  assert.equal(job(t, JobId).statecode, 3);
  const next = t.store.state.tables.asyncoperation.find((row) => row.asyncoperationid !== JobId);
  // stepped from its own start (START+1h), not from the completion time: the first occurrence still after now is day 3
  assert.equal(next.postponeuntil, new Date(START + 3 * DAY + 3600e3).toISOString());
  assert.equal(next.recurrencestarttime, next.postponeuntil);
});

test('BulkDelete retained filters and pages only retained snapshots; default targets only active records', async () => {
  const t = await setup({ retained: true, pageSize: 2 });
  const activeId = await t.widget('Active', 2);
  t.store.state.dataverse ??= {};
  t.store.state.dataverse.retained = {
    widget: [
      { widgetid: activeId, name: 'Archived version', status: 2 },
      { widgetid: 'aaaaaaaa-0000-4000-8000-000000000011', name: 'Archived B', status: 2 },
      { widgetid: 'aaaaaaaa-0000-4000-8000-000000000012', name: 'Archived C', status: 2 },
      { widgetid: 'aaaaaaaa-0000-4000-8000-000000000013', name: 'Retained keep', status: 1 },
    ],
  };
  const writes = [];
  t.api.recordHooks.add('beforeWrite', (c, mapping) => {
    if (mapping.logicalName === 'widget') writes.push(c.method);
  });
  const events = [];
  t.store.addMutationObserver((event) => events.push(event));
  const { JobId } = (await t.submit({ QuerySet: [{ ...retire(2), DataSource: 'retained' }] })).body;
  await t.flush();
  assert.equal(job(t, JobId).statecode, 3);
  assert.equal(job(t, JobId).statuscode, 30);
  assert.equal(operation(t, JobId).successcount, 3);
  assert.equal(operation(t, JobId).failurecount, 0);
  assert.deepEqual(widgetNames(t), ['Active']);
  assert.deepEqual(
    t.store.state.dataverse.retained.widget.map((row) => row.name),
    ['Retained keep'],
  );
  assert.deepEqual(writes, [], 'retained deletion invokes no active record or plug-in hooks');
  assert.deepEqual(events, [], 'retained deletion emits no phantom active table changes');
  const { JobId: second } = (await t.submit({ QuerySet: [{ ...retire(2), DataSource: 'default' }] })).body;
  await t.flush();
  assert.deepEqual(widgetNames(t), []);
  assert.equal(operation(t, second).successcount, 1);
  assert.equal(t.store.state.dataverse.retained.widget.length, 1);
});

// @test-kind security: privilege and row-access checks: the submitter's read and delete grants decide each retained delete
test("retained BulkDelete uses the submitter's row read and delete grants", async () => {
  for (const [readDepth, deleteDepth, expectedFailures] of [
    [1, 8, 0],
    [8, 1, 1],
  ]) {
    const state = fixtureState();
    state.mappings.widget.ownership = 'UserOwned';
    const t = await setup({ state, retained: true });
    await t.store.transact(() => {
      for (const [operation, depth] of [
        ['Read', readDepth],
        ['Delete', deleteDepth],
      ]) {
        const privilege = t.store.state.tables.privilege.find((row) => row.name === `prv${operation}Widget`);
        assert.ok(privilege);
        for (const grant of t.store.state.tables.roleprivileges.filter(
          (row) => row.privilegeid.id === privilege.privilegeid,
        ))
          grant.privilegedepthmask = depth;
      }
      t.store.state.dataverse ??= {};
      t.store.state.dataverse.retained = {
        widget: [
          {
            widgetid: 'aaaaaaaa-0000-4000-8000-000000000021',
            name: 'Owned',
            status: 2,
            ownerid: { id: t.admin.systemuserid, logical_name: 'systemuser' },
          },
          {
            widgetid: 'aaaaaaaa-0000-4000-8000-000000000022',
            name: 'Other owner',
            status: 2,
            ownerid: { id: t.basic.systemuserid, logical_name: 'systemuser' },
          },
        ],
      };
    });
    const { JobId } = (await t.submit({ QuerySet: [{ ...retire(2), DataSource: 'retained' }] })).body;
    await t.flush();
    assert.equal(job(t, JobId).statuscode, 30);
    assert.equal(operation(t, JobId).successcount, 1);
    assert.equal(operation(t, JobId).failurecount, expectedFailures);
    assert.deepEqual(
      t.store.state.dataverse.retained.widget.map((row) => row.name),
      ['Other owner'],
    );
    assert.equal(t.store.state.tables.bulkdeletefailure.length, expectedFailures);
  }
});

test('canceling a retained BulkDelete preserves already committed deletes and stops before its next row', async () => {
  const t = await setup({ retained: true });
  t.store.state.dataverse ??= {};
  t.store.state.dataverse.retained = {
    widget: [1, 2].map((n) => ({
      widgetid: `aaaaaaaa-0000-4000-8000-00000000003${n}`,
      name: `Archived ${n}`,
      status: 2,
    })),
  };
  let arrive,
    open,
    held = false;
  const reached = new Promise((resolve) => {
    arrive = resolve;
  });
  const released = new Promise((resolve) => {
    open = resolve;
  });
  const original = t.api.change;
  t.api.change = async (fn) => {
    const result = await original(fn);
    if (!held && t.store.state.dataverse.retained.widget.length === 1) {
      held = true;
      arrive();
      await released;
    }
    return result;
  };
  const { JobId } = (await t.submit({ QuerySet: [{ ...retire(2), DataSource: 'retained' }] })).body;
  const running = t.flush();
  await reached;
  assert.equal((await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 3, statuscode: 32 } })).status, 204);
  open();
  await running;
  assert.equal(job(t, JobId).statuscode, 32);
  assert.equal(operation(t, JobId).successcount, 1);
  assert.equal(operation(t, JobId).failurecount, 0);
  assert.equal(t.store.state.dataverse.retained.widget.length, 1);
});

test('a cancel of a running job is written as Locked/Canceling and its run ends it Canceled (32) without deleting', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  await t.widget('Old B', 2);
  const held = holdDelete(t, 1);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)] })).body;
  const running = t.flush();
  await held.reached;
  assert.equal((await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 3, statuscode: 32 } })).status, 204);
  assert.equal(job(t, JobId).statecode, 2);
  assert.equal(job(t, JobId).statuscode, 22);
  held.release();
  await running;
  assert.equal(job(t, JobId).statecode, 3);
  assert.equal(job(t, JobId).statuscode, 32);
  assert.equal(widgetNames(t).length, 2, 'no row is deleted after the cancel');
});

test('a paused recurring job resumes, or is cancelled while suspended, and a cancelled one queues no occurrence', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  const { JobId } = (await t.submit({ QuerySet: [retire(2)], RecurrencePattern: 'FREQ=DAILY' })).body;
  const held = holdDelete(t, 1);
  const first = t.flush();
  await held.reached;
  assert.equal((await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 1 } })).status, 204);
  held.release();
  await first;
  assert.equal(job(t, JobId).statecode, 1);
  assert.equal((await t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 3 } })).status, 204);
  assert.equal(job(t, JobId).statuscode, 32);
  await t.flush();
  assert.equal(
    t.store.state.tables.asyncoperation.filter((row) => row.statecode === 0).length,
    0,
    'a cancelled series queues no occurrence',
  );
  assert.equal((await failure(t.send('PATCH', PATCH_JOB(JobId), { body: { statecode: 0 } }))).status, 400);
});

test('after a restart, a Locked job whose cancel or pause was requested is finished as Canceled or Suspended, not run again', async () => {
  const t = await setup();
  await t.widget('Old A', 2);
  await t.widget('Old B', 3);
  const canceling = (await t.submit({ QuerySet: [retire(2)] })).body.JobId;
  const pausing = (await t.submit({ QuerySet: [retire(3)] })).body.JobId;
  job(t, canceling).statecode = 2;
  job(t, canceling).statuscode = 22;
  job(t, pausing).statecode = 2;
  job(t, pausing).statuscode = 21;
  const restarted = await setup({ state: t.store.state });
  await restarted.flush();
  assert.equal(job(restarted, canceling).statecode, 3);
  assert.equal(job(restarted, canceling).statuscode, 32);
  assert.equal(job(restarted, pausing).statecode, 1);
  assert.equal(job(restarted, pausing).statuscode, 10);
  assert.deepEqual(widgetNames(restarted), ['Old A', 'Old B']);
});

// Cascade job ids, OnBackgroundOperationComplete and the system job helper that dataverse-duplicates uses.
const EMPTY_ID = '00000000-0000-0000-0000-000000000000';
const BG_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
test('the cascade job ids answer the empty id, and a missing or malformed parameter is refused', async () => {
  const t = await setup();
  const assign = t.api.registry.find({ name: 'RetrieveCascadeAssignAsyncJobId', kind: 'function', binding: 'unbound' });
  const deleted = t.api.registry.find({
    name: 'RetrieveCascadeDeleteAsyncJobId',
    kind: 'function',
    binding: 'unbound',
  });
  assert.deepEqual((await assign.handle({ params: { ParentEntityId: BG_ID }, user: t.admin })).body, {
    AsyncJobId: EMPTY_ID,
  });
  assert.equal((await failure(assign.handle({ params: {}, user: t.admin }))).status, 400);
  assert.deepEqual((await deleted.handle({ params: { ParentEntityIds: [BG_ID] }, user: t.admin })).body, {
    AsyncJobId: EMPTY_ID,
  });
  assert.equal((await failure(deleted.handle({ params: { ParentEntityIds: BG_ID }, user: t.admin }))).status, 400);
});

test('OnBackgroundOperationComplete checks its parameters and the background operation row it names', async () => {
  const t = await setup();
  const complete = t.api.registry.find({ name: 'OnBackgroundOperationComplete', kind: 'action', binding: 'unbound' });
  t.store.state.tables.backgroundoperation.push({ backgroundoperationid: BG_ID });
  const call = (body) => complete.handle({ body, user: t.admin, caller: t.admin, origin: ORIGIN, version: VERSION });
  assert.equal(
    (
      await call({
        BackgroundOperationId: BG_ID,
        PayloadType: 0,
        LocationUrl: `${ORIGIN}/api/backgroundoperation/${BG_ID}`,
      })
    ).status,
    204,
  );
  assert.equal(
    (await failure(call({ BackgroundOperationId: EMPTY_ID, PayloadType: 0, LocationUrl: ORIGIN }))).status,
    404,
  );
  assert.equal((await failure(call({ BackgroundOperationId: BG_ID, PayloadType: 0 }))).status, 400);
});

test('a system job runs its work on a later tick: Succeeded with its message, or Failed with the error', async () => {
  const t = await setup();
  const callerId = t.admin.systemuserid;
  const ok = await t.api.systemJob(
    { name: 'Probe', operationtype: BULK_DUPLICATE_TYPE, callerId },
    async () => '2 found',
  );
  const bad = await t.api.systemJob({ name: 'Broken', operationtype: BULK_DUPLICATE_TYPE, callerId }, async () => {
    throw new DataError('Probe failed', 400, 'InvalidRequest');
  });
  assert.equal(job(t, ok).statecode, 0, 'Ready until the tick');
  await t.flush();
  assert.equal(job(t, ok).statecode, 3);
  assert.equal(job(t, ok).statuscode, 30);
  assert.equal(job(t, ok).message, '2 found');
  assert.equal(job(t, ok).operationtype, BULK_DUPLICATE_TYPE);
  assert.equal(job(t, bad).statuscode, 31);
  assert.equal(job(t, bad).message, 'Probe failed');
});

// Gives each user a role that holds the background-operation read and write privileges at Basic depth. The privileges are
// named as the access check names them (prvReadBackgroundOperation), which is how a role grant is matched to a right.
async function grantBackgroundBasic(t, users) {
  const roleid = uuidV5(ORG, 'role:Background Basic');
  const names = ['prvReadBackgroundOperation', 'prvWriteBackgroundOperation'];
  await t.store.transact(() => {
    (t.store.state.tables.role ??= []).push({ roleid, name: 'Background Basic' });
    for (const name of names)
      t.store.state.tables.privilege.push({ privilegeid: privilegeId(ORG, name), name, accessright: 0 });
    applyRoleGrants(
      t.store,
      roleid,
      names.map((name) => ({ privilegeid: privilegeId(ORG, name), mask: DEPTH.Basic })),
    );
  });
  for (const user of users) await assignRoles(t.store, { systemuserid: user.systemuserid, roleIds: [roleid] });
}

// @test-kind security: the status monitor checks the operation row, so another user's operation is refused as an ordinary row read refuses it
test("the status monitor reads and cancels an operation only as the operation's row allows: another user's is refused", async () => {
  const t = await setup();
  const op = echoApi(t);
  await grantBackgroundBasic(t, [t.basic, t.none]);
  const id = (await runInBackground(t.api, t.callOf(op, { user: t.basic }), op)).headers[
    'x-ms-dyn-backgroundoperationid'
  ];
  assert.equal((await t.monitor('GET', id, t.basic)).status, 200);
  const ordinary = await failure(t.send('GET', `/api/data/${VERSION}/backgroundoperations(${id})`, { user: t.none }));
  assert.equal((await failure(t.monitor('GET', id, t.none))).status, ordinary.status);
  assert.equal((await failure(t.monitor('DELETE', id, t.none))).status, ordinary.status);
  assert.equal(bgRow(t, id).backgroundoperationstatecode, 0, 'the other user cannot cancel the operation');
});

// Holds a system job's work at its first await until release(), so a test can write to the job while its work runs.
function holdWork(value = 'done') {
  let arrive;
  let open;
  const reached = new Promise((resolve) => {
    arrive = resolve;
  });
  const released = new Promise((resolve) => {
    open = resolve;
  });
  return {
    reached,
    release: () => open(),
    work: async () => {
      arrive();
      await released;
      return value;
    },
  };
}
const systemJobOf = (t, work) =>
  t.api.systemJob({ name: 'Probe job', operationtype: BULK_DUPLICATE_TYPE, callerId: t.admin.systemuserid }, work);

// @test-kind contract: a cancel written while a system job's work runs is held as Canceling, and the work's return ends the job Canceled
test('a system job cancelled while its work runs ends Canceled (32) when the work returns', async () => {
  const t = await setup();
  const held = holdWork();
  const jobId = await systemJobOf(t, held.work);
  const running = t.flush();
  await held.reached;
  assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 3 } })).status, 204);
  assert.equal(job(t, jobId).statecode, 2);
  assert.equal(job(t, jobId).statuscode, 22);
  held.release();
  await running;
  assert.equal(job(t, jobId).statecode, 3);
  assert.equal(job(t, jobId).statuscode, 32);
});

// @test-kind contract: a system job cancelled before its tick is Canceled, and its work never starts
test('a system job cancelled before its tick never runs its work', async () => {
  const t = await setup();
  let ran = 0;
  const jobId = await systemJobOf(t, async () => {
    ran += 1;
    return 'ran';
  });
  assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 3 } })).status, 204);
  await t.flush();
  assert.equal(ran, 0);
  assert.equal(job(t, jobId).statecode, 3);
  assert.equal(job(t, jobId).statuscode, 32);
});

// @test-kind contract: a pause written while a system job's work runs is held as Pausing, and the work's return ends the job Suspended
test('a system job paused while its work runs ends Suspended (1) with status Waiting (10)', async () => {
  const t = await setup();
  const held = holdWork();
  const jobId = await systemJobOf(t, held.work);
  const running = t.flush();
  await held.reached;
  assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 1 } })).status, 204);
  assert.equal(job(t, jobId).statuscode, 21);
  held.release();
  await running;
  assert.equal(job(t, jobId).statecode, 1);
  assert.equal(job(t, jobId).statuscode, 10);
});

// @test-kind contract: a suspended system job does not start until it is resumed, and then its work runs once
test('a system job suspended before its tick runs its work once, after it is resumed', async () => {
  const t = await setup();
  let ran = 0;
  const jobId = await systemJobOf(t, async () => {
    ran += 1;
    return 'ran';
  });
  job(t, jobId).statecode = 1; // a suspended job as the store holds it before its tick (a Ready job cannot be paused)
  await t.flush();
  assert.equal(ran, 0);
  assert.equal(job(t, jobId).statecode, 1);
  assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 0 } })).status, 204);
  await t.flush();
  assert.equal(ran, 1);
  assert.equal(job(t, jobId).statecode, 3);
  assert.equal(job(t, jobId).statuscode, 30);
});

// @test-kind contract: a cancel written while a system job's work runs is kept when that work then throws, so the job ends Canceled (32)
test('a system job cancelled while its work runs ends Canceled (32) when the work then throws', async () => {
  const t = await setup();
  const held = holdWork();
  const jobId = await systemJobOf(t, async () => {
    await held.work();
    throw new Error('invented failure');
  });
  const running = t.flush();
  await held.reached;
  assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 3 } })).status, 204);
  held.release();
  await running;
  assert.equal(job(t, jobId).statecode, 3);
  assert.equal(job(t, jobId).statuscode, 32);
});

// @test-kind compatibility: Microsoft Learn, Background operations (Retries): a failed operation is retried up to three times on an exponential backoff, and the count is kept on the row
test('a failed background operation is retried on a backoff, and the retry count is kept on its row', async () => {
  const t = await setup();
  let calls = 0;
  const op = echoApi(t, () => {
    calls += 1;
    if (calls <= 2) throw new DataError('Transient failure', 500, 'InternalError');
    return { status: 200, body: { '@odata.context': 'ctx', Out: 'recovered' } };
  });
  const id = (await runInBackground(t.api, t.callOf(op), op)).headers['x-ms-dyn-backgroundoperationid'];
  await t.flush();
  assert.equal(calls, 1);
  assert.equal(bgRow(t, id).retrycount, 1);
  assert.equal(bgRow(t, id).backgroundoperationstatecode, 0, 'waits for its retry');
  assert.deepEqual(
    t.tasks.map((task) => task.due - t.time.now),
    [1000],
  );
  t.time.now += 1000;
  await t.flush();
  assert.equal(calls, 2);
  assert.equal(bgRow(t, id).retrycount, 2);
  assert.deepEqual(
    t.tasks.map((task) => task.due - t.time.now),
    [2000],
  );
  t.time.now += 2000;
  await t.flush();
  assert.equal(calls, 3);
  assert.equal(bgRow(t, id).backgroundoperationstatecode, 3);
  assert.equal(bgRow(t, id).backgroundoperationstatuscode, 30);
  assert.equal(bgRow(t, id).retrycount, 2);
  assert.equal((await t.monitor('GET', id)).body.Out, 'recovered');
});

// @test-kind compatibility: Microsoft Learn, Background operations (Retries): once the retries are used up, the failure is written to the row
test('a background operation that fails on every attempt is finished Failed after its three retries', async () => {
  const t = await setup();
  let calls = 0;
  const op = echoApi(t, () => {
    calls += 1;
    throw new DataError('Permanent failure', 500, 'InternalError');
  });
  const id = (await runInBackground(t.api, t.callOf(op), op)).headers['x-ms-dyn-backgroundoperationid'];
  for (const delay of [1000, 2000, 4000]) {
    await t.flush();
    t.time.now += delay;
  }
  await t.flush();
  assert.equal(calls, 4);
  assert.equal(bgRow(t, id).backgroundoperationstatuscode, 31);
  assert.equal(bgRow(t, id).retrycount, 3);
  assert.equal(bgRow(t, id).errormessage, 'Permanent failure');
  assert.equal(t.tasks.length, 0);
});

// Queues a background operation whose first attempt fails, so its retry waits on the 1 s backoff.
// Returns the operation id and the handler's call count.
async function failedOnceAwaitingRetry(t) {
  const counts = { calls: 0 };
  const op = echoApi(t, () => {
    counts.calls += 1;
    throw new DataError('Transient failure', 500, 'InternalError');
  });
  const id = (await runInBackground(t.api, t.callOf(op), op)).headers['x-ms-dyn-backgroundoperationid'];
  await t.flush();
  assert.deepEqual(
    t.tasks.map((task) => task.due - t.time.now),
    [1000],
  );
  return { id, counts };
}

// @test-kind contract: a cancel during a retry's 1 s backoff ends the operation Canceled (32) when its retry is due, with no further run
test('a background operation cancelled during its retry wait ends Canceled and its handler is not run again', async () => {
  const t = await setup();
  const { id, counts } = await failedOnceAwaitingRetry(t);
  assert.equal((await t.monitor('DELETE', id)).status, 200);
  assert.equal(bgRow(t, id).backgroundoperationstatecode, 2);
  assert.equal(bgRow(t, id).backgroundoperationstatuscode, 22);
  t.time.now += 1000;
  await t.flush();
  assert.equal(counts.calls, 1);
  assert.equal(bgRow(t, id).backgroundoperationstatecode, 3);
  assert.equal(bgRow(t, id).backgroundoperationstatuscode, 32);
  assert.equal(bgRow(t, id).retrycount, 1);
  assert.equal(t.tasks.length, 0);
});

// @test-kind contract: a restart during a retry's 1 s backoff fails the operation with the restart message, and the handler is not run again
test('a background operation restarted during its retry wait is failed and its handler is not run again', async () => {
  const t = await setup();
  const { id, counts } = await failedOnceAwaitingRetry(t);
  const restarted = await setup({ state: t.store.state });
  assert.equal(bgRow(restarted, id).backgroundoperationstatecode, 3);
  assert.equal(bgRow(restarted, id).backgroundoperationstatuscode, 31);
  assert.equal(bgRow(restarted, id).errormessage, 'The background operation was interrupted by a restart.');
  assert.equal(bgRow(restarted, id).retrycount, 1);
  restarted.time.now += 1000;
  await restarted.flush();
  assert.equal(counts.calls, 1);
  assert.equal(restarted.tasks.length, 0);
});

// @test-kind contract: a reset that removes the operation's row during its retry wait leaves the due retry with nothing to run
test('a background operation whose row a reset removes during its retry wait is not run when the retry is due', async () => {
  const t = await setup();
  const { counts } = await failedOnceAwaitingRetry(t);
  delete t.store.state.tables.backgroundoperation;
  await reset(t.api);
  assert.deepEqual(bgRows(t), []);
  t.time.now += 1000;
  await t.flush();
  assert.equal(counts.calls, 1);
  assert.equal(t.tasks.length, 0);
});

// @test-kind contract: a waiter on a system job's completion resolves with the final row once the run ends the job Succeeded
test('whenJobSettled resolves with the row once a system job run ends Succeeded (30)', async () => {
  const t = await setup();
  const jobId = await systemJobOf(t, async () => 'done');
  const settled = asyncModule.whenJobSettled(t.store, jobId);
  await t.flush();
  const row = await settled;
  assert.equal(row.statecode, 3);
  assert.equal(row.statuscode, 30);
});

// @test-kind contract: a waiter on a system job's completion resolves with Failed (31) when the work throws
test('whenJobSettled resolves with Failed (31) when the system job work throws', async () => {
  const t = await setup();
  const jobId = await systemJobOf(t, async () => {
    throw new Error('invented failure');
  });
  const settled = asyncModule.whenJobSettled(t.store, jobId);
  await t.flush();
  const row = await settled;
  assert.equal(row.statecode, 3);
  assert.equal(row.statuscode, 31);
  assert.equal(row.message, 'invented failure');
});

// @test-kind contract: a waiter on a job cancelled while its work runs resolves with Canceled (32) when the work returns
test('whenJobSettled resolves with Canceled (32) for a job cancelled while its work runs', async () => {
  const t = await setup();
  const held = holdWork();
  const jobId = await systemJobOf(t, held.work);
  const running = t.flush();
  await held.reached;
  const settled = asyncModule.whenJobSettled(t.store, jobId);
  assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 3 } })).status, 204);
  held.release();
  await running;
  const row = await settled;
  assert.equal(row.statecode, 3);
  assert.equal(row.statuscode, 32);
});

// @test-kind contract: a waiter on a job cancelled before its tick resolves with Canceled (32) when the cancel is written
test('whenJobSettled resolves with Canceled (32) when a Web API cancel completes a job before its tick', async () => {
  const t = await setup();
  const jobId = await systemJobOf(t, async () => 'never');
  const settled = asyncModule.whenJobSettled(t.store, jobId);
  assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 3 } })).status, 204);
  const row = await settled;
  assert.equal(row.statecode, 3);
  assert.equal(row.statuscode, 32);
});

// @test-kind contract: a job the restart pass interrupts resolves its waiters with Failed (31) once the store is restarted
test('whenJobSettled resolves with Failed (31) for a job the restart pass interrupts', async () => {
  const t = await setup();
  const jobId = await systemJobOf(t, async () => 'never');
  const restarted = await setup({ state: t.store.state });
  const row = await asyncModule.whenJobSettled(restarted.store, jobId);
  assert.equal(row.statuscode, 31);
  assert.equal(row.message, 'The system job was interrupted by a restart.');
});

// @test-kind contract: a waiter asked after a job completed resolves at once from the stored row, with no further run
test('whenJobSettled asked after completion resolves at once from the stored row', async () => {
  const t = await setup();
  const jobId = await systemJobOf(t, async () => 'done');
  await t.flush();
  const row = await asyncModule.whenJobSettled(t.store, jobId);
  assert.equal(row.statecode, 3);
  assert.equal(row.statuscode, 30);
  assert.equal(row, job(t, jobId));
});

// @test-kind contract: a waiter on an unknown job is refused at once rather than left to wait for a row that is never written
test('whenJobSettled refuses an unknown job', async () => {
  const t = await setup();
  await assert.rejects(asyncModule.whenJobSettled(t.store, '00000000-0000-4000-8000-000000000000'), /does not exist/);
});

// @test-kind contract: a waiter is settled only once the terminal job write has committed; a rolled-back write leaves it pending until a later committed cancel
test('whenJobSettled keeps a waiter pending when the transaction that cancelled the job rolls back', async () => {
  const t = await setup();
  const jobId = await systemJobOf(t, async () => 'never');
  const settled = asyncModule.whenJobSettled(t.store, jobId);
  let resolved = false;
  settled.then(() => {
    resolved = true;
  });
  await assert.rejects(
    t.store.transact(
      async () => {
        assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 3 } })).status, 204);
        throw new Error('rolled back');
      },
      { isolated: true },
    ),
    /rolled back/,
  );
  assert.equal(job(t, jobId).statecode, 0);
  await Promise.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(resolved, false);
  assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 3 } })).status, 204);
  const row = await settled;
  assert.equal(row.statecode, 3);
  assert.equal(row.statuscode, 32);
});

// @test-kind contract: a waiter on a Ready job is rejected when its row is deleted, so the reserved job id can be released
test('whenJobSettled rejects a waiter whose Ready job row is deleted before the job completes', async () => {
  const t = await setup();
  const jobId = await systemJobOf(t, async () => 'never');
  const waited = asyncModule.whenJobSettled(t.store, jobId);
  let outcome = 'pending';
  waited.then(
    () => {
      outcome = 'resolved';
    },
    () => {
      outcome = 'rejected';
    },
  );
  assert.equal((await t.send('DELETE', PATCH_JOB(jobId))).status, 204);
  assert.equal(job(t, jobId), undefined);
  assert.equal(outcome, 'rejected');
  await assert.rejects(waited, /no longer exists/);
});

// @test-kind contract: a reset that removes the job row rejects its waiter at once, so the reserved job id is released
test('reset(api) rejects a waiter on a job whose asyncoperation table a reset removed', async () => {
  const t = await setup();
  const jobId = await systemJobOf(t, async () => 'never');
  const waited = asyncModule.whenJobSettled(t.store, jobId);
  let outcome = 'pending';
  waited.then(
    () => {
      outcome = 'resolved';
    },
    () => {
      outcome = 'rejected';
    },
  );
  delete t.store.state.tables.asyncoperation;
  delete t.store.state.mappings.asyncoperation;
  await asyncModule.reset(t.api);
  assert.equal(outcome, 'rejected');
  await assert.rejects(waited, /no longer exists/);
});

// @test-kind contract: closing the API rejects a waiter on an unsettled job, so the waiter does not outlive the API
test('close(api) rejects a waiter on a job that has not settled', async () => {
  const t = await setup();
  const jobId = await systemJobOf(t, async () => 'never');
  const waited = asyncModule.whenJobSettled(t.store, jobId);
  asyncModule.close(t.api);
  await assert.rejects(waited, /was closed before it settled/);
});

// The work closes over its payload only through this factory, so the test's own binding does not keep the payload alive.
const workCapturing = (payload) => async () => payload.bytes.length;

// A system job suspended before its tick, then ended by `end` over the Web API: returns a WeakRef to the payload its work
// captures.
async function suspendedThenEnded(t, end) {
  const payload = { bytes: Buffer.alloc(1024) };
  const ref = new WeakRef(payload);
  const jobId = await systemJobOf(t, workCapturing(payload));
  job(t, jobId).statecode = 1; // a suspended job as the store holds it before its tick (a Ready job cannot be paused)
  await t.flush();
  await end(t, jobId);
  return ref;
}
// The two ways a suspended job is ended over the Web API: a cancel, and a DELETE of its row.
const cancelOverWebApi = async (t, jobId) => {
  assert.equal((await t.send('PATCH', PATCH_JOB(jobId), { body: { statecode: 3 } })).status, 204);
  assert.equal(job(t, jobId).statuscode, 32);
};
const deleteOverWebApi = async (t, jobId) => {
  assert.equal((await t.send('DELETE', PATCH_JOB(jobId))).status, 204);
  assert.equal(job(t, jobId), undefined);
};

// @test-kind contract: a suspended system job that is cancelled to Completed never runs again, so the closure that would start it is released
test('a system job cancelled while suspended releases the closure that would start it', async () => {
  const t = await setup();
  const ref = await suspendedThenEnded(t, cancelOverWebApi);
  await new Promise((resolve) => setImmediate(resolve));
  v8.setFlagsFromString('--expose-gc');
  vm.runInNewContext('gc')();
  assert.equal(ref.deref(), undefined, 'the cancelled job no longer holds the work that captured the payload');
});

// @test-kind contract: Paqvilo design: a deleted suspended system job is done, so the closure that would start it is released
test('a system job deleted while suspended releases the closure that would start it', async () => {
  const t = await setup();
  const ref = await suspendedThenEnded(t, deleteOverWebApi);
  await new Promise((resolve) => setImmediate(resolve));
  v8.setFlagsFromString('--expose-gc');
  vm.runInNewContext('gc')();
  assert.equal(ref.deref(), undefined, 'the deleted job no longer holds the work that captured the payload');
});
