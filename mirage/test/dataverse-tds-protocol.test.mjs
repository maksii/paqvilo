// Dataverse TDS protocol server (dataverse-tds-protocol.mjs). The unit tests drive TDS 8 strict mode with a hand-built
// client over TLS (no client library). The end-to-end tests use tedious and are skipped unless TDS_TEDIOUS_PATH names the
// tedious entry file, for example:
//   npm install --prefix <dir> tedious@20.3.8
//   TDS_TEDIOUS_PATH=<dir>/node_modules/tedious/lib/tedious.js
// Loopback only, invented SQL and an invented token.
import assert from "node:assert/strict";
import { once } from "node:events";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import { createSelfSignedCertificate } from "../lib/dataverse-tls.mjs";
import { TDS, createMessageReader, decodePrelogin, encodePrelogin, writeMessage } from "../lib/dataverse-tds-framing.mjs";
import { createTdsServer } from "../lib/dataverse-tds-protocol.mjs";

const VALID_TOKEN = "valid-token";
const DONE = 0xfd;
const ERROR = 0xaa;
const FEATURE_ACK_FEDAUTH = Buffer.from([0xae, 0x02, 0, 0, 0, 0, 0xff]);

let waitStarted = null;
const one = (columns, rows) => ({ resultSets: [{ columns, rows }] });

// Test SQL: "SELECT 1 AS x", "SELECT @p AS v", "SELECT missing", "MULTI", "WAIT" (runs until cancelled) and anything else (empty).
function onQuery({ sql, params, signal }) {
  const text = sql.trim();
  if (/^SELECT 1 AS x$/i.test(text)) return one([{ name: "x", type: "int" }], [[1]]);
  if (/^SELECT @p AS v$/i.test(text)) return one([{ name: "v", type: "int" }], [[params["@p"]]]);
  if (/^SELECT missing$/i.test(text)) throw { number: 208, message: "Invalid object name 'missing'.", state: 1, class: 16 };
  if (/^MULTI$/i.test(text)) {
    return { resultSets: [
      { columns: [{ name: "a", type: "int" }], rows: [[1], [2]] },
      { columns: [{ name: "b", type: "nvarchar" }], rows: [["x"]] },
    ] };
  }
  if (/^WAIT$/i.test(text)) {
    waitStarted?.();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(one([{ name: "x", type: "int" }], [[0]])), 10_000);
      timer.unref();
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      });
    });
  }
  return { resultSets: [] };
}

async function onLogin({ token }) {
  return token === VALID_TOKEN ? { ok: true, principal: { name: "tester" } } : { ok: false };
}

async function startServer() {
  const { key, cert } = createSelfSignedCertificate();
  const secureContext = tls.createSecureContext({ key, cert, maxVersion: "TLSv1.2" });
  const srv = createTdsServer({ secureContext, onLogin, onQuery });
  const address = await srv.listen(0, "127.0.0.1");
  return { ...srv, port: address.port };
}

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};

// LOGIN7 (MS-TDS 2.2.6.4): 94-byte fixed header, UTF-16LE variable data, FeatureExt with FEDAUTH (SecurityToken, library 1).
function login7({ user = "tester", database = "org", token }) {
  const fixed = Buffer.alloc(94);
  fixed.writeUInt32LE(0x74000004, 4);
  fixed.writeUInt32LE(4096, 8);
  fixed.writeUInt8(0x10, 27); // OptionFlags3: FeatureExt present
  const variable = [];
  let at = 94;
  const put = (slot, text) => {
    const data = Buffer.from(text, "utf16le");
    fixed.writeUInt16LE(at, slot);
    fixed.writeUInt16LE(text.length, slot + 2);
    variable.push(data);
    at += data.length;
  };
  put(36, "client-host");
  put(40, user);
  put(48, "unit-test");
  put(52, "mirage");
  put(60, "unit-test-lib");
  put(68, database);
  const tokenBytes = Buffer.from(token, "utf16le");
  const fedAuthData = Buffer.concat([Buffer.from([0x03]), u32(tokenBytes.length), tokenBytes]); // options (lib 1 << 1 | echo), token
  const feature = Buffer.concat([Buffer.from([0x02]), u32(fedAuthData.length), fedAuthData, Buffer.from([0xff])]);
  fixed.writeUInt16LE(at, 56); // ibExtension: where the FeatureExt pointer DWORD sits
  variable.push(u32(at + 4), feature);
  const body = Buffer.concat([fixed, ...variable]);
  body.writeUInt32LE(body.length, 0);
  return body;
}

// SQL_BATCH payload: ALL_HEADERS with a transaction descriptor, then UTF-16LE text.
function sqlBatch(text) {
  const headers = Buffer.alloc(22);
  headers.writeUInt32LE(22, 0);
  headers.writeUInt32LE(18, 4);
  headers.writeUInt16LE(2, 8);
  headers.writeUInt32LE(1, 18);
  return Buffer.concat([headers, Buffer.from(text, "utf16le")]);
}

// Hand-built TDS 8 client: TLS first (ALPN tds/8.0), then TDS messages inside TLS.
async function connectStrict(port) {
  const socket = tls.connect({ host: "127.0.0.1", port, ALPNProtocols: ["tds/8.0"], rejectUnauthorized: false });
  socket.on("error", () => {});
  await once(socket, "secureConnect");
  const queue = [];
  const waiting = [];
  socket.on("data", createMessageReader((type, payload) => {
    const resume = waiting.shift();
    if (resume) resume({ type, payload });
    else queue.push({ type, payload });
  }));
  return {
    socket,
    send: (type, payload) => writeMessage(socket, type, payload),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve))),
  };
}

async function loginStrict(port) {
  const client = await connectStrict(port);
  client.send(TDS.PRELOGIN, encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }));
  await client.next();
  client.send(TDS.LOGIN7, login7({ token: VALID_TOKEN }));
  const response = await client.next();
  assert.equal(response.payload[0], 0xe3, "login response starts with ENVCHANGE");
  return client;
}

// DONE status for the final token of a reply, which is always 13 bytes.
const finalDoneStatus = (payload) => payload.readUInt16LE(payload.length - 12);

describe("TDS protocol over TDS 8 strict (hand-built client)", () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });

  test("PRELOGIN answers the version, encryption off and FEDAUTHREQUIRED", async () => {
    const client = await connectStrict(server.port);
    try {
      client.send(TDS.PRELOGIN, encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }));
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

  test("LOGIN7 with a valid token gets ENVCHANGE, LOGINACK, FEATUREEXTACK FEDAUTH and DONE", async () => {
    const client = await connectStrict(server.port);
    try {
      client.send(TDS.PRELOGIN, encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }));
      await client.next();
      client.send(TDS.LOGIN7, login7({ token: VALID_TOKEN }));
      const { payload } = await client.next();
      assert.equal(payload[0], 0xe3, "ENVCHANGE first");
      assert.ok(payload.indexOf(Buffer.from([0xad])) > 0, "LOGINACK present");
      assert.ok(payload.indexOf(FEATURE_ACK_FEDAUTH) > 0, "empty FEDAUTH feature ack present");
      assert.equal(payload[payload.length - 13], DONE, "login ends with DONE");
      assert.equal(finalDoneStatus(payload), 0);
    } finally {
      client.socket.destroy();
    }
  });

  test("LOGIN7 with a rejected token gets ERROR 18456 and the connection closes", async () => {
    const client = await connectStrict(server.port);
    try {
      client.send(TDS.PRELOGIN, encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01 }));
      await client.next();
      client.send(TDS.LOGIN7, login7({ token: "wrong-token" }));
      const reply = await client.next();
      assert.equal(reply.payload[0], ERROR);
      assert.equal(reply.payload.readInt32LE(3), 18456);
      await once(client.socket, "close");
    } finally {
      client.socket.destroy();
    }
  });

  test("ATTENTION on an idle connection is answered with DONE carrying the ATTN status", async () => {
    const client = await loginStrict(server.port);
    try {
      client.send(0x06, Buffer.alloc(0));
      const reply = await client.next();
      assert.equal(reply.payload[0], DONE);
      assert.equal(reply.payload.readUInt16LE(1) & 0x20, 0x20);
    } finally {
      client.socket.destroy();
    }
  });

  test("a query error is ERROR followed by DONE with the ERROR status", async () => {
    const client = await loginStrict(server.port);
    try {
      client.send(TDS.SQL_BATCH, sqlBatch("SELECT missing"));
      const reply = await client.next();
      assert.equal(reply.payload[0], ERROR);
      assert.equal(reply.payload.readInt32LE(3), 208);
      assert.equal(finalDoneStatus(reply.payload) & 0x02, 0x02);
    } finally {
      client.socket.destroy();
    }
  });

  test("multiple result sets set MORE on every DONE except the last", async () => {
    const client = await loginStrict(server.port);
    try {
      client.send(TDS.SQL_BATCH, sqlBatch("MULTI"));
      const reply = await client.next();
      // First set ends with DONE status MORE (0x01) | COUNT (0x10); the last set ends with COUNT only.
      assert.ok(reply.payload.indexOf(Buffer.from([DONE, 0x11, 0x00])) >= 0, "DONE with MORE|COUNT after the first set");
      assert.equal(finalDoneStatus(reply.payload), 0x10);
    } finally {
      client.socket.destroy();
    }
  });
});

// ---- end-to-end with tedious (skipped unless TDS_TEDIOUS_PATH is set) ----

const tediousPath = process.env.TDS_TEDIOUS_PATH;
const skip = tediousPath ? false : "set TDS_TEDIOUS_PATH to the tedious entry file to run the tedious checks";
const loadedTedious = tediousPath ? await import(pathToFileURL(tediousPath).href) : null; // CommonJS: the exports sit on default
const tedious = loadedTedious?.default ?? loadedTedious;

describe("TDS protocol end to end with tedious", { skip }, () => {
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
        server: "127.0.0.1",
        authentication: { type: "azure-active-directory-access-token", options: { token: VALID_TOKEN } },
        options: { port: server.port, database: "org", encrypt: true, trustServerCertificate: true, connectTimeout: 5000, requestTimeout: 10000 },
      });
      connection.on("connect", (err) => (err ? reject(err) : resolve(connection)));
      connection.connect();
    });
  }

  function execute(connection, sql, { batch = false, params = [] } = {}) {
    return new Promise((resolve, reject) => {
      const rows = [];
      const request = new tedious.Request(sql, (err, rowCount) => (err ? reject(err) : resolve({ rows, rowCount })));
      request.on("row", (columns) => rows.push(columns.map((c) => c.value)));
      for (const [name, type, value] of params) request.addParameter(name, type, value);
      if (batch) connection.execSqlBatch(request);
      else connection.execSql(request);
    });
  }

  test("access-token login over encrypted TDS 7 runs SELECT 1 AS x as RPC and as a SQL batch", { timeout: 20_000 }, async () => {
    const connection = await connect();
    try {
      assert.deepEqual((await execute(connection, "SELECT 1 AS x")).rows, [[1]]);
      assert.deepEqual((await execute(connection, "SELECT 1 AS x", { batch: true })).rows, [[1]]);
    } finally {
      connection.close();
    }
  });

  test("a parameterised query reaches the server through sp_executesql", { timeout: 20_000 }, async () => {
    const connection = await connect();
    try {
      const result = await execute(connection, "SELECT @p AS v", { params: [["p", tedious.TYPES.Int, 42]] });
      assert.deepEqual(result.rows, [[42]]);
    } finally {
      connection.close();
    }
  });

  test("a server error reaches the client with its number", { timeout: 20_000 }, async () => {
    const connection = await connect();
    try {
      await assert.rejects(execute(connection, "SELECT missing"), (err) => err.number === 208);
    } finally {
      connection.close();
    }
  });

  test("ATTENTION from tedious cancels a running query and the connection stays usable", { timeout: 20_000 }, async () => {
    const connection = await connect();
    try {
      const started = new Promise((resolve) => {
        waitStarted = resolve;
      });
      const pending = execute(connection, "WAIT");
      await started;
      waitStarted = null;
      connection.cancel();
      await assert.rejects(pending);
      assert.deepEqual((await execute(connection, "SELECT 1 AS x")).rows, [[1]]);
    } finally {
      connection.close();
    }
  });
});
