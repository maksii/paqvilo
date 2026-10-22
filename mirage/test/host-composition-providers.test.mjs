// Pack provider factories (organization-host.mjs composeProviders): pack storageProviders, messageProviders and
// outboxHandlers are instantiated once per host, closed with it, and a throwing factory fails composition naming the pack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { composeProviders, composeOrganizationHost, closeProviders, settleProviders, providerRequirements } from '../lib/organization-host.mjs';
import { createMemoryStorage } from '../lib/storage-memory.mjs';
import { createLocalMessageBus } from '../lib/message-bus.mjs';
import { messagingOf, serviceEndpointTarget } from '../lib/dataverse-webhooks.mjs';
import '../lib/provider-modules.mjs';

const ENDPOINT = '77777777-7777-4777-8777-777777777701';
const store = async () => new DataStore({ state: emptyState() }).init();

function fxPack(calls) {
  return {
    id: 'fx-pack', name: 'Invented', description: 'Invented', matches: () => true, presets: () => ({}),
    storageProviders: { blob: ({ id }) => {
      calls.push(`storage:${id}`);
      const provider = createMemoryStorage({ id });
      return { ...provider, descriptor: provider.descriptor, close: async () => { calls.push(`close:${id}`); await provider.close(); } };
    } },
    messageProviders: { amqp: ({ id, store: target }) => {
      calls.push(`messaging:${id}`);
      const bus = createLocalMessageBus({ store: target, id });
      return Object.assign(bus, { close: () => { calls.push(`close:${id}`); } });
    } },
    outboxHandlers: { observe: () => entry => { calls.push(`observed:${entry.subject}`); } },
  };
}

test('a pack storageProviders factory serves its route and the host closes it once', async () => {
  const calls = [];
  const providers = await composeProviders({ store: await store(), packs: [fxPack(calls)], config: { providers: {
    storage: { fxblob: { kind: 'pack:fx-pack/blob' } }, routes: { annotations: 'fxblob' } } } });
  assert.deepEqual(calls, ['storage:fxblob']);
  const route = providers.storage.forRoute('annotations');
  await route.put('annotations/x/1', Buffer.from('invented'), { contentType: 'text/plain' });
  const chunks = [];
  for await (const chunk of (await route.get('annotations/x/1')).body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'invented');
  assert.deepEqual((await providerRequirements({ providers })).find(row => row.id === 'provider:storage/fxblob'), { id: 'provider:storage/fxblob', reachable: true, message: null });
  await closeProviders(providers);
  await closeProviders(providers);
  assert.deepEqual(calls.filter(call => call.startsWith('close:fxblob')), ['close:fxblob']);
});

test('a throwing factory fails composition with PROVIDER_FACTORY_FAILED naming the pack', async () => {
  const diagnostics = [];
  const pack = { id: 'fx-broken', storageProviders: { blob: () => { throw new Error('invented failure'); } } };
  await assert.rejects(() => composeProviders({ store: { counters: null }, packs: [pack], diagnostic: entry => diagnostics.push(entry),
    config: { providers: { storage: { fxblob: { kind: 'pack:fx-broken/blob' } } } } }), error => error.code === 'PROVIDER_FACTORY_FAILED' && error.pack === 'fx-broken' && /invented failure/.test(error.message));
  assert.equal(diagnostics[0].code, 'PROVIDER_FACTORY_FAILED');
  assert.equal(diagnostics[0].pack, 'fx-broken');
});

test('an azurite entry with an unset connection string is instantiated by core and answers Unavailable with the reason', async () => {
  const diagnostics = [];
  const providers = await composeProviders({ store: await store(), env: {}, diagnostic: entry => diagnostics.push(entry), config: { providers: {
    storage: { emulator: { kind: 'azurite', connectionString: 'env:FX_UNSET_AZURITE' } }, routes: { annotations: 'emulator' } } } });
  const route = providers.storage.forRoute('annotations');
  assert.equal(route.descriptor.level, 'contract');
  await assert.rejects(route.put('annotations/x/1', Buffer.from('x')), { code: 'Unavailable', diagnostic: 'PROVIDER_SECRET_MISSING' });
  assert.ok(!diagnostics.some(entry => entry.code === 'PROVIDER_NOT_REGISTERED'));
  const [row] = (await providerRequirements({ providers, env: {} })).filter(item => item.id === 'provider:storage/emulator');
  assert.equal(row.reachable, false);
  assert.match(row.message, /FX_UNSET_AZURITE is not set/);
  await closeProviders(providers);
});

test('the core azurite factory serves a declared azurite route against a Blob endpoint and its preflight is satisfied', async (t) => {
  const { startAzuriteFake } = await import('../testing/azurite-fake.mjs');
  const fake = await startAzuriteFake();
  t.after(() => fake.close());
  const env = { FX_AZURITE: fake.connectionString() };
  const providers = await composeProviders({ store: await store(), env, config: { providers: {
    storage: { emulator: { kind: 'azurite', connectionString: 'env:FX_AZURITE', container: 'fx-composition' } }, routes: { annotations: 'emulator' } } } });
  const route = providers.storage.forRoute('annotations');
  assert.equal(route.descriptor.level, 'behaviour');
  await route.put('annotations/x/1', Buffer.from('invented'), { contentType: 'text/plain' });
  const chunks = [];
  for await (const chunk of (await route.get('annotations/x/1')).body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'invented');
  assert.ok(fake.containers.get('fx-composition').has('annotations/x/1'));
  assert.deepEqual((await providerRequirements({ providers, env })).find(row => row.id === 'provider:storage/emulator'), { id: 'provider:storage/emulator', reachable: true, message: null });
  assert.ok(!JSON.stringify(providers.storage.describe()).includes(fake.connectionString()));
  await closeProviders(providers);
});

test('a pack messageProviders bus receives a mapped service endpoint message', async () => {
  const calls = [], target = await store();
  const providers = await composeProviders({ store: target, packs: [fxPack(calls)], config: { providers: {
    messaging: { ext: { kind: 'pack:fx-pack/amqp' }, endpoints: { [ENDPOINT]: 'ext/x_queue' } } } } });
  const resolved = serviceEndpointTarget(messagingOf(providers.messaging), { serviceendpointid: ENDPOINT, contract: 2 });
  assert.equal(resolved.providerId, 'ext');
  assert.equal(resolved.bus, providers.messaging.buses.ext);
  await resolved.bus.send(resolved.entity, { body: { invented: true } });
  assert.equal(providers.messaging.buses.ext.peek('x_queue').length, 1);
  await closeProviders(providers);
  assert.ok(calls.includes('close:ext'));
});

test('outbox pack handlers observe committed captures only, after capture', async () => {
  const calls = [], target = await store();
  const providers = await composeProviders({ store: target, packs: [fxPack(calls)], config: { providers: { outbox: { kind: 'pack:fx-pack' } } } });
  await providers.outbox.capture({ channel: 'email', to: ['a@example.test'], subject: 'kept' });
  // A nested capture rolled back with its caller is never observed.
  await target.transact(async () => {
    await providers.outbox.capture({ channel: 'email', to: ['a@example.test'], subject: 'rolled back' }, { nested: true });
    throw new Error('invented rollback');
  }).catch(() => {});
  await settleProviders(providers);
  assert.deepEqual(calls.filter(call => call.startsWith('observed:')), ['observed:kept']);
  assert.deepEqual(providers.outbox.list().map(entry => entry.subject), ['kept']);
});

test('a failing later factory closes the earlier instances before the failure propagates', async () => {
  const calls = [];
  const pack = { ...fxPack(calls), messageProviders: { amqp: () => { throw new Error('invented messaging failure'); } } };
  await assert.rejects(composeProviders({ store: await store(), packs: [pack], config: { providers: {
    storage: { fxblob: { kind: 'pack:fx-pack/blob' } }, messaging: { ext: { kind: 'pack:fx-pack/amqp' } } } } }), { code: 'PROVIDER_FACTORY_FAILED' });
  assert.deepEqual(calls, ['storage:fxblob', 'close:fxblob']);
});

test('a failing settle still closes the provider; a failed close is retried by the next closeProviders only', async () => {
  const calls = [];
  let closeFails = true;
  const bus = (name, extra) => ({ descriptor: { id: name }, send: async () => {}, ...extra });
  const pack = { id: 'fx-life', messageProviders: {
    good: () => bus('good', { settle: () => calls.push('settle:good'), close: () => calls.push('close:good') }),
    bad: () => bus('bad', { settle: () => { calls.push('settle:bad'); if (closeFails) throw new Error('invented settle'); },
      close: () => { calls.push('close:bad'); if (closeFails) throw new Error('invented close'); } }) } };
  const providers = await composeProviders({ store: await store(), packs: [pack], config: { providers: { messaging: {
    a: { kind: 'pack:fx-life/good' }, b: { kind: 'pack:fx-life/bad' } } } } });
  await assert.rejects(settleProviders(providers), { code: 'PROVIDER_SETTLE_FAILED' });
  assert.deepEqual(calls.splice(0), ['settle:good', 'settle:bad'], 'every provider is settled despite one failure');
  await assert.rejects(closeProviders(providers), error => error.code === 'PROVIDER_CLOSE_FAILED' && error.providers.join() === 'messageProviders/b'
    && error.errors.length === 2 && /invented settle/.test(error.message) && /invented close/.test(error.message));
  assert.deepEqual(calls.splice(0), ['settle:bad', 'close:bad', 'settle:good', 'close:good']);
  closeFails = false;
  await closeProviders(providers);
  assert.deepEqual(calls.splice(0), ['settle:bad', 'close:bad']);
  await closeProviders(providers);
  assert.deepEqual(calls, []);
});

test('a second host.close() retries only the provider whose close failed, without settling it again', async () => {
  const calls = [];
  let closeFails = true;
  const pack = { id: 'fx-host', messageProviders: { bad: () => ({ descriptor: { id: 'bad' }, send: async () => {}, settle: () => calls.push('settle'),
    close: () => { calls.push('close'); if (closeFails) throw new Error('invented close'); } }) } };
  const host = await composeOrganizationHost({ store: await store(), packs: [pack], config: { providers: { messaging: { b: { kind: 'pack:fx-host/bad' } } } },
    sources: { plugins: () => undefined, workflows: () => new Map(), layers: () => [] } });
  await assert.rejects(host.close(), error => error.errors.some(item => item.code === 'PROVIDER_CLOSE_FAILED' && /invented close/.test(item.message)));
  assert.deepEqual(calls.splice(0), ['settle', 'close']);
  closeFails = false;
  await host.close();
  assert.deepEqual(calls.splice(0), ['close']);
  await host.close();
  assert.deepEqual(calls, []);
});

test('an azurite entry whose loopback endpoint answers 200 but is no Blob endpoint is never satisfied', async (t) => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => res.end('')).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const key = Buffer.from('fx-invented-composition-key').toString('base64');
  const env = { FX_AZURITE: `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${key};BlobEndpoint=http://127.0.0.1:${server.address().port}/devstoreaccount1;` };
  const providers = await composeProviders({ store: await store(), env, config: { providers: { storage: { emulator: { kind: 'azurite', connectionString: 'env:FX_AZURITE' } } } } });
  const [row] = (await providerRequirements({ providers, env })).filter(item => item.id === 'provider:storage/emulator');
  assert.equal(row.reachable, false);
  assert.match(row.message, /not a Blob endpoint/);
  assert.ok(!row.message.includes(key));
  await closeProviders(providers);
});

test('the host graph shows the Azurite node by its observed state, never a constant declared', async (t) => {
  const { startAzuriteFake } = await import('../testing/azurite-fake.mjs');
  const fake = await startAzuriteFake();
  t.after(() => fake.close());
  const env = { FX_AZURITE: fake.connectionString() };
  const compose = async (environment) => composeOrganizationHost({ store: await store(), env: environment, config: { providers: {
    storage: { emulator: { kind: 'azurite', connectionString: 'env:FX_AZURITE', container: 'fx-graph' } }, routes: { annotations: 'emulator' } } },
  sources: { plugins: () => undefined, workflows: () => new Map(), layers: () => [] } });
  const azuriteNode = host => host.topology().nodes.find(item => item.id === 'external:azurite');
  const host = await compose(env);
  t.after(() => host.close());
  assert.equal(azuriteNode(host).status, 'declared'); // not contacted yet
  // The topology is memoised (store revision, 5-second bucket): a fresh host probed before its first topology shows ready.
  const probed = await compose(env);
  t.after(() => probed.close());
  await providerRequirements({ providers: probed.providers, env });
  assert.equal(azuriteNode(probed).status, 'ready');
  assert.equal(azuriteNode(probed).detail.health[0].ready, true);
  const missing = await compose({});
  t.after(() => missing.close());
  const node = azuriteNode(missing);
  assert.equal(node.status, 'missing');
  assert.match(node.detail.health[0].reason, /FX_AZURITE is not set/);
});

test('an outbox pack kind without outboxHandlers fails composition', async () => {
  const target = await store();
  await assert.rejects(() => composeProviders({ store: target, packs: [], config: { providers: { outbox: { kind: 'pack:fx-missing' } } } }),
    { code: 'PROVIDER_NOT_REGISTERED' });
});
