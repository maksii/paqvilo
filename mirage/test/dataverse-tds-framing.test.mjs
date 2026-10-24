import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { Duplex, Readable } from 'node:stream';
import tls from 'node:tls';
import { test } from 'node:test';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';
import {
  acceptTls,
  createMessageReader,
  decodePrelogin,
  detectTdsMode,
  encodePrelogin,
  readPackets,
  TDS,
  writeMessage,
} from '../lib/dataverse-tds-framing.mjs';

const TIMEOUT = 15_000;
const VERSION = Buffer.from([12, 0, 0x07, 0xd0, 0, 0]);

function collect() {
  const out = [];
  return { stream: { write: (buffer) => out.push(buffer) }, bytes: () => Buffer.concat(out) };
}

// Feeds bytes to a fresh reader and returns the messages it emits.
function decodeAll(bytes, slice = bytes.length) {
  const messages = [];
  const reader = createMessageReader((type, payload) => messages.push({ type, payload }));
  for (let i = 0; i < bytes.length; i += slice) reader(bytes.subarray(i, i + slice));
  return messages;
}

// Resolves with the next complete message and stops listening, leaving the stream open.
function nextMessage(stream) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      try {
        reader(chunk);
      } catch (error) {
        stream.off('data', onData);
        reject(error);
      }
    };
    const reader = createMessageReader((type, payload) => {
      stream.off('data', onData);
      resolve({ type, payload });
    });
    stream.on('data', onData);
  });
}

// Test-side client wrapper, written independently of the library adapter: TLS writes are PRELOGIN-wrapped until
// setRaw() (called on 'secure'); inbound packets are unwrapped until the first raw TLS record.
function wrapClient(net1) {
  let outRaw = false;
  let inRaw = false;
  let inbound = Buffer.alloc(0);
  const duplex = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      if (outRaw) return net1.write(chunk, callback);
      writeMessage(net1, TDS.PRELOGIN, chunk);
      callback();
    },
    final(callback) {
      net1.end();
      callback();
    },
    destroy(error, callback) {
      net1.destroy();
      callback(error);
    },
  });
  net1.on('data', (chunk) => {
    if (inRaw) return duplex.push(chunk);
    inbound = Buffer.concat([inbound, chunk]);
    while (inbound.length) {
      if (inbound[0] !== TDS.PRELOGIN) {
        inRaw = true;
        duplex.push(inbound);
        inbound = Buffer.alloc(0);
        return;
      }
      if (inbound.length < 8) return;
      const length = inbound.readUInt16BE(2);
      if (inbound.length < length) return;
      duplex.push(inbound.subarray(8, length));
      inbound = inbound.subarray(length);
    }
  });
  net1.on('end', () => duplex.push(null));
  return {
    duplex,
    setRaw: () => {
      outRaw = true;
    },
  };
}

test('reassembles a multi-packet message split at arbitrary byte boundaries', () => {
  const payload = Buffer.from(Array.from({ length: 1500 }, (_, i) => i % 251));
  const sink = collect();
  writeMessage(sink.stream, TDS.TABULAR, payload, 512); // 504-byte bodies: three packets
  const bytes = sink.bytes();
  assert.equal(bytes[0], TDS.TABULAR);
  assert.equal(bytes[1], 0, 'first packet is not end of message');
  assert.equal(bytes.readUInt16BE(2), 512);
  assert.equal(bytes[6], 1, 'packet ids start at 1');
  for (const slice of [1, 7, 512, bytes.length]) {
    const messages = decodeAll(bytes, slice);
    assert.equal(messages.length, 1, `slice ${slice}`);
    assert.equal(messages[0].type, TDS.TABULAR);
    assert.deepEqual(messages[0].payload, payload);
  }
});

test('emits consecutive messages, including an empty payload, from one chunk', () => {
  const sink = collect();
  writeMessage(sink.stream, TDS.SQL_BATCH, Buffer.from('select 1', 'utf8'));
  writeMessage(sink.stream, TDS.TABULAR, Buffer.alloc(0));
  const messages = decodeAll(sink.bytes());
  assert.deepEqual(
    messages.map((m) => [m.type, m.payload.toString()]),
    [
      [TDS.SQL_BATCH, 'select 1'],
      [TDS.TABULAR, ''],
    ],
  );
});

test('writeMessage splits by packet size and rejects a length below the header', () => {
  const sink = collect();
  writeMessage(sink.stream, TDS.PRELOGIN, Buffer.alloc(1100), 512);
  const bytes = sink.bytes();
  const lengths = [];
  for (let at = 0; at < bytes.length; at += bytes.readUInt16BE(at + 2))
    lengths.push([bytes.readUInt16BE(at + 2), bytes[at + 1]]);
  assert.deepEqual(lengths, [
    [512, 0],
    [512, 0],
    [100, 1],
  ]);
  assert.throws(() => decodeAll(Buffer.from([0x04, 0x01, 0x00, 0x04, 0, 0, 1, 0])), /below the header size/);
  assert.throws(() => writeMessage(sink.stream, TDS.PRELOGIN, Buffer.alloc(1), 100), RangeError);
});

test('PRELOGIN round-trips every option and terminates the option table', () => {
  const fields = {
    version: VERSION,
    encryption: 0x01,
    instOpt: 0x00,
    threadId: Buffer.alloc(0),
    mars: 0x00,
    traceId: Buffer.alloc(36, 0x61),
    fedAuthRequired: 0x01,
    nonceOpt: Buffer.alloc(32, 0x07),
  };
  const encoded = encodePrelogin(fields);
  assert.equal(encoded[8 * 5], 0xff, 'terminator follows the eight-entry table');
  const decoded = decodePrelogin(encoded);
  assert.deepEqual(Object.keys(decoded), Object.keys(fields));
  for (const [name, value] of Object.entries(fields))
    assert.deepEqual(decoded[name], typeof value === 'number' ? Buffer.from([value]) : value, name);
  assert.equal(decodePrelogin(encodePrelogin({ encryption: 0x02 })).encryption[0], 0x02);
  assert.throws(() => decodePrelogin(Buffer.from([0x01, 0x00, 0x05, 0x00, 0x00])), /not terminated/);
  assert.throws(() => decodePrelogin(Buffer.from([0x01, 0x00, 0x06, 0x00, 0x09, 0xff])), /outside the message/);
  assert.throws(() => encodePrelogin({ bogus: 1 }), /unknown PRELOGIN option/);
});

test('detectTdsMode separates TLS-first strict connections from PRELOGIN', () => {
  assert.equal(detectTdsMode(Buffer.from([0x16, 0x03])), 'tds8');
  assert.equal(detectTdsMode(Buffer.from([0x12, 0x01])), 'tds7');
  assert.equal(detectTdsMode(Buffer.from([0x01])), null);
});

test('PRELOGIN-wrapped TLS 1.2 handshake carries a multi-packet reply both ways', { timeout: TIMEOUT }, async (t) => {
  const { key, cert } = createSelfSignedCertificate();
  const secureContext = tls.createSecureContext({ key, cert, maxVersion: 'TLSv1.2' });
  let resolveServerTls;
  const serverTlsReady = new Promise((resolve) => {
    resolveServerTls = resolve;
  });
  const server = net.createServer(async (socket) => {
    const prelogin = await nextMessage(socket);
    assert.equal(prelogin.type, TDS.PRELOGIN);
    assert.equal(decodePrelogin(prelogin.payload).encryption[0], 0x01);
    writeMessage(socket, TDS.TABULAR, encodePrelogin({ version: VERSION, encryption: 0x01, fedAuthRequired: 0x01 }));
    const tlsSocket = acceptTls(socket, { secureContext });
    tlsSocket.once('secure', () => resolveServerTls(tlsSocket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const sockets = [];
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  const net1 = net.connect(port, '127.0.0.1');
  sockets.push(net1);
  await once(net1, 'connect');
  writeMessage(net1, TDS.PRELOGIN, encodePrelogin({ version: VERSION, encryption: 0x01 }));
  const reply = await nextMessage(net1);
  assert.equal(reply.type, TDS.TABULAR);
  assert.equal(decodePrelogin(reply.payload).fedAuthRequired[0], 0x01);
  const wrapper = wrapClient(net1);
  const clientTls = tls.connect({ socket: wrapper.duplex, ca: cert, servername: 'localhost' });
  sockets.push(clientTls);
  clientTls.once('secure', () => wrapper.setRaw());
  await once(clientTls, 'secureConnect');
  const serverTls = await serverTlsReady;
  sockets.push(serverTls);
  assert.equal(serverTls.getProtocol(), 'TLSv1.2');

  const big = Buffer.from(Array.from({ length: 10_000 }, (_, i) => (i * 7) % 256));
  const received = nextMessage(clientTls);
  writeMessage(serverTls, TDS.TABULAR, big, 512);
  const got = await received;
  assert.equal(got.type, TDS.TABULAR);
  assert.deepEqual(got.payload, big);

  const query = Buffer.from('select 1', 'utf8');
  writeMessage(clientTls, TDS.SQL_BATCH, query);
  const fromClient = await nextMessage(serverTls);
  assert.deepEqual(fromClient.payload, query);
});

test(
  'TDS 8 strict: TLS first on the raw socket, ALPN tds/8.0, PRELOGIN inside TLS',
  { timeout: TIMEOUT },
  async (t) => {
    const { key, cert } = createSelfSignedCertificate();
    const secureContext = tls.createSecureContext({ key, cert });
    const server = net.createServer((socket) => {
      socket.once('data', async (first) => {
        assert.equal(detectTdsMode(first), 'tds8');
        const tlsSocket = acceptTls(socket, { secureContext, initial: first, strict: true });
        await once(tlsSocket, 'secure');
        assert.equal(tlsSocket.alpnProtocol, 'tds/8.0');
        const prelogin = await nextMessage(tlsSocket);
        assert.equal(prelogin.type, TDS.PRELOGIN);
        writeMessage(tlsSocket, TDS.TABULAR, encodePrelogin({ version: VERSION, encryption: 0x01 }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = tls.connect({
      host: '127.0.0.1',
      port: server.address().port,
      servername: 'localhost',
      ca: cert,
      ALPNProtocols: ['tds/8.0'],
    });
    t.after(() => {
      client.destroy();
      server.close();
    });
    await once(client, 'secureConnect');
    assert.equal(client.alpnProtocol, 'tds/8.0');
    writeMessage(client, TDS.PRELOGIN, encodePrelogin({ version: VERSION, encryption: 0x01, mars: 0x00 }));
    const reply = await nextMessage(client);
    assert.equal(reply.type, TDS.TABULAR);
    assert.equal(decodePrelogin(reply.payload).encryption[0], 0x01);
  },
);

test('readPackets yields reassembled messages from a stream', async () => {
  const payload = Buffer.from('x'.repeat(3000));
  const sink = collect();
  writeMessage(sink.stream, TDS.TABULAR, payload, 512);
  writeMessage(sink.stream, TDS.TABULAR, Buffer.from('tail'));
  const bytes = sink.bytes();
  const source = Readable.from([bytes.subarray(0, 100), bytes.subarray(100)]);
  const seen = [];
  for await (const message of readPackets(source)) seen.push(message);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].payload, payload);
  assert.equal(seen[1].payload.toString(), 'tail');
});
