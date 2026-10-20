// TDS endpoint wired into the Dataverse API: login with an Entra token, SELECT through the real record handlers
// (so table security applies to the caller), refusals and unknown tables. Invented schema and GUIDs; loopback only.
// The tedious checks run only when TDS_TEDIOUS_PATH names the tedious entry file.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { hashSecret } from "../lib/dataverse-auth.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";
import { TDS, createMessageReader, encodePrelogin, writeMessage } from "../lib/dataverse-tds-framing.mjs";
import { queryLimitMs } from "../lib/dataverse-tds.mjs";
import { parsePrefer } from "../lib/dataverse-odata.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";

const ANNOTATIONS = 'odata.include-annotations="*"';
const ORG_ID = "0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const APP_ID = "22222222-2222-2222-2222-222222222222";
const PUBLIC_APP_ID = "44444444-4444-4444-4444-444444444444";
const BASIC_OID = "66666666-6666-6666-6666-666666666666";
const SECRET_VAR = "PAQVILO_TDS_INTEGRATION_SECRET";
const PASSWORD = "Pass!23";
const REDIRECT = "http://localhost:1/cb";
const VERSION = "v9.2";
const ERROR = 0xaa;
const DONE = 0xfd;

const text = { dataverseType: "nvarchar" };
// User-owned, so a Basic User can create rows and reads only the rows it owns.
const widgetMapping = () => ({ logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name", ownership: "UserOwned", fields: { name: text, ownerid: { dataverseType: "lookup" } } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const utf16 = (value) => Buffer.from(value, "utf16le");

// LOGIN7 with FEDAUTH (SecurityToken, library 1) carrying the access token (MS-TDS 2.2.6.4).
function login7({ user = "tester", database = "org", token }) {
  const fixed = Buffer.alloc(94);
  fixed.writeUInt32LE(0x74000004, 4);
  fixed.writeUInt32LE(4096, 8);
  fixed.writeUInt8(0x10, 27);
  const variable = [];
  let at = 94;
  const put = (slot, value) => {
    const data = utf16(value);
    fixed.writeUInt16LE(at, slot);
    fixed.writeUInt16LE(value.length, slot + 2);
    variable.push(data);
    at += data.length;
  };
  put(36, "client-host");
  put(40, user);
  put(48, "tds-integration");
  put(52, "mirage");
  put(60, "tds-integration-lib");
  put(68, database);
  const tokenBytes = utf16(token);
  const fedAuthData = Buffer.concat([Buffer.from([0x03]), u32(tokenBytes.length), tokenBytes]);
  const feature = Buffer.concat([Buffer.from([0x02]), u32(fedAuthData.length), fedAuthData, Buffer.from([0xff])]);
  fixed.writeUInt16LE(at, 56);
  variable.push(u32(at + 4), feature);
  const body = Buffer.concat([fixed, ...variable]);
  body.writeUInt32LE(body.length, 0);
  return body;
}

// SQL_BATCH: ALL_HEADERS with a transaction descriptor, then UTF-16LE text.
function sqlBatch(sql) {
  const headers = Buffer.alloc(22);
  headers.writeUInt32LE(22, 0);
  headers.writeUInt32LE(18, 4);
  headers.writeUInt16LE(2, 8);
  headers.writeUInt32LE(1, 18);
  return Buffer.concat([headers, utf16(sql)]);
}

// Hand-built TDS 8 client (TLS first, ALPN tds/8.0). Replies are read whole: the assertions search their bytes.
async function connect(port) {
  const socket = tls.connect({ host: "127.0.0.1", port, ALPNProtocols: ["tds/8.0"], rejectUnauthorized: false });
  socket.on("error", () => {});
  await once(socket, "secureConnect");
  const queue = [];
  const waiting = [];
  socket.on("data", createMessageReader((type, payload) => {
    const resume = waiting.shift();
    if (resume) resume(payload);
    else queue.push(payload);
  }));
  return {
    socket,
    send: (type, payload) => writeMessage(socket, type, payload),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve))),
    close: () => socket.destroy(),
  };
}

// PRELOGIN, then LOGIN7 with the token. Returns the client and the login reply.
async function login(port, token) {
  const client = await connect(port);
  client.send(TDS.PRELOGIN, encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }));
  await client.next();
  client.send(TDS.LOGIN7, login7({ token }));
  return { client, reply: await client.next() };
}

async function query(client, sql) {
  client.send(TDS.SQL_BATCH, sqlBatch(sql));
  return client.next();
}

describe("TDS endpoint wired into the Dataverse API", () => {
  let api;
  let origin;
  let tenantId;
  let appToken;
  let basicToken;

  before(async () => {
    process.env[SECRET_VAR] = "tds-integration-secret";
    const state = emptyState();
    state.mappings.widget = widgetMapping();
    const store = await new DataStore({ state }).init();
    // tds is not given: the endpoint is on by default, on an ephemeral port.
    const settings = dataverseSettings({
      enabled: true,
      organizationId: ORG_ID,
      applications: [
        { appId: APP_ID, displayName: "TDS test app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] },
        { appId: PUBLIC_APP_ID, displayName: "Public app", publicClient: true, redirectUris: [REDIRECT] },
      ],
      users: [{ domainname: "basic@example.test", fullname: "Basic", objectId: BASIC_OID, roles: ["Basic User"] }],
    });
    api = await startDataverseApi({ store, settings, log: () => {} });
    origin = api.origin;
    tenantId = api.tenantId;
    await store.transact(() => {
      store.state.dataverse.passwords ??= {};
      store.state.dataverse.passwords[uuidV5(api.organizationId, `systemuser:oid:${BASIC_OID}`)] = hashSecret(PASSWORD);
    });
    appToken = await token({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR] });
    basicToken = await token({ grant_type: "password", client_id: PUBLIC_APP_ID, username: "basic@example.test", password: PASSWORD });
    await createWidget(appToken, "Admin's");
    await createWidget(basicToken, "Basic's");
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  async function token(form) {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ scope: `${origin}/.default`, ...form }),
    });
    const body = await response.json();
    assert.ok(body.access_token, `token request failed: ${JSON.stringify(body)}`);
    return body.access_token;
  }

  async function createWidget(bearer, name) {
    const response = await fetch(`${origin}/api/data/${VERSION}/widgets`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(response.status < 300, `widget create answered ${response.status}`);
  }

  it("listens on an ephemeral loopback port by default", () => {
    assert.ok(Number.isInteger(api.tdsPort) && api.tdsPort > 0);
  });

  it("a valid application token logs in and SELECTs every row", async () => {
    const { client, reply } = await login(api.tdsPort, appToken);
    try {
      assert.equal(reply[0], 0xe3, "login starts with ENVCHANGE");
      const payload = await query(client, "SELECT name FROM widget");
      assert.ok(payload.indexOf(utf16("Admin's")) > 0, "the admin's widget is returned");
      assert.ok(payload.indexOf(utf16("Basic's")) > 0, "the basic user's widget is returned");
      assert.equal(payload[payload.length - 13], DONE, "the batch ends with DONE");
    } finally {
      client.close();
    }
  });

  it("a Basic User token SELECTs only the rows its security role may read", async () => {
    const { client } = await login(api.tdsPort, basicToken);
    try {
      const payload = await query(client, "SELECT name FROM widget");
      assert.ok(payload.indexOf(utf16("Basic's")) > 0, "the caller's own widget is returned");
      assert.equal(payload.indexOf(utf16("Admin's")), -1, "a row hidden by security is not returned");
    } finally {
      client.close();
    }
  });

  it("an invalid token is refused at login", async () => {
    const { client, reply } = await login(api.tdsPort, "not-a-token");
    try {
      assert.equal(reply[0], ERROR);
      assert.equal(reply.readUInt32LE(3), 18456, "login failure number");
    } finally {
      client.close();
    }
  });

  it("SELECT on an unknown table answers 208", async () => {
    const { client } = await login(api.tdsPort, appToken);
    try {
      const payload = await query(client, "SELECT name FROM no_such_table");
      assert.equal(payload[0], ERROR);
      assert.equal(payload.readUInt32LE(3), 208, "invalid object name");
    } finally {
      client.close();
    }
  });

  it("settings tds.enabled false keeps the listener and refuses every login", async () => {
    const state = emptyState();
    const store = await new DataStore({ state }).init();
    const settings = dataverseSettings({ enabled: true, organizationId: ORG_ID, tds: { enabled: false } });
    const off = await startDataverseApi({ store, settings, log: () => {} });
    try {
      assert.ok(Number.isInteger(off.tdsPort) && off.tdsPort > 0, "the endpoint stays reachable");
      const { client, reply } = await login(off.tdsPort, "not-a-token");
      try {
        assert.equal(reply[0], ERROR);
        assert.equal(reply.readUInt32LE(3), 18456, "login failure number");
        assert.ok(reply.indexOf(utf16("TDS protocol endpoint is disabled for this organization.")) > 0, "the refusal names the disabled endpoint");
      } finally {
        client.close();
      }
    } finally {
      await off.close();
    }
  });
});

describe("TDS query time limit", () => {
  it("a string literal containing JOIN gets the 5-minute class", () => {
    assert.equal(queryLimitMs("SELECT 'JOIN' AS word FROM widget"), 5 * 60_000);
  });

  it("JOIN, APPLY, a nested FROM and SELECT * get the 2-minute class", () => {
    for (const sql of [
      "SELECT w.name FROM widget w JOIN widget v ON v.name = w.name",
      "SELECT w.name FROM widget w CROSS APPLY (SELECT 1 AS one) a",
      "SELECT x.name FROM (SELECT name FROM widget) x",
      "SELECT * FROM widget",
    ]) assert.equal(queryLimitMs(sql), 2 * 60_000, sql);
  });
});

describe("TDS query paging and service protection", () => {
  const WIDGET_NAMES = ["paged-1", "paged-2", "paged-3", "paged-4", "paged-5"];

  // A fresh API with one application; serviceProtection is the settings block, or null. install(api) sees the api's
  // record handlers (the same object the TDS endpoint reads through), as an extension would.
  async function startApi(serviceProtection = null, install = () => {}) {
    process.env[SECRET_VAR] = "tds-paging-secret";
    const state = emptyState();
    state.mappings.widget = widgetMapping();
    const store = await new DataStore({ state }).init();
    const settings = dataverseSettings({
      enabled: true,
      organizationId: ORG_ID,
      applications: [{ appId: APP_ID, displayName: "TDS test app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
      serviceProtection,
    });
    return startDataverseApi({ store, settings, log: () => {}, extensions: [...EXTENSIONS, { install }] });
  }

  async function appTokenOf(api) {
    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${api.origin}/.default` }),
    });
    return (await response.json()).access_token;
  }

  async function createNamedWidget(api, bearer, name) {
    const response = await fetch(`${api.origin}/api/data/${VERSION}/widgets`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(response.status < 300, `widget create answered ${response.status}`);
  }

  it("scan follows @odata.nextLink to the last page", async () => {
    let records;
    const api = await startApi(null, (hooked) => {
      records = hooked.records;
    });
    try {
      const bearer = await appTokenOf(api);
      for (const name of WIDGET_NAMES) await createNamedWidget(api, bearer, name);
      // Two rows a page, forced on every scan request through Prefer odata.maxpagesize: five rows take three pages.
      const handle = records.handle;
      let pages = 0;
      records.handle = (request) => {
        pages += 1;
        const prefer = `${ANNOTATIONS}, odata.maxpagesize=2`;
        return handle.call(records, { ...request, prefer: parsePrefer(prefer), headers: { ...request.headers, prefer } });
      };
      const { client } = await login(api.tdsPort, bearer);
      try {
        const payload = await query(client, "SELECT name FROM widget");
        for (const name of WIDGET_NAMES) assert.ok(payload.indexOf(utf16(name)) > 0, `${name} is returned`);
        assert.equal(pages, 3, "the scan read every page");
      } finally {
        client.close();
      }
    } finally {
      await api.close();
      delete process.env[SECRET_VAR];
    }
  });

  it("a pushable WHERE and TOP reach the records request as $filter and $top", async () => {
    let records;
    const api = await startApi(null, (hooked) => {
      records = hooked.records;
    });
    try {
      const bearer = await appTokenOf(api);
      for (const name of WIDGET_NAMES) await createNamedWidget(api, bearer, name);
      const requests = [];
      const handle = records.handle;
      records.handle = (request) => {
        requests.push(request.url.searchParams);
        return handle.call(records, request);
      };
      const { client } = await login(api.tdsPort, bearer);
      try {
        const payload = await query(client, "SELECT TOP 2 name FROM widget WHERE widgetid IS NOT NULL");
        assert.notEqual(payload[0], ERROR, "the query is admitted");
      } finally {
        client.close();
      }
      const params = requests.find((p) => p.has("$filter"));
      assert.ok(params, "a records request carries $filter");
      assert.equal(params.get("$filter"), "widgetid ne null");
      assert.equal(params.get("$top"), "2");
    } finally {
      await api.close();
      delete process.env[SECRET_VAR];
    }
  });

  it("service protection rejection answers 40501", async () => {
    const api = await startApi({ requestsPer300s: 1 });
    try {
      const { client } = await login(api.tdsPort, await appTokenOf(api));
      try {
        const admitted = await query(client, "SELECT name FROM widget");
        assert.notEqual(admitted[0], ERROR, "the first query is admitted");
        const refused = await query(client, "SELECT name FROM widget");
        assert.equal(refused[0], ERROR);
        assert.equal(refused.readUInt32LE(3), 40501, "service protection error");
      } finally {
        client.close();
      }
    } finally {
      await api.close();
      delete process.env[SECRET_VAR];
    }
  });
});

const tediousPath = process.env.TDS_TEDIOUS_PATH;
const skip = tediousPath ? false : "set TDS_TEDIOUS_PATH to the tedious entry file to run the tedious checks";
const loadedTedious = tediousPath ? await import(pathToFileURL(tediousPath).href) : null; // CommonJS: the exports sit on default
const tedious = loadedTedious?.default ?? loadedTedious;

describe("TDS endpoint with tedious", { skip }, () => {
  let api;
  let tenantId;
  let origin;

  before(async () => {
    process.env[SECRET_VAR] = "tds-tedious-secret";
    const state = emptyState();
    state.mappings.widget = widgetMapping();
    const store = await new DataStore({ state }).init();
    const settings = dataverseSettings({
      enabled: true,
      organizationId: ORG_ID,
      applications: [{ appId: APP_ID, displayName: "TDS test app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
    });
    api = await startDataverseApi({ store, settings, log: () => {} });
    origin = api.origin;
    tenantId = api.tenantId;
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  it("access-token login runs SELECT name FROM widget through tedious", { timeout: 20_000 }, async () => {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${origin}/.default` }),
    });
    const { access_token: token } = await response.json();
    const created = await fetch(`${origin}/api/data/${VERSION}/widgets`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Tedious" }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(created.status < 300, `widget create answered ${created.status}`);
    const connection = await new Promise((resolve, reject) => {
      const c = new tedious.Connection({
        server: "127.0.0.1",
        authentication: { type: "azure-active-directory-access-token", options: { token } },
        options: { port: api.tdsPort, database: "org", encrypt: true, trustServerCertificate: true, connectTimeout: 5000, requestTimeout: 10000 },
      });
      c.on("connect", (err) => (err ? reject(err) : resolve(c)));
      c.connect();
    });
    try {
      const rows = await new Promise((resolve, reject) => {
        const collected = [];
        const request = new tedious.Request("SELECT name FROM widget", (err) => (err ? reject(err) : resolve(collected)));
        request.on("row", (columns) => collected.push(columns.map((column) => column.value)));
        connection.execSql(request);
      });
      assert.deepEqual(rows, [["Tedious"]]);
    } finally {
      connection.close();
    }
  });
});
