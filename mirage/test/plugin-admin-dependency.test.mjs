import test from 'node:test';
import { CLR_SKIP } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import { disableSteps, originalStepSimulator, pluginFixture, pluginId } from './plugin-fixture.mjs';

import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
test(
  'Actual admin mock and disabled modes suppress original CLR loopback dependency calls',
  { skip: CLR_SKIP },
  async (t) => {
    const worker = new Worker(
      'const {parentPort}=require("node:worker_threads");const http=require("node:http");let requests=0;const server=http.createServer((q,r)=>{requests++;r.end("Owned loopback dependency executed");});server.listen(0,"127.0.0.1",()=>parentPort.postMessage({port:server.address().port}));parentPort.on("message",m=>{if(m.kind==="count")parentPort.postMessage({count:requests});});',
      { eval: true },
    );
    t.after(() => worker.terminate());
    const [{ port }] = await once(worker, 'message');
    const count = async () => {
      worker.postMessage({ kind: 'count' });
      return (await once(worker, 'message'))[0].count;
    };
    const fixture = await pluginFixture(t),
      initial = fixture.app.store.snapshot();
    await fixture.app.close();
    await disableSteps(fixture.solution, 4, 11);
    const app = await originalStepSimulator(t, fixture, initial, {
      source:
        'using System;using System.Net;using Microsoft.Xrm.Sdk;namespace Invented.WidgetRules {public sealed class Validate:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];using(var client=new WebClient())target["fx_note"]=client.DownloadString("http://127.0.0.1:' +
        port +
        '/owned-fixture");}}}',
      evidence: 'Invented loopback dependency admin-mode fixture',
    });
    const key = 'plugin-step:' + pluginId(3),
      admin = (body) =>
        fetch(app.url + '/__sim/api/operations/' + encodeURIComponent(key), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
          body: JSON.stringify(body),
        }),
      write = (title) =>
        fetch(app.url + '/_api/fx_widgets', {
          method: 'POST',
          headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
          body: JSON.stringify({ fx_title: title }),
        });
    assert.equal(await count(), 0);
    assert.equal((await admin({ mode: 'clr' })).status, 200);
    assert.equal((await write('Original CLR phase')).status, 204);
    assert.equal(await count(), 1);
    assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_note, 'Owned loopback dependency executed');
    const hostsBefore = app.state().diagnostics.filter((n) => n.code === 'PLUGIN_CLR_HOST_STARTED').length;
    assert.equal(hostsBefore, 1);
    assert.equal((await admin({ mode: 'mock', body: { target: { fx_note: 'Exact admin mock result' } } })).status, 200);
    assert.equal((await write('Mock phase')).status, 204);
    assert.equal(await count(), 1);
    assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_note, 'Exact admin mock result');
    assert.equal(app.store.snapshot().simulator.operations[key].mode, 'mock');
    assert.equal((await admin({ mode: 'disabled' })).status, 200);
    assert.equal((await write('Disabled phase')).status, 204);
    assert.equal(await count(), 1);
    assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_note, undefined);
    assert.equal(app.store.snapshot().simulator.operations[key].mode, 'disabled');
    const starts = app.state().diagnostics.filter((n) => n.code === 'PLUGIN_CLR_HOST_STARTED'),
      stops = app.state().diagnostics.filter((n) => n.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(starts.length, 1);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].absenceVerified, true);
  },
);
