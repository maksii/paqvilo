// HTTP-level checks for the router core: service protection, identity and impersonation, the request body, changesets
// (runAtomic) and federated issuers from settings. Invented schema and loopback fixtures only.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { runAtomic, startDataverseApi } from "../lib/dataverse-api.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";

const SECRET_VAR = "PAQVILO_CORE_TEST_SECRET";
const ORG_ID = "0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const APP_ID = "22222222-2222-2222-2222-222222222222";
const FED_APP_ID = "55555555-5555-4555-8555-555555555555";
const MAKER_OID = "33333333-3333-3333-3333-333333333333";
const WIDGET_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ISSUER = "https://issuer.example.test";
const SUBJECT = "invented-subject-1";
const AUDIENCE = "api://AzureADTokenExchange";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const API = "/api/data/v9.2/";
const CRM = "Microsoft.Dynamics.CRM.";
const CRLF = "\r\n";
const CALLER_MESSAGE = "CallerId provided for impersonation is invalid. Provided CallerId is either NULL or empty string";

process.env[SECRET_VAR] = "core-test-secret";
const servers = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("condition was not reached");
}

// One router per call. The records stub answers every table call: ?hold=1 parks the request until gate.release(), ?sleep=1
// waits 25 ms, a POST writes a widget row through the store and answers 204 with its OData-EntityId.
async function start({ serviceProtection = null, extensions = [], applications = null, federatedIssuers = [], tables = {}, managedIdentity = null } = {}) {
  const state = emptyState();
  state.mappings = { widget: { entitySet: "widgets", idColumn: "widgetid", fields: { name: { dataverseType: "nvarchar" } } } };
  state.tables = { widget: [{ widgetid: WIDGET_ID, name: "one" }], ...tables };
  const store = await new DataStore({ state }).init();
  const calls = [];
  const gate = {};
  let api;
  const capture = { name: "capture", install: (installed) => { api = installed; } };
  const records = {
    handle: async (ctx) => {
      calls.push(ctx);
      if (ctx.url.searchParams.has("hold")) await new Promise((resolve) => (gate.release = resolve));
      if (ctx.url.searchParams.has("sleep")) await delay(25);
      if (ctx.method === "POST") {
        const widgetid = randomUUID();
        await store.transact(() => store.state.tables.widget.push({ widgetid, name: "made" }));
        return { status: 204, headers: { "OData-EntityId": `${ctx.origin}${API}widgets(${widgetid})` } };
      }
      return { status: 200, body: { echo: ctx.route.kind } };
    },
  };
  const settings = dataverseSettings({
    enabled: true,
    organizationId: ORG_ID,
    serviceProtection,
    federatedIssuers,
    applications: applications ?? [{ appId: APP_ID, displayName: "Core test app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
    users: [{ domainname: "maker@example.test", fullname: "Maker User", objectId: MAKER_OID, roles: [] }],
  });
  const router = await startDataverseApi({ store, settings, records, extensions: [capture, ...extensions], log: () => {}, managedIdentity });
  servers.push(router);
  const origin = router.origin;
  const appUserId = uuidV5(router.organizationId, `systemuser:app:${APP_ID}`);
  const makerId = uuidV5(router.organizationId, `systemuser:oid:${MAKER_OID}`);
  const tokenFor = async (form) => {
    const response = await fetch(`${origin}/${router.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ scope: `${origin}/.default`, ...form }),
    });
    return response.json();
  };
  const { access_token: token } = await tokenFor({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR] });
  const url = (path) => (path.startsWith("/") ? `${origin}${path}` : `${origin}${API}${path}`);
  const call = (method, path, { headers = {}, body } = {}) =>
    fetch(url(path), { method, headers: { authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(10_000) });
  return {
    api,
    router,
    store,
    origin,
    tenantId: router.tenantId,
    appUserId,
    makerId,
    calls,
    gate,
    tokenFor,
    get: (path, headers) => call("GET", path, { headers }),
    send: (method, path, body, headers) => call(method, path, { body, headers }),
  };
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function signedJwt(privateKey, kid, claims) {
  const head = b64({ alg: "RS256", typ: "JWT", kid });
  const body = b64(claims);
  return `${head}.${body}.${sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

// Batch bodies, as the $batch tests write them.
const httpPart = (contentId, method, path, json) =>
  ["Content-Type: application/http", "Content-Transfer-Encoding: binary", `Content-ID: ${contentId}`, "", `${method} ${path} HTTP/1.1`, ...(json !== undefined ? ["Content-Type: application/json", "", JSON.stringify(json)] : [])].join(CRLF);
const multipartBody = (boundary, parts) => `${parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF)}${CRLF}--${boundary}--`;
const changesetOf = (boundary, parts) => ["Content-Type: multipart/mixed; boundary=" + boundary, "", multipartBody(boundary, parts)].join(CRLF);

after(async () => {
  delete process.env[SECRET_VAR];
  for (const router of servers) await router.close();
});

describe("service protection on the Web API", () => {
  it("counts requests against requestsPer300s, reports what is left, and answers the configured limit with Retry-After", async () => {
    const s = await start({ serviceProtection: { requestsPer300s: 2 } });
    const first = await s.get("widgets");
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-ms-ratelimit-burst-remaining-xrm-requests"), "1");
    assert.equal((await s.get("widgets")).headers.get("x-ms-ratelimit-burst-remaining-xrm-requests"), "0");
    const limited = await s.get("widgets");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    const { error } = await limited.json();
    assert.equal(error.code, "0x80072322");
    assert.equal(error.message, "Number of requests exceeded the limit of 2 over time window of 300 seconds.");
  });

  it("holds a concurrency slot until its request ends and answers 0x80072326 past concurrentRequests", async () => {
    const s = await start({ serviceProtection: { concurrentRequests: 1 } });
    const held = s.get("widgets?hold=1");
    await until(() => s.gate.release);
    const refused = await s.get("widgets");
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "1");
    assert.equal((await refused.json()).error.code, "0x80072326");
    s.gate.release();
    assert.equal((await held).status, 200);
    assert.equal((await s.get("widgets")).status, 200);
  });

  it("counts the execution time of finished requests against executionMsPer300s", async () => {
    const s = await start({ serviceProtection: { executionMsPer300s: 1 } });
    assert.equal((await s.get("widgets?sleep=1")).status, 200);
    const refused = await s.get("widgets");
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error.code, "0x80072321");
    assert.equal(refused.headers.get("x-ms-ratelimit-time-remaining-xrm-requests"), "0.00");
  });
});

describe("identity and impersonation", () => {
  it("gives every request identity the Dataverse identity, with hierarchy functions that the store's clone skips", async () => {
    const s = await start();
    assert.equal((await s.get("widgets")).status, 200);
    const { identity } = s.calls.at(-1);
    assert.equal(identity.dataverse.userId, s.appUserId);
    assert.equal(identity.dataverse.callerId, s.appUserId);
    assert.ok(Array.isArray(identity.dataverse.teamIds));
    assert.equal(typeof identity.dataverse.hierarchy, "function");
    assert.equal(typeof identity.dataverse.userHierarchy, "function");
    assert.equal(Object.keys(identity.dataverse).includes("hierarchy"), false);
    assert.doesNotThrow(() => structuredClone(identity));
  });

  it("lists the team memberships of the caller in teamIds", async () => {
    const team = "7a7a7a7a-0000-4000-8000-000000000001";
    const appUserId = uuidV5(ORG_ID, `systemuser:app:${APP_ID}`);
    const s = await start({
      tables: {
        team: [{ teamid: team, name: "Operations", teamtype: 0 }],
        teammembership: [{ teammembershipid: "8a8a8a8a-0000-4000-8000-000000000001", systemuserid: appUserId, teamid: team }],
      },
    });
    assert.equal(s.appUserId, appUserId);
    await s.get("widgets");
    assert.ok(s.calls.at(-1).identity.dataverse.teamIds.includes(team));
  });

  it("impersonates through MSCRMCallerID as the caller's effective principal and records the caller", async () => {
    const s = await start();
    assert.equal((await s.get("widgets", { MSCRMCallerID: s.makerId })).status, 200);
    const { user, identity } = s.calls.at(-1);
    assert.equal(user.systemuserid, s.makerId);
    assert.equal(user.impersonator.systemuserid, s.appUserId);
    assert.equal(identity.dataverse.userId, s.makerId);
    assert.equal(identity.dataverse.callerId, s.appUserId);
  });

  it("answers an empty or malformed CallerId, by either header, with 400 0x80048d1A", async () => {
    const s = await start();
    for (const headers of [{ MSCRMCallerID: "" }, { CallerObjectId: "" }, { MSCRMCallerID: "not-a-guid" }]) {
      const res = await s.get("widgets", headers);
      assert.equal(res.status, 400, JSON.stringify(headers));
      const { error } = await res.json();
      assert.equal(error.code, "0x80048d1A");
      assert.equal(error.message, CALLER_MESSAGE);
    }
  });
});

describe("request body", () => {
  it("answers a body over 128 MB with 413 0x8004418a", async () => {
    const s = await start();
    const res = await s.send("POST", "widgets", Buffer.alloc(128 * 1024 * 1024 + 1), { "content-type": "application/octet-stream" });
    assert.equal(res.status, 413);
    const { error } = await res.json();
    assert.equal(error.code, "0x8004418a");
    assert.equal(error.message, "Request message length is too large.");
  });

  it("hands an operation the received bytes unchanged in bodyBuffer", async () => {
    const extension = {
      name: "bytes",
      install: (api) =>
        api.registry.register({
          name: "PaqBytes",
          kind: "action",
          binding: "unbound",
          handle: async (ctx) => ({ status: 200, body: { hex: ctx.bodyBuffer.toString("hex"), isBuffer: Buffer.isBuffer(ctx.bodyBuffer) } }),
        }),
    };
    const s = await start({ extensions: [extension] });
    const res = await s.send("POST", `${CRM}PaqBytes`, Buffer.from([0xff, 0x00, 0xfe]), { "content-type": "application/octet-stream" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { hex: "ff00fe", isBuffer: true });
  });
});

describe("changesets and runAtomic", () => {
  it("rolls a changeset back when a later part fails, after the earlier part had written", async () => {
    const s = await start();
    const before = s.store.tableRows("widget").length;
    const cs = changesetOf("cs_roll", [
      httpPart("1", "POST", `${s.origin}${API}widgets`, { name: "kept" }),
      httpPart("2", "POST", `${s.origin}${API}widgets`, { "parent@odata.bind": "$missing" }),
    ]);
    const res = await s.send("POST", "$batch", multipartBody("b_roll", [cs]), { "content-type": "multipart/mixed; boundary=b_roll" });
    const text = await res.text();
    // A failed changeset part fails the batch with 400 (as the rollback test in dataverse-api.test.mjs expects), and the
    // response names only the failed part. The first part did reach the records layer before the rollback.
    assert.equal(res.status, 400, text);
    assert.match(text, /HTTP\/1\.1 400/);
    assert.equal(s.calls.filter((ctx) => ctx.method === "POST").length, 1);
    assert.equal(s.store.tableRows("widget").length, before);
  });

  it("a changeset's writes stay private until it returns, and a plain transact inside it joins it", async () => {
    const s = await start();
    const before = s.store.tableRows("widget").length;
    // Created outside the changeset, so its continuation reads the committed state while the changeset is parked.
    const outside = delay(5).then(() => s.store.tableRows("widget").length);
    let inside;
    await runAtomic(s.api, async () => {
      await s.store.transact(() => s.store.state.tables.widget.push({ widgetid: randomUUID(), name: "joined" }));
      inside = s.store.tableRows("widget").length;
      assert.equal(await outside, before, "a concurrent reader sees the committed rows only");
    });
    assert.equal(inside, before + 1);
    assert.equal(s.store.tableRows("widget").length, before + 1);
  });

  it("runAtomic restores the store when fn throws and keeps the writes when fn returns", async () => {
    const s = await start();
    assert.ok(s.api.changes, "the api exposes its change log");
    const before = s.store.tableRows("widget").length;
    const write = (name) => s.store.transact(() => s.store.state.tables.widget.push({ widgetid: randomUUID(), name }));
    await assert.rejects(
      runAtomic(s.api, async () => {
        await write("gone");
        throw new Error("stop");
      }),
      /stop/,
    );
    assert.equal(s.store.tableRows("widget").length, before);
    assert.equal(await runAtomic(s.api, async () => (await write("kept")) && "done"), "done");
    assert.equal(s.store.tableRows("widget").length, before + 1);
  });
});

describe("managed identity hook", () => {
  const managedIdentity = (req) =>
    req.pathname === "/msi/token" && req.method === "GET" ? { status: 200, headers: {}, body: { via: "hook", resource: req.searchParams.get("resource") } } : null;

  it("answers a GET it claims before authentication, and leaves other GETs to the router", async () => {
    const s = await start({ managedIdentity });
    const hooked = await fetch(`${s.origin}/msi/token?resource=x`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(hooked.status, 200);
    assert.match(hooked.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await hooked.json(), { via: "hook", resource: "x" });
    const routed = await s.get("widgets");
    assert.equal(routed.status, 200);
    assert.deepEqual(await routed.json(), { echo: "collection" });
  });

  it("startDataverseApi returns the authority's managed identity token issuer", async () => {
    const s = await start();
    assert.equal(typeof s.router.issueManagedIdentityToken, "function");
  });
});

describe("federated issuers from settings", () => {
  it("verifies a federated client assertion against the issuers the settings register", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "ext-1", alg: "RS256", use: "sig" };
    const s = await start({
      federatedIssuers: [{ issuer: ISSUER, jwks: { keys: [jwk] } }],
      applications: [
        { appId: APP_ID, displayName: "Core test app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] },
        { appId: FED_APP_ID, displayName: "Federated app", federatedCredentials: [{ issuer: ISSUER, subject: SUBJECT, audiences: [AUDIENCE] }] },
      ],
    });
    const now = Math.floor(Date.now() / 1000);
    const assertion = signedJwt(pair.privateKey, "ext-1", { iss: ISSUER, sub: SUBJECT, aud: AUDIENCE, nbf: now, exp: now + 300, jti: randomUUID() });
    const token = await s.tokenFor({ grant_type: "client_credentials", client_id: FED_APP_ID, client_assertion_type: ASSERTION_TYPE, client_assertion: assertion });
    assert.ok(token.access_token, JSON.stringify(token));
    assert.equal(JSON.parse(Buffer.from(token.access_token.split(".")[1], "base64url").toString("utf8")).appidacr, "2");
  });
});
