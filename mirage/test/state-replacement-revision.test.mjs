import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { pluginFixture, pluginId } from './plugin-fixture.mjs';

function fixture() {
  const state = emptyState();
  state.simulator = {};
  state.mappings.fixture = {
    entitySet: 'fixtures',
    idColumn: 'fixtureid',
    fields: { name: { dataverseType: 'nvarchar' } },
  };
  state.tables.fixture = [{ fixtureid: 'row', name: 'Source' }];
  return new DataStore({ state });
}

test('snapshot provenance rejects later replacement after an SDK write commits during asynchronous preparation', async () => {
  const store = fixture(),
    snapshot = store.snapshot(),
    revision = store.snapshotRevision(snapshot);
  snapshot.simulator.example = 'Prepared before async work';
  await store.transact(() => (store.state.tables.fixture[0].name = 'Committed SDK write'));
  // Provenance follows the original snapshot even if saveState starts later.
  assert.equal(store.snapshotRevision(snapshot), revision);
  assert.equal(store.snapshotRevision(JSON.parse(JSON.stringify(snapshot))), undefined);
  await assert.rejects(
    store.replaceState(snapshot, { expectedRevision: revision }),
    (error) => error.code === 'StateConflict' && error.status === 409,
  );
  assert.equal(store.state.tables.fixture[0].name, 'Committed SDK write');
  assert.equal(store.state.simulator.example, undefined);
});

test('replacement checks the revision inside the queue after an already pending SDK transaction commits', async () => {
  const store = fixture(),
    snapshot = store.snapshot(),
    revision = store.snapshotRevision(snapshot);
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve));
  const write = store.transact(async () => {
    store.state.tables.fixture[0].name = 'Queued SDK write';
    entered();
    await gate;
  });
  await started;
  const replacement = store.replaceState(snapshot, { expectedRevision: revision });
  release();
  await write;
  await assert.rejects(replacement, (error) => error.code === 'StateConflict');
  assert.equal(store.state.tables.fixture[0].name, 'Queued SDK write');
});

test('guards accept current snapshots, keep provenance out of JSON and permit explicit unguarded state imports', async () => {
  const store = fixture(),
    snapshot = store.snapshot(),
    revision = store.snapshotRevision(snapshot);
  assert.equal(Object.keys(snapshot).includes('snapshotRevision'), false);
  const projected = store.snapshot({ sections: ['settings'] });
  assert.equal(store.snapshotRevision(projected), revision);
  snapshot.simulator.example = 'Current';
  await store.replaceState(snapshot, { expectedRevision: revision });
  assert.equal(store.state.simulator.example, 'Current');
  const explicit = JSON.parse(JSON.stringify(snapshot));
  explicit.tables.fixture[0].name = 'Explicit import';
  await store.replaceState(explicit, { expectedRevision: store.revision });
  assert.equal(store.state.tables.fixture[0].name, 'Explicit import');
});

test('runtime configuration rejects stale publication while retaining an SDK commit and prior compiler state', async (t) => {
  const { sim } = await modelDrivenFixture(t, { dataverse: { enabled: true } });
  // This fixture supplies raw initial data, so provide the admin configuration
  // fields normally installed by the CLI bootstrap before exercising its API.
  Object.assign(sim.store.state.simulator, {
    mode: 'local',
    pageMode: 'local',
    identity: { roles: [] },
    endpoints: [],
  });
  const replace = sim.store.replaceState.bind(sim.store),
    before = sim.store.state.settings.permissionMode;
  let inject = true;
  sim.store.replaceState = async (state, options) => {
    if (inject) {
      inject = false;
      await sim.store.transact(() =>
        sim.store.sdkMutation(() =>
          sim.store.updateRecord(
            'x_item',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            { x_name: 'Committed SDK write' },
            { admin: true },
          ),
        ),
      );
    }
    return replace(state, options);
  };
  t.after(() => {
    sim.store.replaceState = replace;
  });
  const response = await fetch(`${sim.url}/_sim/api/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
    body: JSON.stringify({
      mode: 'local',
      pageMode: 'local',
      permissionMode: before === 'permissive' ? 'enforce' : 'permissive',
    }),
  });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(
    sim.store.state.tables.x_item.find((row) => row.x_itemid === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').x_name,
    'Committed SDK write',
  );
  assert.equal(sim.store.state.settings.permissionMode, before);
  const read = await fetch(`${sim.url}/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`).then((response) =>
    response.json(),
  );
  assert.equal(read.row.x_name, 'Committed SDK write');
});

test('operation configuration reapplies only its delta after a background job commits, preserving job rows', async (t) => {
  const { app } = await pluginFixture(t),
    replace = app.store.replaceState.bind(app.store);
  const jobId = '77777777-7777-4777-8777-777777777790',
    operationKey = `plugin-step:${pluginId(7)}`;
  let attempts = 0;
  app.store.replaceState = async (state, options) => {
    if (++attempts === 1)
      await app.store.transact(() => {
        app.store.state.tables.asyncoperation ??= [];
        app.store.state.tables.asyncoperation.push({
          asyncoperationid: jobId,
          statecode: 3,
          statuscode: 30,
          message: 'Background completion retained',
        });
      });
    return replace(state, options);
  };
  t.after(() => {
    app.store.replaceState = replace;
  });
  const response = await fetch(`${app.url}/__sim/api/operations/${encodeURIComponent(operationKey)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
    body: JSON.stringify({ mode: 'mock', body: { target: { fx_title: 'Configured' } } }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(attempts, 2, 'the stale full snapshot is rejected before the explicit delta retries');
  assert.equal(app.store.state.simulator.operations[operationKey].mode, 'mock');
  assert.equal(
    app.store.state.tables.asyncoperation.find((row) => row.asyncoperationid === jobId).message,
    'Background completion retained',
  );
});
