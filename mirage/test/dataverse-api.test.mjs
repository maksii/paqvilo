import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { hashSecret } from "../lib/dataverse-auth.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";

const APP_ID = "22222222-2222-2222-2222-222222222222";
const SECRET_VAR = "PAQVILO_TEST_SECRET";
const MAKER_OID = "33333333-3333-3333-3333-333333333333";

describe("dataverse API router", () => {
  let api;
  let origin;
  let tenantId;
  let organizationId;
  let token;
  let appUserId;
  let makerUserId;
  const recordCalls = [];

  before(async () => {
    process.env[SECRET_VAR] = "test-secret-value";
    const state = emptyState();
    state.mappings = {
      widget: { entitySet: "widgets", idColumn: "widgetid", fields: { name: { dataverseType: "nvarchar" }, ownerid: { dataverseType: "owner" } } },
    };
    state.tables = { widget: [{ widgetid: "aaaaaaaa-0000-0000-0000-000000000001", name: "one" }, { widgetid: "aaaaaaaa-0000-0000-0000-000000000002", name: "two" }] };
    const store = await new DataStore({ state }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [{ appId: APP_ID, displayName: "Gate app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
      users: [{ domainname: "maker@example.test", fullname: "Maker User", objectId: MAKER_OID, roles: [] }],
    });
    const records = {
      handle: async (ctx) => {
        recordCalls.push(ctx);
        return { status: 200, body: { echo: ctx.route.kind, user: ctx.user.systemuserid } };
      },
    };
    api = await startDataverseApi({ store, change: (fn) => fn(), settings, records, log: () => {} });
    origin = api.origin;
    tenantId = api.tenantId;
    organizationId = api.organizationId;
    appUserId = uuidV5(organizationId, `systemuser:app:${APP_ID}`);
    makerUserId = uuidV5(organizationId, `systemuser:oid:${MAKER_OID}`);
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: APP_ID,
        client_secret: process.env[SECRET_VAR],
        scope: `${origin}/.default`,
      }),
    });
    token = (await response.json()).access_token;
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });
  const get = (path, headers = {}) => fetch(`${origin}${path}`, { headers: { ...auth(), ...headers } });
  const apiPath = (suffix) => `/api/data/v9.2/${suffix}`;

  it("serves the OIDC v2 document under the real origin", async () => {
    const response = await fetch(`${origin}/${tenantId}/v2.0/.well-known/openid-configuration`);
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.ok(document.token_endpoint.startsWith(`${origin}/`));
  });

  it("issues a client_credentials token that the API accepts", async () => {
    assert.equal(typeof token, "string");
    assert.equal(token.split(".").length, 3);
  });

  it("answers WhoAmI with the application user and the root business unit", async () => {
    const response = await get(apiPath("WhoAmI"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.UserId, appUserId);
    assert.equal(body.OrganizationId, organizationId);
    assert.equal(body.BusinessUnitId, uuidV5(organizationId, "businessunit:root"));
  });

  it("answers a missing token with a 401 challenge and no body", async () => {
    const response = await fetch(`${origin}${apiPath("WhoAmI")}`);
    assert.equal(response.status, 401);
    const challenge = response.headers.get("www-authenticate");
    assert.ok(challenge.includes(`authorization_uri="${origin}/${tenantId}/oauth2/authorize"`));
    assert.ok(challenge.includes(`resource_id="${origin}/"`));
    assert.ok(!challenge.includes("invalid_token"));
    assert.equal(await response.text(), "");
  });

  it("answers a garbage token with a 401 invalid_token challenge", async () => {
    const response = await get(apiPath("WhoAmI"), { authorization: "Bearer not.a.token" });
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("www-authenticate").includes('error="invalid_token"'));
  });

  it("returns 404 with an empty code for POST to a function", async () => {
    const response = await fetch(`${origin}${apiPath("WhoAmI")}`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, "");
    assert.ok(body.error.message.includes("No HTTP resource was found"));
  });

  it("answers RetrieveVersion", async () => {
    const response = await get(apiPath("RetrieveVersion"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).Version, "9.2.25041.00000");
  });

  it("answers RetrieveCurrentOrganization with the endpoint dictionary", async () => {
    const response = await get(apiPath("RetrieveCurrentOrganization(AccessType='Default')"));
    assert.equal(response.status, 200);
    const { Detail } = await response.json();
    assert.equal(Detail.OrganizationId, organizationId);
    assert.deepEqual(Detail.Endpoints.Keys, ["OrganizationService", "OrganizationDataService", "WebApplication"]);
    assert.equal(Detail.Endpoints.Values.length, 3);
    assert.equal(Detail.Endpoints.Values[2], `${origin}/`);
  });

  it("answers RetrieveTotalRecordCount for a table", async () => {
    const query = new URLSearchParams({ "@p": '["widget"]' });
    const response = await get(apiPath(`RetrieveTotalRecordCount(EntityNames=@p)?${query}`));
    assert.equal(response.status, 200);
    const { EntityRecordCountCollection } = await response.json();
    assert.deepEqual(EntityRecordCountCollection.Keys, ["widget"]);
    assert.deepEqual(EntityRecordCountCollection.Values, [2]);
  });

  it("answers the discovery Instances endpoint with a normal token", async () => {
    const response = await get("/api/discovery/v2.0/Instances");
    assert.equal(response.status, 200);
    const [instance] = (await response.json()).value;
    assert.equal(instance.Id, organizationId);
    assert.equal(instance.TenantId, tenantId);
  });

  it("lists the widgets entity set in the service document", async () => {
    const response = await get(apiPath(""));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.value.some((item) => item.name === "widgets"));
  });

  it("filters EntityDefinitions by LogicalName", async () => {
    const response = await get(apiPath("EntityDefinitions?$select=LogicalName,EntitySetName&$filter=LogicalName+eq+'widget'"));
    assert.equal(response.status, 200);
    const { value } = await response.json();
    assert.equal(value.length, 1);
    assert.equal(value[0].LogicalName, "widget");
    assert.ok(value[0].MetadataId);
  });

  it("lists owner attributes including ownerid", async () => {
    const response = await get(apiPath("EntityDefinitions(LogicalName='widget')/Attributes/Microsoft.Dynamics.CRM.OwnerAttributeMetadata"));
    assert.equal(response.status, 200);
    const { value } = await response.json();
    assert.ok(value.some((item) => item.LogicalName === "ownerid"));
  });

  it("returns the user privileges wrapped as RolePrivileges", async () => {
    const response = await get(apiPath(`systemusers(${appUserId})/Microsoft.Dynamics.CRM.RetrieveUserPrivileges()`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.RolePrivileges));
  });

  it("passes collection reads to the record handler with the caller", async () => {
    recordCalls.length = 0;
    const response = await get(apiPath("widgets"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.echo, "collection");
    assert.equal(body.user, appUserId);
    assert.equal(recordCalls.at(-1).user.systemuserid, appUserId);
  });

  it("impersonates a target user via MSCRMCallerID for an administrator application", async () => {
    recordCalls.length = 0;
    const response = await get(apiPath("widgets"), { MSCRMCallerID: makerUserId });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user, makerUserId);
    assert.equal(recordCalls.at(-1).user.systemuserid, makerUserId);
    assert.equal(recordCalls.at(-1).caller.systemuserid, appUserId);
  });

  it("answers an unknown route with 404 0x8006088a", async () => {
    const response = await get("/api/data/v8.0/widgets");
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "0x8006088a");
  });

  it("answers SOAP POST with a 500 text/xml fault", async () => {
    const response = await fetch(`${origin}/XRMServices/2011/Organization.svc/web`, { method: "POST", body: "<x/>" });
    assert.equal(response.status, 500);
    assert.ok(response.headers.get("content-type").startsWith("text/xml"));
    assert.ok((await response.text()).includes("<faultcode>s:Receiver</faultcode>"));
  });

  it("logs requests without authorization data", async () => {
    const entries = api.requests();
    assert.ok(entries.length > 0);
    assert.ok(entries.every((entry) => !("authorization" in entry)));
    assert.ok(!JSON.stringify(entries).includes(token));
  });

  it("answers OPTIONS with CORS headers", async () => {
    const response = await fetch(`${origin}${apiPath("widgets")}`, { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  });

  it("closes all listeners", async () => {
    await api.close();
    api = null;
  });
});

// Batch, metadata and sign-in over HTTP. This fixture omits `records`, so the real record handlers answer the data calls.
const CRLF = "\r\n";
const PUBLIC_APP_ID = "44444444-4444-4444-4444-444444444444";
const REDIRECT = "http://localhost:1/cb";
const VERIFIER = "pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const PASSWORD = "Pass!23";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const WIDGET_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const multipart = (boundary, parts) => `${parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF)}${CRLF}--${boundary}--`;
// `raw` sends a body verbatim, for a request that must fail to parse.
const httpPart = ({ contentId, method, path, json, raw }) =>
  [
    "Content-Type: application/http",
    "Content-Transfer-Encoding: binary",
    ...(contentId ? [`Content-ID: ${contentId}`] : []),
    "",
    `${method} ${path} HTTP/1.1`,
    ...(json !== undefined || raw !== undefined ? ["Content-Type: application/json", "", raw ?? JSON.stringify(json)] : []),
  ].join(CRLF);
const changesetPart = (boundary, requests) => ["Content-Type: multipart/mixed; boundary=" + boundary, "", multipart(boundary, requests)].join(CRLF);
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
const form = { "content-type": "application/x-www-form-urlencoded" };

describe("dataverse API batch, metadata and sign-in", () => {
  let api;
  let origin;
  let tenantId;
  let organizationId;
  let store;
  let token;
  let makerUserId;
  let now;

  before(async () => {
    process.env[SECRET_VAR] = "test-secret-value";
    now = Date.parse("2026-10-19T12:00:00Z");
    const state = emptyState();
    state.mappings = {
      widget: {
        entitySet: "widgets",
        idColumn: "widgetid",
        fields: {
          name: { dataverseType: "nvarchar" },
          ownerid: { dataverseType: "owner" },
          category: { dataverseType: "picklist", options: [{ value: 1, label: "Standard" }, { value: 2, label: "Premium" }] },
        },
      },
    };
    state.tables = { widget: [{ widgetid: WIDGET_ID, name: "one" }, { widgetid: "aaaaaaaa-0000-0000-0000-000000000002", name: "two" }] };
    store = await new DataStore({ state }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        { appId: APP_ID, displayName: "Gate app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] },
        { appId: PUBLIC_APP_ID, displayName: "Public app", publicClient: true, redirectUris: [REDIRECT] },
      ],
      users: [{ domainname: "maker@example.test", fullname: "Maker User", objectId: MAKER_OID, roles: [] }],
    });
    api = await startDataverseApi({ store, change: (fn) => fn(), settings, clock: () => now, log: () => {} });
    origin = api.origin;
    tenantId = api.tenantId;
    organizationId = api.organizationId;
    makerUserId = uuidV5(organizationId, `systemuser:oid:${MAKER_OID}`);
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${origin}/.default` }),
    });
    token = (await response.json()).access_token;
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  const bearer = (value) => ({ authorization: `Bearer ${value}` });
  const send = (path, init = {}) => fetch(`${origin}${path}`, init);
  const apiPath = (suffix) => `/api/data/v9.2/${suffix}`;
  const count = () => store.tableRows("widget").length;
  const batch = (boundary, parts, headers = {}) =>
    send(apiPath("$batch"), {
      method: "POST",
      headers: { ...bearer(token), "content-type": `multipart/mixed; boundary=${boundary}`, ...headers },
      body: `${multipart(boundary, parts)}${CRLF}`,
    });
  const tokenRequest = async (fields) => {
    const response = await send(`/${tenantId}/oauth2/v2.0/token`, { method: "POST", headers: form, body: new URLSearchParams(fields) });
    return { status: response.status, body: await response.json() };
  };

  it("serves $metadata as application/xml with the widget entity type", async () => {
    const response = await send(apiPath("$metadata"), { headers: bearer(token) });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith("application/xml"));
    assert.ok((await response.text()).includes('EntityType Name="widget"'));
  });

  it("answers RetrieveMetadataChanges with one entry for widget", async () => {
    const criteria = { Conditions: [{ PropertyName: "LogicalName", ConditionOperator: "Equals", Value: { Type: "System.String", Value: "widget" } }] };
    const query = JSON.stringify({ Criteria: criteria });
    const response = await send(apiPath(`RetrieveMetadataChanges(Query=@p1)?${new URLSearchParams({ "@p1": query })}`), { headers: bearer(token) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.EntityMetadata.length, 1);
    assert.equal(body.EntityMetadata[0].LogicalName, "widget");
    assert.ok(body["@odata.context"].endsWith("Microsoft.Dynamics.CRM.RetrieveMetadataChangesResponse"));
  });

  it("expands nested OptionSet options on picklist attributes", async () => {
    const path = apiPath("EntityDefinitions(LogicalName='widget')/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)");
    const response = await send(path, { headers: bearer(token) });
    assert.equal(response.status, 200);
    const { value } = await response.json();
    const category = value.find((item) => item.LogicalName === "category");
    assert.ok(category, "expected the category picklist attribute");
    assert.equal(category.OptionSet.Options[0].Value, 1);
    assert.equal(category.OptionSet.Options[0].Label.LocalizedLabels[0].Label, "Standard");
  });

  it("answers WhoAmI() with parentheses", async () => {
    const response = await send(apiPath("WhoAmI()"), { headers: bearer(token) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).OrganizationId, organizationId);
  });

  it("runs a changeset of two creates and returns the entity ids in a multipart response", async () => {
    const before = count();
    const response = await batch("batch_ok", [
      changesetPart("cs_ok", [
        httpPart({ contentId: "1", method: "POST", path: apiPath("widgets"), json: { name: "alpha" } }),
        httpPart({ contentId: "2", method: "POST", path: apiPath("widgets"), json: { name: "beta" } }),
      ]),
    ]);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith("multipart/mixed"));
    const text = await response.text();
    assert.ok(text.includes("--changesetresponse_"));
    assert.equal(text.match(/OData-EntityId:/gi)?.length, 2);
    assert.equal(count(), before + 2);
  });

  it("rolls back earlier changeset writes when a later request fails with 400", async () => {
    const before = count();
    const response = await batch("batch_bad", [
      changesetPart("cs_bad", [
        httpPart({ contentId: "1", method: "POST", path: apiPath("widgets"), json: { name: "gamma" } }),
        httpPart({ contentId: "2", method: "POST", path: apiPath("widgets"), raw: '{"name":' }),
      ]),
    ]);
    assert.equal(response.status, 400);
    assert.equal(count(), before);
  });

  it("continues past a failed part when Prefer odata.continue-on-error is set", async () => {
    const before = count();
    const response = await batch(
      "batch_cont",
      [
        httpPart({ method: "GET", path: apiPath("widgets(aaaaaaaa-0000-0000-0000-0000000000ff)") }),
        httpPart({ method: "POST", path: apiPath("widgets"), json: { name: "delta" } }),
      ],
      { prefer: "odata.continue-on-error" },
    );
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("preference-applied").includes("odata.continue-on-error"));
    const text = await response.text();
    assert.ok(text.includes("HTTP/1.1 404"));
    assert.match(text, /HTTP\/1\.1 20[14]/);
    assert.equal(count(), before + 1);
  });

  it("rejects a GET inside a changeset with 400", async () => {
    const response = await batch("batch_get", [changesetPart("cs_get", [httpPart({ contentId: "1", method: "GET", path: apiPath("widgets") })])]);
    assert.equal(response.status, 400);
  });

  it("answers GET on $batch with 405", async () => {
    const response = await send(apiPath("$batch"), { headers: bearer(token) });
    assert.equal(response.status, 405);
  });

  const authorizeQuery = () =>
    new URLSearchParams({
      client_id: PUBLIC_APP_ID,
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: `${origin}/.default openid`,
      state: "s1",
      nonce: "n1",
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      code_challenge_method: "S256",
    });
  const authorizePath = () => `/${tenantId}/oauth2/v2.0/authorize?${authorizeQuery()}`;
  let code;
  let userToken;

  it("shows the account picker for an interactive sign-in", async () => {
    const response = await send(authorizePath());
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith("text/html"));
    assert.ok((await response.text()).includes("Maker User"));
  });

  it("redirects with a code and the state once the picker is submitted", async () => {
    const response = await send(authorizePath(), {
      method: "POST",
      redirect: "manual",
      headers: form,
      body: new URLSearchParams({ ...Object.fromEntries(authorizeQuery()), oid: MAKER_OID }),
    });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
    assert.equal(location.searchParams.get("state"), "s1");
    code = location.searchParams.get("code");
    assert.ok(code);
  });

  it("exchanges the code with PKCE for a user access token and an id token", async () => {
    const { status, body } = await tokenRequest({
      grant_type: "authorization_code",
      client_id: PUBLIC_APP_ID,
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    assert.equal(status, 200);
    assert.ok(body.id_token);
    userToken = body.access_token;
    assert.equal(claimsOf(userToken).upn, "maker@example.test");
  });

  it("answers WhoAmI with the interactive user's systemuserid", async () => {
    const response = await send(apiPath("WhoAmI"), { headers: bearer(userToken) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).UserId, makerUserId);
  });

  let device;
  const poll = () => tokenRequest({ grant_type: DEVICE_GRANT, client_id: PUBLIC_APP_ID, device_code: device.device_code });

  it("issues a device code and reports authorization_pending before approval", async () => {
    const response = await send(`/${tenantId}/oauth2/v2.0/devicecode`, {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ client_id: PUBLIC_APP_ID, scope: `${origin}/.default openid` }),
    });
    assert.equal(response.status, 200);
    device = await response.json();
    assert.ok(device.user_code);
    const pending = await poll();
    assert.equal(pending.status, 400);
    assert.equal(pending.body.error, "authorization_pending");
  });

  it("issues a token once the verification page approves the code", async () => {
    const approve = await send("/common/oauth2/deviceauth", {
      method: "POST",
      redirect: "manual",
      headers: form,
      body: new URLSearchParams({ otc: device.user_code, oid: MAKER_OID }),
    });
    assert.equal(approve.status, 200);
    now += 6_000; // the device poll interval is 5 seconds
    const done = await poll();
    assert.equal(done.status, 200);
    assert.equal(claimsOf(done.body.access_token).upn, "maker@example.test");
  });

  it("signs in with a password grant only when the stored secret matches", async () => {
    store.state.dataverse.passwords ??= {};
    store.state.dataverse.passwords[makerUserId] = hashSecret(PASSWORD);
    const fields = { grant_type: "password", client_id: PUBLIC_APP_ID, username: "maker@example.test", scope: `${origin}/.default` };
    const ok = await tokenRequest({ ...fields, password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal(claimsOf(ok.body.access_token).upn, "maker@example.test");
    const wrong = await tokenRequest({ ...fields, password: "not-the-password" });
    assert.equal(wrong.status, 400);
    assert.ok(wrong.body.error_description.startsWith("AADSTS50126"));
  });
});
