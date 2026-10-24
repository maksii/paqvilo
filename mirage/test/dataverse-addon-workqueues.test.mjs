// Work-queue messages (lib/dataverse-addon-workqueues.mjs) over HTTP: enqueue, dequeue (priority, FIFO, delay and expiry, FetchXML),
// clear, SLA computation and processing history.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';

const APP_ID = '55555555-5555-5555-5555-555555555555';
const SECRET_VAR = 'PAQVILO_WORKQUEUE_SECRET';
const VERSION = 'v9.2';
const T0 = '2026-10-20T10:00:00.000Z';
const T1 = '2026-10-20T10:01:00.000Z';
const T2 = '2026-10-20T10:02:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const MINUTE = 60000;

const queueId = (n) => `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const itemId = (n) => `f1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Q = {
  main: queueId(1),
  paused: queueId(2),
  order: queueId(3),
  delay: queueId(4),
  fetch: queueId(5),
  clear: queueId(6),
  other: queueId(7),
  sla: queueId(8),
  nosla: queueId(9),
  waiting: queueId(10),
};
const I = {
  x: itemId(1),
  y: itemId(2),
  z: itemId(3),
  delayed: itemId(4),
  expired: itemId(5),
  ok: itemId(6),
  f1: itemId(7),
  f2: itemId(8),
  c1: itemId(9),
  c2: itemId(10),
  o1: itemId(11),
  inSla: itemId(12),
  atRisk: itemId(13),
  out: itemId(14),
  done: itemId(15),
  noSla: itemId(16),
  waitDelayed: itemId(17),
  waitExpired: itemId(18),
};

const queue = (id, extra) => ({
  workqueueid: id,
  name: `Invented queue ${id.slice(-2)}`,
  statecode: 0,
  statuscode: 1,
  inputschematype: 0,
  ...extra,
});
const item = (id, queueOf, extra) => ({
  workqueueitemid: id,
  workqueueid: queueOf,
  statecode: 0,
  statuscode: 0,
  priority: 1,
  createdon: T0,
  ...extra,
});

const SEED_QUEUES = [
  queue(Q.main, { defaultitemtimetoliveinminutes: 60, slathresholdinpercentage: 50, inputschematype: 1 }),
  queue(Q.paused, { statuscode: 3 }),
  queue(Q.order),
  queue(Q.delay),
  queue(Q.fetch),
  queue(Q.clear),
  queue(Q.other),
  queue(Q.sla, { defaultitemtimetoliveinminutes: 60 }),
  queue(Q.nosla),
  queue(Q.waiting),
];
const SEED_ITEMS = [
  item(I.x, Q.order, { priority: 2, createdon: T0, name: 'x' }),
  item(I.y, Q.order, { priority: 1, createdon: T1, name: 'y' }),
  item(I.z, Q.order, { priority: 1, createdon: T2, name: 'z' }),
  item(I.delayed, Q.delay, { delayuntil: FUTURE }),
  item(I.expired, Q.delay, { expirydate: PAST }),
  item(I.ok, Q.delay, { priority: 5 }),
  item(I.f1, Q.fetch, {}),
  item(I.f2, Q.fetch, { statecode: 1, statuscode: 1 }),
  item(I.c1, Q.clear, {}),
  item(I.c2, Q.clear, {}),
  item(I.o1, Q.other, {}),
  item(I.inSla, Q.sla, { expirydate: FUTURE, slathresholddate: FUTURE, slastatus: 0 }),
  item(I.atRisk, Q.sla, { expirydate: FUTURE, slathresholddate: PAST, slastatus: 0 }),
  item(I.out, Q.sla, { expirydate: PAST, slathresholddate: PAST, slastatus: 0 }),
  item(I.done, Q.sla, { statecode: 2, statuscode: 2, expirydate: PAST, slastatus: 1 }),
  item(I.noSla, Q.nosla, { slastatus: 1 }),
  item(I.waitDelayed, Q.waiting, { delayuntil: FUTURE }),
  item(I.waitExpired, Q.waiting, { expirydate: PAST }),
];

describe('dataverse work-queue messages over HTTP', () => {
  let api;
  let store;
  let token;

  before(async () => {
    process.env[SECRET_VAR] = 'workqueue-secret';
    store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Workqueue app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
      ],
    });
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: EXTENSIONS });
    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: process.env[SECRET_VAR],
        scope: `${api.origin}/.default`,
      }),
    });
    token = (await response.json()).access_token;
    await store.transact(() => {
      store.state.tables.workqueue ??= [];
      store.state.tables.workqueue.push(...SEED_QUEUES);
      store.state.tables.workqueueitem ??= [];
      store.state.tables.workqueueitem.push(...SEED_ITEMS);
    });
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  // A bound call on a queue (or item) row: POST <entitySet>(<id>)/Microsoft.Dynamics.CRM.<name>.
  async function call(set, id, name, body = {}) {
    const result = await fetch(`${api.origin}/api/data/${VERSION}/${set}(${id})/Microsoft.Dynamics.CRM.${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await result.text();
    return { status: result.status, body: text ? JSON.parse(text) : null };
  }
  const queueCall = (id, name, body) => call('workqueues', id, name, body);
  const itemCall = (id, name, body) => call('workqueueitems', id, name, body);
  const rowOf = (logical, pk, id) => store.state.tables[logical].find((row) => row[pk] === id);
  const itemsIn = (queueOf) => store.state.tables.workqueueitem.filter((row) => row.workqueueid === queueOf);

  it('every work-queue message is declared in $metadata', async () => {
    const metadata = await (
      await fetch(`${api.origin}/api/data/${VERSION}/$metadata`, { headers: { authorization: `Bearer ${token}` } })
    ).text();
    for (const name of [
      'EnqueueWorkQueueItem',
      'Dequeue',
      'ClearWorkQueue',
      'ComputeSlaWorkQueueItem',
      'AddWorkQueueItemProcessingHistoryEntry',
    ]) {
      assert.match(metadata, new RegExp(`Name="${name}"`), name);
    }
    assert.match(metadata, /Name="EnqueueWorkQueueItemResponse"/);
  });

  it('enqueue creates a queued item with TTL expiry and an SLA threshold', async () => {
    const before = Date.now();
    const result = await queueCall(Q.main, 'EnqueueWorkQueueItem', {
      workQueueItem: { name: 'job 1', input: '{"a":1}', priority: 2 },
    });
    const after = Date.now();
    assert.equal(result.status, 200);
    assert.match(result.body.workQueueItemId, /^[0-9a-f-]{36}$/);
    assert.equal(result.body.workQueueItemRecord, undefined);
    const row = rowOf('workqueueitem', 'workqueueitemid', result.body.workQueueItemId);
    assert.equal(row.workqueueid, Q.main);
    assert.equal(row.statecode, 0);
    assert.equal(row.statuscode, 0);
    assert.equal(row.priority, 2);
    assert.equal(row.requeuecount, 0);
    assert.equal(row.retrycount, 0);
    assert.equal(row.slastatus, 1);
    const created = Date.parse(row.createdon);
    assert.ok(created >= before && created <= after);
    // TTL 60 minutes; the threshold is 50 percent of the TTL after creation.
    assert.ok(Date.parse(row.expirydate) >= before + 60 * MINUTE && Date.parse(row.expirydate) <= after + 60 * MINUTE);
    assert.ok(
      Date.parse(row.slathresholddate) >= before + 30 * MINUTE &&
        Date.parse(row.slathresholddate) <= after + 30 * MINUTE,
    );
  });

  it('returnCreated returns the record', async () => {
    const result = await queueCall(Q.main, 'EnqueueWorkQueueItem', {
      workQueueItem: { name: 'job 2' },
      returnCreated: true,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.workQueueItemRecord.workqueueitemid, result.body.workQueueItemId);
    assert.equal(result.body.workQueueItemRecord.name, 'job 2');
    assert.match(result.body['@odata.context'], /#Microsoft\.Dynamics\.CRM\.EnqueueWorkQueueItemResponse$/);
  });

  it('enqueue on a paused queue fails', async () => {
    const result = await queueCall(Q.paused, 'EnqueueWorkQueueItem', { workQueueItem: { name: 'job 3' } });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, '0x80040203');
    assert.equal(result.body.error.message, 'Work queue paused or stopped');
  });

  it('enqueue rejects input that is not JSON on a Json queue, and a duplicate uniqueidbyqueue', async () => {
    const badJson = await queueCall(Q.main, 'EnqueueWorkQueueItem', { workQueueItem: { input: '{not json' } });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, '0x80040203');
    const first = await queueCall(Q.main, 'EnqueueWorkQueueItem', { workQueueItem: { uniqueidbyqueue: 'dup-1' } });
    assert.equal(first.status, 200);
    const second = await queueCall(Q.main, 'EnqueueWorkQueueItem', { workQueueItem: { uniqueidbyqueue: 'dup-1' } });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, '0x80040237');
  });

  it('dequeue picks priority then FIFO, marks the item Processing, then answers 204 when empty', async () => {
    const order = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await queueCall(Q.order, 'Dequeue', { request: '{}' });
      assert.equal(result.status, 200);
      order.push(result.body.workqueueitemid);
    }
    assert.deepEqual(order, [I.y, I.z, I.x]);
    const taken = rowOf('workqueueitem', 'workqueueitemid', I.y);
    assert.equal(taken.statecode, 1);
    assert.equal(taken.statuscode, 1);
    assert.equal(typeof taken.processingstarttime, 'string');
    assert.equal(taken.processinguser.logical_name, 'systemuser');
    assert.equal((await queueCall(Q.order, 'Dequeue', { request: '{}' })).status, 204);
  });

  it('dequeue skips delayed and expired items', async () => {
    const result = await queueCall(Q.delay, 'Dequeue', {});
    assert.equal(result.status, 200);
    assert.equal(result.body.workqueueitemid, I.ok);
    assert.equal((await queueCall(Q.delay, 'Dequeue', {})).status, 204);
    assert.equal(rowOf('workqueueitem', 'workqueueitemid', I.delayed).statecode, 0);
    assert.equal(rowOf('workqueueitem', 'workqueueitemid', I.expired).statecode, 0);
  });

  it('dequeue honours a FetchXML query, returns only Queued items and requires workqueueid', async () => {
    const query = (entity, attribute = 'workqueueid') =>
      `<fetch><entity name="${entity}"><attribute name="workqueueitemid"/><filter><condition attribute="${attribute}" operator="eq" value="${Q.fetch}"/></filter></entity></fetch>`;
    const request = (xml) => ({ request: JSON.stringify({ query: xml }) });
    const first = await queueCall(Q.fetch, 'Dequeue', request(query('workqueueitem')));
    assert.equal(first.status, 200);
    assert.equal(first.body.workqueueitemid, I.f1, 'I.f2 is Processing and must be skipped');
    assert.equal((await queueCall(Q.fetch, 'Dequeue', request(query('workqueueitem')))).status, 204);
    const otherEntity = await queueCall(Q.fetch, 'Dequeue', request(query('workqueue')));
    assert.equal(otherEntity.status, 400);
    assert.equal(otherEntity.body.error.code, '0x80040203');
    const noQueueCondition = await queueCall(Q.fetch, 'Dequeue', request(query('workqueueitem', 'name')));
    assert.equal(noQueueCondition.status, 400);
    assert.equal(noQueueCondition.body.error.message, 'Invalid FetchXML');
  });

  it("clear removes only that queue's items and answers isDeletionGoingAsync false", async () => {
    const result = await queueCall(Q.clear, 'ClearWorkQueue', {});
    assert.equal(result.status, 200);
    assert.equal(result.body.isDeletionGoingAsync, false);
    assert.equal(itemsIn(Q.clear).length, 0);
    assert.equal(itemsIn(Q.other).length, 1);
  });

  it('compute SLA sets In, AtRisk and Out, leaves Processed items alone, and NotSet without a TTL', async () => {
    assert.equal((await queueCall(Q.sla, 'ComputeSlaWorkQueueItem', {})).status, 204);
    const status = (id) => rowOf('workqueueitem', 'workqueueitemid', id).slastatus;
    assert.equal(status(I.inSla), 1);
    assert.equal(status(I.atRisk), 2);
    assert.equal(status(I.out), 3);
    assert.equal(status(I.done), 1, 'a Processed item keeps its status');
    assert.equal((await queueCall(Q.nosla, 'ComputeSlaWorkQueueItem', {})).status, 204);
    assert.equal(status(I.noSla), 0, 'no TTL: NotSet');
  });

  it('processing history appends each entry to executioncontext', async () => {
    const entry = { name: 'attempt', processingresult: 'ok' };
    assert.equal((await itemCall(I.x, 'AddWorkQueueItemProcessingHistoryEntry', { item: entry })).status, 204);
    assert.equal(
      (await itemCall(I.x, 'AddWorkQueueItemProcessingHistoryEntry', { item: { ...entry, name: 'retry' } })).status,
      204,
    );
    const history = JSON.parse(rowOf('workqueueitem', 'workqueueitemid', I.x).executioncontext);
    assert.equal(history.length, 2);
    assert.equal(history[0].name, 'attempt');
    assert.equal(history[1].name, 'retry');
    assert.equal(typeof history[1].createdon, 'string');
  });

  it('parallel consumers never claim the same item and parallel unique ids create only one row', async () => {
    const created = await queueCall(Q.other, 'EnqueueWorkQueueItem', {
      workQueueItem: { uniqueidbyqueue: 'parallel-claim' },
    });
    assert.equal(created.status, 200);
    const claims = await Promise.all(Array.from({ length: 4 }, () => queueCall(Q.other, 'Dequeue', {})));
    const ids = claims.filter((result) => result.status === 200).map((result) => result.body.workqueueitemid);
    assert.equal(ids.length, 2, 'the seeded and newly enqueued item are claimed once each');
    assert.equal(new Set(ids).size, 2);
    const duplicates = await Promise.all(
      Array.from({ length: 3 }, () =>
        queueCall(Q.main, 'EnqueueWorkQueueItem', { workQueueItem: { uniqueidbyqueue: 'parallel-unique' } }),
      ),
    );
    assert.deepEqual(duplicates.map((result) => result.status).sort(), [200, 400, 400]);
    assert.equal(itemsIn(Q.main).filter((row) => row.uniqueidbyqueue === 'parallel-unique').length, 1);
  });

  it('FetchXML consumers skip delayed/expired rows and reject a scalar request', async () => {
    const request = JSON.stringify({
      query: `<fetch><entity name="workqueueitem"><attribute name="workqueueitemid"/><filter><condition attribute="workqueueid" operator="eq" value="${Q.waiting}"/></filter></entity></fetch>`,
    });
    assert.equal((await queueCall(Q.waiting, 'Dequeue', { request })).status, 204);
    assert.equal((await queueCall(Q.waiting, 'Dequeue', { request: 'null' })).status, 400);
    assert.equal((await queueCall(Q.main, 'EnqueueWorkQueueItem', { workQueueItem: 'invalid' })).status, 400);
  });
});
