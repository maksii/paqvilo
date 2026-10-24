// SDK verification gate: tedious 20.3.8 against the Mirage Dataverse TDS endpoint.
// Access-token login (FEDAUTH), then real SQL batches: TOP, JOIN, GROUP BY, UNION, security trimming and the read-only refusal.
// Opt-in (`npm test` in this folder or `npm run test:sdk`); never part of `npm run validate`.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../../lib/data.mjs";
import { dataverseSettings } from "../../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../../lib/dataverse-api.mjs";
import { hashSecret } from "../../lib/dataverse-auth.mjs";
import { uuidV5 } from "../../lib/dataverse-security.mjs";
import { gateState } from "../harness.mjs";
import tedious from "tedious";

const ORG_ID = "0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const APP_ID = "33333333-3333-3333-3333-333333333333";
const PUBLIC_APP_ID = "44444444-4444-4444-4444-444444444444";
const BASIC_OID = "66666666-6666-6666-6666-666666666666";
const SECRET_VAR = "PAQVILO_SDK_GATE_TDS_SECRET";
const PASSWORD = "Pass!23";
const REDIRECT = "http://localhost:1/cb";
const VERSION = "v9.2";
const T = { timeout: 60_000 };

describe("Dataverse TDS endpoint through tedious", () => {
  let api;
  let origin;
  let tenantId;
  let admin;
  let basic;

  before(async () => {
    process.env[SECRET_VAR] = "tds-sdk-gate-secret";
    const state = gateState();
    state.mappings.widget.ownership = "UserOwned";
    const store = await new DataStore({ state }).init();
    const settings = dataverseSettings({
      enabled: true,
      organizationId: ORG_ID,
      applications: [
        { appId: APP_ID, displayName: "TDS gate admin", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] },
        { appId: PUBLIC_APP_ID, displayName: "TDS gate public", publicClient: true, redirectUris: [REDIRECT] },
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

    const adminToken = await token({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR] });
    const basicToken = await token({ grant_type: "password", client_id: PUBLIC_APP_ID, username: "basic@example.test", password: PASSWORD });

    // Admin-A, Admin-B and Gadget G1 bound to Admin-A; Basic-A is owned by the Basic User.
    const adminA = await create(adminToken, "widgets", { name: "Admin-A", quantity: 1 });
    await create(adminToken, "widgets", { name: "Admin-B", quantity: 1 });
    await create(adminToken, "gadgets", { name: "G1", "widgetid@odata.bind": `/widgets(${adminA})` });
    await create(basicToken, "widgets", { name: "Basic-A", quantity: 2 });

    admin = await connect(adminToken);
    basic = await connect(basicToken);
  });

  after(async () => {
    admin?.close();
    basic?.close();
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
    assert.ok(body.access_token, `token request failed: ${body.error ?? response.status}`);
    return body.access_token;
  }

  // Creates a row through the Web API as the caller and returns its id from the OData-EntityId header.
  async function create(bearer, collection, data) {
    const response = await fetch(`${origin}/api/data/${VERSION}/${collection}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(response.status < 300, `${collection} create answered ${response.status}`);
    return response.headers.get("OData-EntityId").match(/\(([^)]+)\)$/)[1];
  }

  function connect(bearer) {
    return new Promise((resolve, reject) => {
      const connection = new tedious.Connection({
        server: "127.0.0.1",
        authentication: { type: "azure-active-directory-access-token", options: { token: bearer } },
        options: { port: api.tdsPort, database: "org", encrypt: true, trustServerCertificate: true, connectTimeout: 5000, requestTimeout: 10000 },
      });
      connection.on("connect", (err) => (err ? reject(err) : resolve(connection)));
      connection.connect();
    });
  }

  // Runs one SQL batch; resolves with the rows as arrays of column values, rejects with tedious' RequestError.
  function query(connection, sql) {
    return new Promise((resolve, reject) => {
      const rows = [];
      const request = new tedious.Request(sql, (err) => (err ? reject(err) : resolve(rows)));
      request.on("row", (columns) => rows.push(columns.map((column) => column.value)));
      connection.execSql(request);
    });
  }

  it("SELECT TOP returns the requested number of rows", T, async () => {
    const rows = await query(admin, "SELECT TOP 2 name FROM widget");
    assert.equal(rows.length, 2);
    for (const [name] of rows) assert.equal(typeof name, "string");
  });

  it("JOIN pairs each gadget with its widget", T, async () => {
    const rows = await query(admin, "SELECT w.name AS widget_name, g.name AS gadget_name FROM widget w JOIN gadget g ON g.widgetid = w.widgetid");
    assert.deepEqual(rows, [["Admin-A", "G1"]]);
  });

  it("GROUP BY with COUNT(*) and ORDER BY", T, async () => {
    const rows = await query(admin, "SELECT quantity, COUNT(*) AS n FROM widget GROUP BY quantity ORDER BY quantity");
    assert.deepEqual(rows, [[1, 2], [2, 1]]);
  });

  it("UNION combines two selects into one result set", T, async () => {
    const rows = await query(admin, "SELECT name FROM widget WHERE name = 'Admin-A' UNION SELECT name FROM gadget WHERE name = 'G1'");
    assert.deepEqual(rows.map(([name]) => name).sort(), ["Admin-A", "G1"]);
  });

  it("security trimming: the Basic User token sees fewer rows than the admin token", T, async () => {
    const everything = await query(admin, "SELECT name FROM widget");
    const own = await query(basic, "SELECT name FROM widget");
    assert.equal(everything.length, 3);
    assert.deepEqual(own, [["Basic-A"]]);
    assert.ok(own.length < everything.length);
  });

  it("INSERT is refused by the read-only endpoint with error 102", T, async () => {
    await assert.rejects(
      query(admin, "INSERT INTO widget (name) VALUES ('Refused')"),
      (err) => {
        assert.equal(err.number, 102);
        assert.match(err.message, /read-only/);
        return true;
      },
    );
  });
});
