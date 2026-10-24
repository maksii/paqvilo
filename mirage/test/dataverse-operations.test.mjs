// Extension operations, routes and install order for the Dataverse API.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { createOperationRegistry } from "../lib/dataverse-operations.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";

const APP_ID = "44444444-4444-4444-4444-444444444444";
const SECRET_VAR = "PAQVILO_OPERATIONS_TEST_SECRET";
const WIDGET_ID = "aaaaaaaa-0000-0000-0000-0000000000a1";
const MISSING_ID = "aaaaaaaa-0000-0000-0000-0000000000ff";
const CRM = "Microsoft.Dynamics.CRM.";
const API = "/api/data/v9.2/";
// Routes the stubbed record handler was asked to answer (the real records module is covered in dataverse-routing-errors.test.mjs).
const handledRoutes = [];

it('mutable operation providers follow live definitions without replacing immutable static registrations', () => {
  const registry = createOperationRegistry(), platform = () => 'platform', dynamic = () => 'dynamic';
  const staticDefinition = { name: 'Stable', kind: 'action', binding: 'unbound', handle: platform };
  registry.register(staticDefinition);
  staticDefinition.name = 'ChangedCallerObject';
  let name = 'new_First';
  registry.setProvider('invented', () => [
    { name: 'Stable', kind: 'action', binding: 'unbound', handle: dynamic },
    { name: 'WhoAmI', kind: 'action', binding: 'unbound', handle: dynamic },
    { name, kind: 'action', binding: 'unbound', handle: dynamic, signature: { params: [['Value', 'Edm.String']] } },
  ]);
  assert.equal(registry.find({ name: 'Stable', kind: 'action', binding: 'unbound' }).handle(), 'platform');
  assert.equal(registry.find({ name: 'WhoAmI', kind: 'action', binding: 'unbound' }), null, 'A provider cannot shadow a built-in implemented by the HTTP router.');
  assert.ok(registry.csdlFragments().includes('Name="new_First"'));
  name = 'new_Second';
  assert.equal(registry.has('new_First'), false);
  assert.equal(registry.has('new_Second'), true);
  assert.ok(!registry.csdlFragments().includes('Name="new_First"'));
  registry.setProvider('invented', () => []);
  assert.deepEqual(registry.names(), ['Stable']);
});

function fixtureState() {
  const state = emptyState();
  state.mappings = {
    widget: { logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name", fields: { name: { dataverseType: "nvarchar" } } },
  };
  state.tables = { widget: [{ widgetid: WIDGET_ID, name: "one" }] };
  return state;
}

// Starts a full API on loopback with one application user that is a System Administrator.
async function startServer({ extensions = [], change = (fn) => fn() } = {}) {
  process.env[SECRET_VAR] = "test-secret-value";
  const store = await new DataStore({ state: fixtureState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [{ appId: APP_ID, displayName: "Operations test app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
  });
  const server = await startDataverseApi({
    store,
    change,
    settings,
    extensions,
    records: { handle: async (ctx) => { handledRoutes.push(ctx.route); return { status: 200, body: { echo: "records" } }; } },
    log: () => {},
  });
  const tokenResponse = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${server.origin}/.default` }),
  });
  const authorization = `Bearer ${(await tokenResponse.json()).access_token}`;
  const timed = (init) => ({ ...init, signal: AbortSignal.timeout(5000) });
  return {
    server,
    store,
    origin: server.origin,
    authorization,
    appUserId: uuidV5(server.organizationId, `systemuser:app:${APP_ID}`),
    get: (path) => fetch(`${server.origin}${path}`, timed({ headers: { authorization } })),
    send: (method, path, body) =>
      fetch(`${server.origin}${path}`, timed({ method, headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) })),
    close: async () => {
      delete process.env[SECRET_VAR];
      await server.close();
    },
  };
}

// Captures the api object an extension receives at install, so tests can reach the store and the registry.
function captureExtension(name, install, extra = {}) {
  const extension = {
    name,
    ...extra,
    install(api) {
      extension.api = api;
      return install?.(api);
    },
  };
  return extension;
}

const seedContract = (api) =>
  api.store.transact(() => {
    api.store.state.mappings.paqcontract = {
      logicalName: "paqcontract",
      entitySet: "paqcontracts",
      idColumn: "paqcontractid",
      nameColumn: "name",
      userConfigured: true,
      dataverseOnly: true,
      fields: { name: { dataverseType: "nvarchar" } },
    };
  });

describe("operation registry", () => {
  it("finds the exact entity before the wildcard and never crosses kind or binding", () => {
    const registry = createOperationRegistry();
    const handle = async () => ({ status: 200 });
    registry.register({ name: "PaqScore", kind: "function", binding: "entity", entity: "*", handle });
    registry.register({ name: "PaqScore", kind: "function", binding: "entity", entity: "widget", handle });
    registry.register({ name: "PaqRun", kind: "action", binding: "unbound", handle });
    assert.equal(registry.find({ name: "PaqScore", kind: "function", binding: "entity", entity: "widget" }).entity, "widget");
    assert.equal(registry.find({ name: "PaqScore", kind: "function", binding: "entity", entity: "gadget" }).entity, "*");
    assert.equal(registry.find({ name: "PaqRun", kind: "function", binding: "unbound" }), null);
    assert.equal(registry.find({ name: "PaqRun", kind: "action", binding: "unbound", entity: "widget" }).binding, "unbound");
    assert.equal(registry.has("PaqRun"), true);
    assert.equal(registry.has("Missing"), false);
  });

  it("rejects malformed and duplicate registrations and joins CSDL fragments in order", () => {
    const registry = createOperationRegistry();
    const handle = async () => ({ status: 200 });
    assert.throws(() => registry.register({ name: "bad name", kind: "function", binding: "unbound", handle }), /identifier/);
    assert.throws(() => registry.register({ name: "PaqX", kind: "verb", binding: "unbound", handle }), /kind/);
    assert.throws(() => registry.register({ name: "PaqX", kind: "function", binding: "entity", handle }), /entity/);
    registry.register({ name: "PaqA", kind: "function", binding: "unbound", handle, csdl: "<A/>" });
    registry.register({ name: "PaqB", kind: "action", binding: "unbound", handle, csdl: "<B/>" });
    assert.throws(() => registry.register({ name: "PaqA", kind: "function", binding: "unbound", handle }), /already registered/);
    assert.equal(registry.csdlFragments(), "<A/>\n<B/>");
  });
});

describe("extension operations on the Web API", () => {
  let server;
  // Registered last, so its fragment is the last one joined; the bound function must not get an import.
  const csdl = captureExtension("csdl", (api) => {
    api.registry.register({ name: "PaqFn", kind: "function", binding: "unbound", csdl: '<Function Name="PaqFn">\n</Function>', handle: async () => ({ status: 204 }) });
    api.registry.register({ name: "PaqAct", kind: "action", binding: "unbound", csdl: '<Action Name="PaqAct">\n</Action>', handle: async () => ({ status: 204 }) });
    api.registry.register({ name: "PaqBound", kind: "function", binding: "entity", entity: "widget", csdl: '<Function Name="PaqBound" IsBound="true">\n</Function>', handle: async () => ({ status: 204 }) });
    api.registry.register({ name: "PaqFragment", kind: "function", binding: "unbound", csdl: '<Function Name="PaqFragment"/>', handle: async () => ({ status: 204 }) });
  });

  before(async () => {
    server = await startServer({
      extensions: [
        captureExtension("ops", (api) => {
          api.registry.register({
            name: "PaqEcho",
            kind: "function",
            binding: "unbound",
            handle: async (ctx) => ({ status: 200, body: { params: ctx.params, version: ctx.version, method: ctx.method } }),
          });
          api.registry.register({
            name: "PaqEnvelope",
            kind: "action",
            binding: "unbound",
            handle: async (ctx) => ({
              status: 201,
              headers: { "x-paq": "1" },
              body: { json: ctx.body, raw: ctx.bodyBuffer.toString("utf8"), contentType: ctx.headers["content-type"] },
            }),
          });
          api.registry.register({
            name: "PaqBytes",
            kind: "function",
            binding: "unbound",
            handle: async () => ({ status: 200, headers: { "content-type": "image/png" }, body: Buffer.from([0, 255, 16]) }),
          });
          api.registry.register({
            name: "PaqInspect",
            kind: "function",
            binding: "entity",
            entity: "widget",
            handle: async (ctx) => ({ status: 200, body: { name: ctx.target.row.name, id: ctx.target.id, logical: ctx.target.mapping.logicalName } }),
          });
          api.registry.register({
            name: "paq_candidate",
            kind: "action",
            binding: "unbound",
            handle: async (ctx) => ({ status: 200, body: { via: "candidate", method: ctx.method } }),
          });
          api.registry.register({
            name: "PaqCount",
            kind: "function",
            binding: "collection",
            entity: "widget",
            handle: async (ctx) => ({ status: 200, body: { logical: ctx.target.mapping.logicalName, hasRow: "row" in ctx.target } }),
          });
        }),
        csdl,
      ],
    });
  });

  after(async () => {
    await server?.close();
  });

  it("runs an unbound function with parsed parameters, the version and the method", async () => {
    const response = await server.get(`${API}${CRM}PaqEcho(Name='abc',Count=3)`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.params.Name, "abc");
    assert.equal(body.params.Count, 3);
    assert.equal(body.version, "v9.2");
    assert.equal(body.method, "GET");
  });

  it("runs an unbound action with raw and parsed body, its headers and a custom status", async () => {
    const response = await server.send("POST", `${API}${CRM}PaqEnvelope`, { amount: 7 });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-paq"), "1");
    assert.equal(response.headers.get("odata-version"), "4.0");
    const body = await response.json();
    assert.deepEqual(body.json, { amount: 7 });
    assert.equal(body.raw, JSON.stringify({ amount: 7 }));
    assert.equal(body.contentType, "application/json");
  });

  it("answers an object result as application/json; odata.metadata=minimal with no charset", async () => {
    const response = await server.get(`${API}${CRM}PaqEcho()`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; odata.metadata=minimal");
  });

  it("sends a Buffer body as-is with the operation's content type", async () => {
    const response = await server.get(`${API}${CRM}PaqBytes()`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual([...Buffer.from(await response.arrayBuffer())], [0, 255, 16]);
  });

  it("runs an entity-bound function with the loaded row, and 404s a missing row", async () => {
    const found = await server.get(`${API}widgets(${WIDGET_ID})/${CRM}PaqInspect()`);
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), { name: "one", id: WIDGET_ID, logical: "widget" });
    const missing = await server.get(`${API}widgets(${MISSING_ID})/${CRM}PaqInspect()`);
    assert.equal(missing.status, 404);
    assert.ok((await missing.json()).error.message.includes(`Entity 'widget' With Id = ${MISSING_ID} Does Not Exist`));
  });

  it("answers an entity-bound operation written without the namespace prefix with 400", async () => {
    const response = await server.get(`${API}widgets(${WIDGET_ID})/PaqInspect`);
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(error.code, "");
    assert.equal(error.message, "Request message has unresolved parameters");
  });

  it("resolves a one-segment path that names a registered operation before reading it as a set", async () => {
    const response = await server.send("POST", `${API}paq_candidate`, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { via: "candidate", method: "POST" });
  });

  it("reads an unregistered function with empty parentheses as an entity set, which the record handler then rejects (native: 404 0x80060888)", async () => {
    const response = await server.get(`${API}NoSuchFunction()`);
    assert.equal(response.status, 200); // the stubbed record handler answers
    assert.deepEqual(handledRoutes.at(-1), { version: "v9.2", kind: "collection", set: "NoSuchFunction" });
  });

  it("runs a collection-bound function with no row in the target", async () => {
    const response = await server.get(`${API}widgets/${CRM}PaqCount()`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { logical: "widget", hasRow: false });
  });

  it("answers a wrong verb or an unregistered binding with the 404 envelope", async () => {
    const wrongVerbFunction = await server.send("POST", `${API}${CRM}PaqEcho`, {});
    const wrongVerbAction = await server.get(`${API}${CRM}PaqEnvelope`);
    const wrongBinding = await server.get(`${API}gadgets/${CRM}PaqCount()`);
    for (const response of [wrongVerbFunction, wrongVerbAction, wrongBinding]) {
      assert.equal(response.status, 404);
      const error = (await response.json()).error;
      assert.equal(error.code, "");
      assert.ok(error.message.startsWith("No HTTP resource was found that matches the request URI"));
    }
  });

  it("falls through to the built-ins on a registry miss (WhoAmI)", async () => {
    const response = await server.get(`${API}WhoAmI`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).UserId, server.appUserId);
  });

  it("exposes the CSDL fragments and a data revision that advances with a write on the api object", async () => {
    // The core metadata functions are declared too, so the fragments carry the extension's line among them.
    assert.ok(csdl.api.registry.csdlFragments().endsWith('<Function Name="PaqFragment"/>'));
    const before = csdl.api.dataRevision();
    await csdl.api.store.transact(() => { csdl.api.store.state.tables.widget.push({ widgetid: "aaaaaaaa-0000-0000-0000-0000000000a2", name: "two" }); });
    assert.notEqual(csdl.api.dataRevision(), before);
  });

  it("imports each unbound extension function and action in the EntityContainer, and no bound one", async () => {
    const xml = await (await server.get(`${API}$metadata`)).text();
    assert.match(xml, /<FunctionImport Name="PaqFn" Function="mscrm\.PaqFn" IncludeInServiceDocument="false" \/>/);
    assert.match(xml, /<ActionImport Name="PaqAct" Action="mscrm\.PaqAct" \/>/);
    assert.doesNotMatch(xml, /Import Name="PaqBound"/);
    // The imports sit inside the EntityContainer, after the built-in ones.
    assert.ok(xml.indexOf('<FunctionImport Name="PaqFn"') > xml.indexOf('<EntityContainer'));
  });
});

describe("addRoute precedence", () => {
  it("answers matching routes before the built-ins, the first registration winning", async () => {
    const extension = captureExtension("routes", (api) => {
      api.addRoute((pathname, method) => pathname === "/api/custom/ping" && method === "GET", () => ({ status: 200, body: { by: "first" } }));
      api.addRoute((pathname) => pathname === "/api/custom/ping", () => ({ status: 200, body: { by: "second" } }));
      api.addRoute((pathname) => pathname.endsWith("/WhoAmI"), () => ({ status: 200, body: { by: "whoami" } }));
    });
    const probe = await startServer({ extensions: [extension] });
    try {
      assert.deepEqual(await (await probe.get("/api/custom/ping")).json(), { by: "first" });
      assert.deepEqual(await (await probe.get(`${API}WhoAmI`)).json(), { by: "whoami" });
    } finally {
      await probe.close();
    }
  });
});

describe("install order and security re-seed", () => {
  it("installs in list order, seeds a table during install and grants it privileges", async () => {
    const order = [];
    const seeder = captureExtension("seeder", async (api) => {
      order.push("seeder");
      await seedContract(api);
    });
    const second = captureExtension("second", (api) => {
      order.push("second");
      api.registry.register({
        name: "PaqContractProbe",
        kind: "function",
        binding: "unbound",
        handle: async (ctx) => {
          // Throws unless the caller holds Read on the table seeded by the first extension.
          ctx.api.principals.authorize({ user: ctx.user, entity: "paqcontract", operation: "read", mapping: ctx.api.store.resolveMapping("paqcontract") });
          return { status: 200, body: { ok: true } };
        },
      });
    });
    const probe = await startServer({ extensions: [seeder, second] });
    try {
      assert.deepEqual(order, ["seeder", "second"]);
      const privileges = probe.store.tableRows("privilege").map((row) => row.name);
      assert.ok(privileges.includes("prvReadPaqcontract"));
      assert.ok(privileges.includes("prvCreatePaqcontract"));
      const response = await probe.get(`${API}${CRM}PaqContractProbe()`);
      assert.equal(response.status, 200);
    } finally {
      await probe.close();
    }
  });

  it("calls each reset(api) on reseed and keeps the security rows for the seeded table", async () => {
    let resets = 0;
    const extension = captureExtension("resettable", (api) => seedContract(api), {
      reset() {
        resets += 1;
      },
    });
    const probe = await startServer({ extensions: [extension] });
    try {
      await probe.server.reseed();
      assert.equal(resets, 1);
      assert.ok(probe.store.tableRows("privilege").some((row) => row.name === "prvReadPaqcontract"));
    } finally {
      await probe.close();
    }
  });
});

describe("batch-aware api.change", () => {
  // A serial queue, as the server uses: a nested change call inside a batch would wait on the batch's own slot forever.
  const serialChange = (() => {
    let tail = Promise.resolve();
    return (fn) => {
      const run = tail.then(fn);
      tail = run.catch(() => {});
      return run;
    };
  })();

  it("completes an operation's write inside a $batch changeset and outside one", async () => {
    const extension = captureExtension("writer", (api) => {
      api.registry.register({
        name: "PaqWrite",
        kind: "action",
        binding: "unbound",
        handle: async (ctx) => {
          await ctx.api.change(() => ctx.api.store.createRecord("widget", { name: ctx.body.name }, ctx.identity));
          return { status: 204 };
        },
      });
    });
    const probe = await startServer({ extensions: [extension], change: serialChange });
    try {
      const direct = await probe.send("POST", `${API}${CRM}PaqWrite`, { name: "direct" });
      assert.equal(direct.status, 204);

      const boundary = "batch_paq";
      const changeset = "changeset_paq";
      const body = [
        `--${boundary}`,
        `Content-Type: multipart/mixed; boundary=${changeset}`,
        "",
        `--${changeset}`,
        "Content-Type: application/http",
        "Content-Transfer-Encoding: binary",
        "Content-ID: 1",
        "",
        `POST ${API}${CRM}PaqWrite HTTP/1.1`,
        "Content-Type: application/json",
        "",
        JSON.stringify({ name: "from-batch" }),
        `--${changeset}--`,
        `--${boundary}--`,
        "",
      ].join("\r\n");
      const response = await fetch(`${probe.origin}${API}$batch`, {
        method: "POST",
        headers: { authorization: probe.authorization, "content-type": `multipart/mixed; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /HTTP\/1\.1 204/, "the operation's part answers 204");
      const names = probe.store.tableRows("widget").map((row) => row.name);
      assert.deepEqual(names.filter((name) => name !== "one").sort(), ["direct", "from-batch"]);
    } finally {
      await probe.close();
    }
  });
});
