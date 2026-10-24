// Minimal AMQP 1.0 client for the Azure Service Bus emulator: plain TCP on loopback, SASL PLAIN, one session. One encoder
// (encode), one decoder (decode), one frame writer (frame) and one connection state machine (connectAmqp); nothing beyond
// what the message bus needs: sender and receiver links, link credit and drain, transfers (multi-frame), dispositions,
// detach, close and idle-timeout keepalive. Every wait is bounded by timeoutMs. The shared access key is read once through
// credentials() while SASL runs and is never kept, logged or put into an error.
// Specification: OASIS AMQP 1.0 (ISO/IEC 19464)
//   types     http://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-types-v1.0-os.html (1.6 encodings)
//   transport http://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-transport-v1.0-os.html (2.2 header, 2.3 frames,
//             2.4.5 idle timeout, 2.6.7 flow control, 2.7 performatives, 2.8.14-15 error and conditions)
//   messaging http://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-messaging-v1.0-os.html (3.2 sections, 3.4 outcomes, 3.5 terminus)
//   security  http://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-security-v1.0-os.html (5.2 SASL header, 5.3 SASL frames)
// Service Bus use of AMQP: https://learn.microsoft.com/azure/service-bus-messaging/service-bus-amqp-protocol-guide
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ProviderError } from './storage-provider.mjs';

// --- Types (types 1.6)
const TYPE = Symbol('amqp.type');
const typed = (type) => (value) => ({ [TYPE]: type, value });
/** Wrappers for values whose AMQP type a JS value cannot carry. */
export const sym = typed('symbol'),
  uint = typed('uint'),
  ulong = typed('ulong'),
  ubyte = typed('ubyte'),
  ushort = typed('ushort');
/** A described value; descriptor is a numeric code (encoded as ulong) or a symbol name. */
export class Described {
  constructor(descriptor, value) {
    this.descriptor = descriptor;
    this.value = value;
  }
}
export const described = (descriptor, value) => new Described(descriptor, value);

const bytes = (...values) => Buffer.from(values);
function fixed(code, size, write) {
  const out = Buffer.alloc(1 + size);
  out[0] = code;
  write(out);
  return out;
}
function variable(small, large, body) {
  if (body.length <= 0xff) return Buffer.concat([bytes(small, body.length), body]);
  const head = Buffer.alloc(5);
  head[0] = large;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}
function compound(small, large, items) {
  const body = Buffer.concat(items);
  if (body.length + 1 <= 0xff && items.length <= 0xff)
    return Buffer.concat([bytes(small, body.length + 1, items.length), body]);
  const head = Buffer.alloc(9);
  head[0] = large;
  head.writeUInt32BE(body.length + 4, 1);
  head.writeUInt32BE(items.length, 5);
  return Buffer.concat([head, body]);
}
function encodeTyped(type, value) {
  switch (type) {
    case 'symbol':
      return variable(0xa3, 0xb3, Buffer.from(value, 'ascii'));
    case 'uint':
      return value === 0
        ? bytes(0x43)
        : value <= 0xff
          ? bytes(0x52, value)
          : fixed(0x70, 4, (b) => b.writeUInt32BE(value, 1));
    case 'ulong':
      return value === 0
        ? bytes(0x44)
        : value <= 0xff
          ? bytes(0x53, value)
          : fixed(0x80, 8, (b) => b.writeBigUInt64BE(BigInt(value), 1));
    case 'ubyte':
      return bytes(0x50, value);
    case 'ushort':
      return fixed(0x60, 2, (b) => b.writeUInt16BE(value, 1));
    default:
      throw new TypeError(`Unknown AMQP type ${type}`);
  }
}

/** Encodes one value: null, boolean, string (str), Buffer (binary), Date (timestamp), safe integer (long), other number
 * (double), bigint (long), Array (list), Map or plain object (map), a sym/uint/ulong/ubyte/ushort wrapper or Described. */
export function encode(value) {
  if (value == null) return bytes(0x40);
  if (value === true) return bytes(0x41);
  if (value === false) return bytes(0x42);
  if (value instanceof Described)
    return Buffer.concat([
      bytes(0x00),
      encode(typeof value.descriptor === 'number' ? ulong(value.descriptor) : sym(value.descriptor)),
      encode(value.value),
    ]);
  if (value[TYPE]) return encodeTyped(value[TYPE], value.value);
  if (typeof value === 'string') return variable(0xa1, 0xb1, Buffer.from(value, 'utf8'));
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return variable(0xa0, 0xb0, Buffer.from(value));
  if (value instanceof Date) return fixed(0x83, 8, (b) => b.writeBigInt64BE(BigInt(value.getTime()), 1));
  if (typeof value === 'bigint') return fixed(0x81, 8, (b) => b.writeBigInt64BE(value, 1));
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value))
      return value >= -128 && value <= 127
        ? bytes(0x55, value & 0xff)
        : fixed(0x81, 8, (b) => b.writeBigInt64BE(BigInt(value), 1));
    return fixed(0x82, 8, (b) => b.writeDoubleBE(value, 1));
  }
  if (Array.isArray(value)) return value.length ? compound(0xc0, 0xd0, value.map(encode)) : bytes(0x45);
  if (typeof value !== 'object') throw new TypeError(`Cannot encode ${typeof value} as AMQP`);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return compound(
    0xc1,
    0xd1,
    entries.flatMap(([key, item]) => [encode(key), encode(item)]),
  );
}

const truncated = () => new RangeError('AMQP value is truncated');
const integer = (big) =>
  big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
const uuidText = (b) => b.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');

/** Decodes the value at offset → [value, next offset]. Symbols decode to strings, maps to plain objects (keys as strings),
 * ulong/long to numbers (bigint beyond 2^53), timestamps to Date, uuid to text, binary to Buffer, arrays and lists to arrays. */
export function decode(buffer, offset = 0) {
  if (offset >= buffer.length) throw truncated();
  const code = buffer[offset];
  if (code !== 0x00) return decodeAs(code, buffer, offset + 1);
  const [descriptor, at] = decode(buffer, offset + 1);
  const [value, end] = decode(buffer, at);
  return [new Described(descriptor, value), end];
}
function decodeAs(code, b, at) {
  const need = (n) => {
    if (at + n > b.length) throw truncated();
  };
  switch (code) {
    case 0x40:
      return [null, at];
    case 0x41:
      return [true, at];
    case 0x42:
      return [false, at];
    case 0x43:
    case 0x44:
      return [0, at];
    case 0x56:
      need(1);
      return [b[at] !== 0, at + 1];
    case 0x50:
    case 0x52:
    case 0x53:
      need(1);
      return [b[at], at + 1];
    case 0x51:
    case 0x54:
    case 0x55:
      need(1);
      return [b.readInt8(at), at + 1];
    case 0x60:
      need(2);
      return [b.readUInt16BE(at), at + 2];
    case 0x61:
      need(2);
      return [b.readInt16BE(at), at + 2];
    case 0x70:
      need(4);
      return [b.readUInt32BE(at), at + 4];
    case 0x71:
      need(4);
      return [b.readInt32BE(at), at + 4];
    case 0x72:
      need(4);
      return [b.readFloatBE(at), at + 4];
    case 0x73:
      need(4);
      return [String.fromCodePoint(b.readUInt32BE(at)), at + 4];
    case 0x80:
      need(8);
      return [integer(b.readBigUInt64BE(at)), at + 8];
    case 0x81:
      need(8);
      return [integer(b.readBigInt64BE(at)), at + 8];
    case 0x82:
      need(8);
      return [b.readDoubleBE(at), at + 8];
    case 0x83:
      need(8);
      return [new Date(Number(b.readBigInt64BE(at))), at + 8];
    case 0x98:
      need(16);
      return [uuidText(b.subarray(at, at + 16)), at + 16];
    case 0xa0:
    case 0xa1:
    case 0xa3:
    case 0xb0:
    case 0xb1:
    case 0xb3: {
      const wide = code >= 0xb0;
      need(wide ? 4 : 1);
      const size = wide ? b.readUInt32BE(at) : b[at],
        start = at + (wide ? 4 : 1);
      if (start + size > b.length) throw truncated();
      const raw = b.subarray(start, start + size);
      return [
        (code & 0x0f) === 0 ? Buffer.from(raw) : raw.toString((code & 0x0f) === 1 ? 'utf8' : 'ascii'),
        start + size,
      ];
    }
    case 0x45:
      return [[], at];
    case 0xc0:
    case 0xc1:
    case 0xd0:
    case 0xd1:
    case 0xe0:
    case 0xf0: {
      const wide = code === 0xd0 || code === 0xd1 || code === 0xf0,
        width = wide ? 4 : 1;
      need(2 * width);
      const size = wide ? b.readUInt32BE(at) : b[at],
        count = wide ? b.readUInt32BE(at + width) : b[at + width];
      const end = at + width + size;
      if (end > b.length) throw truncated();
      let cursor = at + 2 * width;
      const items = [];
      if (code === 0xe0 || code === 0xf0) {
        if (!count) return [[], end];
        const element = b[cursor++];
        if (element === 0x00) throw new TypeError('Described AMQP array elements are not supported');
        for (let index = 0; index < count; index += 1) {
          const [item, next] = decodeAs(element, b, cursor);
          items.push(item);
          cursor = next;
        }
        return [items, end];
      }
      for (let index = 0; index < count; index += 1) {
        const [item, next] = decode(b.subarray(0, end), cursor);
        items.push(item);
        cursor = next;
      }
      if (code === 0xc0 || code === 0xd0) return [items, end];
      const entries = [];
      for (let index = 0; index + 1 < items.length; index += 2) entries.push([String(items[index]), items[index + 1]]);
      const map = Object.fromEntries(entries);
      return [map, end];
    }
    default:
      throw new TypeError(`Unsupported AMQP type code 0x${code.toString(16)}`);
  }
}

// --- Frames (transport 2.2, 2.3; security 5.2)
export const AMQP_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 0, 1, 0, 0]);
export const SASL_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 3, 1, 0, 0]);
export const EMPTY_FRAME = Buffer.from([0, 0, 0, 8, 2, 0, 0, 0]); // a heartbeat: an AMQP frame without a body (2.4.5)
/** Descriptor codes used here: performatives (2.7), error (2.8.14), outcomes (3.4), terminus (3.5), SASL (5.3), sections (3.2). */
export const CODE = Object.freeze({
  open: 0x10,
  begin: 0x11,
  attach: 0x12,
  flow: 0x13,
  transfer: 0x14,
  disposition: 0x15,
  detach: 0x16,
  end: 0x17,
  close: 0x18,
  error: 0x1d,
  accepted: 0x24,
  rejected: 0x25,
  released: 0x26,
  modified: 0x27,
  source: 0x28,
  target: 0x29,
  saslMechanisms: 0x40,
  saslInit: 0x41,
  saslOutcome: 0x44,
  header: 0x70,
  messageAnnotations: 0x72,
  properties: 0x73,
  applicationProperties: 0x74,
  data: 0x75,
  amqpSequence: 0x76,
  amqpValue: 0x77,
});

/** The frame writer: type 0 (AMQP) or 1 (SASL), channel, a performative and an optional payload (transfer bytes). */
export function frame(type, channel, performative, payload = null) {
  const body = payload ? Buffer.concat([encode(performative), payload]) : encode(performative);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head[4] = 2;
  head[5] = type;
  head.writeUInt16BE(channel, 6);
  return Buffer.concat([head, body]);
}

/** Reads one complete frame from the front of buffer → { type, channel, performative, payload, size }, or null if incomplete. */
export function readFrame(buffer, maxSize) {
  if (buffer.length < 8) return null;
  const size = buffer.readUInt32BE(0),
    doff = buffer[4];
  if (size < 8 || doff < 2 || doff * 4 > size || size > maxSize)
    throw new RangeError(`Malformed AMQP frame (size ${size})`);
  if (buffer.length < size) return null;
  const body = buffer.subarray(doff * 4, size);
  if (!body.length)
    return { type: buffer[5], channel: buffer.readUInt16BE(6), performative: null, payload: null, size };
  const [performative, next] = decode(body);
  return { type: buffer[5], channel: buffer.readUInt16BE(6), performative, payload: body.subarray(next), size };
}

// --- Messages (messaging 3.2)
/** Message bytes from its sections: header (list), annotations (Map with sym keys), properties (list), applicationProperties
 * (object) and body (a Buffer becomes a data section, anything else an amqp-value section). */
export function encodeMessage({
  header = null,
  annotations = null,
  properties = null,
  applicationProperties = null,
  body = null,
}) {
  const sections = [];
  if (header) sections.push(described(CODE.header, header));
  if (annotations?.size) sections.push(described(CODE.messageAnnotations, annotations));
  if (properties) sections.push(described(CODE.properties, properties));
  if (applicationProperties && Object.keys(applicationProperties).length)
    sections.push(described(CODE.applicationProperties, applicationProperties));
  sections.push(described(Buffer.isBuffer(body) ? CODE.data : CODE.amqpValue, body));
  return Buffer.concat(sections.map(encode));
}

/** Sections of message bytes → { header: [], annotations: {}, properties: [], applicationProperties: {}, body }. Several data
 * sections concatenate into one Buffer; delivery-annotations and footer are ignored. */
export function decodeMessage(payload) {
  const message = { header: [], annotations: {}, properties: [], applicationProperties: {}, body: null };
  const data = [];
  for (let at = 0; at < payload.length;) {
    const [section, next] = decode(payload, at);
    at = next;
    if (!(section instanceof Described)) throw new TypeError('An AMQP message section must be described');
    const value = section.value;
    if (section.descriptor === CODE.header) message.header = value ?? [];
    else if (section.descriptor === CODE.messageAnnotations) message.annotations = value ?? {};
    else if (section.descriptor === CODE.properties) message.properties = value ?? [];
    else if (section.descriptor === CODE.applicationProperties) message.applicationProperties = value ?? {};
    else if (section.descriptor === CODE.data) data.push(value);
    else if (section.descriptor === CODE.amqpValue || section.descriptor === CODE.amqpSequence) message.body = value;
  }
  if (data.length) message.body = Buffer.concat(data);
  return message;
}

// --- Errors (transport 2.8.15, messaging 3.4; Service Bus conditions)
const CONDITION_CODES = Object.freeze({
  'amqp:not-found': 'NotFound',
  'amqp:unauthorized-access': 'Unauthorized',
  'amqp:not-allowed': 'Unsupported',
  'amqp:not-implemented': 'Unsupported',
  'amqp:resource-limit-exceeded': 'Unavailable',
  'amqp:link:message-size-exceeded': 'TooLarge',
});
const SASL_OUTCOMES = Object.freeze(['ok', 'auth', 'sys', 'sys-perm', 'sys-temp']);
const unavailable = (message, diagnostic, provider) =>
  new ProviderError('Unavailable', message, { provider, diagnostic });
/** A ProviderError from an AMQP error (condition, description), with the condition as its diagnostic. */
export function amqpError(error, provider = null, context = '') {
  const [condition = 'amqp:internal-error', description = null] = error instanceof Described ? (error.value ?? []) : [];
  const code = CONDITION_CODES[condition] ?? 'Unavailable';
  return new ProviderError(code, `${context}${description ?? 'The broker answered an error'} (${condition}).`, {
    provider,
    diagnostic: condition,
  });
}

// --- Connection state machine
const MAX_FRAME = 1 << 20; // our max-frame-size: 1 MiB covers the emulator's 256 KB messages in one frame
// Session windows: Service Bus imposes no session-level throttling windows.
// ponytail: the peer's incoming window is not enforced and ours is re-announced only with each flow; enforce both for a broker that throttles.
const WINDOW = 5000;

/**
 * Opens a connection: TCP → SASL header → sasl-mechanisms → sasl-init PLAIN → sasl-outcome → AMQP header → open → begin.
 * credentials() → { user, password } is called once during SASL. signal (optional) aborts every wait. Resolves to
 * { attach, transfer, take, settle, detach, close, failed }; any failure rejects with a ProviderError and destroys the socket.
 */
export async function connectAmqp({
  host,
  port = 5672,
  hostname = host,
  credentials,
  timeoutMs = 5000,
  signal = null,
  provider = null,
}) {
  const waits = new Map(),
    links = new Map(),
    byRemote = new Map(),
    sending = new Map();
  let phase = 'connect',
    input = Buffer.alloc(0),
    failure = null,
    keepalive = null,
    closing = false;
  let remoteMaxFrame = 512,
    nextOutgoingId = 0,
    nextIncomingId = 0,
    nextHandle = 0;
  const socket = net.connect({ host, port });
  socket.setNoDelay(true);
  const write = (chunk) => {
    if (!failure) socket.write(chunk);
  };
  const send = (performative, payload) => write(frame(0, 0, performative, payload));

  // expect(key) registers a bounded wait that answer(key, value) resolves; it must be registered before the request is written.
  function expect(key, label = key, ms = timeoutMs) {
    if (failure) return Promise.reject(failure);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waits.delete(key);
        reject(unavailable(`No ${label} from the Service Bus emulator within ${ms} ms.`, 'AMQP_TIMEOUT', provider));
      }, ms);
      waits.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          waits.delete(key);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          waits.delete(key);
          reject(error);
        },
      });
    });
    promise.catch(() => {}); // a wait abandoned by an earlier failure must not surface as an unhandled rejection
    return promise;
  }
  const answer = (key, value) => waits.get(key)?.resolve(value);
  const soft = (promise) =>
    promise.catch((error) => {
      if (error?.diagnostic !== 'AMQP_TIMEOUT') throw error;
    });

  function fail(error) {
    if (failure) return;
    failure = error;
    clearInterval(keepalive);
    for (const wait of [...waits.values()]) wait.reject(error);
    for (const link of links.values()) link.failure ??= error;
    socket.destroy();
  }
  signal?.addEventListener(
    'abort',
    () =>
      fail(
        unavailable(
          `The Service Bus emulator did not answer within the ${timeoutMs} ms bound.`,
          'AMQP_TIMEOUT',
          provider,
        ),
      ),
    { once: true },
  );
  socket.on('connect', () => answer('connect'));
  // Before the TCP connection exists the emulator is not reachable; afterwards a socket error is the connection closing under
  // whatever was in flight (a transfer, a disposition wait), named by its condition.
  socket.on('error', (error) =>
    fail(
      phase === 'connect'
        ? unavailable(
            `The Service Bus emulator on loopback port ${port} is not reachable (${error.code ?? 'connection failed'}).`,
            'AMQP_UNREACHABLE',
            provider,
          )
        : unavailable(
            `The Service Bus emulator closed the connection (${error.code ?? 'socket error'}).`,
            'AMQP_CONNECTION_CLOSED',
            provider,
          ),
    ),
  );
  socket.on('close', () =>
    fail(unavailable('The Service Bus emulator closed the connection.', 'AMQP_CONNECTION_CLOSED', provider)),
  );
  socket.on('data', (chunk) => {
    try {
      receive(chunk);
    } catch (error) {
      fail(unavailable(`The Service Bus emulator sent malformed AMQP: ${error.message}`, 'AMQP_FRAMING', provider));
    }
  });

  function receive(chunk) {
    input = input.length ? Buffer.concat([input, chunk]) : chunk;
    while (!failure) {
      if (phase === 'sasl-header' || phase === 'amqp-header') {
        if (input.length < 8) return;
        const header = input.subarray(0, 8),
          wanted = phase === 'sasl-header' ? SASL_HEADER : AMQP_HEADER;
        input = input.subarray(8);
        if (!header.equals(wanted))
          return fail(
            unavailable(
              'The peer answered a different protocol header; it is not an AMQP 1.0 broker with SASL.',
              'AMQP_PROTOCOL_MISMATCH',
              provider,
            ),
          );
        phase = phase === 'sasl-header' ? 'sasl' : 'amqp';
        answer('header');
        continue;
      }
      const item = readFrame(input, MAX_FRAME);
      if (!item) return;
      input = input.subarray(item.size);
      onFrame(item);
    }
  }

  function onFrame({ type, performative, payload }) {
    if (!performative) return; // heartbeat
    const f = performative.value ?? [];
    if (phase === 'sasl') {
      if (type !== 1) throw new Error('expected a SASL frame');
      if (performative.descriptor === CODE.saslMechanisms) answer('sasl-mechanisms', [f[0]].flat());
      if (performative.descriptor === CODE.saslOutcome) {
        phase = 'amqp-header';
        answer('sasl-outcome', f[0]);
      }
      return; // sasl-challenge is not part of PLAIN
    }
    switch (performative.descriptor) {
      case CODE.open:
        remoteMaxFrame = Math.max(512, Math.min(f[2] ?? MAX_FRAME, MAX_FRAME));
        // Idle timeout (2.4.5): send something at least every half of the peer's idle-time-out.
        if (f[4] > 0) {
          keepalive = setInterval(() => write(EMPTY_FRAME), Math.max(Math.floor(f[4] / 2), 50));
          keepalive.unref?.();
        }
        return answer('open');
      case CODE.begin:
        nextIncomingId = f[1] ?? 0;
        return answer('begin');
      case CODE.attach: {
        const link = links.get(f[0]);
        if (!link) return;
        link.remote = f[1];
        byRemote.set(f[1], link);
        if (link.role === 'receiver') link.deliveryCount = f[9] ?? 0;
        // A refused attach answers a null terminus and then a detach with the error.
        if ((link.role === 'sender' ? f[6] : f[5]) == null) return;
        return answer(`attach:${link.name}`);
      }
      case CODE.flow: {
        const link = f[4] == null ? null : byRemote.get(f[4]);
        if (!link) return; // session-level flow: windows are not enforced (see WINDOW)
        if (link.role === 'sender') {
          // 2.6.7: link-credit(snd) = delivery-count(rcv) + link-credit(rcv) - delivery-count(snd)
          link.credit = (f[5] ?? link.deliveryCount) + (f[6] ?? 0) - link.deliveryCount;
          if (link.credit > 0) answer(`credit:${link.name}`);
        } else if (link.draining && (f[6] ?? 0) === 0) {
          link.deliveryCount = f[5] ?? link.deliveryCount;
          link.credit = 0;
          answer(`drain:${link.name}`);
        }
        return;
      }
      case CODE.transfer: {
        const link = byRemote.get(f[0]);
        if (!link) return;
        if (!link.partial) {
          link.partial = { deliveryId: f[1], tag: f[2], settled: f[4] === true, chunks: [] };
          nextIncomingId = (f[1] ?? nextIncomingId) + 1;
        }
        if (payload?.length) link.partial.chunks.push(payload);
        if (f[5] === true) return; // more frames of this delivery follow
        const delivery = link.partial;
        link.partial = null;
        if (f[7] === true) return; // aborted
        link.deliveryCount += 1;
        link.credit = Math.max(0, link.credit - 1);
        link.buffer.push({
          deliveryId: delivery.deliveryId,
          tag: delivery.tag,
          settled: delivery.settled,
          payload: Buffer.concat(delivery.chunks),
        });
        if (link.buffer.length >= link.wanted) answer(`filled:${link.name}`);
        return;
      }
      case CODE.disposition: {
        if (f[0] !== true) return; // only the broker's settlement of our transfers is awaited
        const first = f[1],
          last = f[2] ?? first;
        for (const id of [...sending.keys()]) if (id >= first && id <= last) answer(`delivery:${id}`, f[4] ?? null);
        return;
      }
      case CODE.detach: {
        const link = byRemote.get(f[0]);
        if (!link) return;
        byRemote.delete(f[0]);
        links.delete(link.name);
        const error = f[2]
          ? amqpError(f[2], provider, `'${link.address}': `)
          : unavailable(`The emulator detached the link to '${link.address}'.`, 'AMQP_DETACHED', provider);
        link.failure ??= error;
        if (waits.has(`detach:${link.name}`)) return answer(`detach:${link.name}`);
        send(described(CODE.detach, [uint(link.handle), true]));
        for (const key of [`attach:${link.name}`, `credit:${link.name}`, `filled:${link.name}`, `drain:${link.name}`])
          waits.get(key)?.reject(link.failure);
        for (const [id, owner] of sending) if (owner === link) waits.get(`delivery:${id}`)?.reject(link.failure);
        return;
      }
      case CODE.end:
        return fail(
          f[0]
            ? amqpError(f[0], provider)
            : unavailable('The emulator ended the session.', 'AMQP_SESSION_ENDED', provider),
        );
      case CODE.close:
        if (closing) return answer('close');
        send(described(CODE.close, []));
        return fail(
          f[0]
            ? amqpError(f[0], provider)
            : unavailable('The emulator closed the connection.', 'AMQP_CONNECTION_CLOSED', provider),
        );
      default:
    }
  }

  try {
    await expect('connect', 'TCP connection');
    phase = 'sasl-header';
    let header = expect('header', 'SASL protocol header');
    const mechanisms = expect('sasl-mechanisms', 'SASL mechanisms');
    write(SASL_HEADER);
    await header;
    if (!(await mechanisms).includes('PLAIN'))
      throw new ProviderError('Unauthorized', 'The emulator does not offer SASL PLAIN.', {
        provider,
        diagnostic: 'SASL_PLAIN_UNAVAILABLE',
      });
    const outcome = expect('sasl-outcome', 'SASL outcome');
    {
      const { user, password } = credentials();
      // security 5.3.3.1 sasl-init; PLAIN initial response is NUL authzid NUL authcid NUL passwd (RFC 4616). Service Bus takes the
      // shared access rule name as user name and its key as password.
      // Assumption: the emulator accepts SASL PLAIN over plain TCP without CBS (the cloud documents CBS only with ANONYMOUS and TLS).
      write(
        frame(
          1,
          0,
          described(CODE.saslInit, [
            sym('PLAIN'),
            Buffer.concat([bytes(0), Buffer.from(String(user ?? '')), bytes(0), Buffer.from(String(password ?? ''))]),
            hostname,
          ]),
        ),
      );
    }
    credentials = null; // the key is not kept after SASL
    const code = await outcome;
    if (code !== 0) {
      throw new ProviderError(
        'Unauthorized',
        `SASL PLAIN authentication was refused (sasl-outcome ${code}: ${SASL_OUTCOMES[code] ?? 'unknown'}); check SharedAccessKeyName and SharedAccessKey.`,
        { provider, diagnostic: 'SASL_AUTH_FAILED' },
      );
    }
    header = expect('header', 'AMQP protocol header');
    write(AMQP_HEADER);
    await header;
    const opened = expect('open', 'open');
    send(described(CODE.open, [`paqvilo-${randomUUID()}`, hostname, uint(MAX_FRAME), ushort(0), null]));
    await opened;
    const begun = expect('begin', 'begin');
    send(described(CODE.begin, [null, uint(0), uint(WINDOW), uint(WINDOW)]));
    await begun;
  } catch (error) {
    fail(error);
    throw error;
  }

  const live = (link) => {
    if (failure) throw failure;
    if (link?.failure) throw link.failure;
  };
  const flow = (link, credit, drain = false) => {
    link.credit = credit;
    send(
      described(CODE.flow, [
        uint(nextIncomingId),
        uint(WINDOW),
        uint(nextOutgoingId),
        uint(WINDOW),
        uint(link.handle),
        uint(link.deliveryCount),
        uint(credit),
        null,
        drain,
      ]),
    );
  };
  // One operation at a time per link, so credit and fill waits never interleave.
  const exclusive = (link, task) => {
    const run = link.queue.then(task);
    link.queue = run.catch(() => {});
    return run;
  };

  return {
    get failed() {
      return failure;
    },
    /** Attach a link (2.7.3): role 'sender' targets address, 'receiver' sources it; settled: receive pre-settled (receive-and-delete). */
    async attach({ role, address, settled = false }) {
      live();
      const name = `paqvilo-${role}-${randomUUID()}`,
        handle = nextHandle++;
      const link = {
        name,
        handle,
        role,
        address,
        remote: null,
        credit: 0,
        deliveryCount: 0,
        buffer: [],
        wanted: Infinity,
        partial: null,
        draining: false,
        failure: null,
        queue: Promise.resolve(),
      };
      links.set(name, link);
      const attached = expect(`attach:${name}`, `attach answer for '${address}'`);
      const local = described(role === 'sender' ? CODE.source : CODE.target, [name]);
      const remote = described(role === 'sender' ? CODE.target : CODE.source, [address]);
      send(
        described(CODE.attach, [
          name,
          uint(handle),
          role === 'receiver',
          ubyte(settled ? 1 : 0),
          ubyte(0),
          role === 'sender' ? local : remote,
          role === 'sender' ? remote : local,
          null,
          null,
          role === 'sender' ? uint(0) : null,
        ]),
      );
      try {
        await attached;
      } catch (error) {
        links.delete(name);
        throw error;
      }
      return link;
    },
    /** Send message bytes unsettled and await the broker's disposition: accepted resolves, rejected throws its error. */
    transfer(link, payload) {
      return exclusive(link, async () => {
        live(link);
        while (link.credit <= 0) {
          await expect(`credit:${link.name}`, `link credit for '${link.address}'`);
          live(link);
        }
        link.credit -= 1;
        link.deliveryCount += 1;
        const id = nextOutgoingId++,
          tag = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
        const settled = expect(`delivery:${id}`, `disposition for the message sent to '${link.address}'`);
        sending.set(id, link);
        const room = remoteMaxFrame - 64; // ponytail: a transfer performative here stays under 64 bytes; measure it if fields grow
        try {
          for (let at = 0; at === 0 || at < payload.length; at += room) {
            const more = at + room < payload.length;
            send(
              described(
                CODE.transfer,
                at === 0
                  ? [uint(link.handle), uint(id), tag, uint(0), false, more]
                  : [uint(link.handle), null, null, null, null, more],
              ),
              payload.subarray(at, at + room),
            );
          }
          const state = await settled.catch((error) => {
            if (error?.diagnostic !== 'AMQP_CONNECTION_CLOSED') throw error;
            throw unavailable(
              `The message sent to '${link.address}' was not settled: ${error.message}`,
              'AMQP_CONNECTION_CLOSED',
              provider,
            );
          });
          if (state?.descriptor === CODE.accepted) return;
          if (state?.descriptor === CODE.rejected) throw amqpError(state.value?.[0], provider, `'${link.address}': `);
          throw unavailable(
            `The emulator did not accept the message sent to '${link.address}'.`,
            'AMQP_NOT_ACCEPTED',
            provider,
          );
        } finally {
          sending.delete(id);
        }
      });
    },
    /** Up to max deliveries: grant credit, wait up to waitMs for them, then drain (2.6.7) so no credit stays outstanding.
     * Deliveries that arrive after a drain that timed out stay buffered for the next take.
     * Assumption: the emulator answers drain with a flow (link-credit 0); without one the take ends after timeoutMs. */
    take(link, max, waitMs) {
      return exclusive(link, async () => {
        live(link);
        const taken = link.buffer.splice(0, max);
        if (taken.length >= max) return taken;
        link.wanted = max - taken.length;
        try {
          flow(link, link.wanted);
          if (waitMs > 0) await soft(expect(`filled:${link.name}`, 'messages', waitMs));
          if (link.buffer.length < link.wanted) {
            link.draining = true;
            const drained = expect(`drain:${link.name}`, `drain answer for '${link.address}'`);
            flow(link, link.credit, true);
            await soft(drained);
          }
        } finally {
          link.draining = false;
          link.wanted = Infinity;
        }
        return taken.concat(link.buffer.splice(0, max - taken.length));
      });
    },
    /** Settle a received delivery (2.7.6) with an outcome; Service Bus answers nothing to a receiver's settled disposition. */
    settle(link, deliveryId, state) {
      live(link);
      send(described(CODE.disposition, [true, uint(deliveryId), uint(deliveryId), true, state]));
    },
    async detach(link) {
      if (failure || link.failure || !links.has(link.name)) return;
      const done = expect(`detach:${link.name}`, 'detach answer');
      send(described(CODE.detach, [uint(link.handle), true]));
      await soft(done);
      links.delete(link.name);
    },
    async close() {
      if (failure) return;
      closing = true;
      const done = expect('close', 'close answer');
      send(described(CODE.close, []));
      await soft(done).catch(() => {});
      fail(unavailable('The connection was closed.', 'AMQP_CONNECTION_CLOSED', provider));
    },
  };
}
