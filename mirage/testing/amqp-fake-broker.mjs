// Test-only loopback AMQP 1.0 broker that speaks the subset mirage/lib/amqp-client.mjs uses, with the Service Bus behaviour
// the Learn AMQP guide describes (https://learn.microsoft.com/azure/service-bus-messaging/service-bus-amqp-protocol-guide):
// SASL PLAIN with a shared access rule name and key; queues, topics fanning out to subscriptions (<topic>/subscriptions/<name>)
// and $deadletterqueue sub-queues; peek-lock through unsettled transfers; accepted removes; modified with delivery-failed
// (abandon) redelivers with a higher delivery count and dead-letters at maxDeliveryCount; released only unlocks; rejected with
// com.microsoft:dead-letter dead-letters; receive-and-delete through pre-settled transfers; drain; an unknown entity answers
// an attach with a null terminus followed by a detach carrying amqp:not-found. It is not Service Bus: no sessions, no
// management node, no CBS, no TLS.
// It has its own codec, written from the OASIS AMQP 1.0 field tables and deliberately not shared with amqp-client.mjs, and it
// always answers with the wide encodings (uint32, ulong descriptors, str32, list32, map32), so a field-position or encoding
// mistake in the client fails the tests instead of being mirrored here.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const DLQ = '/$deadletterqueue';
const SASL_HEADER = Buffer.from('AMQP\x03\x01\x00\x00', 'latin1');
const AMQP_HEADER = Buffer.from('AMQP\x00\x01\x00\x00', 'latin1');
// Descriptor codes (transport 2.7, 2.8.14; messaging 3.2, 3.4, 3.5; security 5.3).
const OPEN = 0x10,
  BEGIN = 0x11,
  ATTACH = 0x12,
  FLOW = 0x13,
  TRANSFER = 0x14,
  DISPOSITION = 0x15,
  DETACH = 0x16,
  END = 0x17,
  CLOSE = 0x18,
  ERROR = 0x1d;
const ACCEPTED = 0x24,
  REJECTED = 0x25,
  RELEASED = 0x26,
  MODIFIED = 0x27,
  SOURCE = 0x28,
  TARGET = 0x29;
const SASL_MECHANISMS = 0x40,
  SASL_INIT = 0x41,
  SASL_OUTCOME = 0x44;
const HEADER = 0x70,
  MESSAGE_ANNOTATIONS = 0x72,
  PROPERTIES = 0x73,
  APPLICATION_PROPERTIES = 0x74,
  DATA = 0x75,
  AMQP_VALUE = 0x77;

// ---- Independent codec: nodes are { t, v }; decoded values are plain JS, described values { d, v }
const node = (t, v) => ({ t, v });
const NUL = node('null');
const uint = (v) => node('uint', v),
  ubyte = (v) => node('ubyte', v),
  ushort = (v) => node('ushort', v),
  sym = (v) => node('sym', v);
const list = (items) => node('list', items),
  desc = (code, value) => node('desc', [code, value]);
const head = (code, size) => {
  const b = Buffer.alloc(1 + size);
  b[0] = code;
  return b;
};
function wide(code, body, count = null) {
  const b = Buffer.alloc(count == null ? 5 : 9);
  b[0] = code;
  b.writeUInt32BE(body.length + (count == null ? 0 : 4), 1);
  if (count != null) b.writeUInt32BE(count, 5);
  return Buffer.concat([b, body]);
}
/** A plain JS value as a node: string, number (long or double), boolean, null, Date, Buffer, array (list), object (map). */
function val(x) {
  if (x && typeof x === 'object' && 't' in x) return x;
  if (x == null) return NUL;
  if (typeof x === 'string') return node('str', x);
  if (typeof x === 'boolean') return node('bool', x);
  if (typeof x === 'number') return node(Number.isSafeInteger(x) ? 'long' : 'double', x);
  if (typeof x === 'bigint') return node('long', x);
  if (x instanceof Date) return node('ts', x.getTime());
  if (Buffer.isBuffer(x)) return node('bin', x);
  if (Array.isArray(x)) return list(x.map(val));
  return node(
    'map',
    Object.entries(x).map(([k, v]) => [node('str', k), val(v)]),
  );
}
function enc(n) {
  n = val(n);
  switch (n.t) {
    case 'null':
      return Buffer.from([0x40]);
    case 'bool':
      return Buffer.from([n.v ? 0x41 : 0x42]);
    case 'ubyte':
      return Buffer.from([0x50, n.v]);
    case 'ushort': {
      const b = head(0x60, 2);
      b.writeUInt16BE(n.v, 1);
      return b;
    }
    case 'uint': {
      const b = head(0x70, 4);
      b.writeUInt32BE(n.v, 1);
      return b;
    }
    case 'ulong': {
      const b = head(0x80, 8);
      b.writeBigUInt64BE(BigInt(n.v), 1);
      return b;
    }
    case 'long': {
      const b = head(0x81, 8);
      b.writeBigInt64BE(BigInt(n.v), 1);
      return b;
    }
    case 'double': {
      const b = head(0x82, 8);
      b.writeDoubleBE(n.v, 1);
      return b;
    }
    case 'ts': {
      const b = head(0x83, 8);
      b.writeBigInt64BE(BigInt(n.v), 1);
      return b;
    }
    case 'bin':
      return wide(0xb0, Buffer.from(n.v));
    case 'str':
      return wide(0xb1, Buffer.from(n.v, 'utf8'));
    case 'sym':
      return wide(0xb3, Buffer.from(n.v, 'ascii'));
    case 'list':
      return wide(0xd0, Buffer.concat(n.v.map(enc)), n.v.length);
    case 'map':
      return wide(0xd1, Buffer.concat(n.v.flatMap(([k, v]) => [enc(k), enc(v)])), n.v.length * 2);
    case 'desc':
      return Buffer.concat([Buffer.from([0x00]), enc(node('ulong', n.v[0])), enc(n.v[1])]);
    default:
      throw new TypeError(`fake broker cannot encode ${n.t}`);
  }
}
function dec(b, at) {
  const code = b[at++];
  const fixed = {
    0x50: 1,
    0x52: 1,
    0x53: 1,
    0x55: 1,
    0x54: 1,
    0x60: 2,
    0x70: 4,
    0x71: 4,
    0x80: 8,
    0x81: 8,
    0x82: 8,
    0x83: 8,
  };
  if (code === 0x00) {
    const [d, a] = dec(b, at);
    const [v, e] = dec(b, a);
    return [{ d, v }, e];
  }
  if (code === 0x40) return [null, at];
  if (code === 0x41 || code === 0x42) return [code === 0x41, at];
  if (code === 0x43 || code === 0x44) return [0, at];
  if (code === 0x45) return [[], at];
  if (Object.hasOwn(fixed, code)) {
    let v;
    switch (code) {
      case 0x50:
      case 0x52:
      case 0x53:
        v = b[at];
        break;
      case 0x55:
      case 0x54:
        v = b.readInt8(at);
        break;
      case 0x60:
        v = b.readUInt16BE(at);
        break;
      case 0x70:
        v = b.readUInt32BE(at);
        break;
      case 0x71:
        v = b.readInt32BE(at);
        break;
      case 0x80:
        v = Number(b.readBigUInt64BE(at));
        break;
      case 0x81:
        v = Number(b.readBigInt64BE(at));
        break;
      case 0x82:
        v = b.readDoubleBE(at);
        break;
      case 0x83:
        v = new Date(Number(b.readBigInt64BE(at)));
        break;
    }
    return [v, at + fixed[code]];
  }
  if ([0xa0, 0xa1, 0xa3, 0xb0, 0xb1, 0xb3].includes(code)) {
    const big = code >= 0xb0,
      size = big ? b.readUInt32BE(at) : b[at],
      start = at + (big ? 4 : 1),
      raw = b.subarray(start, start + size);
    return [code % 16 === 0 ? Buffer.from(raw) : raw.toString(code % 16 === 1 ? 'utf8' : 'ascii'), start + size];
  }
  if ([0xc0, 0xc1, 0xd0, 0xd1].includes(code)) {
    const big = code >= 0xd0,
      w = big ? 4 : 1,
      size = big ? b.readUInt32BE(at) : b[at],
      count = big ? b.readUInt32BE(at + w) : b[at + w];
    const items = [];
    let cursor = at + 2 * w;
    for (let i = 0; i < count; i += 1) {
      const [v, next] = dec(b, cursor);
      items.push(v);
      cursor = next;
    }
    if (code % 16 === 0) return [items, at + w + size];
    const entries = [];
    for (let i = 0; i < items.length; i += 2) entries.push([String(items[i]), items[i + 1]]);
    const map = Object.fromEntries(entries);
    return [map, at + w + size];
  }
  throw new TypeError(`fake broker cannot decode 0x${code.toString(16)}`);
}
/** One frame (transport 2.3.1): size, doff, type, channel, then the performative and payload. */
function frameOf(type, performative, payload = null) {
  const body = payload ? Buffer.concat([enc(performative), payload]) : enc(performative),
    h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h[4] = 2;
  h[5] = type;
  return Buffer.concat([h, body]);
}
function sectionsOf(payload) {
  const message = { header: [], annotations: {}, properties: [], applicationProperties: {}, body: null };
  for (let at = 0; at < payload.length;) {
    const [section, next] = dec(payload, at);
    at = next;
    if (section.d === HEADER) message.header = section.v;
    else if (section.d === MESSAGE_ANNOTATIONS) message.annotations = section.v;
    else if (section.d === PROPERTIES) message.properties = section.v;
    else if (section.d === APPLICATION_PROPERTIES) message.applicationProperties = section.v;
    else if (section.d === DATA || section.d === AMQP_VALUE) message.body = section.v;
  }
  return message;
}

/**
 * Starts the broker on 127.0.0.1 (ephemeral port). Options: keyName, key, queues (names), topics ({ topic: [subscriptions] }),
 * maxDeliveryCount, lockMs, maxFrameSize (its frames; small values exercise multi-frame transfers), idleTimeoutMs (announced
 * in open). Returns { port, count(entity), frames, payloads, stats, dropConnections(), close() }; frames lists every
 * performative the client sent as { code, fields } decoded by this broker's own codec; payloads retains completed
 * transfer bytes for independent wire assertions.
 */
export async function startFakeBroker({
  keyName = 'RootManageSharedAccessKey',
  key,
  queues = [],
  topics = {},
  maxDeliveryCount = 10,
  lockMs = 30_000,
  maxFrameSize = 4096,
  idleTimeoutMs = null,
} = {}) {
  const entities = new Map();
  const declare = (name) => {
    entities.set(name, []);
    entities.set(name + DLQ, []);
  };
  queues.forEach(declare);
  for (const [topic, subscriptions] of Object.entries(topics))
    for (const name of subscriptions) declare(`${topic}/subscriptions/${name}`);
  const sendable = (name) => queues.includes(name) || Object.hasOwn(topics, name);
  const receivers = new Set(),
    sockets = new Set(),
    frames = [],
    payloads = [];
  const stats = { connections: 0, heartbeats: 0, saslFailures: 0 };
  let sequence = 0;

  const targetsOf = (address) =>
    queues.includes(address) ? [address] : (topics[address] ?? []).map((name) => `${address}/subscriptions/${name}`);
  function deadLetter(address, message, reason, description) {
    const items = entities.get(address);
    items.splice(items.indexOf(message), 1);
    message.lock = null;
    message.applicationProperties = {
      ...message.applicationProperties,
      DeadLetterReason: reason,
      DeadLetterErrorDescription: description,
    };
    entities.get(address + DLQ).push(message);
  }
  // A failed delivery (abandon, lock expiry) raises the delivery count; released only unlocks (JMS mapping on Learn).
  function unlock(address, message, failed) {
    message.lock = null;
    if (!failed) return;
    message.failures += 1;
    if (message.failures >= maxDeliveryCount && !address.endsWith(DLQ))
      deadLetter(
        address,
        message,
        'MaxDeliveryCountExceeded',
        `Message could not be consumed after ${maxDeliveryCount} delivery attempts.`,
      );
  }
  function pump() {
    for (const link of receivers) deliver(link);
  }

  function deliver(link) {
    const items = entities.get(link.address),
      at = Date.now();
    for (const message of [...items])
      if (message.lock && message.lockedUntil <= at) unlock(link.address, message, true);
    while (link.credit > 0) {
      const message = items.find((item) => !item.lock && item.visibleAt <= at);
      if (!message) break;
      link.credit -= 1;
      link.deliveryCount += 1;
      const id = link.connection.nextOutgoingId++,
        tag = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
      const annotations = {
        ...message.annotations,
        'x-opt-sequence-number': message.sequence,
        'x-opt-enqueued-time': message.enqueuedTime,
        ...(link.settled ? {} : { 'x-opt-locked-until': new Date(at + lockMs) }),
      };
      const properties = message.properties.map((value, index) =>
        index === 6 && typeof value === 'string' ? sym(value) : val(value),
      );
      const sections = [
        desc(HEADER, list([NUL, NUL, NUL, NUL, uint(message.failures)])),
        desc(
          MESSAGE_ANNOTATIONS,
          node(
            'map',
            Object.entries(annotations).map(([name, value]) => [sym(name), val(value)]),
          ),
        ),
        desc(PROPERTIES, list(properties)),
        desc(APPLICATION_PROPERTIES, val(message.applicationProperties)),
        Buffer.isBuffer(message.body) ? desc(DATA, node('bin', message.body)) : desc(AMQP_VALUE, val(message.body)),
      ];
      const payload = Buffer.concat(sections.map(enc));
      if (link.settled) items.splice(items.indexOf(message), 1);
      else {
        message.lock = { link, id };
        message.lockedUntil = at + lockMs;
      }
      const room = Math.min(maxFrameSize, link.connection.peerMaxFrame) - 96;
      for (let offset = 0; offset === 0 || offset < payload.length; offset += room) {
        const more = offset + room < payload.length;
        // transfer: handle, delivery-id, delivery-tag, message-format, settled, more (transport 2.7.5)
        const fields =
          offset === 0
            ? [uint(link.handle), uint(id), node('bin', tag), uint(0), node('bool', link.settled), node('bool', more)]
            : [uint(link.handle), NUL, NUL, NUL, NUL, node('bool', more)];
        link.connection.send(desc(TRANSFER, list(fields)), payload.subarray(offset, offset + room));
      }
    }
    if (link.drain) {
      link.deliveryCount += link.credit;
      link.credit = 0;
      link.drain = false;
      link.connection.flow(link, 0, true);
    }
  }

  function accept(socket) {
    sockets.add(socket);
    stats.connections += 1;
    const links = new Map();
    let phase = 'sasl-header',
      input = Buffer.alloc(0);
    const connection = {
      nextOutgoingId: 0,
      nextIncomingId: 0,
      peerMaxFrame: 512,
      send: (performative, payload) => {
        if (!socket.destroyed) socket.write(frameOf(0, performative, payload));
      },
      // flow: next-incoming-id, incoming-window, next-outgoing-id, outgoing-window, handle, delivery-count, link-credit, available, drain (2.7.4)
      flow: (link, credit, drain = false) =>
        connection.send(
          desc(
            FLOW,
            list([
              uint(connection.nextIncomingId),
              uint(5000),
              uint(connection.nextOutgoingId),
              uint(5000),
              uint(link.handle),
              uint(link.deliveryCount),
              uint(credit),
              NUL,
              node('bool', drain),
            ]),
          ),
        ),
    };
    const drop = () => {
      for (const link of links.values()) receivers.delete(link);
      sockets.delete(socket);
    };
    socket.on('close', drop);
    socket.on('error', drop);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      for (;;) {
        if (phase === 'sasl-header' || phase === 'amqp-header') {
          if (input.length < 8) return;
          const header = input.subarray(0, 8);
          input = input.subarray(8);
          if (!header.equals(phase === 'sasl-header' ? SASL_HEADER : AMQP_HEADER)) {
            socket.destroy();
            return;
          }
          if (phase === 'sasl-header') {
            socket.write(SASL_HEADER);
            socket.write(frameOf(1, desc(SASL_MECHANISMS, list([sym('PLAIN')]))));
            phase = 'sasl';
          } else {
            socket.write(AMQP_HEADER);
            phase = 'amqp';
          }
          continue;
        }
        if (input.length < 8) return;
        const size = input.readUInt32BE(0);
        if (input.length < size) return;
        const body = input.subarray(input[4] * 4, size);
        input = input.subarray(size);
        if (!body.length) {
          stats.heartbeats += 1;
          continue;
        }
        const [performative, next] = dec(body, 0);
        frames.push({ code: performative.d, fields: performative.v ?? [] });
        onFrame(performative.d, performative.v ?? [], body.subarray(next));
      }
    });

    function onFrame(code, f, payload) {
      if (phase === 'sasl') {
        if (code !== SASL_INIT) return;
        // sasl-init: mechanism, initial-response, hostname (security 5.3.3.2)
        const [, user = '', password = ''] = Buffer.from(f[1] ?? [])
          .toString('utf8')
          .split('\0');
        const ok = f[0] === 'PLAIN' && user === keyName && password === key;
        socket.write(frameOf(1, desc(SASL_OUTCOME, list([ubyte(ok ? 0 : 1)]))));
        if (!ok) {
          stats.saslFailures += 1;
          socket.end();
          return;
        }
        phase = 'amqp-header';
        return;
      }
      switch (code) {
        case OPEN: // container-id, hostname, max-frame-size, channel-max, idle-time-out (2.7.1)
          connection.peerMaxFrame = f[2] ?? 4294967295;
          return connection.send(
            desc(
              OPEN,
              list([
                node('str', 'fake-broker'),
                NUL,
                uint(maxFrameSize),
                ushort(0),
                idleTimeoutMs ? uint(idleTimeoutMs) : NUL,
              ]),
            ),
          );
        case BEGIN: // remote-channel, next-outgoing-id, incoming-window, outgoing-window (2.7.2)
          connection.nextIncomingId = f[1] ?? 0;
          return connection.send(desc(BEGIN, list([ushort(0), uint(0), uint(5000), uint(5000)])));
        case ATTACH: {
          // name, handle, role, snd-settle-mode, rcv-settle-mode, source, target, …, initial-delivery-count (2.7.3)
          const [name, handle, clientReceives] = f;
          const address = clientReceives ? f[5]?.v?.[0] : f[6]?.v?.[0];
          const known = clientReceives ? entities.has(address) : sendable(address);
          const terminus = (code2, value) =>
            value?.v?.[0] == null ? NUL : desc(code2, list([node('str', value.v[0])]));
          if (!known) {
            connection.send(
              desc(
                ATTACH,
                list([node('str', name), uint(handle), node('bool', !clientReceives), ubyte(0), ubyte(0), NUL, NUL]),
              ),
            );
            return connection.send(
              desc(
                DETACH,
                list([
                  uint(handle),
                  node('bool', true),
                  desc(
                    ERROR,
                    list([
                      sym('amqp:not-found'),
                      node('str', `The messaging entity '${address}' could not be found.`),
                      NUL,
                    ]),
                  ),
                ]),
              ),
            );
          }
          const link = {
            handle,
            address,
            receiver: !clientReceives,
            settled: f[3] === 1,
            credit: 0,
            deliveryCount: 0,
            drain: false,
            partial: null,
            connection,
          };
          links.set(handle, link);
          connection.send(
            desc(
              ATTACH,
              list([
                node('str', name),
                uint(handle),
                node('bool', !clientReceives),
                ubyte(f[3] ?? 0),
                ubyte(0),
                terminus(SOURCE, f[5]),
                terminus(TARGET, f[6]),
                NUL,
                NUL,
                clientReceives ? uint(0) : NUL,
              ]),
            ),
          );
          if (link.receiver) return connection.flow(link, 1000);
          return receivers.add(link);
        }
        case FLOW: {
          const link = f[4] == null ? null : links.get(f[4]);
          if (!link || link.receiver) return;
          link.credit = (f[5] ?? 0) + (f[6] ?? 0) - link.deliveryCount; // 2.6.7
          link.drain = f[8] === true;
          return deliver(link);
        }
        case TRANSFER: {
          const link = links.get(f[0]);
          if (!link?.receiver) return;
          if (!link.partial) {
            link.partial = { id: f[1], chunks: [] };
            connection.nextIncomingId = f[1] + 1;
          }
          if (payload?.length) link.partial.chunks.push(payload);
          if (f[5] === true) return;
          const { id, chunks } = link.partial;
          link.partial = null;
          link.deliveryCount += 1;
          const completePayload = Buffer.concat(chunks);
          payloads.push(Buffer.from(completePayload));
          const message = sectionsOf(completePayload),
            now = Date.now();
          const scheduled = message.annotations['x-opt-scheduled-enqueue-time'];
          if (scheduled instanceof Date && scheduled.getTime() > now)
            setTimeout(pump, scheduled.getTime() - now + 1).unref();
          for (const target of targetsOf(link.address)) {
            entities.get(target).push({
              sequence: ++sequence,
              enqueuedTime: new Date(now),
              visibleAt: scheduled instanceof Date ? scheduled.getTime() : now,
              failures: 0,
              lock: null,
              lockedUntil: 0,
              annotations: Object.fromEntries(
                Object.entries(message.annotations).filter(([name]) => !name.startsWith('x-opt-sequence')),
              ),
              properties: message.properties,
              applicationProperties: message.applicationProperties,
              body: message.body,
            });
          }
          // disposition: role, first, last, settled, state (2.7.6)
          connection.send(
            desc(
              DISPOSITION,
              list([node('bool', true), uint(id), uint(id), node('bool', true), desc(ACCEPTED, list([]))]),
            ),
          );
          connection.flow(link, 1000);
          return pump();
        }
        case DISPOSITION: {
          if (f[0] !== true) return;
          const first = f[1],
            last = f[2] ?? first,
            state = f[4];
          for (const [address, items] of entities) {
            for (const message of [...items]) {
              if (
                !message.lock ||
                message.lock.link.connection !== connection ||
                message.lock.id < first ||
                message.lock.id > last
              )
                continue;
              if (state?.d === ACCEPTED) items.splice(items.indexOf(message), 1);
              else if (state?.d === REJECTED && state.v?.[0]?.v?.[0] === 'com.microsoft:dead-letter') {
                const info = state.v[0].v[2] ?? {};
                deadLetter(
                  address,
                  message,
                  info.DeadLetterReason ?? 'DeadLettered',
                  info.DeadLetterErrorDescription ?? null,
                );
              } else unlock(address, message, state?.d === MODIFIED ? state.v?.[0] === true : state?.d !== RELEASED);
            }
          }
          return pump();
        }
        case DETACH: {
          const link = links.get(f[0]);
          links.delete(f[0]);
          if (link) receivers.delete(link);
          return connection.send(desc(DETACH, list([uint(f[0]), node('bool', true)])));
        }
        case END:
          return connection.send(desc(END, list([])));
        case CLOSE:
          connection.send(desc(CLOSE, list([])));
          socket.end();
          return;
        default:
      }
    }
  }

  const server = net.createServer(accept);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    stats,
    frames,
    // Completed client transfers, including their actual encoded message bytes.
    payloads,
    /** Messages an entity holds (available, scheduled and locked). */
    count: (entity) => entities.get(entity)?.length ?? 0,
    /** Drops every client connection (the broker keeps listening; locks stay until they expire, as without link recovery). */
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The fake broker's own codec, exported for golden-byte tests against the client. */
export const fakeCodec = Object.freeze({ enc, dec, val, desc, list, uint, ubyte, ushort, sym, frameOf });
