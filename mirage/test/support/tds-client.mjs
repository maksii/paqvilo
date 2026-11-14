// A hand-built TDS 8 client for the TDS endpoint suites (dataverse-tds-protocol, dataverse-tds-integration, trace-tds): TLS
// first with ALPN tds/8.0 against a loopback certificate, PRELOGIN, LOGIN7 with a FEDAUTH access token, SQL_BATCH.
// Replies are read whole; the assertions search their bytes.
import { once } from 'node:events';
import tls from 'node:tls';
import { TDS, createMessageReader, encodePrelogin, writeMessage } from '../../lib/dataverse-tds-framing.mjs';

export const utf16 = (value) => Buffer.from(value, 'utf16le');
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

// LOGIN7 (MS-TDS 2.2.6.4): the 94-byte fixed header, UTF-16LE variable data, and a FeatureExt with FEDAUTH (SecurityToken,
// library 1) carrying the access token.
export function login7({ user = 'tester', database = 'org', token }) {
  const fixed = Buffer.alloc(94);
  fixed.writeUInt32LE(0x74000004, 4);
  fixed.writeUInt32LE(4096, 8);
  fixed.writeUInt8(0x10, 27); // OptionFlags3: FeatureExt present
  const variable = [];
  let at = 94;
  const put = (slot, value) => {
    const data = utf16(value);
    fixed.writeUInt16LE(at, slot);
    fixed.writeUInt16LE(value.length, slot + 2);
    variable.push(data);
    at += data.length;
  };
  put(36, 'client-host');
  put(40, user);
  put(48, 'paqvilo-test');
  put(52, 'mirage');
  put(60, 'paqvilo-test-lib');
  put(68, database);
  const tokenBytes = utf16(token);
  const fedAuthData = Buffer.concat([Buffer.from([0x03]), u32(tokenBytes.length), tokenBytes]); // options (lib 1 << 1 | echo), token
  const feature = Buffer.concat([Buffer.from([0x02]), u32(fedAuthData.length), fedAuthData, Buffer.from([0xff])]);
  fixed.writeUInt16LE(at, 56); // ibExtension: where the FeatureExt pointer DWORD sits
  variable.push(u32(at + 4), feature);
  const body = Buffer.concat([fixed, ...variable]);
  body.writeUInt32LE(body.length, 0);
  return body;
}

// SQL_BATCH: ALL_HEADERS with a transaction descriptor, then UTF-16LE text.
export function sqlBatch(sql) {
  const headers = Buffer.alloc(22);
  headers.writeUInt32LE(22, 0);
  headers.writeUInt32LE(18, 4);
  headers.writeUInt16LE(2, 8);
  headers.writeUInt32LE(1, 18);
  return Buffer.concat([headers, utf16(sql)]);
}

// A TDS 8 connection trusting only ca: send(type, payload) writes one message, next() resolves with the next whole reply
// payload.
export async function connectTds(port, ca) {
  const socket = tls.connect({ host: '127.0.0.1', port, ALPNProtocols: ['tds/8.0'], ca });
  socket.on('error', () => {});
  await once(socket, 'secureConnect');
  const queue = [];
  const waiting = [];
  socket.on(
    'data',
    createMessageReader((type, payload) => {
      const resume = waiting.shift();
      if (resume) resume(payload);
      else queue.push(payload);
    }),
  );
  return {
    socket,
    send: (type, payload) => writeMessage(socket, type, payload),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve))),
    close: () => socket.destroy(),
  };
}

// PRELOGIN (encryption on, FEDAUTH required), then LOGIN7 with the token: the client and the login reply.
export async function tdsLogin(port, token, ca) {
  const client = await connectTds(port, ca);
  client.send(
    TDS.PRELOGIN,
    encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }),
  );
  await client.next();
  client.send(TDS.LOGIN7, login7({ token }));
  return { client, reply: await client.next() };
}

// One SQL batch: resolves with its whole reply.
export function tdsQuery(client, sql) {
  client.send(TDS.SQL_BATCH, sqlBatch(sql));
  return client.next();
}
