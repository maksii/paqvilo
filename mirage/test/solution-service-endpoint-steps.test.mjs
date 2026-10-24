// A Solution's SdkMessageProcessingStep whose <EventHandler> is a service endpoint (eventhandler targets plugintype and
// serviceendpoint) is delivered like a registered one: a contract 2 queue through the core Service Bus emulator
// bus to the fake broker, a contract 8 web hook to a loopback receiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { overlayRegisteredSteps, solutionPluginExtension, solutionPluginRows } from '../lib/dataverse-plugin-registration.mjs';
import { serviceEndpointDelivery } from '../lib/dataverse-webhooks.mjs';
import { createLocalMessageBus, createServiceBusEmulatorBus, mappedEntities, messagingSettings } from '../lib/message-bus.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { importSolutionPlugins, parsePluginDocument, pluginCatalogue } from '../lib/exported-plugins.mjs';
import { startFakeBroker } from '../testing/amqp-fake-broker.mjs';

const KEY = 'invented-key-5e1d', QUEUE = '77777777-7777-4777-8777-777777777731', HOOK = '77777777-7777-4777-8777-777777777732';
const QUEUE_STEP = '77777777-7777-4777-8777-777777777733', HOOK_STEP = '77777777-7777-4777-8777-777777777734', ORPHAN_STEP = '77777777-7777-4777-8777-777777777735';
const CREATE = '9ebdbb1b-ea3e-db11-86a7-000a3a5473e8';
// The exported step shape: a bare EventHandler, as the workspace export writes it; a second shape names the handler's type code.
const stepXml = (id, handler, extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<SdkMessageProcessingStep Name="x_widget Create ${id.slice(-2)}" SdkMessageProcessingStepId="{${id}}">
  <SdkMessageId>${CREATE}</SdkMessageId>
  <EventHandler>${handler}</EventHandler>${extra}
  <PrimaryEntity>x_widget</PrimaryEntity>
  <Mode>1</Mode><Rank>1</Rank><Stage>40</Stage><SupportedDeployment>0</SupportedDeployment><StateCode>0</StateCode>
  <SdkMessageProcessingStepImages />
</SdkMessageProcessingStep>`;
const solution = (documents) => importSolutionPlugins([{ documents: documents.map(([file, xml]) => ({ file, facts: { plugins: parsePluginDocument(xml) } })) }]);

// A store holding the Solution's seeded step rows (as solutionPluginExtension writes them) and the given organization rows.
async function stepStore(plugins, tables = {}) {
  const state = emptyState();
  const organizationid = '77777777-7777-4777-8777-7777777777a0';
  Object.assign(state.tables, { organization: [{ organizationid, name: 'x' }], sdkmessageprocessingstep: solutionPluginRows(plugins, { organizationId: organizationid }).sdkmessageprocessingstep, ...tables });
  return new DataStore({ state }).init();
}

async function world(t, documents) {
  const broker = await startFakeBroker({ key: KEY, queues: ['x-queue'] });
  const posts = [];
  const receiver = http.createServer((req, res) => { let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => { posts.push({ url: req.url, body: JSON.parse(body) }); res.writeHead(200).end(); }); });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const plugins = solution(documents);
  const state = emptyState();
  state.mappings.x_widget = { logicalName: 'x_widget', entitySet: 'x_widgets', idColumn: 'x_widgetid', nameColumn: 'x_name', userConfigured: true, fields: { x_name: { dataverseType: 'nvarchar' } }, relationships: {} };
  state.tables.x_widget = [];
  const store = await new DataStore({ state }).init();
  const api = await startDataverseApi({ store, settings: dataverseSettings({ enabled: true, tds: { enabled: false } }), log: () => {}, extensions: [...EXTENSIONS, solutionPluginExtension(plugins)] });
  // The endpoint rows come from the organization (a pack seeds them in the workspace), not from the step export.
  await store.create('serviceendpoint', { serviceendpointid: QUEUE, name: 'x-requests-queue', contract: 2, connectionmode: 1, authtype: 2 }, { admin: true });
  await store.create('serviceendpoint', { serviceendpointid: HOOK, name: 'x-loopback-hook', contract: 8, connectionmode: 1, authtype: 5, url: `http://127.0.0.1:${receiver.address().port}/api/x-hook` }, { admin: true });
  const env = { FX_SB: `Endpoint=sb://127.0.0.1;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${KEY};UseDevelopmentEmulator=true;` };
  const settings = messagingSettings({ sb: { kind: 'servicebus-emulator', connectionString: 'env:FX_SB', amqpPort: broker.port }, endpoints: { 'x-requests-queue': 'sb/x-queue' } });
  const emulator = createServiceBusEmulatorBus({ id: 'sb', settings: settings.sb, entities: mappedEntities(settings, 'sb'), env });
  const webhooks = serviceEndpointDelivery(store, { messaging: { bus: createLocalMessageBus({ store }), buses: { sb: emulator }, settings, organizationUri: 'https://invented.example.test' } });
  const diagnostics = [];
  const steps = () => pluginCatalogue({ plugins: overlayRegisteredSteps(plugins, store), handlers: new Map() });
  const runner = createAsyncPluginRunner({ store, items: steps, handlers: new Map(), runtimes: new Map(), webhooks, diagnostic: (entry) => diagnostics.push(entry), systemJobs: () => true });
  t.after(async () => { await runner.close(); await api.close(); await emulator.close(); await broker.close(); receiver.close(); });
  const job = (step) => store.tableRows('asyncoperation').find((row) => row.owningextensionid?.id === step);
  return { plugins, store, broker, emulator, runner, posts, job, steps, diagnostics };
}

test('a Solution step whose EventHandler is a service endpoint resolves to that endpoint, not to a missing plug-in type', async () => {
  const plugins = solution([['a.xml', stepXml(QUEUE_STEP, QUEUE)], ['b.xml', stepXml(HOOK_STEP, HOOK, '\n  <EventHandlerTypeCode>4618</EventHandlerTypeCode>')]]);
  assert.deepEqual(plugins.diagnostics.filter((entry) => entry.code === 'PLUGIN_STEP_UNSUPPORTED'), []);
  // The type code names the endpoint at import; a bare EventHandler waits for the organization's rows.
  const hook = plugins.steps.find((item) => item.id === HOOK_STEP);
  assert.equal(hook.serviceEndpointId, HOOK);
  assert.equal(hook.unsupported, null);
  const bare = plugins.steps.find((item) => item.id === QUEUE_STEP);
  assert.equal(bare.eventHandlerId, QUEUE);
  assert.match(bare.unsupported, /handler unresolved/);
  const store = await stepStore(plugins, { serviceendpoint: [{ serviceendpointid: QUEUE, name: 'x-requests-queue', contract: 2 }] });
  const steps = overlayRegisteredSteps(plugins, store).steps;
  for (const [id, endpoint] of [[QUEUE_STEP, QUEUE], [HOOK_STEP, HOOK]]) {
    const step = steps.find((item) => item.id === id);
    assert.equal(step.serviceEndpointId, endpoint);
    assert.equal(step.typeId, null);
    assert.equal(step.unsupported, null);
  }
  assert.equal(pluginCatalogue({ plugins: { ...plugins, steps } }).every((item) => item.mode === 'webhook'), true);
});

test('a bare EventHandler that names neither a plug-in type nor a service endpoint stays unsupported (handler unresolved)', async () => {
  const plugins = solution([['a.xml', stepXml(ORPHAN_STEP, '77777777-7777-4777-8777-7777777777ff').replace('<Mode>1</Mode>', '<Mode>0</Mode>')]]);
  const store = await stepStore(plugins);
  const [step] = overlayRegisteredSteps(plugins, store).steps;
  assert.equal(step.serviceEndpointId, null);
  assert.match(step.unsupported, /handler unresolved/);
  const [item] = pluginCatalogue({ plugins: { ...plugins, steps: [step] } });
  assert.notEqual(item.mode, 'webhook', 'a missing dependency never becomes a web hook that only warns');
  assert.match(item.unsupported, /handler unresolved/);
});

test('Solution service endpoint steps deliver to the emulator queue and to the loopback web hook after commit', async (t) => {
  const { store, broker, emulator, runner, posts, job } = await world(t, [['a.xml', stepXml(QUEUE_STEP, QUEUE)], ['b.xml', stepXml(HOOK_STEP, HOOK)]]);
  const row = store.tableRows('sdkmessageprocessingstep').find((item) => item.sdkmessageprocessingstepid === QUEUE_STEP);
  assert.equal(row.eventhandler, QUEUE, 'the seeded row names its endpoint as the event handler');
  assert.equal(row.plugintypeid, null);
  await store.create('x_widget', { x_widgetid: '77777777-7777-4777-8777-777777777736', x_name: 'alpha' }, { admin: true });
  await runner.drain();
  assert.equal(broker.count('x-queue'), 1);
  const [message] = await emulator.receive('x-queue');
  assert.equal(message.body.PrimaryEntityName, 'x_widget');
  assert.equal(message.body.OwningExtension.Id, QUEUE_STEP);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/x-hook');
  assert.equal(posts[0].body.MessageName, 'Create');
  assert.equal(job(QUEUE_STEP).statuscode, 30);
  assert.equal(job(HOOK_STEP).statuscode, 30);
});

test('an asynchronous step that executes nothing ends Canceled, never Succeeded', async (t) => {
  // A plug-in type the selected layers do not export: the registration is unsupported, so the run executes nothing.
  const orphan = stepXml(ORPHAN_STEP, '77777777-7777-4777-8777-777777777737').replace('<EventHandler>', '<PluginTypeName>X.Missing, X</PluginTypeName><EventHandler>');
  const { store, runner, job } = await world(t, [['c.xml', orphan]]);
  await store.create('x_widget', { x_widgetid: '77777777-7777-4777-8777-777777777738', x_name: 'beta' }, { admin: true });
  await runner.drain();
  assert.equal(job(ORPHAN_STEP).statuscode, 32);
  assert.match(job(ORPHAN_STEP).message, /nothing was executed/);
});

test('a bare EventHandler naming a plug-in type the organization registered resolves to that type', async () => {
  const handler = '77777777-7777-4777-8777-7777777777fe', assembly = '77777777-7777-4777-8777-7777777777fd';
  const plugins = solution([['a.xml', stepXml(ORPHAN_STEP, handler).replace('<Mode>1</Mode>', '<Mode>0</Mode>')]]);
  const store = await stepStore(plugins, { pluginassembly: [{ pluginassemblyid: assembly, name: 'X.Plugins' }], plugintype: [{ plugintypeid: handler, typename: 'X.Plugins.Validate', pluginassemblyid: assembly }] });
  const [step] = overlayRegisteredSteps(plugins, store).steps;
  assert.equal(step.typeName, 'X.Plugins.Validate');
  assert.equal(step.assemblyId, assembly);
  assert.equal(step.serviceEndpointId, null);
  assert.equal(step.unsupported, null);
});
