// Request context (lib/request-context.mjs): one context per call in the organization ALS. The client correlation id of a
// Web API call reaches the committed event and the asynchronous web hook payload; a child context goes one level deeper.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { overlayRegisteredSteps } from '../lib/dataverse-plugin-registration.mjs';
import { webhookDelivery } from '../lib/dataverse-webhooks.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import {
  pluginCatalogue,
  pluginPhaseRequiresCheckpoint,
  pluginStepMatchesEntity,
  runPluginPhase,
} from '../lib/exported-plugins.mjs';
import { createRequestContext, currentRequest, runWithRequest } from '../lib/request-context.mjs';
import { ownsChange, runOwned } from '../lib/dataverse-transaction-context.mjs';
import { fixedClock, sequentialIds } from '../testing.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const APP_ID = '77777777-7777-4777-8777-777777777771';
const ENDPOINT = '77777777-7777-4777-8777-777777777772';
const STEP = '77777777-7777-4777-8777-777777777773';
const CORRELATION = '77777777-7777-4777-8777-77777777c0de';

// The web hook receiver runs as its own process, as in dataverse-webhooks.test.mjs.
const RECEIVER = `
import { createServer } from 'node:http';
const log = [];
createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.url === '/__log') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(log)); return; }
    log.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
    res.writeHead(200); res.end('{}');
  });
}).listen(0, '127.0.0.1', function () { console.log('PORT ' + this.address().port); });
`;

async function receiver(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'request-context-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'receiver.mjs'), RECEIVER);
  const child = childProcess.spawn(process.execPath, [path.join(dir, 'receiver.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  ownedFixture(t).add(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /PORT (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`receiver exited with ${code}`)));
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    log: async () => (await fetch(`http://127.0.0.1:${port}/__log`)).json(),
  };
}

test('a child context keeps the correlation, records its parent and goes one level deeper', () => {
  const ids = sequentialIds();
  const root = createRequestContext({
    ids,
    clock: fixedClock(Date.parse('2026-02-01T00:00:00Z')),
    correlationId: CORRELATION,
  });
  const child = root.child({ mode: 'async' });
  assert.equal(child.correlationId, CORRELATION);
  assert.equal(child.parentId, CORRELATION);
  assert.equal(child.depth, 1);
  assert.equal(child.mode, 'async');
  assert.equal(child.child().depth, 2);
  assert.equal(root.clock.now(), Date.parse('2026-02-01T00:00:00Z'));
  // A correlation that is not a plain token is replaced by a fresh id.
  assert.notEqual(createRequestContext({ ids, correlationId: 'bad value\r\n' }).correlationId, 'bad value\r\n');
  assert.equal(currentRequest(), null);
  runWithRequest(root, () => {
    assert.equal(currentRequest().correlationId, CORRELATION);
    assert.equal(ownsChange(), false, 'a plain request context still queues its writes');
    runOwned(() => {
      assert.equal(ownsChange(), true);
      assert.equal(currentRequest().correlationId, CORRELATION, 'owning the change slot keeps the request context');
    });
  });
});

test('x-ms-correlation-request-id reaches the committed event and the asynchronous web hook payload', async (t) => {
  const hook = await receiver(t);
  const secretVar = `PAQVILO_REQUEST_CONTEXT_SECRET_${process.pid}`;
  process.env[secretVar] = 'request-context-secret';
  t.after(() => {
    delete process.env[secretVar];
  });
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: { x_name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.x_item = [];
  const store = await new DataStore({ state }).init();
  const server = await startDataverseApi({
    store,
    log: () => {},
    extensions: [...EXTENSIONS],
    settings: dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Invented caller',
          secretEnvironmentVariable: secretVar,
          roles: ['System Administrator'],
        },
      ],
    }),
  });
  const messageId = store.tableRows('sdkmessage').find((row) => row.name === 'Create').sdkmessageid;
  const filterId = store
    .tableRows('sdkmessagefilter')
    .find((row) => row.sdkmessageid === messageId && row.primaryobjecttypecode === 'x_item').sdkmessagefilterid;
  await store.create(
    'serviceendpoint',
    {
      serviceendpointid: ENDPOINT,
      name: 'Invented hook',
      url: `${hook.origin}/hook`,
      authtype: 5,
      contract: 8,
      authvalue: '',
    },
    { admin: true },
  );
  await store.create(
    'sdkmessageprocessingstep',
    {
      sdkmessageprocessingstepid: STEP,
      name: 'Invented async hook',
      sdkmessageid: messageId,
      sdkmessagefilterid: filterId,
      eventhandler: { id: ENDPOINT, logical_name: 'serviceendpoint' },
      stage: 40,
      mode: 1,
      rank: 1,
      statecode: 0,
      supporteddeployment: 0,
    },
    { admin: true },
  );
  const webhooks = webhookDelivery(store),
    diagnostics = [];
  const steps = () =>
    pluginCatalogue({
      plugins: overlayRegisteredSteps({ steps: [], types: [], assemblies: [] }, store),
      handlers: new Map(),
    });
  store.setPluginPipeline(
    (context) =>
      runPluginPhase({
        ...context,
        store,
        items: steps(),
        handlers: new Map(),
        webhooks,
        diagnostic: (entry) => diagnostics.push(entry),
      }),
    ({ entity, operation }) =>
      steps().some(
        (item) =>
          item.enabled && pluginStepMatchesEntity(item, entity) && String(item.message).toLowerCase() === operation,
      ),
    (context) => pluginPhaseRequiresCheckpoint(steps(), context),
  );
  const runner = createAsyncPluginRunner({
    store,
    items: steps,
    handlers: new Map(),
    runtimes: new Map(),
    webhooks,
    diagnostic: (entry) => diagnostics.push(entry),
    systemJobs: () => true,
  });
  t.after(async () => {
    await runner.close();
    await server.close();
  });
  const events = [];
  store.addCommittedEvents((batch) => events.push(...batch));

  const token = await (
    await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: process.env[secretVar],
        scope: `${server.origin}/.default`,
      }),
    })
  ).json();
  const created = await fetch(`${server.origin}/api/data/v9.2/x_items`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.access_token}`,
      'content-type': 'application/json',
      'x-ms-correlation-request-id': CORRELATION,
    },
    body: JSON.stringify({ x_name: 'Invented correlated row' }),
  });
  assert.equal(created.status, 204, await created.text());
  await store.flushCommittedEvents();
  await runner.drain();

  const event = events.find((entry) => entry.entity === 'x_item' && entry.operation === 'create');
  assert.equal(event.correlationId, CORRELATION, 'the committed event carries the request correlation');
  assert.notEqual(event.chain?.id, CORRELATION, 'the per-root-event chain id is not replaced by the correlation');
  const [delivery] = await hook.log();
  assert.equal(delivery.body.CorrelationId, CORRELATION, 'the web hook payload carries the request correlation');
});
