import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore } from '../lib/data.mjs';
import {
  createLocalMessageBus, localMessageBusDescriptor, messagingSettings, serviceBusEmulatorDescriptor,
  serviceBusEmulatorPreflight, QUEUE_MESSAGE_TABLE,
} from '../lib/message-bus.mjs';

function fixedClock(start = Date.parse('2026-01-01T00:00:00Z')) { let t = start; return { now: () => t, advance: (ms) => (t += ms) }; }
function sequentialIds() { let n = 0; return { uuid: () => `77777777-7777-4777-8777-${String(++n).padStart(12, '0')}` }; }
function busFixture(options = {}) {
  const store = new DataStore();
  const clock = fixedClock(), ids = sequentialIds();
  return { store, clock, bus: createLocalMessageBus({ store, clock, ids, lockDurationMs: 30_000, ...options }) };
}

test('messages are delivered FIFO per entity and entities do not mix', async () => {
  const { bus } = busFixture();
  for (const n of [1, 2, 3]) await bus.send('fx-orders', { n });
  await bus.send('fx-other', { n: 99 });
  const received = await bus.receive('fx-orders', { mode: 'receiveAndDelete', maxMessages: 10 });
  assert.deepEqual(received.map((message) => message.body.n), [1, 2, 3]);
  assert.deepEqual((await bus.receive('fx-other', { mode: 'receiveAndDelete' })).map((message) => message.body.n), [99]);
  assert.deepEqual(await bus.receive('fx-orders'), []);
});

test('an expired peek lock redelivers the message with a higher delivery count', async () => {
  const { bus, clock } = busFixture({ retry: { maxAttempts: 3 } });
  await bus.send('fx-orders', { n: 1 }, { properties: { x_table: 'x_item' } });
  const [first] = await bus.receive('fx-orders');
  assert.equal(first.deliveryCount, 1);
  assert.equal(first.properties.x_table, 'x_item');
  assert.deepEqual(await bus.receive('fx-orders'), [], 'locked message is invisible');
  clock.advance(30_001);
  const [second] = await bus.receive('fx-orders');
  assert.equal(second.deliveryCount, 2);
  assert.notEqual(second.lockToken, first.lockToken);
  await assert.rejects(bus.complete(first.lockToken), (error) => error.code === 'MessageLockLost');
  assert.equal(await bus.complete(second.lockToken), true);
  assert.deepEqual(bus.stats('fx-orders'), { active: 0, locked: 0, scheduled: 0, deadLettered: 0 });
});

test('exceeding maxAttempts moves the message to the dead-letter sub-queue', async () => {
  const { bus, clock } = busFixture({ retry: { maxAttempts: 2, backoffMs: [1000], deadLetter: true } });
  await bus.send('fx-orders', { n: 1 }, { messageId: 'm-1' });
  const [first] = await bus.receive('fx-orders');
  await bus.abandon(first.lockToken, { reason: 'listener down' });
  assert.deepEqual(await bus.receive('fx-orders'), [], 'backoff hides the abandoned message');
  clock.advance(1000);
  const [second] = await bus.receive('fx-orders');
  assert.equal(second.deliveryCount, 2);
  await bus.abandon(second.lockToken);
  assert.deepEqual(bus.stats('fx-orders'), { active: 0, locked: 0, scheduled: 0, deadLettered: 1 });
  const [dead] = await bus.receive('fx-orders/$deadletterqueue', { mode: 'receiveAndDelete' });
  assert.equal(dead.messageId, 'm-1');
  assert.equal(dead.deadLetterReason, 'MaxDeliveryCountExceeded');
});

test('an explicit dead-letter keeps the reason, and deadLetter false drops exhausted messages', async () => {
  const { bus } = busFixture();
  await bus.send('fx-orders', { n: 1 });
  const [message] = await bus.receive('fx-orders');
  await bus.deadLetter(message.lockToken, { reason: 'Poison', description: 'invented failure' });
  const [dead] = bus.peek('fx-orders/$deadletterqueue');
  assert.equal(dead.deadLetterReason, 'Poison');
  assert.equal(dead.state, 'deadLettered');

  const dropping = busFixture({ retry: { maxAttempts: 1, deadLetter: false } }).bus;
  await dropping.send('fx-orders', { n: 2 });
  const [once] = await dropping.receive('fx-orders');
  await dropping.abandon(once.lockToken);
  assert.deepEqual(dropping.stats('fx-orders'), { active: 0, locked: 0, scheduled: 0, deadLettered: 0 });
});

test('a scheduled message stays invisible until it is due', async () => {
  const { bus, clock } = busFixture();
  await bus.send('fx-orders', { n: 1 }, { scheduledEnqueueTime: new Date(clock.now() + 60_000) });
  assert.equal(bus.peek('fx-orders')[0].state, 'scheduled');
  assert.deepEqual(await bus.receive('fx-orders'), []);
  clock.advance(60_000);
  assert.equal((await bus.receive('fx-orders', { mode: 'receiveAndDelete' }))[0].body.n, 1);
});

test('send is idempotent by messageId while the bus holds the message', async () => {
  const { bus } = busFixture();
  const first = await bus.send('fx-orders', { n: 1 }, { messageId: 'dup' });
  const again = await bus.send('fx-orders', { n: 2 }, { messageId: 'dup' });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.body.n, 1);
  assert.equal(bus.peek('fx-orders', { max: 10 }).length, 1);
  await assert.rejects(bus.send('fx-orders/$deadletterqueue', {}), (error) => error.code === 'InvalidEntity');
  await assert.rejects(bus.send('fx-orders', undefined), (error) => error.code === 'InvalidRequest');
});

test('messages survive a restart through the store state, and a rolled-back transaction keeps none', async () => {
  const { store, bus, clock } = busFixture();
  await bus.send('fx-orders', { n: 1 }, { messageId: 'keep' });
  const [locked] = await bus.receive('fx-orders');
  await assert.rejects(store.transact(async () => { await bus.send('fx-orders', { n: 2 }, { nested: true }); throw new Error('invented rollback'); }, { incremental: true }), /invented rollback/);
  const snapshot = store.snapshot();
  assert.ok(snapshot.mappings[QUEUE_MESSAGE_TABLE], 'internal mapping is registered');
  assert.equal(snapshot.mappings[QUEUE_MESSAGE_TABLE].entitySet, undefined, 'internal table has no entity set');

  const restarted = new DataStore({ state: snapshot });
  const again = createLocalMessageBus({ store: restarted, clock, lockDurationMs: 30_000, retry: { maxAttempts: 5 } });
  assert.deepEqual(again.peek('fx-orders').map((message) => [message.messageId, message.state]), [['keep', 'locked']]);
  clock.advance(30_000);
  const [redelivered] = await again.receive('fx-orders');
  assert.equal(redelivered.messageId, 'keep');
  assert.equal(redelivered.deliveryCount, locked.deliveryCount + 1);
});

test('receive waits for a message sent during waitMs', async () => {
  const { bus } = busFixture();
  setTimeout(() => bus.send('fx-orders', { n: 7 }), 30);
  const [message] = await bus.receive('fx-orders', { mode: 'receiveAndDelete', waitMs: 2000 });
  assert.equal(message.body.n, 7);
});

test('descriptors declare the local bus and the core emulator transport as behaviour', () => {
  assert.equal(localMessageBusDescriptor.name, 'message-bus:local');
  assert.equal(localMessageBusDescriptor.level, 'behaviour');
  assert.deepEqual(localMessageBusDescriptor.capabilities, { ordering: 'fifo-per-entity', redelivery: true, deadLetter: true, sessions: false, scheduled: true });
  assert.equal(localMessageBusDescriptor.stateOwner, `store:tables.${QUEUE_MESSAGE_TABLE}`);
  assert.equal(serviceBusEmulatorDescriptor.kind, 'servicebus-emulator');
  assert.equal(serviceBusEmulatorDescriptor.level, 'behaviour');
  assert.ok(serviceBusEmulatorDescriptor.requires.includes('external-process:servicebus-emulator'));
  const sources = serviceBusEmulatorDescriptor.fidelity.sources;
  assert.ok(sources.length > 0 && sources.every((url) => url.startsWith('https://learn.microsoft.com/')), sources.join());
});

test('emulator preflight refuses non-emulator and non-loopback endpoints without contacting them', async () => {
  const secret = 'SharedAccessKey=invented-key-value';
  const missing = await serviceBusEmulatorPreflight({});
  assert.equal(missing.diagnostics[0].code, 'SERVICEBUS_EMULATOR_CONNECTION_MISSING');
  const cloud = await serviceBusEmulatorPreflight({ connectionString: `Endpoint=sb://fx.example.test;${secret}` });
  assert.equal(cloud.diagnostics[0].code, 'SERVICEBUS_EMULATOR_NOT_DEVELOPMENT');
  const remote = await serviceBusEmulatorPreflight({ connectionString: `Endpoint=sb://fx.example.test;${secret};UseDevelopmentEmulator=true;` });
  assert.equal(remote.diagnostics[0].code, 'SERVICEBUS_EMULATOR_NOT_LOOPBACK');
  assert.equal(remote.reachable, false);
  for (const result of [missing, cloud, remote]) {
    assert.equal(result.ready, false);
    assert.doesNotMatch(JSON.stringify(result), /invented-key-value/);
  }
});

test('a nested receive refuses waitMs but keeps waitMs 0 working inside a transaction', async () => {
  const { store, bus } = busFixture();
  await bus.send('fx-orders', { n: 1 });
  await store.transact(async () => {
    await assert.rejects(bus.receive('fx-orders', { nested: true, waitMs: 50 }), (error) => error.status === 400 && error.code === 'InvalidRequest');
    const [message] = await bus.receive('fx-orders', { nested: true, waitMs: 0 });
    assert.equal(message.deliveryCount, 1);
  });
});

test('emulator preflight reports an invalid healthPort instead of a loopback refusal', async () => {
  const connectionString = 'Endpoint=sb://localhost;UseDevelopmentEmulator=true';
  for (const healthPort of ['x', NaN, 0, 65536, 5300.5]) {
    const result = await serviceBusEmulatorPreflight({ connectionString, healthPort });
    assert.deepEqual(result.diagnostics.map((item) => item.code), ['SERVICEBUS_EMULATOR_PORT_INVALID']);
    assert.equal(result.ready, false);
  }
});

test('emulator preflight probes the loopback health endpoint', async (t) => {
  const server = http.createServer((request, response) => { response.statusCode = request.url === '/health' ? 200 : 404; response.end('ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const connectionString = 'Endpoint=sb://127.0.0.1;SharedAccessKeyName=x;SharedAccessKey=invented-key-value;UseDevelopmentEmulator=true;';
  const healthy = await serviceBusEmulatorPreflight({ connectionString, healthPort: server.address().port });
  assert.equal(healthy.ready, true);
  assert.equal(healthy.reachable, true);
  assert.equal(healthy.endpoint, 'sb://127.0.0.1');
  assert.doesNotMatch(JSON.stringify(healthy), /invented-key-value/);
  const closedPort = await new Promise((resolve) => { const probe = http.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const down = await serviceBusEmulatorPreflight({ connectionString, healthPort: closedPort, timeoutMs: 1000 });
  assert.equal(down.ready, false);
  assert.ok(down.diagnostics.some((item) => item.code === 'SERVICEBUS_EMULATOR_UNREACHABLE'));
});

test('messagingSettings normalises providers and rejects literal credentials', () => {
  const settings = messagingSettings({
    queue: { kind: 'local-queue', retry: { maxAttempts: 3, backoffMs: [100, 1000] } },
    emulator: { kind: 'servicebus-emulator', connectionString: 'env:FX_SB_EMULATOR' },
    endpoints: { 'fx-endpoint': 'queue/fx-orders' },
  });
  assert.deepEqual(settings.queue.retry, { maxAttempts: 3, backoffMs: [100, 1000], deadLetter: true });
  assert.deepEqual(settings.local, { kind: 'local-queue', retry: { maxAttempts: 1, backoffMs: [], deadLetter: true } });
  assert.equal(settings.endpoints['fx-endpoint'], 'queue/fx-orders');
  assert.throws(() => messagingSettings({ emulator: { kind: 'servicebus-emulator', connectionString: 'Endpoint=sb://localhost;SharedAccessKey=invented' } }),
    (error) => /env:NAME/.test(error.message) && !error.message.includes('invented'));
  assert.throws(() => messagingSettings({ queue: { kind: 'kafka' } }), /kind/);
  assert.throws(() => messagingSettings({ queue: { kind: 'local-queue', extra: 1 } }), /Unknown providers.messaging.queue key/);
  assert.throws(() => messagingSettings({ endpoints: { x: 'missing/fx-orders' } }), /declared messaging provider/);
  assert.throws(() => messagingSettings({ queue: { kind: 'local-queue', retry: { maxAttempts: 0 } } }), /maxAttempts/);
});

test('receive and complete with nested: true join a caller transaction', async () => {
  const { store, bus } = busFixture();
  await bus.send('fx-orders', { n: 1 });
  await store.transact(async () => {
    const [message] = await bus.receive('fx-orders', { nested: true });
    assert.equal(message.deliveryCount, 1);
    assert.equal(await bus.complete(message.lockToken, { nested: true }), true);
  });
  assert.deepEqual(bus.peek('fx-orders'), []);
});

test('a rolled-back caller transaction leaves a nested receive undone', async () => {
  const { store, bus } = busFixture();
  await bus.send('fx-orders', { n: 1 });
  await assert.rejects(store.transact(async () => {
    await bus.receive('fx-orders', { nested: true });
    throw new Error('invented rollback');
  }), /invented rollback/);
  const [pending] = bus.peek('fx-orders');
  assert.equal(pending.deliveryCount, 0);
  assert.equal(pending.state, 'active');
  const [again] = await bus.receive('fx-orders');
  assert.equal(again.deliveryCount, 1);
});
