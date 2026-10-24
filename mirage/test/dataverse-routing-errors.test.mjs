// Routing and admission errors of the Dataverse Web API, over HTTP. Each expectation mirrors a native response.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";

const APP_ID = "44444444-4444-4444-4444-444444444444";
const SECRET_VAR = "PAQVILO_ROUTING_TEST_SECRET";
const WIDGET = "aaaaaaaa-0000-4000-8000-000000000001";
const GADGET = "bbbbbbbb-0000-4000-8000-000000000001";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const API = "/api/data/v9.2";

function schema() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid", nameColumn: "contoso_name",
    alternateKeys: [{ name: "contoso_code", attributes: ["contoso_code"] }],
    fields: { contoso_name: { dataverseType: "nvarchar" }, contoso_code: { dataverseType: "nvarchar" } },
    relationships: {},
  };
  state.mappings.contoso_gadget = {
    logicalName: "contoso_gadget", entitySet: "contoso_gadgets", idColumn: "contoso_gadgetid", nameColumn: "contoso_name",
    fields: { contoso_name: { dataverseType: "nvarchar" }, contoso_widgetid: { dataverseType: "lookup" } },
    relationships: { contoso_widget: { entity: "contoso_widget", from: "contoso_widgetid", to: "contoso_widgetid", many: false } },
  };
  state.tables.contoso_widget = [{ contoso_widgetid: WIDGET, contoso_name: "alpha", contoso_code: "A1" }];
  state.tables.contoso_gadget = [{ contoso_gadgetid: GADGET, contoso_name: "gizmo" }];
  return state;
}

describe("dataverse Web API routing and admission errors", () => {
  let api;
  let token;

  before(async () => {
    process.env[SECRET_VAR] = "routing-test-secret";
    const store = await new DataStore({ state: schema() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [{ appId: APP_ID, displayName: "Routing test app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
    });
    api = await startDataverseApi({ store, change: (fn) => fn(), settings, log: () => {} });
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${api.origin}/.default` });
    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    token = (await response.json()).access_token;
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  // Plain node:http so that Origin and Access-Control-Request-Method can be sent with an OPTIONS request.
  function send(method, path, { headers = {}, body, auth = true } = {}) {
    const url = new URL(`${api.origin}${path}`);
    const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const all = { ...(auth ? { authorization: `Bearer ${token}` } : {}), accept: "application/json", ...headers };
    if (payload !== null && all["content-type"] === undefined) all["content-type"] = "application/json; charset=utf-8";
    if (payload !== null) all["content-length"] = Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
      const req = request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: all }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      });
      req.on("error", reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  const error = async (response) => (await response.json()).error;
  const record = (id = WIDGET) => `${API}/contoso_widgets(${id})`;

  it("refuses an OData-Version other than 4.0 or 4.01 with 412 0x80060888 before the request runs", async () => {
    const response = await send("GET", record(), { headers: { "OData-Version": "3.0" } });
    assert.equal(response.status, 412);
    assert.deepEqual(await error(response), {
      code: "0x80060888",
      message: "The value '3.0' of the OData-Version HTTP header is invalid. Only '4.0' and '4.01' are supported as values for the OData-Version header.",
    });
    assert.equal((await send("GET", record(), { headers: { "OData-Version": "4.01" } })).status, 200);
  });

  it("answers HEAD on a Web API resource with 405 and no body", async () => {
    const response = await send("HEAD", record());
    assert.equal(response.status, 405);
    assert.equal(response.text, "");
  });

  it("answers an authenticated OPTIONS that is not a preflight with 405, and keeps CORS preflight and anonymous OPTIONS at 204", async () => {
    const refused = await send("OPTIONS", record());
    assert.equal(refused.status, 405);
    assert.deepEqual(await error(refused), { code: "", message: "The requested resource does not support http method 'OPTIONS'." });

    const preflight = await send("OPTIONS", record(), {
      auth: false,
      headers: { origin: "https://app.example.test", "access-control-request-method": "PATCH" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "*");
    assert.equal((await send("OPTIONS", record(), { auth: false })).status, 204);
  });

  it("refuses a record write whose body is text/plain with 415 and the media type in the message", async () => {
    const response = await send("PATCH", record(), { headers: { "content-type": "text/plain", "if-none-match": "*" }, body: "hello" });
    assert.equal(response.status, 415);
    assert.deepEqual(await error(response), {
      code: "",
      message: "The request entity's media type 'text/plain' is not supported for this resource.",
    });
    assert.equal((await send("PATCH", record(), { body: { contoso_name: "beta" } })).status, 204);
  });

  it("answers PUT and POST on a record with their native 405 messages", async () => {
    const put = await send("PUT", record(), { body: {} });
    assert.equal(put.status, 405);
    assert.deepEqual(await error(put), { code: "0x80060888", message: "Operation not supported on contoso_widget" });

    const post = await send("POST", record(), { body: {} });
    assert.equal(post.status, 405);
    assert.deepEqual(await error(post), {
      code: "0x80060888",
      message: "Unmapped Request found, PathTemplate:~/entityset/key, HttpVerb:POST",
    });
  });

  it("answers a plain segment after a set without a key as a query-syntax error (400 0x80060888)", async () => {
    const response = await send("GET", `${API}/contoso_widgets/invalidsegment`);
    assert.equal(response.status, 400);
    assert.deepEqual(await error(response), { code: "0x80060888", message: "Bad Request - Error in query syntax." });
  });

  it("reads set() with empty parentheses as the entity set", async () => {
    const response = await send("GET", `${API}/contoso_widgets()`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).value.length, 1);
  });

  it("answers unknown, wrongly cased and capitalised entity set names with 404 0x80060888 and the segment message", async () => {
    for (const name of ["contoso_missing", "CONTOSO_WIDGETS", "Accounts", "contoso_widget"]) {
      const response = await send("GET", `${API}/${name}`);
      assert.equal(response.status, 404, name);
      assert.deepEqual(await error(response), { code: "0x80060888", message: `Resource not found for the segment '${name}'.` }, name);
    }
  });

  it("answers an unknown property after a record with 404 0x80060888, without a trailing period", async () => {
    const response = await send("GET", record() + "/contoso_nosuch");
    assert.equal(response.status, 404);
    assert.deepEqual(await error(response), { code: "0x80060888", message: "Resource not found for the segment 'contoso_nosuch'" });
  });

  it("separates malformed key syntax (400 0x80060888), a valid but missing row (404 0x80040217) and an undeclared alternate key (400 0x80060888)", async () => {
    const malformed = await send("GET", `${API}/contoso_widgets(not-a-guid)`);
    assert.equal(malformed.status, 400);
    assert.deepEqual(await error(malformed), { code: "0x80060888", message: "')' or ',' expected at position 6 in '(not-a-guid)'." });

    const missing = await send("GET", record(MISSING));
    assert.equal(missing.status, 404);
    assert.deepEqual(await error(missing), { code: "0x80040217", message: `Entity 'contoso_widget' With Id = ${MISSING} Does Not Exist` });
    // An engine error repeats the request id: two REQ_ID lines (the same id twice, as fetch joins them).
    const id = missing.headers["x-ms-service-request-id"];
    assert.equal(missing.headers.req_id, `${id}, ${id}`);

    const undeclared = await send("GET", `${API}/contoso_widgets(contoso_nope='x')`);
    assert.equal(undeclared.status, 400);
    assert.deepEqual(await error(undeclared), {
      code: "0x80060888",
      message: "The key in the request URI is not valid for resource 'Microsoft.Dynamics.CRM.contoso_widget'. Ensure that the names and number of key properties match the declared or alternate key properties for the resource 'Microsoft.Dynamics.CRM.contoso_widget'.",
    });
  });

  it("refuses a malformed GUID in @odata.bind as a key syntax error, not as a missing row", async () => {
    const response = await send("PATCH", `${API}/contoso_gadgets(${GADGET})`, {
      body: { "contoso_widget@odata.bind": "/contoso_widgets(not-a-guid)" },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await error(response), { code: "0x80060888", message: "')' or ',' expected at position 6 in '(not-a-guid)'." });
    // Observed: a bind value's engine error repeats the request id (REQ_ID twice), unlike a malformed URL key.
    const id = response.headers["x-ms-service-request-id"];
    assert.equal(response.headers.req_id, `${id}, ${id}`);
  });

  it("answers an unknown EntityDefinitions key with 404 0x80060888 naming the metadata id", async () => {
    const response = await send("GET", `${API}/EntityDefinitions(LogicalName='contoso_missing')`);
    assert.equal(response.status, 404);
    assert.deepEqual(await error(response), {
      code: "0x80060888",
      message: "EntityMetadata With Id = LogicalName='contoso_missing' does not exist.",
    });
  });

  it("answers an MSCRMCallerID naming no user with 404 in the _error body", async () => {
    const response = await send("GET", record(), { headers: { MSCRMCallerID: "99999999-9999-4999-8999-999999999999" } });
    assert.equal(response.status, 404);
    const body = response.json();
    assert.equal(body._error.Code, "0x80040217");
    assert.equal(body._error.Title, "Record Is Unavailable");
    assert.equal(body._error.ErrorCode, -2147220969);
  });
});
