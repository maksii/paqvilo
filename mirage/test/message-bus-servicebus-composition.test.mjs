// @test-kind contract: the organization host composes Paqvilo's core servicebus-emulator bus from its provider settings and options.
// Composition of a servicebus-emulator entry (organization-host.mjs composeProviders): core instantiates the AMQP bus without a
// pack, a mapped service endpoint message reaches the broker, preflight probes it, and the host closes it.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { DataStore, emptyState } from '../lib/data.mjs';
import { composeProviders, closeProviders, providerRequirements } from '../lib/organization-host.mjs';
import { messagingOf, serviceEndpointTarget } from '../lib/dataverse-webhooks.mjs';
import { startFakeBroker } from '../testing/amqp-fake-broker.mjs';
import '../lib/provider-modules.mjs';

const KEY = 'invented-key-7f3a9c',
  ENDPOINT = '77777777-7777-4777-8777-777777777702',
  VARIABLE = 'FX_SB_COMPOSITION';
const connectionString = `Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${KEY};UseDevelopmentEmulator=true;`;

test('a servicebus-emulator entry composes the core AMQP bus and delivers a mapped endpoint message', async (t) => {
  const broker = await startFakeBroker({ key: KEY, queues: ['fx-orders'] });
  process.env[VARIABLE] = connectionString;
  ownedFixture(t).add(async () => {
    delete process.env[VARIABLE];
    await broker.close();
  });
  const diagnostics = [];
  const providers = await composeProviders({
    store: await new DataStore({ state: emptyState() }).init(),
    diagnostic: (entry) => diagnostics.push(entry),
    // No wall-clock bound: the in-process broker answers every request, and a missing answer is ended by the runner's
    // --test-timeout.
    messageBusTimeoutMs: null,
    config: {
      providers: {
        messaging: {
          sb: { kind: 'servicebus-emulator', connectionString: `env:${VARIABLE}`, amqpPort: broker.port },
          endpoints: { [ENDPOINT]: 'sb/fx-orders' },
        },
      },
    },
  });
  assert.ok(!diagnostics.some((entry) => entry.code === 'PROVIDER_NOT_REGISTERED'), 'no pack is needed');
  const bus = providers.messaging.buses.sb;
  assert.equal(bus.descriptor.kind, 'servicebus-emulator');
  assert.deepEqual(bus.entities, ['fx-orders']);
  const target = serviceEndpointTarget(messagingOf(providers.messaging), { serviceendpointid: ENDPOINT, contract: 2 });
  assert.equal(target.bus, bus);
  await target.bus.send(
    target.entity,
    { x_name: 'fx' },
    { messageId: 'fx-operation', properties: { requestName: 'Create' }, nested: true },
  );
  assert.equal(broker.count('fx-orders'), 1);
  const row = async (env) =>
    (await providerRequirements({ providers, env })).find((item) => item.id === 'provider:messaging/sb');
  assert.deepEqual(await row(process.env), { id: 'provider:messaging/sb', reachable: true, message: null });
  const unset = await row({});
  assert.equal(unset.reachable, false);
  assert.match(unset.message, new RegExp(`${VARIABLE} is not set`));
  assert.doesNotMatch(JSON.stringify([unset, diagnostics]), new RegExp(KEY));
  await closeProviders(providers);
  const before = broker.stats.connections;
  await closeProviders(providers);
  assert.equal(broker.stats.connections, before, 'a closed host opens nothing');
});

test('a servicebus-emulator entry parsed by the catalogue settings composes again (one idempotent normalisation)', async () => {
  const { parseSetting } = await import('../lib/config-keys.mjs');
  const raw = {
    messaging: {
      local: { kind: 'local-queue' },
      sb: { kind: 'servicebus-emulator', connectionString: `env:${VARIABLE}` },
      endpoints: { 'fx-queue': 'sb/fx-orders' },
    },
  };
  const parsed = parseSetting('providers', raw);
  assert.equal(parsed.messaging.sb.retry, undefined, 'the emulator owns its retry policy');
  assert.deepEqual(parseSetting('providers', parsed), parsed);
  const diagnostics = [];
  const providers = await composeProviders({
    store: await new DataStore({ state: emptyState() }).init(),
    diagnostic: (entry) => diagnostics.push(entry),
    config: { providers: parsed },
  });
  assert.equal(providers.messaging.buses.sb.descriptor.kind, 'servicebus-emulator');
  await closeProviders(providers);
});

test('the host passes its message-bus bound to the core emulator bus, and the bus keeps its own default without one', async (t) => {
  // Accepts the connection and never answers, so each wait ends only at the bus bound.
  const silent = net.createServer((socket) => socket.resume());
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  silent.on('connection', (socket) => sockets.add(socket));
  ownedFixture(t).add(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => silent.close(resolve));
  });
  process.env[VARIABLE] = connectionString;
  t.after(() => delete process.env[VARIABLE]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const send = async (options) => {
    const providers = await composeProviders({
      store: await new DataStore({ state: emptyState() }).init(),
      config: {
        providers: {
          messaging: {
            sb: { kind: 'servicebus-emulator', connectionString: `env:${VARIABLE}`, amqpPort: silent.address().port },
            endpoints: { [ENDPOINT]: 'sb/fx-orders' },
          },
        },
      },
      ...options,
    });
    ownedFixture(t).add(() => closeProviders(providers));
    // The client registers its wait before it writes, so the first bytes mean the bounded wait is armed.
    const written = once(silent, 'connection').then(([socket]) => once(socket, 'data'));
    let settled = false;
    const sent = providers.messaging.buses.sb.send('fx-orders', { n: 1 }).finally(() => {
      settled = true;
    });
    sent.catch(() => {});
    await written;
    return { sent, settled: () => settled };
  };
  const bounded = await send({ messageBusTimeoutMs: 60_000 });
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bounded.settled(), false, 'the host bound replaces the 5 s default');
  t.mock.timers.tick(55_000);
  await assert.rejects(bounded.sent, (error) => error.diagnostic === 'AMQP_TIMEOUT');
  const defaulted = await send({});
  t.mock.timers.tick(5_000);
  await assert.rejects(defaulted.sent, (error) => error.diagnostic === 'AMQP_TIMEOUT');
});
