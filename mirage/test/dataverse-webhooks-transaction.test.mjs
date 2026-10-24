// Webhook RemoteExecutionContext transaction flags (dataverse-webhooks.mjs remoteExecutionContext): IsInTransaction comes from
// the pipeline's transaction state, Mode from the delivery. A PreValidation step outside an existing transaction does not
// participate, PreOperation and PostOperation steps participate, asynchronous steps never do. An asynchronous PostOperation
// step has Mode 1; RemoteExecutionContext.IsExecutingOffline is true only for the offline Outlook client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { overlayRegisteredSteps } from '../lib/dataverse-plugin-registration.mjs';
import { webhookDelivery } from '../lib/dataverse-webhooks.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { pluginCatalogue, pluginPhaseRequiresCheckpoint, pluginStepMatchesEntity, runPluginPhase } from '../lib/exported-plugins.mjs';

const WIDGET = 'bbbbbbbb-0000-4000-8000-000000000073';
const ENDPOINT = 'cccccccc-0000-4000-8000-000000000073';
const STEPS = [[10, 0, 'dddddddd-0000-4000-8000-000000000710'], [20, 0, 'dddddddd-0000-4000-8000-000000000720'],
  [40, 0, 'dddddddd-0000-4000-8000-000000000740'], [40, 1, 'dddddddd-0000-4000-8000-000000000741']];

test('IsInTransaction and Mode follow the pipeline stage, its transaction and the delivery mode', async (t) => {
  const received = [];
  const receiver = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => { received.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.writeHead(200); res.end(); });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => receiver.close(resolve)));

  const state = emptyState();
  state.mappings.x_widget = { logicalName: 'x_widget', entitySet: 'x_widgets', idColumn: 'x_widgetid', nameColumn: 'x_name', userConfigured: true, fields: { x_name: { dataverseType: 'nvarchar' } }, relationships: {} };
  state.tables.x_widget = [];
  const store = await new DataStore({ state }).init();
  const api = await startDataverseApi({ store, settings: dataverseSettings({ enabled: true }), log: () => {}, extensions: [...EXTENSIONS] });
  const messageId = store.tableRows('sdkmessage').find((row) => row.name === 'Create').sdkmessageid;
  const filterId = store.tableRows('sdkmessagefilter').find((row) => row.sdkmessageid === messageId && row.primaryobjecttypecode === 'x_widget').sdkmessagefilterid;
  await store.create('serviceendpoint', { serviceendpointid: ENDPOINT, name: 'Invented hook', url: `http://127.0.0.1:${receiver.address().port}/hook`, authtype: 5, contract: 8, authvalue: '' }, { admin: true });
  for (const [stage, mode, id] of STEPS) {
    await store.create('sdkmessageprocessingstep', { sdkmessageprocessingstepid: id, name: `Invented step ${stage}/${mode}`, sdkmessageid: messageId, sdkmessagefilterid: filterId,
      eventhandler: { id: ENDPOINT, logical_name: 'serviceendpoint' }, stage, mode, rank: 1, statecode: 0, supporteddeployment: 0 }, { admin: true });
  }
  const webhooks = webhookDelivery(store);
  const steps = () => pluginCatalogue({ plugins: overlayRegisteredSteps({ steps: [], types: [], assemblies: [] }, store), handlers: new Map() });
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items: steps(), handlers: new Map(), webhooks }),
    ({ entity, operation }) => steps().some((item) => item.enabled && pluginStepMatchesEntity(item, entity) && String(item.message).toLowerCase() === operation),
    (context) => pluginPhaseRequiresCheckpoint(steps(), context),
  );
  const runner = createAsyncPluginRunner({ store, items: steps, handlers: new Map(), runtimes: new Map(), webhooks, systemJobs: () => true });
  t.after(async () => { await runner.close(); await api.close(); });

  await store.create('x_widget', { x_widgetid: WIDGET, x_name: 'Invented' }, { admin: true });
  await runner.drain();
  const flags = Object.fromEntries(received.map((body) => [`${body.Stage}/${body.Mode}`, [body.IsInTransaction, body.IsExecutingOffline]]));
  assert.deepEqual(flags, {
    '10/0': [false, false], // PreValidation, no transaction yet
    '20/0': [true, false], // synchronous PreOperation, inside the transaction
    '40/0': [true, false], // synchronous PostOperation, inside the transaction
    '40/1': [false, false], // asynchronous, after commit
  });
});
