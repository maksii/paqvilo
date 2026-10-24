import { Duplex } from 'node:stream';
import tls from 'node:tls';

// TDS wire framing for the Dataverse SQL endpoint (MS-TDS). No store or protocol-message knowledge here.
//
// API:
//   readPackets(stream)                 async iterator of { type, payload } messages, reassembled across packets.
//                                       Breaking out of the loop destroys the stream (for-await semantics).
//   createMessageReader(onMessage)      sync push parser: returns (chunk) => void; throws on malformed framing.
//   writeMessage(stream, type, payload, packetSize = 4096)
//                                       splits payload into packets of packetSize bytes (header included), EOM on the last.
//   encodePrelogin(fields) / decodePrelogin(payload)
//                                       fields keyed by name (version, encryption, instOpt, threadId, mars, traceId,
//                                       fedAuthRequired, nonceOpt); values are Buffers, or numbers for one byte.
//                                       decodePrelogin returns Buffers keyed the same way.
//   detectTdsMode(chunk)                first byte of a connection: 'tds8' (TLS first, 0x16), 'tds7' (PRELOGIN, 0x12) or null.
//   createPreloginTlsAdapter(stream, { raw, initial })
//                                       Duplex over a byte stream. Until the client sends a non-0x12 byte at a packet
//                                       boundary (its first raw TLS record), inbound is unwrapped from PRELOGIN packets and
//                                       outbound is wrapped in PRELOGIN packets, one message per flight. raw = true skips
//                                       both (TDS 8 strict). Server side only: the switch follows the client's first raw record.
//   acceptTls(stream, { secureContext, initial, strict })
//                                       server-side tls.TLSSocket over the adapter.
//                                       strict: TDS 8 ALPN 'tds/8.0', raw from the first byte. Non-strict callers should
//                                       pass a context with maxVersion 'TLSv1.2' (wrapped mode cannot carry TLS 1.3 tickets).
//                                       `initial` holds bytes already read from the stream.

export const TDS = Object.freeze({ SQL_BATCH: 0x01, TABULAR: 0x04, PRELOGIN: 0x12, LOGIN7: 0x10, RPC: 0x03 });
export const DEFAULT_PACKET_SIZE = 4096;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 8;
const EOM = 0x01;
const TDS8_ALPN = 'tds/8.0';
const EMPTY = Buffer.alloc(0);

// ---- message framing

export function createMessageReader(onMessage, { maxBytes = MAX_MESSAGE_BYTES } = {}) {
  let pending = EMPTY;
  let parts = [];
  let size = 0;
  let type;
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= HEADER_BYTES) {
      const length = pending.readUInt16BE(2);
      if (length < HEADER_BYTES) throw new Error(`TDS packet length ${length} is below the header size`);
      if (pending.length < length) break;
      if (type === undefined) type = pending[0];
      else if (pending[0] !== type) throw new Error('TDS message packets mix message types');
      parts.push(pending.subarray(HEADER_BYTES, length));
      size += length - HEADER_BYTES;
      if (size > maxBytes) throw new Error(`TDS message exceeds ${maxBytes} bytes`);
      const endOfMessage = (pending[1] & EOM) !== 0;
      pending = pending.subarray(length);
      if (endOfMessage) {
        const payload = parts.length === 1 ? parts[0] : Buffer.concat(parts);
        const messageType = type;
        parts = [];
        size = 0;
        type = undefined;
        onMessage(messageType, payload);
      }
    }
  };
}

export async function* readPackets(stream) {
  const messages = [];
  const reader = createMessageReader((messageType, payload) => messages.push({ type: messageType, payload }));
  for await (const chunk of stream) {
    reader(chunk);
    yield* messages.splice(0);
  }
}

export function writeMessage(stream, type, payload, packetSize = DEFAULT_PACKET_SIZE) {
  if (!Number.isInteger(packetSize) || packetSize < 512 || packetSize > 0xffff) {
    throw new RangeError(`TDS packet size ${packetSize} is out of range`);
  }
  const body = packetSize - HEADER_BYTES;
  const count = Math.max(1, Math.ceil(payload.length / body));
  const out = [];
  for (let i = 0; i < count; i++) {
    const chunk = payload.subarray(i * body, (i + 1) * body);
    const header = Buffer.alloc(HEADER_BYTES);
    header[0] = type;
    header[1] = i === count - 1 ? EOM : 0;
    header.writeUInt16BE(chunk.length + HEADER_BYTES, 2);
    header[6] = (i + 1) & 0xff;
    out.push(header, chunk);
  }
  stream.write(Buffer.concat(out));
}

// ---- PRELOGIN (MS-TDS 2.2.6.5)

const PRELOGIN_TOKENS = Object.freeze({
  version: 0x00,
  encryption: 0x01,
  instOpt: 0x02,
  threadId: 0x03,
  mars: 0x04,
  traceId: 0x05,
  fedAuthRequired: 0x06,
  nonceOpt: 0x07,
});
const PRELOGIN_TERMINATOR = 0xff;
const PRELOGIN_NAMES = Object.fromEntries(Object.entries(PRELOGIN_TOKENS).map(([name, token]) => [token, name]));

export function encodePrelogin(fields) {
  const entries = Object.entries(fields).map(([name, value]) => {
    const token = PRELOGIN_TOKENS[name];
    if (token === undefined) throw new Error(`unknown PRELOGIN option ${name}`);
    return [token, typeof value === 'number' ? Buffer.from([value]) : value];
  });
  let offset = entries.length * 5 + 1;
  const index = [];
  const data = [];
  for (const [token, value] of entries) {
    const entry = Buffer.alloc(5);
    entry[0] = token;
    entry.writeUInt16BE(offset, 1);
    entry.writeUInt16BE(value.length, 3);
    index.push(entry);
    data.push(value);
    offset += value.length;
  }
  return Buffer.concat([...index, Buffer.from([PRELOGIN_TERMINATOR]), ...data]);
}

export function decodePrelogin(payload) {
  const fields = {};
  for (let i = 0; ; i += 5) {
    if (i >= payload.length) throw new Error('PRELOGIN options are not terminated');
    const token = payload[i];
    if (token === PRELOGIN_TERMINATOR) break;
    if (i + 5 > payload.length) throw new Error('PRELOGIN option table is truncated');
    const offset = payload.readUInt16BE(i + 1);
    const length = payload.readUInt16BE(i + 3);
    if (offset + length > payload.length) throw new Error(`PRELOGIN option ${token} points outside the message`);
    fields[PRELOGIN_NAMES[token] ?? `0x${token.toString(16).padStart(2, '0')}`] = payload.subarray(offset, offset + length);
  }
  return fields;
}

// ---- TDS 7.x (PRELOGIN wrapped TLS) and TDS 8.0 (strict, TLS first)

export function detectTdsMode(chunk) {
  if (chunk[0] === 0x16) return 'tds8'; // TLS handshake record before any TDS message
  if (chunk[0] === TDS.PRELOGIN) return 'tds7';
  return null;
}

export function createPreloginTlsAdapter(stream, { raw = false, initial = EMPTY } = {}) {
  return new PreloginTlsAdapter(stream, raw, initial);
}

class PreloginTlsAdapter extends Duplex {
  #stream;
  #raw;
  #inbound = EMPTY;
  #pending = [];

  constructor(stream, raw, initial) {
    super();
    this.#stream = stream;
    this.#raw = raw;
    stream.on('data', (chunk) => this.#receive(chunk));
    stream.once('end', () => this.push(null));
    stream.once('error', (error) => this.destroy(error));
    stream.once('close', () => this.destroy());
    if (initial.length) this.#receive(initial);
  }

  #receive(chunk) {
    if (this.#raw) return this.push(chunk);
    this.#inbound = this.#inbound.length ? Buffer.concat([this.#inbound, chunk]) : chunk;
    while (this.#inbound.length) {
      if (this.#inbound[0] !== TDS.PRELOGIN) { // the client's first raw TLS record: its handshake packets are over
        this.#flush(); // the server's handshake flight is complete, so it goes out in PRELOGIN packets
        this.#raw = true;
        const rest = this.#inbound;
        this.#inbound = EMPTY;
        return this.push(rest);
      }
      if (this.#inbound.length < HEADER_BYTES) return;
      const length = this.#inbound.readUInt16BE(2);
      if (length < HEADER_BYTES) return this.destroy(new Error(`TDS packet length ${length} is below the header size`));
      if (this.#inbound.length < length) return;
      this.push(this.#inbound.subarray(HEADER_BYTES, length));
      this.#inbound = this.#inbound.subarray(length);
    }
  }

  #flush() {
    if (!this.#pending.length) return;
    const payload = Buffer.concat(this.#pending);
    this.#pending = [];
    writeMessage(this.#stream, TDS.PRELOGIN, payload);
  }

  _write(chunk, _encoding, callback) {
    if (this.#raw) return this.#stream.write(chunk, callback);
    this.#pending.push(chunk);
    if (this.#pending.length === 1) setImmediate(() => this.#flush()); // one PRELOGIN message per flight
    callback();
  }

  _read() {}

  _final(callback) {
    this.#flush();
    this.#stream.end();
    callback();
  }

  _destroy(error, callback) {
    this.#stream.destroy();
    callback(error);
  }
}

export function acceptTls(stream, { secureContext, initial = EMPTY, strict = false } = {}) {
  const adapter = createPreloginTlsAdapter(stream, { raw: strict, initial });
  return new tls.TLSSocket(adapter, {
    isServer: true,
    secureContext,
    ...(strict ? { ALPNProtocols: [TDS8_ALPN] } : {}),
  });
}
