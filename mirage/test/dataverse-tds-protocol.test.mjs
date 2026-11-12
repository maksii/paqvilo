// @test-kind unproven: local model of the Dataverse TDS endpoint protocol exchange; no native capture cited
// Dataverse TDS protocol server (dataverse-tds-protocol.mjs). The unit tests drive TDS 8 strict mode with a hand-built
// client over TLS (no client library). The end-to-end tests use tedious and are skipped unless TDS_TEDIOUS_PATH names the
// tedious entry file, for example:
//   npm install --prefix <dir> tedious@20.3.8
//   TDS_TEDIOUS_PATH=<dir>/node_modules/tedious/lib/tedious.js
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';
import {
  TDS,
  createMessageReader,
  decodePrelogin,
  encodePrelogin,
  writeMessage,
} from '../lib/dataverse-tds-framing.mjs';
import { createTdsServer } from '../lib/dataverse-tds-protocol.mjs';
import { columnMetadata, decodeRow } from '../lib/dataverse-tds-types.mjs';
import { login7, sqlBatch } from './support/tds-client.mjs';

const VALID_TOKEN = 'valid-token';
const DONE = 0xfd;
const ERROR = 0xaa;
const FEATURE_ACK_FEDAUTH = Buffer.from([0xae, 0x02, 0, 0, 0, 0, 0xff]);

let waitStarted = null;
const one = (columns, rows) => ({ resultSets: [{ columns, rows }] });

// Test SQL: "SELECT 1 AS x", "SELECT @p AS v", "SELECT missing", "LONG" (an error naming 70,000 characters), "MULTI",
// "WAIT" (runs until cancelled) and anything else (empty).
function onQuery({ sql, params, signal }) {
  const text = sql.trim();
  if (/^SELECT 1 AS x$/i.test(text)) return one([{ name: 'x', type: 'int' }], [[1]]);
  if (/^SELECT @p AS v$/i.test(text)) return one([{ name: 'v', type: 'int' }], [[params['@p']]]);
  if (/^SELECT missing$/i.test(text))
    throw { number: 208, message: "Invalid object name 'missing'.", state: 1, class: 16 };
  if (/^LONG$/i.test(text))
    throw { number: 208, message: `Invalid object name '${'x'.repeat(70000)}'.`, state: 1, class: 16 };
  if (/^MULTI$/i.test(text)) {
    return {
      resultSets: [
        { columns: [{ name: 'a', type: 'int' }], rows: [[1], [2]] },
        { columns: [{ name: 'b', type: 'nvarchar' }], rows: [['x']] },
      ],
    };
  }
  if (/^WAIT$/i.test(text)) {
    waitStarted?.();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(one([{ name: 'x', type: 'int' }], [[0]])), 10_000);
      timer.unref();
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      });
    });
  }
  return { resultSets: [] };
}

async function onLogin({ token }) {
  return token === VALID_TOKEN ? { ok: true, principal: { name: 'tester' } } : { ok: false };
}

// Asks for a token (FEDAUTHINFO) while the token is empty, then decides as onLogin does.
async function onFedAuthLogin(args) {
  if (!args.token) return { fedAuthInfo: { stsUrl: 'https://sts.invalid/tenant', spn: 'https://sts.invalid' } };
  return onLogin(args);
}

async function startServer(query = onQuery, login = onLogin) {
  const { key, cert } = createSelfSignedCertificate();
  const secureContext = tls.createSecureContext({ key, cert, maxVersion: 'TLSv1.2' });
  const srv = createTdsServer({ secureContext, onLogin: login, onQuery: query });
  const address = await srv.listen(0, '127.0.0.1');
  return { ...srv, port: address.port, cert };
}

// Hand-built TDS 8 client: TLS first (ALPN tds/8.0), then TDS messages inside TLS.
async function connectStrict(port, ca) {
  const socket = tls.connect({ host: '127.0.0.1', port, ALPNProtocols: ['tds/8.0'], ca });
  socket.on('error', () => {});
  await once(socket, 'secureConnect');
  const queue = [];
  const waiting = [];
  socket.on(
    'data',
    createMessageReader((type, payload) => {
      const resume = waiting.shift();
      if (resume) resume({ type, payload });
      else queue.push({ type, payload });
    }),
  );
  return {
    socket,
    send: (type, payload) => writeMessage(socket, type, payload),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve))),
  };
}

async function loginStrict(port, ca) {
  const client = await connectStrict(port, ca);
  client.send(
    TDS.PRELOGIN,
    encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }),
  );
  await client.next();
  client.send(TDS.LOGIN7, login7({ token: VALID_TOKEN }));
  const response = await client.next();
  assert.equal(response.payload[0], 0xe3, 'login response starts with ENVCHANGE');
  return client;
}

// DONE status for the final token of a reply, which is always 13 bytes.
const finalDoneStatus = (payload) => payload.readUInt16LE(payload.length - 12);

// One TDS packet: type, end-of-message status, big-endian length, SPID, packet id, window, then the body.
function rawPacket(type, endOfMessage, body) {
  const header = Buffer.from([type, endOfMessage ? 0x01 : 0x00, 0, 0, 0, 0, 0, 0]);
  header.writeUInt16BE(8 + body.length, 2);
  return Buffer.concat([header, body]);
}

describe('TDS protocol over TDS 8 strict (hand-built client)', () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });

  test('PRELOGIN answers the version, encryption off and FEDAUTHREQUIRED', async () => {
    const client = await connectStrict(server.port, server.cert);
    try {
      client.send(
        TDS.PRELOGIN,
        encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }),
      );
      const reply = await client.next();
      assert.equal(reply.type, TDS.TABULAR);
      const fields = decodePrelogin(reply.payload);
      assert.deepEqual([...fields.version], [12, 0, 0x07, 0xd0, 0, 0]);
      assert.deepEqual([...fields.encryption], [0x00]);
      assert.deepEqual([...fields.fedAuthRequired], [0x01]);
    } finally {
      client.socket.destroy();
    }
  });

  test('LOGIN7 with a valid token gets ENVCHANGE, LOGINACK, FEATUREEXTACK FEDAUTH and DONE', async () => {
    const client = await connectStrict(server.port, server.cert);
    try {
      client.send(
        TDS.PRELOGIN,
        encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }),
      );
      await client.next();
      client.send(TDS.LOGIN7, login7({ token: VALID_TOKEN }));
      const { payload } = await client.next();
      assert.equal(payload[0], 0xe3, 'ENVCHANGE first');
      assert.ok(payload.indexOf(Buffer.from([0xad])) > 0, 'LOGINACK present');
      assert.ok(payload.indexOf(FEATURE_ACK_FEDAUTH) > 0, 'empty FEDAUTH feature ack present');
      assert.equal(payload[payload.length - 13], DONE, 'login ends with DONE');
      assert.equal(finalDoneStatus(payload), 0);
    } finally {
      client.socket.destroy();
    }
  });

  test('LOGIN7 with a rejected token gets ERROR 18456 and the connection closes', async () => {
    const client = await connectStrict(server.port, server.cert);
    try {
      client.send(TDS.PRELOGIN, encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01 }));
      await client.next();
      client.send(TDS.LOGIN7, login7({ token: 'wrong-token' }));
      const reply = await client.next();
      assert.equal(reply.payload[0], ERROR);
      assert.equal(reply.payload.readInt32LE(3), 18456);
      await once(client.socket, 'close');
    } finally {
      client.socket.destroy();
    }
  });

  test('ATTENTION on an idle connection is answered with DONE carrying the ATTN status', async () => {
    const client = await loginStrict(server.port, server.cert);
    try {
      client.send(0x06, Buffer.alloc(0));
      const reply = await client.next();
      assert.equal(reply.payload[0], DONE);
      assert.equal(reply.payload.readUInt16LE(1) & 0x20, 0x20);
    } finally {
      client.socket.destroy();
    }
  });

  test('a query error is ERROR followed by DONE with the ERROR status', async () => {
    const client = await loginStrict(server.port, server.cert);
    try {
      client.send(TDS.SQL_BATCH, sqlBatch('SELECT missing'));
      const reply = await client.next();
      assert.equal(reply.payload[0], ERROR);
      assert.equal(reply.payload.readInt32LE(3), 208);
      assert.equal(finalDoneStatus(reply.payload) & 0x02, 0x02);
    } finally {
      client.socket.destroy();
    }
  });

  test('multiple result sets set MORE on every DONE except the last', async () => {
    const client = await loginStrict(server.port, server.cert);
    try {
      client.send(TDS.SQL_BATCH, sqlBatch('MULTI'));
      const reply = await client.next();
      // First set ends with DONE status MORE (0x01) | COUNT (0x10); the last set ends with COUNT only.
      assert.ok(
        reply.payload.indexOf(Buffer.from([DONE, 0x11, 0x00])) >= 0,
        'DONE with MORE|COUNT after the first set',
      );
      assert.equal(finalDoneStatus(reply.payload), 0x10);
    } finally {
      client.socket.destroy();
    }
  });

  // ALL_HEADERS is the 22-byte prefix of an empty SQL batch; RPC parameters are a name, a status byte and TYPE_INFO.
  const rpcHeaders = sqlBatch('').subarray(0, 22);
  const utf16 = (text) => Buffer.from(text, 'utf16le');
  const nvarcharType = (text) => {
    const length = Buffer.alloc(2);
    length.writeUInt16LE(utf16(text).length);
    return Buffer.concat([Buffer.from([0xe7, 0xa0, 0x0f, 0x09, 0x04, 0xd0, 0x00, 0x34]), length, utf16(text)]);
  };
  const unnamed = (typed) => Buffer.concat([Buffer.from([0, 0]), typed]);
  const named = (name, typed) => Buffer.concat([Buffer.from([name.length, 0]), utf16(name), typed]);
  const executeSqlRpc = (stmt, ...params) =>
    Buffer.concat([rpcHeaders, Buffer.from([0xff, 0xff, 10, 0, 0, 0]), unnamed(nvarcharType(stmt)), ...params]);
  const VARCHAR_TYPE = Buffer.from([0xa7, 0x0a, 0x00, 0x09, 0x04, 0xd0, 0x00, 0x34, 0x03, 0x61, 0x62, 0x63]);
  const INT_TYPE = Buffer.from([0x26, 4, 4, 7, 0, 0, 0]);

  // The failed request gets ERROR + DONE(ERROR); the same connection then answers the next batch with COLMETADATA.
  async function assertUsableAfter(client, check) {
    const reply = await client.next();
    assert.equal(reply.payload[0], ERROR);
    assert.equal(finalDoneStatus(reply.payload) & 0x02, 0x02);
    if (check) check(reply.payload);
    client.send(TDS.SQL_BATCH, sqlBatch('SELECT 1 AS x'));
    assert.equal((await client.next()).payload[0], 0x81);
  }

  // @test-kind contract: an RPC parameter the endpoint does not decode is an ERROR reply, not a dropped connection.
  test('an unsupported RPC parameter type gets ERROR and the connection stays usable', async () => {
    const client = await loginStrict(server.port, server.cert);
    try {
      client.send(TDS.RPC, executeSqlRpc('SELECT @p1', named('@p1', VARCHAR_TYPE)));
      await assertUsableAfter(client, (payload) => assert.match(payload.toString('utf16le', 11), /varchar/));
    } finally {
      client.socket.destroy();
    }
  });

  // @test-kind contract: an RPC whose last value is cut short is an ERROR reply, not a dropped connection.
  test('a truncated RPC gets ERROR and the connection stays usable', async () => {
    const client = await loginStrict(server.port, server.cert);
    try {
      const full = executeSqlRpc('SELECT @p1', named('@p1', INT_TYPE));
      client.send(TDS.RPC, full.subarray(0, full.length - 3));
      await assertUsableAfter(client);
    } finally {
      client.socket.destroy();
    }
  });

  // @test-kind security: a PRELOGIN over 64 KiB is refused before it completes, so a silent peer cannot stream one.
  test('an oversize PRELOGIN closes the connection before it completes', async () => {
    const socket = net.connect(server.port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    // Seventeen non-final 4096-byte packets: 69,632 bytes, and the message never ends.
    for (let i = 0; i < 17; i += 1) socket.write(rawPacket(TDS.PRELOGIN, false, Buffer.alloc(4088)));
    await once(socket, 'close');
  });

  // @test-kind security: over TDS 8 the 64 KiB PRELOGIN limit applies too, so the peer is cut off at 65,537 bytes.
  test('an oversize PRELOGIN over TDS 8 closes the connection before it completes', async () => {
    const client = await connectStrict(server.port, server.cert);
    const closed = once(client.socket, 'close');
    // Sixteen non-final packets carry exactly 64 KiB of payload; the one-byte packet after them is the 65,537th byte.
    for (let i = 0; i < 16; i += 1) client.socket.write(rawPacket(TDS.PRELOGIN, false, Buffer.alloc(4096)));
    client.socket.write(rawPacket(TDS.PRELOGIN, false, Buffer.alloc(1)));
    await closed;
  });

  // @test-kind contract: server error text longer than the ERROR token can carry is capped, not a dropped connection.
  test('an error text of 70,000 characters is capped and the connection stays usable', async () => {
    const client = await loginStrict(server.port, server.cert);
    try {
      client.send(TDS.SQL_BATCH, sqlBatch('LONG'));
      await assertUsableAfter(client, (payload) => assert.equal(payload.readUInt16LE(9), 4000));
    } finally {
      client.socket.destroy();
    }
  });
});

// A FEDAUTH token message (MS-TDS 2.2.6.8, type 0x08) with a payload that the endpoint must refuse as malformed.
const FEDAUTH_TOKEN = 0x08;
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const MALFORMED_FEDAUTH_TOKENS = {
  'shorter than its header': Buffer.from([1, 2, 3, 4]),
  'token length beyond the payload': Buffer.concat([u32(0), u32(100), Buffer.from('ab', 'utf16le')]),
  'odd UTF-16LE token length': Buffer.concat([u32(0), u32(3), Buffer.from('abc')]),
};

// @test-kind contract: a FEDAUTH token message cut short or inconsistent is an ERROR reply, and the connection stays usable.
test('a malformed FEDAUTH token message gets ERROR and a later login on the same connection succeeds', async () => {
  const fedServer = await startServer(onQuery, onFedAuthLogin);
  const client = await connectStrict(fedServer.port, fedServer.cert);
  try {
    client.send(
      TDS.PRELOGIN,
      encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }),
    );
    await client.next();
    for (const [shape, payload] of Object.entries(MALFORMED_FEDAUTH_TOKENS)) {
      client.send(TDS.LOGIN7, login7({ token: '' }));
      assert.equal((await client.next()).payload[0], 0xee, `${shape}: the login asks for a token`);
      client.send(FEDAUTH_TOKEN, payload);
      // A closed connection never answers: the close wins the race, and the assertion below names the shape.
      const answer = await Promise.race([client.next(), once(client.socket, 'close').then(() => null)]);
      assert.ok(answer, `${shape}: the server answers instead of closing`);
      assert.equal(answer.payload[0], ERROR, `${shape}: ERROR token`);
      assert.equal(answer.payload.readUInt32LE(3), 50000, `${shape}: protocol error number`);
      assert.ok(answer.payload.indexOf(Buffer.from('FEDAUTH', 'utf16le')) > 0, `${shape}: the error names FEDAUTH`);
      assert.equal(finalDoneStatus(answer.payload) & 0x02, 0x02, `${shape}: DONE with the error bit`);
    }
    client.send(TDS.LOGIN7, login7({ token: VALID_TOKEN }));
    assert.equal((await client.next()).payload[0], 0xe3, 'a valid token logs in on the same connection');
  } finally {
    client.socket.destroy();
    await fedServer.close();
  }
});

// @test-kind contract: a packet header is read once however the bytes arrive, so reassembly never rescans.
test('the message assembler reads each packet header once, however small the chunks', async () => {
  const { createMessageAssembler } = await import('../lib/dataverse-tds-protocol.mjs');
  let headers = 0;
  const assembler = createMessageAssembler({
    readLength: (buffer, at) => {
      headers += 1;
      return buffer.readUInt16BE(at + 2);
    },
  });
  const packets = 50;
  const wire = Buffer.concat(
    Array.from({ length: packets }, (_, i) => rawPacket(TDS.PRELOGIN, i === packets - 1, Buffer.alloc(100, i))),
  );
  const messages = [];
  for (let at = 0; at < wire.length; at += 1) {
    assembler.push(wire.subarray(at, at + 1));
    for (let message = assembler.next(); message; message = assembler.next()) messages.push(message);
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, TDS.PRELOGIN);
  assert.equal(messages[0].payload.length, packets * 100);
  assert.equal(headers, packets);
});

// ---- evaluator value shapes over the wire ----

// Result sets as the SQL evaluator returns them: exact decimals as { decimal }, datetimes as Date objects or ISO text.
// `text` is the decoded row values, as SQL Server returns them.
const WIRE_TYPES = {
  columns: [
    { name: 'price', type: 'money' },
    { name: 'cost', type: 'decimal', precision: 10, scale: 2 },
    { name: 'one', type: 'decimal', precision: 2, scale: 1 },
    { name: 'created', type: 'datetime' },
    { name: 'stamp', type: 'datetime' },
    { name: 'precise', type: 'datetime2', scale: 7 },
  ],
  rows: [
    [
      { decimal: '-1234.5' },
      { decimal: '-0.125' },
      { decimal: '1.5' },
      new Date('2026-11-12T10:20:30.123Z'),
      '2024-01-02T03:04:05.1234567Z',
      '2024-01-02T03:04:05.1234567+02:00',
    ],
    [null, null, null, null, null, null],
    [{ decimal: '922337203685477.5807' }, { decimal: '2.344' }, 1, null, null, null],
    [{ decimal: '-922337203685477.5807' }, 12n, { decimal: '-9.9' }, null, null, null],
    [1.5, null, null, null, null, null],
  ],
  text: [
    ['-1234.5000', '-0.13', '1.5', '2026-11-12 10:20:30.123', '2024-01-02 03:04:05.123', '2024-01-02 01:04:05.1234567'],
    [null, null, null, null, null, null],
    ['922337203685477.5807', '2.34', '1.0', null, null, null],
    ['-922337203685477.5807', '12.00', '-9.9', null, null, null],
    ['1.5000', null, null, null, null, null],
  ],
};

const WIRE_RESULTS = new Map([
  ['TYPES', WIRE_TYPES],
  [
    'SELECT 1.5',
    {
      columns: [{ name: 'v', type: 'decimal', precision: 2, scale: 1 }],
      rows: [[{ decimal: '1.5' }]],
      text: [['1.5']],
    },
  ],
  [
    'SELECT GETDATE()',
    {
      columns: [{ name: 'now', type: 'datetime' }],
      rows: [[new Date('2026-11-12T10:20:30.123Z')]],
      text: [['2026-11-12 10:20:30.123']],
    },
  ],
  [
    "SELECT CAST('2024-01-02' AS datetime)",
    {
      columns: [{ name: 'd', type: 'datetime' }],
      rows: [['2024-01-02T00:00:00Z']],
      text: [['2024-01-02 00:00:00.000']],
    },
  ],
  [
    'SELECT SUM(price)',
    {
      columns: [{ name: 's', type: 'money', precision: 19, scale: 4 }],
      rows: [[{ decimal: '14.2500' }]],
      text: [['14.2500']],
    },
  ],
]);

function wireQuery({ sql }) {
  const set = WIRE_RESULTS.get(sql.trim());
  return set ? one(set.columns, set.rows) : { resultSets: [] };
}

// Decodes the ROW tokens of a reply that is one result set (COLMETADATA, ROWs, DONE); an ERROR reply fails with its text.
function decodeRows(payload, columns) {
  if (payload[0] === ERROR)
    assert.fail(`server error: ${payload.toString('utf16le', 11, 11 + 2 * payload.readUInt16LE(9))}`);
  assert.equal(payload[0], 0x81, 'reply starts with COLMETADATA');
  const rows = [];
  let p = columnMetadata(columns).length;
  while (payload[p] === 0xd1) {
    const decoded = decodeRow(columns, payload, p);
    rows.push(decoded.values);
    p = decoded.next;
  }
  return rows;
}

describe('evaluator value shapes over the wire', () => {
  let server;
  before(async () => {
    server = await startServer(wireQuery);
  });
  after(async () => {
    await server.close();
  });

  async function replyTo(sql) {
    const client = await loginStrict(server.port, server.cert);
    try {
      client.send(TDS.SQL_BATCH, sqlBatch(sql));
      return (await client.next()).payload;
    } finally {
      client.socket.destroy();
    }
  }

  // @test-kind contract: the TDS row adapter is designed to carry evaluator values; the expected text follows SQL Server rounding.
  test('money, decimal, datetime and datetime2 values reach the wire as their exact SQL text', async () => {
    for (const [sql, set] of WIRE_RESULTS) assert.deepEqual(decodeRows(await replyTo(sql), set.columns), set.text, sql);
  });

  // @test-kind contract: TYPE_INFO carries the declared decimal precision and scale and the datetime2 scale.
  test('COLMETADATA TYPE_INFO carries the money, decimal(10,2) and datetime2(7) types', async () => {
    const payload = await replyTo('TYPES');
    // money is 0x6e size 8; decimal(10,2) is 0x6a size 9 precision 10 scale 2; datetime2(7) is 0x2a scale 7.
    for (const typeInfo of [
      [0x6e, 8],
      [0x6a, 9, 10, 2],
      [0x2a, 7],
    ]) {
      assert.ok(payload.includes(Buffer.from(typeInfo)), `TYPE_INFO ${typeInfo.join(' ')}`);
    }
  });
});

// ---- end-to-end with tedious (skipped unless TDS_TEDIOUS_PATH is set) ----

const gateTedious = fileURLToPath(new URL('../test-sdk/tds/node_modules/tedious/lib/tedious.js', import.meta.url));
const tediousPath = process.env.TDS_TEDIOUS_PATH || (existsSync(gateTedious) ? gateTedious : null);
const skip = tediousPath
  ? false
  : 'install mirage/test-sdk/tds (npm ci) or set TDS_TEDIOUS_PATH to run the tedious checks';
const loadedTedious = tediousPath ? await import(pathToFileURL(tediousPath).href) : null; // CommonJS: the exports sit on default
const tedious = loadedTedious?.default ?? loadedTedious;

describe('TDS protocol end to end with tedious', { skip }, () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });

  function connect() {
    return new Promise((resolve, reject) => {
      const connection = new tedious.Connection({
        server: '127.0.0.1',
        authentication: { type: 'azure-active-directory-access-token', options: { token: VALID_TOKEN } },
        options: {
          port: server.port,
          database: 'org',
          encrypt: true,
          trustServerCertificate: true,
          connectTimeout: 60_000,
          requestTimeout: 60_000,
        },
      });
      connection.on('connect', (err) => (err ? reject(err) : resolve(connection)));
      connection.connect();
    });
  }

  function execute(connection, sql, { batch = false, params = [] } = {}) {
    return new Promise((resolve, reject) => {
      const rows = [];
      const request = new tedious.Request(sql, (err, rowCount) => (err ? reject(err) : resolve({ rows, rowCount })));
      request.on('row', (columns) => rows.push(columns.map((c) => c.value)));
      for (const [name, type, value] of params) request.addParameter(name, type, value);
      if (batch) connection.execSqlBatch(request);
      else connection.execSql(request);
    });
  }

  test('access-token login over encrypted TDS 7 runs SELECT 1 AS x as RPC and as a SQL batch', async () => {
    const connection = await connect();
    try {
      assert.deepEqual((await execute(connection, 'SELECT 1 AS x')).rows, [[1]]);
      assert.deepEqual((await execute(connection, 'SELECT 1 AS x', { batch: true })).rows, [[1]]);
    } finally {
      connection.close();
    }
  });

  test('a parameterised query reaches the server through sp_executesql', async () => {
    const connection = await connect();
    try {
      const result = await execute(connection, 'SELECT @p AS v', { params: [['p', tedious.TYPES.Int, 42]] });
      assert.deepEqual(result.rows, [[42]]);
    } finally {
      connection.close();
    }
  });

  test('a server error reaches the client with its number', async () => {
    const connection = await connect();
    try {
      await assert.rejects(execute(connection, 'SELECT missing'), (err) => err.number === 208);
    } finally {
      connection.close();
    }
  });

  test('ATTENTION from tedious cancels a running query and the connection stays usable', async () => {
    const connection = await connect();
    try {
      const started = new Promise((resolve) => {
        waitStarted = resolve;
      });
      const pending = execute(connection, 'WAIT');
      await started;
      waitStarted = null;
      connection.cancel();
      await assert.rejects(pending);
      assert.deepEqual((await execute(connection, 'SELECT 1 AS x')).rows, [[1]]);
    } finally {
      connection.close();
    }
  });
});
