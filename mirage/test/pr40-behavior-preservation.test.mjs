// @test-kind compatibility: PR refactors retain established sorting and snapshot behavior
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compatible } from '../../lense/dataverse/provision.mjs';
import { permissionOrderGraphFingerprint } from '../lib/permission-query.mjs';
import { verificationWitness } from '../lib/verification-witness.mjs';
import { reconcileSupersededRead } from '../lib/request-evidence.mjs';
import { projectHeaders, projectJson } from '../parity-suite.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createFlowRunStore } from '../lib/flow-runs.mjs';
import { connectRuntime } from '../testing/runtime.mjs';
import { createModelDrivenRecordService } from '../lib/dataverse-model-driven.mjs';
import { writeActivityBundle } from '../lib/sim-activity.mjs';
import { captureObservedStylesheets } from '../lib/observed-stylesheets.mjs';
import { routingApi } from './storage-routing-fixture.mjs';
import { collectRecordGarbage } from '../lib/record-file-lease.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const FLOW = '77777777-7777-4777-8777-777777777777';
const initial = () => ({
  mappings: { fixture: {} },
  tables: { fixture: [{ id: 'one' }] },
  settings: {},
  permissions: [],
  simulator: {},
});
const runtime = {};

test('record garbage collection keeps its original lease-to-delete scheduling', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'record-gc-order-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const id = '11111111-1111-4111-8111-111111111111';
  const candidate = path.join(directory, '22222222-2222-4222-8222-222222222222.pages');
  await fs.promises.writeFile(candidate, 'fixture');
  await fs.promises.writeFile(
    path.join(directory, id + '.lease'),
    JSON.stringify({ format: 1, id, pid: 12345, files: [] }),
  );
  const reached = Promise.withResolvers(),
    gate = Promise.withResolvers(),
    order = [];
  const unlink = fs.promises.unlink;
  fs.promises.unlink = (...args) => {
    if (args[0] === candidate) order.push('delete');
    return unlink(...args);
  };
  try {
    const pending = collectRecordGarbage(directory, [], {
      isAlive: () => {
        reached.resolve();
        return gate.promise;
      },
    });
    await reached.promise;
    gate.resolve(true);
    queueMicrotask(() => order.push('marker'));
    await pending;
    assert.deepEqual(order, ['delete', 'marker']);
  } finally {
    fs.promises.unlink = unlink;
  }
});

test('storage sweep starts its transaction after the last listing without an extra turn', async (t) => {
  const h = await routingApi(t);
  const reached = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const guarded = h.router.forRoute('annotations');
  const list = guarded.list,
    transact = h.store.transact;
  const order = [];
  guarded.list = (prefix, options) => {
    if (prefix !== 'annotations/') return list.call(guarded, prefix, options);
    reached.resolve();
    return gate.promise;
  };
  h.store.transact = function (...args) {
    order.push('transaction');
    return transact.apply(this, args);
  };
  t.after(() => {
    guarded.list = list;
    h.store.transact = transact;
  });
  const pending = h.api.storageRouting.sweep();
  await reached.promise;
  gate.resolve({ items: [], continuation: null });
  queueMicrotask(() => order.push('marker'));
  await pending;
  assert.deepEqual(order.slice(0, 2), ['transaction', 'marker']);
});

test('stylesheet capture keeps synchronous rejection and lookup order', async () => {
  const order = [];
  const portal = {
    get webFiles() {
      order.push('lookup');
      return [];
    },
  };
  const live = { origin: 'http://127.0.0.1:12345', context: {} };
  const pending = captureObservedStylesheets({ origin: live.origin }, live, {
    portal,
    paths: ['/invalid.css?x', '/missing.css'],
  });
  order.push('returned');
  const result = await pending;
  assert.deepEqual(order, ['lookup', 'returned']);
  assert.equal(result.failures.length, 2);
});

test('empty activity sections keep their original stream scheduling', async () => {
  const order = [];
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = () => false;
  res.end = () => {};
  const deps = {
    traces: { query: () => ({ total: 0, items: [], pageCount: 1 }) },
    audit: {
      get entries() {
        order.push('audit');
        return [];
      },
    },
    logs: () => [],
    diagnostics: () => [],
    evidence: async () => null,
    runtime: () => ({}),
  };
  const pending = writeActivityBundle(res, new URLSearchParams({ format: 'bundle' }), deps);
  res.emit('drain');
  queueMicrotask(() => order.push('marker'));
  await pending;
  assert.deepEqual(order, ['audit', 'marker']);
});

test('model-driven record identifiers retain template string coercion', async () => {
  const hints = [];
  const id = {
    [Symbol.toPrimitive](hint) {
      hints.push(hint);
      return 'record';
    },
  };
  const stop = new Error('stop after URL argument evaluation');
  const service = createModelDrivenRecordService({
    organization: { read: (fn) => fn() },
    store: { resolveMapping: () => ({ entitySet: 'records' }) },
    records: {},
    origin: () => {
      throw stop;
    },
  });
  await assert.rejects(service.get('record', id), (error) => error === stop);
  assert.deepEqual(hints, ['string']);
});

test('trace subscriptions retain concat spreadability for event selections', async () => {
  let requested;
  const client = await connectRuntime({
    origin: 'http://127.0.0.1:12345',
    fetchImpl: async (url) => {
      requested = new URL(url);
      return new Response('', { status: 200 });
    },
  });
  const events = { 0: 'span-start', 1: 'trace-end', length: 2, [Symbol.isConcatSpreadable]: true };
  const subscription = client.trace.subscribe(() => {}, { events });
  await subscription.closed;
  assert.equal(requested.searchParams.get('events'), 'span-start,trace-end');
});
async function fixture(t, options = {}) {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  ownedFixture(t).add(() => scheduler.close());
  const runs = createFlowRunStore({ store, scheduler, ...options });
  return { store, runs };
}
// @test-kind compatibility: metadata comparison preserves default string sorting for mixed values
test('key attribute comparison retains string sorting for mixed values', () => {
  assert.equal(compatible({ KeyAttributes: [2, '02'] }, { KeyAttributes: ['02', 2] }), true);
});

// @test-kind compatibility: fingerprints retain the prior default sorting of input values
test('permission fingerprints retain string sorting for mixed role and operation values', () => {
  const fingerprint = (values) => permissionOrderGraphFingerprint([{ id: 'one', roles: values, operations: values }]);
  assert.equal(fingerprint([2, '02']), fingerprint(['02', 2]));
});

// @test-kind compatibility: actor hashing retains the prior default sorting of input values
test('actor witness retains string sorting for mixed role values', () => {
  const take = (values) =>
    verificationWitness({
      state: initial(),
      tables: ['fixture'],
      identity: { roles: values, roleIds: values },
      runtime,
    });
  assert.equal(take([2, '02']).hashes.actor, take(['02', 2]).hashes.actor);
});

// @test-kind compatibility: evidence correlation retains the prior sorting of role values
test('superseded read correlates identities using default string sorting', () => {
  const request = {
    method: 'GET',
    path: '/_api/samples',
    startedAt: new Date(0).toISOString(),
    identity: { contactId: 'local-contact', roles: [2, '02'] },
  };
  const completed = {
    ...request,
    id: 'server',
    query: {},
    status: 200,
    durationMs: 0,
    outcome: 'success',
    identity: { ...request.identity, roles: ['02', 2] },
  };
  const replacement = {
    type: 'Document',
    frameId: 'main',
    loaderId: 'new',
    startedAt: new Date(1).toISOString(),
    status: 200,
    finishedTimestamp: 1,
  };
  const proof = reconcileSupersededRead(request, {
    cdpRecords: [{ ...request, loaderId: 'old', frameId: replacement.frameId }, replacement],
    audit: { items: [completed] },
    origin: 'http://127.0.0.1:8888',
  });
  assert.equal(proof?.serverAuditId, 'server');
});

// @test-kind compatibility: closing uses the timer snapshot even if scheduler callbacks add another wait
test('closing flow runs visits the original timer snapshot', async (t) => {
  let store, runs, originalId;
  const scheduled = [],
    cancelled = [];
  const scheduler = {
    schedule() {
      const handle = scheduled.length + 1;
      scheduled.push(handle);
      return handle;
    },
    cancel(handle) {
      cancelled.push(handle);
      if (handle !== 1) return;
      const row = store.state.tables.flowrun.find((item) => item.flowrunid === originalId);
      store.state.tables.flowrun.push({ ...row, flowrunid: 'new-wait' });
      store.state.simulator.flowRuns['new-wait'] = structuredClone(store.state.simulator.flowRuns[originalId]);
      assert.equal(runs.rearm(), 1);
    },
  };
  ({ store, runs } = await fixture(t, { scheduler }));
  const run = await runs.start({ processId: FLOW });
  originalId = run.id;
  await runs.suspend(run.id, {
    actionPath: 'Delay',
    wait: { kind: 'delay', id: 'delay', until: Date.parse('2026-01-01T01:00:00.000Z') },
  });
  runs.close();
  assert.deepEqual(scheduled, [1, 2]);
  assert.deepEqual(cancelled, [1]);
  runs.close();
  assert.deepEqual(cancelled, [1, 2]);
});

// @test-kind compatibility: reports preserve their established entry and locale sorting
test('projection and CSP directive ordering preserve the established sorts', () => {
  const projection = projectJson(JSON.stringify({ value: [{ a: 1, 'a!': 2 }] }));
  assert.deepEqual(Object.keys(projection.fields), ['a!', 'a']);
  const headers = projectHeaders({ 'content-security-policy': "a-z 'self'; a_z 'self'" });
  assert.deepEqual(Object.keys(headers['content-security-policy']), ['a_z', 'a-z']);
});
