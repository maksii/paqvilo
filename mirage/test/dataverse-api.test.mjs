import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
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
