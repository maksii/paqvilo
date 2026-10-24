// SDK verification gate: dynamics-web-api 2.5.1 + @azure/msal-node 7.1.0 against the Mirage Dataverse simulator.
// Opt-in only (`npm test` in this folder); not part of `npm run validate`.
// Variant B: msal uses authorityMetadata pointing at the http token endpoint, so no TLS is needed.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConfidentialClientApplication } from "@azure/msal-node";
import { DynamicsWebApi } from "dynamics-web-api";
import { startGate } from "../harness.mjs";

const T = { timeout: 60_000 };
const CHILD = fileURLToPath(new URL("./msal-tls-child.mjs", import.meta.url));
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_PAGING = "Microsoft.Dynamics.CRM.fetchxmlpagingcookie";

const gate = await startGate();
after(() => gate.close());
const { origin, tenantId, clientId, clientSecret } = gate;

const AUTHORITY_HOST = "login.sim.invalid";
const msal = new ConfidentialClientApplication({
  auth: {
    clientId,
    clientSecret,
    authority: `https://${AUTHORITY_HOST}/${tenantId}`,
    knownAuthorities: [AUTHORITY_HOST],
    authorityMetadata: JSON.stringify({
      issuer: `${origin}/${tenantId}/v2.0`,
      token_endpoint: `${origin}/${tenantId}/oauth2/v2.0/token`,
      authorization_endpoint: `${origin}/${tenantId}/oauth2/v2.0/authorize`,
      end_session_endpoint: `${origin}/${tenantId}/oauth2/v2.0/logout`,
      jwks_uri: `${origin}/${tenantId}/discovery/v2.0/keys`,
    }),
  },
});
const bearer = async () => (await msal.acquireTokenByClientCredential({ scopes: [`${origin}/.default`] })).accessToken;

const api = new DynamicsWebApi({
  serverUrl: origin,
  dataApi: { version: "9.2" },
  onTokenRefresh: async () => bearer(),
});

// Shared state across the ordered tests.
let token;
let alphaId;
let widgetTotal = 0;

test("msal acquires a client-credentials token (variant B)", T, async () => {
  token = await bearer();
  assert.equal(token.split(".").length, 3);
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  assert.equal(payload.appid, clientId);
});

test("WhoAmI returns user, business unit and organisation", T, async () => {
  const who = await api.callFunction("WhoAmI");
  assert.match(who.UserId, GUID);
  assert.match(who.BusinessUnitId, GUID);
  assert.equal(who.OrganizationId.toLowerCase(), gate.organizationId.toLowerCase());
});

test("create returns the GUID from OData-EntityId, and representation on request", T, async () => {
  alphaId = await api.create({ collection: "widgets", data: { name: "Alpha", price: 10, quantity: 2, category: 1 } });
  assert.match(alphaId, GUID);
  widgetTotal += 1;

  const rep = await api.create({ collection: "widgets", data: { name: "Rep", price: 1, quantity: 1, category: 2 }, returnRepresentation: true });
  assert.equal(typeof rep["@odata.etag"], "string");
  assert.match(rep.widgetid, GUID);
  widgetTotal += 1;
});

test("retrieve by key with select, and formatted-value annotations", T, async () => {
  const row = await api.retrieve({ collection: "widgets", key: alphaId, select: ["name", "price"] });
  assert.equal(row.name, "Alpha");

  const annotated = await api.retrieve({ collection: "widgets", key: alphaId, select: ["name", "price", "category"], includeAnnotations: "*" });
  assert.ok("price@OData.Community.Display.V1.FormattedValue" in annotated);
  assert.equal(annotated["category@OData.Community.Display.V1.FormattedValue"], "Standard");
});

test("retrieveMultiple with filter, orderBy, top and count", T, async () => {
  const res = await api.retrieveMultiple({
    collection: "widgets", select: ["name"], filter: "startswith(name,'Al')", orderBy: ["name asc"], top: 5, count: true,
  });
  assert.equal(res.oDataCount, 1);
  assert.equal(res.value.length, 1);
  assert.equal(res.value[0].name, "Alpha");
});

test("paging: maxPageSize yields a nextLink; retrieveAll follows all pages", T, async () => {
  for (const name of ["W2", "W3", "W4", "W5", "W6"]) {
    await api.create({ collection: "widgets", data: { name, price: 1, quantity: 1, category: 1 } });
    widgetTotal += 1;
  }
  const page = await api.retrieveMultiple({ collection: "widgets", select: ["name"], maxPageSize: 2 });
  assert.equal(page.value.length, 2);
  assert.ok(page.oDataNextLink, "expected @odata.nextLink");

  const all = await api.retrieveAll({ collection: "widgets", select: ["name"] });
  assert.equal(all.value.length, widgetTotal);
});

test("update and updateSingleProperty change the stored value", T, async () => {
  await api.update({ collection: "widgets", key: alphaId, data: { name: "Beta" } });
  assert.equal((await api.retrieve({ collection: "widgets", key: alphaId, select: ["name"] })).name, "Beta");

  await api.updateSingleProperty({ collection: "widgets", key: alphaId, fieldValuePair: { name: "Gamma" } });
  assert.equal((await api.retrieve({ collection: "widgets", key: alphaId, select: ["name"] })).name, "Gamma");
});

test("alternate key: upsert creates the row with the key column set", T, async () => {
  await api.upsert({ collection: "widgets", key: "code='W-1'", data: { name: "Keyed" } });
  widgetTotal += 1;
  const keyed = await api.retrieve({ collection: "widgets", key: "code='W-1'", select: ["name", "code"] });
  assert.equal(keyed.name, "Keyed");
  assert.equal(keyed.code, "W-1");
});

test("alternate key: update() sends If-Match: * so a missing key is 404, not an upsert", T, async () => {
  await assert.rejects(
    api.update({ collection: "widgets", key: "code='W-404'", data: { name: "Nope" } }),
    (e) => e.status === 404,
  );
});

test("lookup bind, navigation expand and lookup filter", T, async () => {
  const gadgetId = await api.create({ collection: "gadgets", data: { name: "G1", "widgetid@odata.bind": `/widgets(${alphaId})` } });
  assert.match(gadgetId, GUID);

  const widget = await api.retrieve({
    collection: "widgets", key: alphaId, expand: [{ property: "widget_gadgets", select: ["name"] }],
  });
  assert.equal(widget.widget_gadgets[0].name, "G1");

  const gadgets = await api.retrieveMultiple({ collection: "gadgets", filter: `_widgetid_value eq ${alphaId}` });
  assert.equal(gadgets.value.length, 1);
});

test("count equals the widget total", T, async () => {
  const n = await api.count({ collection: "widgets" });
  assert.equal(n, widgetTotal);
});

test("FetchXML: plain query, paging cookie, and fetchAll", T, async () => {
  const plain = `<fetch><entity name="widget"><attribute name="name"/><order attribute="name"/></entity></fetch>`;
  const rows = await api.fetch({ collection: "widgets", fetchXml: plain });
  assert.equal(rows.value.length, widgetTotal);

  const paged = `<fetch count="2"><entity name="widget"><attribute name="name"/><order attribute="name"/></entity></fetch>`;
  const page1 = await api.fetch({ collection: "widgets", fetchXml: paged, pageNumber: 1, includeAnnotations: FETCH_PAGING });
  assert.equal(page1.value.length, 2);
  assert.ok(page1.PagingInfo?.cookie, "expected PagingInfo.cookie");

  const all = await api.fetchAll({ collection: "widgets", fetchXml: paged, includeAnnotations: FETCH_PAGING });
  assert.equal(all.value.length, widgetTotal);
});

test("errors: retrieve of a missing record is 404 0x80040217 Does Not Exist", T, async () => {
  await assert.rejects(
    api.retrieve({ collection: "widgets", key: randomUUID(), select: ["name"] }),
    (e) => {
      assert.equal(e.status, 404);
      assert.equal(e.code, "0x80040217");
      assert.match(e.message, /Does Not Exist/);
      return true;
    },
  );
});

test("errors: unknown $select column is 400 0x80060888", { ...T }, async () => {
  await assert.rejects(
    api.retrieveMultiple({ collection: "widgets", select: ["nope"] }),
    (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.code, "0x80060888");
      return true;
    },
  );
});

test("errors: a second deleteRecord of the same id is 404", T, async () => {
  const tmp = await api.create({ collection: "widgets", data: { name: "Tmp", price: 1, quantity: 1, category: 1 } });
  widgetTotal += 1;
  await api.deleteRecord({ collection: "widgets", key: tmp });
  widgetTotal -= 1;
  await assert.rejects(api.deleteRecord({ collection: "widgets", key: tmp }), (e) => e.status === 404);
});

test("$batch executes two creates and resolves with their ids", T, async () => {
  api.startBatch();
  api.create({ collection: "widgets", data: { name: "B1", price: 1, quantity: 1, category: 1 } });
  api.create({ collection: "widgets", data: { name: "B2", price: 1, quantity: 1, category: 1 } });
  const ids = await api.executeBatch();
  widgetTotal += 2;
  assert.equal(ids.length, 2);
  for (const id of ids) assert.match(id, GUID);
  const all = await api.retrieveMultiple({ collection: "widgets", select: ["widgetid"] });
  assert.equal(all.value.length, widgetTotal);
});

test("request log shows WhoAmI and never records the bearer token", T, async () => {
  const log = gate.requests();
  // DynamicsWebApi.callFunction sends the parameterless function with empty parentheses.
  assert.ok(log.some((entry) => entry.path === "/api/data/v9.2/WhoAmI()"), "expected WhoAmI() in the request log");
  assert.equal(JSON.stringify(log).includes(token), false, "no request record carries the bearer token");
});

// Variant A: msal discovers the OIDC document over the simulator's TLS listener. Runs in a child process
// so NODE_EXTRA_CA_CERTS can trust the simulator CA (the parent cannot change its own trust store).
test("msal variant A: OIDC discovery over TLS", T, async (t) => {
  const tls = await startGate({ tls: true });
  t.after(() => tls.close());

  const child = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CHILD], {
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: tls.caFile,
        SIM_TLS_ORIGIN: tls.tlsOrigin,
        SIM_TENANT: tls.tenantId,
        SIM_CLIENT_ID: tls.clientId,
        SIM_CLIENT_SECRET: tls.clientSecret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
  assert.equal(result.ok, true, `child exited ${child.code}: ${result.error ?? child.stderr}`);
  assert.equal(result.appid, tls.clientId);

  const paths = tls.requests().map((entry) => entry.path);
  assert.ok(paths.includes(`/${tls.tenantId}/v2.0/.well-known/openid-configuration`), "expected OIDC discovery request");
  assert.ok(paths.includes(`/${tls.tenantId}/oauth2/v2.0/token`), "expected token request");
});
