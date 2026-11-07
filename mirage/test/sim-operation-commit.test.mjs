// @test-kind contract: Paqvilo admin operation changes commit alongside concurrent store writes (asynchronous jobs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginFixture, pluginId } from './plugin-fixture.mjs';

test('an operation mode change commits while other writes keep landing, and keeps every write', async (t) => {
  const { app } = await pluginFixture(t);
  const { store } = app;
  // Controlled gate: right after any full snapshot (the old commit's starting point), another writer commits first, as a
  // committed asynchronous job's several commits did between that snapshot and its save.
  const snapshot = store.snapshot.bind(store);
  let injected = 0;
  store.snapshot = (...args) => {
    const result = snapshot(...args);
    if (args[1]?.forkTables && injected < 5) {
      injected++;
      const n = injected;
      void store.transact(() => {
        store.state.tables.fx_widget.push({
          fx_widgetid: `00000000-0000-4000-8000-00000000000${n}`,
          fx_title: `job ${n}`,
        });
      });
    }
    return result;
  };
  // A write already queued when the request arrives commits first in either implementation.
  void store.transact(() => {
    store.state.tables.fx_widget.push({ fx_widgetid: '00000000-0000-4000-8000-000000000000', fx_title: 'queued job' });
  });
  const response = await fetch(app.url + '/__sim/api/operations/' + encodeURIComponent(`plugin-step:${pluginId(7)}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
    body: JSON.stringify({ mode: 'disabled' }),
  });
  assert.equal(response.status, 200, await response.text());
  await store.queue;
  assert.equal(store.state.simulator.operations[`plugin-step:${pluginId(7)}`].mode, 'disabled');
  assert.equal(store.state.tables.fx_widget.length, injected + 1, 'every concurrent write is kept');
});
