// @test-kind contract: service bus emulator adapter preserves its messaging and reconnect contract against a loopback broker
// The servicebus-emulator bus (message-bus.mjs createServiceBusEmulatorBus over amqp-client.mjs) against the test-only loopback
// fake broker (mirage/testing/amqp-fake-broker.mjs): the same send/receive/complete/abandon/deadLetter contract as the local bus.
// A run against the real emulator is a manual check (mirage/docs/messaging-and-outbox.md), not part of CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import diagnosticsChannel from 'node:diagnostics_channel';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import {
  createServiceBusEmulatorBus,
  messagingSettings,
  mappedEntities,
  serviceBusEmulatorDescriptor,
  serviceBusEmulatorPreflight,
} from '../lib/message-bus.mjs';
import { providerRequirements } from '../lib/organization-host.mjs';
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
    timeoutMs: 30_000,
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
  const [second] = await bus.receive('fx-orders', { waitMs: 30_000 });
  assert.equal(second.deliveryCount, 2);
  assert.notEqual(second.lockToken, first.lockToken);
  await bus.abandon(second.lockToken);
  assert.deepEqual(await bus.receive('fx-orders'), []);
  const [dead] = await bus.receive('fx-orders/$deadletterqueue', { mode: 'receiveAndDelete', waitMs: 30_000 });
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
  const [dead] = await bus.receive('fx-orders/$deadletterqueue', { waitMs: 30_000 });
  assert.equal(dead.deadLetterReason, 'x_invalid');
  assert.equal(dead.deadLetterDescription, 'Invented failure');
  assert.deepEqual(dead.properties, {}, 'reason fields are not application properties of the view');
  await assert.rejects(bus.deadLetter(dead.lockToken), { code: 'InvalidOperation' });
  assert.equal(await bus.complete(dead.lockToken), true);
});

test('a topic send reaches its subscription; receive-and-delete removes on delivery', async (t) => {
  const { broker, bus } = await fixture(t);
  await bus.send('fx-events', { n: 3 });
  const [message] = await bus.receive('fx-events/subscriptions/fx-audit', { mode: 'receiveAndDelete', waitMs: 30_000 });
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
  const [message] = await bus.receive('fx-orders', { waitMs: 30_000 });
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

test('preflight against a silent port answers not ready when the shared idle window ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  const accepted = once(silent, 'connection');
  const probe = bus.preflight();
  await accepted;
  t.mock.timers.tick(30_000); // the shared idle window of a probe without a caller bound
  assert.deepEqual(await probe, {
    ready: false,
    reason: 'The Service Bus emulator did not answer before the probe ended.',
  });
});

test('closing the bus waits for a preflight probe that is still in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const silent = net.createServer((socket) => socket.resume()); // accepts TCP and never answers the protocol header
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const bus = createServiceBusEmulatorBus({
    settings: { connectionString: 'env:FX_SB', amqpPort: silent.address().port },
    env: env(),
  });
  const accepted = once(silent, 'connection');
  const order = [];
  const probe = bus.preflight().then(() => order.push('probe'));
  const [socket] = await accepted;
  t.after(
    () =>
      new Promise((resolve) => {
        socket.destroy();
        silent.close(resolve);
      }),
  );
  const closing = bus.close().then(() => order.push('closed'));
  // only an event this test controls can settle it: one turn lets a version that does not wait run past its wait
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'close waits for the probe in flight');
  t.mock.timers.tick(30_000); // the shared idle window of a probe without a caller bound
  await Promise.all([probe, closing]);
  assert.deepEqual(order, ['probe', 'closed']);
});

const STEP_MS = 20_000;

// A loopback relay between the bus and the fake broker. Broker bytes pass straight through. Each client request is
// held on a mock timer for STEP_MS and released only when the test ticks the clock, so one protocol step takes one
// tick: the client writes one request per step and waits for its answer. A silent relay passes requests on and drops
// every broker answer. Events: 'client-data' for each client write, 'held' for each held request, 'broker-end' when
// the broker's side of a closed connection ends.
async function holdingRelay(t, brokerPort, { silent = false } = {}) {
  const events = new EventEmitter();
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: '127.0.0.1', port: brokerPort });
    sockets.add(client).add(upstream);
    client.on('error', () => {});
    upstream.on('error', () => {});
    client.on('data', (chunk) => {
      events.emit('client-data');
      if (silent) {
        upstream.write(chunk);
        return;
      }
      setTimeout(() => {
        if (!upstream.destroyed) upstream.write(chunk);
      }, STEP_MS);
      events.emit('held');
    });
    upstream.on('data', (chunk) => {
      if (!silent && !client.destroyed) client.write(chunk);
    });
    upstream.on('end', () => events.emit('broker-end'));
    client.on('close', () => upstream.end());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, events };
}

// The bus probe as the host runs it (providerRequirements), with the bus reaching the fake broker through the relay.
async function probeThroughRelay(t, { silent = false } = {}) {
  const broker = await startFakeBroker({ key: KEY, queues: ['fx-orders'], topics: { 'fx-events': ['fx-audit'] } });
  t.after(() => broker.close());
  const relay = await holdingRelay(t, broker.port, { silent });
  const bus = createServiceBusEmulatorBus({
    id: 'emulator',
    settings: { connectionString: 'env:FX_SB', amqpPort: relay.port },
    entities: ['fx-orders', 'fx-events'],
    env: env(),
  });
  t.after(() => bus.close());
  const providers = {
    messaging: {
      settings: { emulator: { kind: 'servicebus-emulator', connectionString: 'env:FX_SB' } },
      buses: { emulator: bus },
    },
  };
  return { relay, rows: providerRequirements({ providers, env: env() }) };
}

// Ticks the mock clock once per held request until the probe settles; returns the mocked time the probe ran for.
async function releaseEachAnswer(t, events, rows) {
  let elapsed = 0;
  for (;;) {
    const answered = await Promise.race([once(events, 'held').then(() => true), rows.then(() => false)]);
    if (!answered) return elapsed;
    t.mock.timers.tick(STEP_MS);
    elapsed += STEP_MS;
  }
}

test('a broker answering each protocol step 20 s apart is ready: each completed step resets the idle guard', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { relay, rows } = await probeThroughRelay(t);
  const elapsed = await releaseEachAnswer(t, relay.events, rows);
  const [row] = await rows;
  assert.equal(row.reachable, true, row.message);
  assert.ok(
    elapsed > 30_000,
    `the probe ran ${elapsed} ms of mocked time, past the 30 s idle window, on progress alone`,
  );
});

test('a broker that accepts the socket and never answers ends the probe at the idle guard, and the socket closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { relay, rows } = await probeThroughRelay(t, { silent: true });
  let settled = false;
  rows.then(() => {
    settled = true;
  });
  await once(relay.events, 'client-data');
  const brokerEnded = once(relay.events, 'broker-end');
  t.mock.timers.tick(29_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the probe waits for the idle window, not for a shorter bound');
  t.mock.timers.tick(1_000);
  const [row] = await rows;
  assert.equal(row.status, 'unknown');
  assert.equal(row.reason, 'PROVIDER_PREFLIGHT_TIMEOUT');
  assert.match(row.message, /did not answer its readiness probe: The provider gave no answer for 30000 ms\./);
  await brokerEnded;
});

test('the emulator health probe with the default is ended by the idle window at 30 s, not by a 2 s bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = new Set();
  const silent = net.createServer((socket) => sockets.add(socket)); // accepts, never answers
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  });
  const requested = new Promise((resolve) => silent.once('connection', (socket) => socket.once('data', resolve)));
  let settled = false;
  const probe = serviceBusEmulatorPreflight({ connectionString: env().FX_SB, healthPort: silent.address().port }).then(
    (result) => {
      settled = true;
      return result;
    },
  );
  await requested;
  t.mock.timers.tick(29_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the idle window has not ended one millisecond early');
  t.mock.timers.tick(1);
  const result = await probe;
  assert.equal(result.reachable, false);
  assert.equal(result.diagnostics[0].code, 'SERVICEBUS_EMULATOR_UNREACHABLE');
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
  const [again] = await bus.receive('fx-orders', { waitMs: 30_000 });
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
  let observedTransfer;
  const transfer = new Promise((resolve) => {
    observedTransfer = resolve;
  });
  const originalPush = broker.frames.push;
  broker.frames.push = function (...frames) {
    const length = originalPush.apply(this, frames);
    const first = frames.find((frame) => frame.code === 0x14 && frame.fields[5] === true);
    if (first) {
      broker.frames.push = originalPush;
      observedTransfer(first);
      // Disconnect before the broker handles this unfinished transfer or settles the send.
      broker.dropConnections();
    }
    return length;
  };
  t.after(() => {
    broker.frames.push = originalPush;
  });
  const sending = bus.send('fx-orders', { text: 'x'.repeat(200_000) });
  const first = await Promise.race([
    transfer,
    sending.then(() => {
      throw new Error('send settled before an unfinished transfer was observed');
    }),
  ]);
  assert.equal(first.fields[4], false, 'transfer is unsettled');
  assert.equal(first.fields[5], true, 'transfer has more frames');
  const error = await sending.then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error?.diagnostic, 'AMQP_CONNECTION_CLOSED');
  assert.match(error.message, /'fx-orders' was not settled: The Service Bus emulator closed the connection/);
  assert.doesNotMatch(error.message, /not reachable/);
  await bus.send('fx-orders', { n: 2 });
});

// Raw client bytes for the broker's framing checks, encoded here rather than through amqp-client.mjs.
const SASL_HEADER_BYTES = Buffer.from('AMQP\x03\x01\x00\x00', 'latin1');
const AMQP_HEADER_BYTES = Buffer.from('AMQP\x00\x01\x00\x00', 'latin1');
const OPEN_EMPTY = Buffer.from([0x00, 0x53, 0x10, 0x45]);
const rawFrame = (type, body) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header[4] = 2;
  header[5] = type;
  return Buffer.concat([header, body]);
};
// sasl-init (security 5.3.3.2): PLAIN with the broker's default rule name and the invented key.
const saslInit = (key) => {
  const initialResponse = Buffer.from(`\0RootManageSharedAccessKey\0${key}`);
  const items = Buffer.concat([
    Buffer.from([0xa3, 5]),
    Buffer.from('PLAIN'),
    Buffer.from([0xa0, initialResponse.length]),
    initialResponse,
  ]);
  return rawFrame(1, Buffer.concat([Buffer.from([0x00, 0x53, 0x41, 0xc0, items.length + 1, 2]), items]));
};
function rawClient(port) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => socket.destroy());
  let received = Buffer.alloc(0);
  let wake = () => {};
  socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk]);
    wake();
  });
  return {
    socket,
    received: () => received,
    // Resolves once the bytes received so far contain text; the wait is an event, not a timer.
    async until(text) {
      while (!received.includes(text)) await new Promise((resolve) => (wake = resolve));
    },
  };
}

test('a client frame larger than the broker max-frame-size is refused with framing-error and the connection closes', async (t) => {
  const broker = await startFakeBroker({ key: KEY, queues: ['fx-orders'], maxFrameSize: 1024 });
  t.after(() => broker.close());
  const client = rawClient(broker.port);
  client.socket.write(Buffer.concat([SASL_HEADER_BYTES, saslInit(KEY), AMQP_HEADER_BYTES, rawFrame(0, OPEN_EMPTY)]));
  await client.until('fake-broker');
  // An empty end performative padded to 1100 bytes, above the 1024 the broker announced in its open.
  const oversize = rawFrame(0, Buffer.concat([Buffer.from([0x00, 0x53, 0x17, 0x45]), Buffer.alloc(1088)]));
  client.socket.write(oversize);
  await client.until('amqp:connection:framing-error');
  assert.ok(
    client.received().includes('amqp:connection:framing-error'),
    'the broker answers the oversize frame with a close',
  );
  await once(client.socket, 'close');
  assert.equal(broker.stats.protocolErrors, 1);
});

test('an undecodable frame closes its connection with amqp:decode-error and the test process survives', async (t) => {
  const broker = await startFakeBroker({ key: KEY, queues: ['fx-orders'], maxFrameSize: 1024 });
  t.after(() => broker.close());
  const client = rawClient(broker.port);
  // sasl-init whose initial-response is a value code no AMQP 1.0 type uses.
  client.socket.write(
    Buffer.concat([SASL_HEADER_BYTES, rawFrame(1, Buffer.from([0x00, 0x53, 0x41, 0xc0, 0x03, 0x01, 0xff, 0x01]))]),
  );
  await once(client.socket, 'close');
  assert.ok(client.received().includes('amqp:decode-error'), 'the broker names the decode error in its close');
  assert.equal(broker.stats.protocolErrors, 1);
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

// A loopback listener standing in for the emulator port. It counts connections and resolves firstBytes with the first
// eight bytes a client sends, then drops that connection. The listener closes with the test.
async function emulatorListener(t) {
  let connections = 0;
  let received;
  const firstBytes = new Promise((resolve) => {
    received = resolve;
  });
  const listener = net.createServer((socket) => {
    connections += 1;
    socket.once('data', (chunk) => {
      received(chunk.subarray(0, 8));
      socket.destroy();
    });
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return {
    port: listener.address().port,
    firstBytes,
    get connections() {
      return connections;
    },
  };
}

// A bus whose endpoint host is bus.localhost, with the DNS answer supplied by the test.
const busFor = (port, lookup) =>
  createServiceBusEmulatorBus({
    settings: { connectionString: 'env:FX_SB', amqpPort: port },
    env: env(KEY, 'bus.localhost'),
    lookup,
  });

// @test-kind security: the emulator transport opens a socket only to an address the loopback check accepts for the endpoint name
test('an endpoint name under localhost that resolves to a routable address is refused before any connection', async (t) => {
  const listener = await emulatorListener(t);
  const asked = [];
  const bus = busFor(listener.port, async (host) => {
    asked.push(host);
    return [
      { address: '127.0.0.1', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
  });
  await assert.rejects(bus.send('fx-orders', 'x'), (error) => error.diagnostic === 'SERVICEBUS_EMULATOR_NOT_LOOPBACK');
  assert.deepEqual(asked, ['bus.localhost']);
  assert.equal(listener.connections, 0, 'the listener sees no connection, so the SASL key is never sent');
  await bus.close();
});

// @test-kind security: the emulator transport opens a socket only to an address the loopback check accepts for the endpoint name
test('an endpoint name whose lookup answers loopback connects to that address and sends the AMQP header', async (t) => {
  const listener = await emulatorListener(t);
  const bus = busFor(listener.port, async () => [{ address: '127.0.0.1', family: 4 }]);
  const sent = bus.send('fx-orders', 'x').catch((error) => error);
  const first = await Promise.race([listener.firstBytes, sent]);
  assert.ok(Buffer.isBuffer(first), `the listener received no connection: ${first?.message ?? first}`);
  assert.deepEqual([...first], [...Buffer.from('AMQP\x03\x01\x00\x00', 'latin1')]);
  await sent;
  await bus.close();
});

// @test-kind security: the emulator transport falls through only to checked loopback addresses, in the order the lookup gave them
test('an endpoint name whose lookup answers IPv6 loopback first connects to the IPv4 loopback address that accepts it', async (t) => {
  const listener = await emulatorListener(t);
  const bus = busFor(listener.port, async () => [
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 },
  ]);
  const sent = bus.send('fx-orders', 'x').catch((error) => error);
  const first = await Promise.race([listener.firstBytes, sent]);
  assert.ok(Buffer.isBuffer(first), `the listener received no connection: ${first?.message ?? first}`);
  assert.deepEqual([...first], [...Buffer.from('AMQP\x03\x01\x00\x00', 'latin1')]);
  await sent;
  await bus.close();
});

// A receiver's settlement has no answer; a drain round trip on the same connection orders after it, so once the drain
// returns the broker has applied every disposition sent before.
async function settled(bus) {
  assert.deepEqual(await bus.receive('fx-orders'), []);
}
