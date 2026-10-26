// The servicebus-emulator bus (message-bus.mjs createServiceBusEmulatorBus over amqp-client.mjs) against the test-only loopback
// fake broker (mirage/testing/amqp-fake-broker.mjs): the same send/receive/complete/abandon/deadLetter contract as the local bus.
// A run against the real emulator is a manual check (mirage/docs/messaging-and-outbox.md), not part of CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import diagnosticsChannel from 'node:diagnostics_channel';
import { once } from 'node:events';
import net from 'node:net';
import {
  createServiceBusEmulatorBus,
  messagingSettings,
  mappedEntities,
  serviceBusEmulatorDescriptor,
} from '../lib/message-bus.mjs';
import { startFakeBroker } from '../testing/amqp-fake-broker.mjs';

const KEY = 'invented-key-7f3a9c';
const env = (key = KEY, host = '127.0.0.1') => ({
  FX_SB: `Endpoint=sb://${host};SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${key};UseDevelopmentEmulator=true;`,
});

async function fixture(t, { broker: brokerOptions = {}, bus: busOptions = {} } = {}) {
  const broker = await startFakeBroker({
    key: KEY,
    queues: ['fx-orders'],
    topics: { 'fx-events': ['fx-audit'] },
    maxDeliveryCount: 2,
    ...brokerOptions,
  });
  const bus = createServiceBusEmulatorBus({
    id: 'emulator',
    settings: { connectionString: 'env:FX_SB', amqpPort: broker.port },
    env: env(),
    timeoutMs: 2000,
    ...busOptions,
  });
  t.after(async () => {
    await bus.close();
    await broker.close();
  });
  return { broker, bus };
}

test('send, peek-lock receive and complete round-trip body, properties and messageId', async (t) => {
  const { broker, bus } = await fixture(t);
  const sent = await bus.send(
    'fx-orders',
    { x_name: 'fx', n: 1 },
    { messageId: 'fx-message-1', properties: { x_table: 'x_item', n: 2 } },
  );
  assert.equal(sent.messageId, 'fx-message-1');
  assert.equal(sent.duplicate, null, 'the sender cannot observe Service Bus duplicate detection');
  assert.equal(broker.count('fx-orders'), 1);
  const [message] = await bus.receive('fx-orders');
  assert.deepEqual(message.body, { x_name: 'fx', n: 1 });
  assert.deepEqual(message.properties, { x_table: 'x_item', n: 2 });
  assert.equal(message.messageId, 'fx-message-1');
  assert.equal(message.deliveryCount, 1);
  assert.equal(message.state, 'locked');
  assert.match(message.lockToken, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(typeof message.sequenceNumber, 'number');
  assert.ok(message.lockedUntil && message.enqueuedTime);
  assert.deepEqual(await bus.receive('fx-orders'), [], 'a locked message is not delivered again');
  assert.equal(await bus.complete(message.lockToken), true);
  await settled(bus);
  assert.equal(broker.count('fx-orders'), 0);
  await assert.rejects(
    bus.complete(message.lockToken),
    (error) => error.code === 'MessageLockLost' && error.status === 410,
  );
  await assert.rejects(bus.complete('77777777-7777-4777-8777-777777777777'), { code: 'MessageLockLost' });
});

test('AMQP map keys preserve constructor and prototype-shaped application properties as data', async (t) => {
  const { bus } = await fixture(t);
  const properties = Object.fromEntries([
    ['__proto__', 'owned value'],
    ['constructor', 'constructor value'],
    ['toString', 'text value'],
  ]);
  await bus.send('fx-orders', { x_name: 'Prototype-shaped keys' }, { properties });
  const [message] = await bus.receive('fx-orders');
  assert.deepEqual(message.properties, properties);
  assert.equal(Object.getPrototypeOf(message.properties), Object.prototype);
  assert.equal(Object.hasOwn(message.properties, '__proto__'), true);
  await bus.complete(message.lockToken);
});

test('abandon redelivers with a higher delivery count and the broker dead-letters at its MaxDeliveryCount', async (t) => {
  const { bus } = await fixture(t);
  await bus.send('fx-orders', { n: 1 });
  const [first] = await bus.receive('fx-orders');
  await bus.abandon(first.lockToken);
  const [second] = await bus.receive('fx-orders', { waitMs: 500 });
  assert.equal(second.deliveryCount, 2);
  assert.notEqual(second.lockToken, first.lockToken);
  await bus.abandon(second.lockToken);
  assert.deepEqual(await bus.receive('fx-orders'), []);
  const [dead] = await bus.receive('fx-orders/$deadletterqueue', { mode: 'receiveAndDelete', waitMs: 500 });
  assert.equal(dead.state, 'deadLettered');
  assert.equal(dead.deadLetterReason, 'MaxDeliveryCountExceeded');
  assert.equal(dead.lockToken, null);
  assert.deepEqual(dead.body, { n: 1 });
});

test('an explicit dead-letter keeps reason and description; a dead-lettered message cannot be dead-lettered again', async (t) => {
  const { bus } = await fixture(t);
  await bus.send('fx-orders', { n: 2 });
  const [message] = await bus.receive('fx-orders');
  await bus.deadLetter(message.lockToken, { reason: 'x_invalid', description: 'Invented failure' });
  const [dead] = await bus.receive('fx-orders/$deadletterqueue', { waitMs: 500 });
  assert.equal(dead.deadLetterReason, 'x_invalid');
  assert.equal(dead.deadLetterDescription, 'Invented failure');
  assert.deepEqual(dead.properties, {}, 'reason fields are not application properties of the view');
  await assert.rejects(bus.deadLetter(dead.lockToken), { code: 'InvalidOperation' });
  assert.equal(await bus.complete(dead.lockToken), true);
});

test('a topic send reaches its subscription; receive-and-delete removes on delivery', async (t) => {
  const { broker, bus } = await fixture(t);
  await bus.send('fx-events', { n: 3 });
  const [message] = await bus.receive('fx-events/subscriptions/fx-audit', { mode: 'receiveAndDelete', waitMs: 500 });
  assert.deepEqual(message.body, { n: 3 });
  assert.equal(message.lockToken, null);
  assert.equal(broker.count('fx-events/subscriptions/fx-audit'), 0);
});

test('receive waits up to waitMs for a message sent later, and drains when nothing is available', async (t) => {
  // The client bound is far beyond a loopback round trip, so an answer inside half of it can only be the drain answer.
  const timeoutMs = 30_000;
  const { bus } = await fixture(t, { bus: { timeoutMs } });
  const started = Date.now();
  assert.deepEqual(await bus.receive('fx-orders', { maxMessages: 5 }), []);
  assert.ok(Date.now() - started < timeoutMs / 2, 'waitMs 0 answers after a drain, not after a timeout');
  // The receiver link is attached, so this receive writes its credit at once; the send's transfer follows its sender
  // attach round trip, so the message reaches the broker only while the receive waits.
  const waiting = bus.receive('fx-orders', { waitMs: timeoutMs });
  await bus.send('fx-orders', { n: 4 });
  const [message] = await waiting;
  assert.deepEqual(message.body, { n: 4 });
});

test('a message larger than the broker frame size crosses as a multi-frame transfer both ways', async (t) => {
  const { bus } = await fixture(t, { broker: { maxFrameSize: 1024 } });
  const text = 'x'.repeat(10_000);
  await bus.send('fx-orders', { text });
  const [message] = await bus.receive('fx-orders', { waitMs: 500 });
  assert.equal(message.body.text, text);
  await assert.rejects(bus.send('fx-orders', { text: 'x'.repeat(300_000) }), { code: 'TooLarge' });
});

test('a scheduled message carries x-opt-scheduled-enqueue-time and stays invisible until due', async (t) => {
  const { broker, bus } = await fixture(t);
  // An hour ahead stays invisible however slow the runner; a second message due shortly shows delivery once due.
  const later = new Date(Date.now() + 3_600_000);
  const sent = await bus.send('fx-orders', { n: 5 }, { scheduledEnqueueTime: later });
  assert.equal(sent.state, 'scheduled');
  assert.deepEqual(await bus.receive('fx-orders'), []);
  const soon = new Date(Date.now() + 200);
  await bus.send('fx-orders', { n: 6 }, { scheduledEnqueueTime: soon });
  const [message] = await bus.receive('fx-orders', { waitMs: 30_000 });
  assert.ok(Date.now() >= soon.getTime(), 'not delivered before its scheduled enqueue time');
  assert.deepEqual(message.body, { n: 6 });
  assert.equal(message.scheduledEnqueueTime, soon.toISOString());
  assert.equal(broker.count('fx-orders'), 2, 'the message scheduled later is still held');
});

test('an unknown entity is the broker AMQP error, named by entity', async (t) => {
  const { bus } = await fixture(t);
  await assert.rejects(
    bus.send('fx-missing', { n: 1 }),
    (error) => error.code === 'NotFound' && error.diagnostic === 'amqp:not-found' && /fx-missing/.test(error.message),
  );
  await assert.rejects(bus.receive('fx-missing/subscriptions/x'), { code: 'NotFound' });
  await bus.send('fx-orders', { n: 1 }); // the connection stays usable after a refused link
});

test('a wrong key fails SASL PLAIN by name and never echoes the key', async (t) => {
  const { broker, bus } = await fixture(t, { bus: { env: env('wrong-invented-key') } });
  const error = await bus.send('fx-orders', { n: 1 }).then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error.code, 'Unauthorized');
  assert.equal(error.diagnostic, 'SASL_AUTH_FAILED');
  assert.match(error.message, /SASL PLAIN/);
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /wrong-invented-key|invented-key-7f3a9c/);
  assert.equal(broker.stats.saslFailures, 1);
});

test('preflight opens a connection and a link to each configured entity within the bound', async (t) => {
  const { broker } = await fixture(t);
  const make = (entities, source = env()) =>
    createServiceBusEmulatorBus({
      id: 'emulator',
      settings: { connectionString: 'env:FX_SB', amqpPort: broker.port },
      entities,
      env: source,
    });
  assert.deepEqual(await make(['fx-orders', 'fx-events']).preflight(), { ready: true, reason: null });
  const missing = await make(['fx-orders', 'fx-missing']).preflight();
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /fx-missing/);
  const unset = await make(['fx-orders'], {}).preflight();
  assert.deepEqual(unset, { ready: false, reason: 'Environment variable FX_SB is not set.' });
  assert.equal(
    (await make([]).preflight({ env: env('wrong-invented-key') })).ready,
    false,
    'an env override applies to this probe',
  );
  const remote = await make([], env(KEY, 'fx.example.test')).preflight();
  assert.equal(remote.ready, false);
  assert.match(remote.reason, /must be localhost/);
  for (const result of [missing, unset, remote]) assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
});

test('preflight against a silent port answers not ready at its 1.8 s connect bound', async (t) => {
  const silent = net.createServer((socket) => socket.resume()); // accepts TCP and never answers the protocol header
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        silent.close(resolve);
      }),
  );
  const bus = createServiceBusEmulatorBus({
    settings: { connectionString: 'env:FX_SB', amqpPort: silent.address().port },
    env: env(),
  });
  const started = Date.now();
  const result = await bus.preflight();
  assert.deepEqual(result, {
    ready: false,
    reason: 'The Service Bus emulator did not answer within the 1800 ms bound.',
  });
  // The bound is the connect abort; the slack only absorbs a loaded runner's timer lag.
  assert.ok(Date.now() - started < 4000);
});

test('the client keeps an idle connection alive with empty frames inside the broker idle-time-out', async (t) => {
  // The keepalive interval is a mock timer; a later round trip orders after the empty frames it wrote.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { broker, bus } = await fixture(t, { broker: { idleTimeoutMs: 100 } });
  await bus.send('fx-orders', { n: 1 });
  assert.equal(broker.stats.heartbeats, 0);
  t.mock.timers.tick(100);
  await bus.send('fx-orders', { n: 2 });
  assert.equal(broker.stats.heartbeats, 2, 'one empty frame every half of the 100 ms idle-time-out');
});

test('a dropped connection loses its locks and the next operation reconnects', async (t) => {
  const sockets = [],
    track = ({ socket }) => sockets.push(socket);
  diagnosticsChannel.subscribe('net.client.socket', track);
  t.after(() => diagnosticsChannel.unsubscribe('net.client.socket', track));
  const { broker, bus } = await fixture(t);
  await bus.send('fx-orders', { n: 1 });
  const [message] = await bus.receive('fx-orders');
  assert.equal(sockets.length, 1);
  const closed = once(sockets[0], 'close'); // runs after the client's own close listener, which fails the connection
  broker.dropConnections();
  await closed;
  await assert.rejects(bus.complete(message.lockToken), { code: 'MessageLockLost' });
  await bus.send('fx-orders', { n: 2 });
  assert.equal(broker.stats.connections, 2);
});

test("the client puts attach, flow, transfer and disposition fields at their spec positions (read by the broker's own codec)", async (t) => {
  const { broker, bus } = await fixture(t);
  await bus.send('fx-orders', { n: 1 });
  const [message] = await bus.receive('fx-orders');
  await bus.abandon(message.lockToken);
  const [again] = await bus.receive('fx-orders', { waitMs: 500 });
  await bus.complete(again.lockToken);
  await settled(bus);
  assert.equal(broker.count('fx-orders'), 0);
  const of = (code) => broker.frames.filter((item) => item.code === code).map((item) => item.fields);
  const [sender, receiver] = of(0x12);
  assert.equal(sender[2], false, 'attach role sender');
  assert.equal(sender[3], 0, 'snd-settle-mode unsettled');
  assert.equal(sender[6].d, 0x29);
  assert.equal(sender[6].v[0], 'fx-orders', 'target address');
  assert.equal(sender[9], 0, 'initial-delivery-count');
  assert.equal(receiver[2], true, 'attach role receiver');
  assert.equal(receiver[5].d, 0x28);
  assert.equal(receiver[5].v[0], 'fx-orders', 'source address');
  const [transfer] = of(0x14);
  assert.equal(transfer.length, 6);
  assert.deepEqual(
    [typeof transfer[0], transfer[1], transfer[2].length, transfer[3], transfer[4], transfer[5]],
    ['number', 0, 16, 0, false, false],
  );
  const flow = of(0x13).find((fields) => fields[6] === 1);
  assert.equal(flow[4], 1, 'flow handle of the receiver link');
  assert.equal(flow[8], false, 'drain flag position');
  const dispositions = of(0x15);
  assert.deepEqual(
    dispositions.map((fields) => [fields[0], fields[1] === fields[2], fields[3], fields[4].d]),
    [
      [true, true, true, 0x27],
      [true, true, true, 0x24],
    ],
  );
  assert.deepEqual(
    dispositions[0][4].v,
    [true, false],
    'abandon: modified with delivery-failed true, undeliverable-here false',
  );
  assert.equal(again.deliveryCount, 2, 'the abandon raised the delivery count');
});

test('a connection reset while a message is in flight fails that send naming the closed connection; the next send reconnects', async (t) => {
  const { broker, bus } = await fixture(t, { broker: { maxFrameSize: 1024 } });
  await bus.send('fx-orders', { n: 1 });
  const sending = bus.send('fx-orders', { text: 'x'.repeat(200_000) });
  setImmediate(() => broker.dropConnections());
  const error = await sending.then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error?.diagnostic, 'AMQP_CONNECTION_CLOSED');
  assert.match(error.message, /'fx-orders' was not settled: The Service Bus emulator closed the connection/);
  assert.doesNotMatch(error.message, /not reachable/);
  await bus.send('fx-orders', { n: 2 });
});

test('settings, descriptor and entity mapping for servicebus-emulator', () => {
  const settings = messagingSettings({
    emulator: { kind: 'servicebus-emulator', connectionString: 'env:FX_SB', amqpPort: 5673 },
    endpoints: { a: 'emulator/fx-orders', b: 'emulator/fx-events', c: 'local/x' },
  });
  assert.equal(settings.emulator.amqpPort, 5673);
  assert.deepEqual(mappedEntities(settings, 'emulator'), ['fx-orders', 'fx-events']);
  assert.throws(
    () =>
      messagingSettings({
        emulator: { kind: 'servicebus-emulator', connectionString: 'env:FX_SB', retry: { maxAttempts: 2 } },
      }),
    /Unknown providers.messaging.emulator key 'retry'/,
  );
  assert.throws(
    () => messagingSettings({ emulator: { kind: 'servicebus-emulator', connectionString: 'env:FX_SB', amqpPort: 0 } }),
    /amqpPort/,
  );
  assert.equal(serviceBusEmulatorDescriptor.level, 'behaviour');
  assert.ok(!serviceBusEmulatorDescriptor.operations.includes('peek'));
  assert.ok(serviceBusEmulatorDescriptor.fidelity.notes.some((note) => /WebSockets/.test(note)));
  assert.throws(
    () => createServiceBusEmulatorBus({ settings: { connectionString: 'Endpoint=sb://localhost;SharedAccessKey=x' } }),
    /env:NAME/,
  );
});

// A receiver's settlement has no answer; a drain round trip on the same connection orders after it, so once the drain
// returns the broker has applied every disposition sent before.
async function settled(bus) {
  assert.deepEqual(await bus.receive('fx-orders'), []);
}
