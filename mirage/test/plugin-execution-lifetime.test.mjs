import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { install } from '../lib/dataverse-customapi.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';

const user = '10000000-0000-0000-0000-000000000002';
const profile = {
  userId: user,
  evidence: 'Invented execution lifetime and transaction tests',
  grants: [{ entity: 'child', operations: ['create'] }],
};
function storeOf() {
  const state = emptyState();
  state.settings.permissionMode = 'permissive';
  for (const entity of ['widget', 'child']) {
    state.mappings[entity] = { entitySet: entity + 's', idColumn: entity + 'id' };
    state.tables[entity] = [];
  }
  return new DataStore({ state });
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

test('timed-out custom API continuations cannot write through SDK or queue a new transaction', async () => {
  const store = storeOf();
  store.state.tables.customapi = [{ customapiid: user, uniquename: 'invented_Delayed', bindingtype: 0 }];
  const gate = deferred(),
    completed = deferred(),
    errors = [];
  const handler = async ({ api }) => {
    await gate.promise;
    for (const write of [
      () => localOrganizationService(api.store, profile).create('child', { title: 'Late SDK write' }),
      () => api.store.transact(() => api.store.createRecord('child', { title: 'Late queued write' }, { admin: true })),
    ])
      try {
        await write();
      } catch (error) {
        errors.push(error.code);
      }
    completed.resolve();
  };
  const operations = [];
  const api = {
    store,
    change: (fn) => fn(),
    principals: { privileges: () => new Map() },
    registry: { register: (op) => operations.push(op), has: (name) => operations.some((op) => op.name === name) },
  };
  await install(api, { handlers: new Map([['invented_delayed', { handler }]]), timeoutMs: 10 }).ready;
  const revision = store.revision;
  await assert.rejects(
    operations
      .find((op) => op.name === 'invented_Delayed')
      .handle({
        method: 'POST',
        url: new URL('http://127.0.0.1/api/data/v9.2/invented_Delayed'),
        origin: 'http://127.0.0.1',
        version: 'v9.2',
        body: {},
        params: {},
        user: { systemuserid: user },
      }),
    (error) => error.details?.innerCode === '0x80040224',
  );
  gate.resolve();
  await completed.promise;
  assert.deepEqual(errors, ['LocalPluginExecutionExpired', 'LocalPluginExecutionExpired']);
  assert.equal(store.tableRows('child').length, 0);
  assert.equal(store.revision, revision);
  await store.create('childs', { title: 'Later independent request' }, { admin: true });
  assert.equal(store.tableRows('child').length, 1);
});

for (const timedOut of [false, true])
  test(`retained exposed API rows, arrays and SDK services are fenced after ${timedOut ? 'timeout' : 'success'}`, async () => {
    const store = storeOf(),
      gate = deferred(),
      completed = deferred(),
      errors = [];
    store.state.tables.child.push({ childid: user, title: 'Before' });
    store.state.tables.customapi = [{ customapiid: user, uniquename: 'invented_Retained', bindingtype: 0 }];
    const handler = ({ api }) => {
      const rows = api.store.state.tables.child,
        row = rows[0];
      const descriptorRow = Object.getOwnPropertyDescriptor(rows, '0').value;
      const service = localOrganizationService(api.store, profile);
      assert.equal(typeof api.store.clock.now(), 'number');
      assert.match(api.store.ids.uuid(), /^[a-f\d-]{36}$/i);
      row.title = 'Allowed while active';
      const inserted = { childid: 'inserted', title: 'Owned inserted value' },
        assigned = { title: 'Owned assigned value' };
      rows.push(inserted);
      row.extra = assigned;
      let callbackRow;
      rows.find((value) => {
        callbackRow = value;
        return true;
      });
      assert.throws(
        () =>
          Object.defineProperty(row, 'immutable', { value: { title: 'Unsafe immutable alias' }, configurable: false }),
        { code: 'LocalPluginStateMutationUnsupported' },
      );
      const prototype = { inheritedCapability: 'Before' };
      assert.throws(() => Object.setPrototypeOf(row, prototype), { code: 'LocalPluginStateMutationUnsupported' });
      const late = (async () => {
        await gate.promise;
        prototype.inheritedCapability = 'Late';
        inserted.title = 'Late inserted alias';
        assigned.title = 'Late assigned alias';
        for (const mutate of [
          () => rows.push({ childid: 'late' }),
          () => {
            row.title = 'Late';
          },
          () => {
            descriptorRow.title = 'Late descriptor';
          },
          () => service.create('child', { title: 'Late SDK' }),
          () => {
            callbackRow.title = 'Late callback alias';
          },
        ]) {
          try {
            mutate();
          } catch (error) {
            errors.push(error.code);
          }
        }
        completed.resolve();
      })();
      return timedOut ? late : {};
    };
    const operations = [],
      api = {
        store,
        change: (fn) => fn(),
        principals: { privileges: () => new Map() },
        registry: { register: (op) => operations.push(op), has: (name) => operations.some((op) => op.name === name) },
      };
    await install(api, { handlers: new Map([['invented_retained', { handler }]]), timeoutMs: 10 }).ready;
    const response = operations
      .find((op) => op.name === 'invented_Retained')
      .handle({
        method: 'POST',
        url: new URL('http://127.0.0.1/api/data/v9.2/invented_Retained'),
        origin: 'http://127.0.0.1',
        version: 'v9.2',
        body: {},
        params: {},
        user: { systemuserid: user },
      });
    if (timedOut) await assert.rejects(response, (error) => error.details?.innerCode === '0x80040224');
    else assert.equal((await response).status, 204);
    gate.resolve();
    await completed.promise;
    assert.deepEqual(errors, Array(5).fill('LocalPluginExecutionExpired'));
    assert.equal(store.tableRows('child').length, timedOut ? 1 : 2);
    assert.equal(store.tableRows('child')[0].title, timedOut ? 'Before' : 'Allowed while active');
    assert.equal(store.tableRows('child')[0].inheritedCapability, undefined);
    if (!timedOut) {
      assert.equal(store.tableRows('child')[1].title, 'Owned inserted value');
      assert.equal(store.tableRows('child')[0].extra.title, 'Owned assigned value');
    }
  });

test('a refused asynchronous synchronous-step handler cannot resume SDK writes after rollback', async () => {
  const store = storeOf(),
    gate = deferred();
  let late;
  const step = {
    id: user,
    enabled: true,
    entity: 'widget',
    message: 'Create',
    stage: 20,
    rank: 1,
    mode: 0,
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
    typeName: 'Invented.Detached',
    assemblyId: 'invented',
  };
  const handlers = new Map([
    [
      step.id,
      () =>
        (late = gate.promise.then(() =>
          localOrganizationService(store, profile).create('child', { title: 'Detached step effect' }),
        )),
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  store.setPluginPipeline((ctx) => runPluginPhase({ ...ctx, store, items, handlers }));
  await assert.rejects(
    store.create('widgets', { title: 'Primary' }, { admin: true }),
    (error) => error.code === 'LocalPluginAsyncHandler',
  );
  gate.resolve();
  await assert.rejects(late, (error) => error.code === 'LocalPluginExecutionExpired');
  assert.equal(store.tableRows('widget').length, 0);
  assert.equal(store.tableRows('child').length, 0);
});

test('a transaction queued by a live handler is fenced if it starts after that invocation expires', async () => {
  const store = storeOf();
  store.state.tables.customapi = [{ customapiid: user, uniquename: 'invented_Queued', bindingtype: 0 }];
  const operations = [];
  let queued,
    ran = false;
  const handler = ({ api }) => {
    const rows = api.store.tableRows('child');
    queued = api.store.transact(() => {
      ran = true;
      rows.push({ childid: user, title: 'Queued late write' });
    });
    return new Promise(() => {});
  };
  const api = {
    store,
    change: (fn) => fn(),
    principals: { privileges: () => new Map() },
    registry: { register: (op) => operations.push(op), has: () => false },
  };
  await install(api, { handlers: new Map([['invented_queued', { handler }]]), timeoutMs: 10 }).ready;
  await assert.rejects(
    operations[0].handle({
      method: 'POST',
      url: new URL('http://127.0.0.1/api/data/v9.2/invented_Queued'),
      origin: 'http://127.0.0.1',
      version: 'v9.2',
      body: {},
      params: {},
      user: { systemuserid: user },
    }),
    (error) => error.details?.innerCode === '0x80040224',
  );
  await assert.rejects(queued, (error) => error.code === 'LocalPluginExecutionExpired');
  assert.equal(ran, false);
  assert.equal(store.tableRows('child').length, 0);
});

for (const stage of [10, 20, 40])
  test(`a caught nested SDK failure ${stage === 10 ? 'preserves independent PreValidation' : 'invalidates the stage ' + stage + ' transaction'}`, async () => {
    const store = storeOf();
    const steps = ['widget', 'child'].map((entity, index) => ({
      id: '30000000-0000-0000-0000-00000000000' + index,
      enabled: true,
      entity,
      message: 'Create',
      stage: index ? 20 : stage,
      rank: 1,
      mode: 0,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      typeName: 'Invented.Rule' + index,
      assemblyId: 'invented',
    }));
    let caught = false;
    const handlers = new Map([
      [
        steps[0].id,
        () => {
          try {
            localOrganizationService(store, profile).create('child', { title: 'Rejected child' });
          } catch {
            caught = true;
          }
        },
      ],
      [steps[1].id, (ctx) => ctx.reject('Child rejected')],
    ]);
    const items = pluginCatalogue({ plugins: { steps }, handlers });
    store.setPluginPipeline((ctx) => runPluginPhase({ ...ctx, store, items, handlers }));
    const create = store.create('widgets', { title: 'Primary' }, { admin: true });
    if (stage === 10) await create;
    else await assert.rejects(create, (error) => error.details?.innerCode === '0x8009000c');
    assert.equal(caught, true);
    assert.equal(store.tableRows('child').length, 0);
    assert.equal(store.tableRows('widget').length, stage === 10 ? 1 : 0);
  });
