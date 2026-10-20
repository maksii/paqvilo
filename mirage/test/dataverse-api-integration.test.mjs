// End-to-end HTTP checks for the Dataverse modules the API wires through EXTENSIONS and the router: one request per module,
// plus the bearer, SOAP, discovery and metadata routes. Invented schema, GUIDs and users only; loopback only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { hashSecret } from "../lib/dataverse-auth.mjs";
import { install as installCustomApis } from "../lib/dataverse-customapi.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";
import { NS } from "../lib/dataverse-soap-xml.mjs";

const APP_ID = "22222222-2222-2222-2222-222222222222";
const PUBLIC_APP_ID = "44444444-4444-4444-4444-444444444444";
const REDIRECT = "http://localhost:1/cb";
const SECRET_VAR = "PAQVILO_INTEGRATION_SECRET";
const PASSWORD = "Pass!23";
const CUSTOMIZER_OID = "55555555-5555-5555-5555-555555555555";
const BASIC_OID = "66666666-6666-6666-6666-666666666666";
const WIDGET = "aaaaaaaa-0000-0000-0000-000000000011";
const DOOMED = "aaaaaaaa-0000-0000-0000-000000000012";
const SAVED_QUERY = "bbbbbbbb-0000-0000-0000-000000000001";
const RULE = "bbbbbbbb-0000-0000-0000-000000000002";
const RULE_CONDITION = "bbbbbbbb-0000-0000-0000-000000000003";
const ACCOUNT_A = "cccccccc-0000-0000-0000-000000000001";
const ACCOUNT_B = "cccccccc-0000-0000-0000-000000000002";
const TEAM = "dddddddd-0000-0000-0000-000000000001";
const CAPI_ID = "eeeeeeee-0000-0000-0000-000000000001";
const ORIGIN_SOAP = "/XRMServices/2011/Organization.svc/web";
const SOAP_WHOAMI = `<s:Envelope xmlns:s="${NS.s}"><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:WhoAmIRequest" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:a="${NS.a}"><a:Parameters/><a:RequestName>WhoAmI</a:RequestName></request></Execute></s:Body></s:Envelope>`;
const CRM = "Microsoft.Dynamics.CRM.";

// The custom API row a Solution's customapis folder would load (dataverse-customapi.mjs seeds the same table).
const capiRow = {
  customapiid: CAPI_ID, uniquename: "pvlo_Ping", name: "pvlo_Ping", bindingtype: 0, boundentitylogicalname: null,
  isfunction: false, isprivate: false, allowedcustomprocessingsteptype: 0, executeprivilegename: null, workflowsdkstepenabled: false,
};

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name", userConfigured: true,
    dataverseMetadata: { IsAuditEnabled: { Value: true } },
    fields: {
      name: { dataverseType: "nvarchar" },
      status: { dataverseType: "int" },
      secret: { dataverseType: "nvarchar", dataverseMetadata: { IsSecured: true } },
      attachment: { dataverseType: "file", MaxSizeInKB: 1024 },
    },
    relationships: {},
  };
  state.mappings.account = {
    logicalName: "account", entitySet: "accounts", idColumn: "accountid", nameColumn: "name",
    fields: { name: { dataverseType: "nvarchar" } }, relationships: {},
  };
  state.tables.widget = [
    { widgetid: WIDGET, name: "alpha", status: 1, secret: "classified" },
    { widgetid: DOOMED, name: "doomed", status: 9, secret: "x" },
  ];
  state.tables.account = [{ accountid: ACCOUNT_A, name: "Acme" }, { accountid: ACCOUNT_B, name: "Acme copy" }];
  state.tables.savedquery = [
    { savedqueryid: SAVED_QUERY, name: "Widgets", returnedtypecode: "widget", fetchxml: '<fetch><entity name="widget"><attribute name="name"/></entity></fetch>', querytype: 0, statecode: 0 },
  ];
  state.tables.duplicaterule = [
    { duplicateruleid: RULE, name: "Widget name", baseentityname: "widget", matchingentityname: "widget", statecode: 1, statuscode: 2, excludeinactiverecords: false, iscasesensitive: false },
  ];
  state.tables.duplicaterulecondition = [
    { duplicateruleconditionid: RULE_CONDITION, regardingobjectid: RULE, baseattributename: "name", matchingattributename: "name", operatorcode: 0, ignoreblankvalues: false },
  ];
  state.tables.team = [{ teamid: TEAM, name: "Sales", teamtype: 0, businessunitid: null }];
  state.tables.customapi = [structuredClone(capiRow)];
  return state;
}

// A custom API row is registered from the table, as the server does for a Solution's customapis folder.
const customApis = { name: "customapi", install: (api) => installCustomApis(api) };

describe("dataverse API: wired modules over HTTP", () => {
  let api;
  let store;
  let origin;
  let tenantId;
  let organizationId;
  let appToken;
  let customizerId;
  let basicId;
  let appUserId;

  before(async () => {
    process.env[SECRET_VAR] = "integration-secret";
    store = await new DataStore({ state: fixtureState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        { appId: APP_ID, displayName: "Integration app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] },
        { appId: PUBLIC_APP_ID, displayName: "Public app", publicClient: true, redirectUris: [REDIRECT] },
      ],
      users: [
        { domainname: "customizer@example.test", fullname: "Customizer", objectId: CUSTOMIZER_OID, roles: ["System Customizer"] },
        { domainname: "basic@example.test", fullname: "Basic", objectId: BASIC_OID, roles: ["Basic User"] },
      ],
    });
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: [...EXTENSIONS, customApis] });
    origin = api.origin;
    tenantId = api.tenantId;
    organizationId = api.organizationId;
    appUserId = uuidV5(organizationId, `systemuser:app:${APP_ID}`);
    customizerId = uuidV5(organizationId, `systemuser:oid:${CUSTOMIZER_OID}`);
    basicId = uuidV5(organizationId, `systemuser:oid:${BASIC_OID}`);
    await store.transact(() => {
      store.tableRows("organization")[0].isauditenabled = true;
      store.state.dataverse.passwords ??= {};
      store.state.dataverse.passwords[customizerId] = hashSecret(PASSWORD);
      store.state.dataverse.passwords[basicId] = hashSecret(PASSWORD);
    });
    appToken = await clientToken();
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  async function clientToken() {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${origin}/.default` }),
    });
    return (await response.json()).access_token;
  }

  async function userToken(username) {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: PUBLIC_APP_ID, username, password: PASSWORD, scope: `${origin}/.default` }),
    });
    return (await response.json()).access_token;
  }

  // One request. A JSON body is serialised; `token` omitted sends no Authorization header.
  const call = (path, { token = appToken, method = "GET", body, headers = {} } = {}) =>
    fetch(`${origin}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const webApi = (suffix) => `/api/data/v9.2/${suffix}`;
  const entityRef = (logical, key, id) => ({ [key]: id, "@odata.type": `${CRM}${logical}` });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it("401s an unauthenticated extension route the way a data request is answered", async () => {
    const response = await call(webApi("EntityDefinitions"), { token: null, method: "POST", body: {} });
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("www-authenticate").includes("Bearer"));
  });

  it("uploads a file: InitializeFileBlocksUpload returns a continuation token", async () => {
    const response = await call(webApi("InitializeFileBlocksUpload"), {
      method: "POST",
      body: { Target: entityRef("widget", "widgetid", WIDGET), FileAttributeName: "attachment", FileName: "notes.txt" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.FileContinuationToken, "string");
    assert.ok(body.FileContinuationToken.length > 0);
  });

  it("runs a savedQuery through the predefined query hook", async () => {
    const response = await call(webApi(`widgets?savedQuery=${SAVED_QUERY}`));
    assert.equal(response.status, 200);
    const names = (await response.json()).value.map((row) => row.name).sort();
    assert.deepEqual(names, ["alpha", "doomed"]);
  });

  it("answers the audit history of a widget after it is created", async () => {
    const created = await call(webApi("widgets"), { method: "POST", body: { name: "audited", status: 2 } });
    assert.equal(created.status, 204);
    const audited = store.tableRows("widget").find((row) => row.name === "audited").widgetid;
    const target = JSON.stringify({ "@odata.id": `widgets(${audited})` });
    const response = await call(webApi(`RetrieveRecordChangeHistory(Target=@t)?${new URLSearchParams({ "@t": target })}`));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.AuditDetailCollection.AuditDetails.length, 1);
  });

  it("calls the custom API the Solution registered", async () => {
    // No response property is declared, so the action has no body to return.
    const response = await call(webApi("pvlo_Ping"), { method: "POST", body: {} });
    assert.equal(response.status, 204, await response.clone().text());
  });

  it("answers a custom API call with Prefer: respond-async 202, and its monitor reports the result", async () => {
    const queued = await call(webApi("pvlo_Ping"), { method: "POST", body: {}, headers: { prefer: "respond-async" } });
    assert.equal(queued.status, 202, await queued.clone().text());
    const monitor = new URL(queued.headers.get("location")).pathname;
    assert.match(monitor, /^\/api\/backgroundoperation\/[0-9a-f-]{36}$/);
    let status = null;
    for (let i = 0; i < 100; i++) {
      const polled = await call(monitor);
      assert.equal(polled.status, 200, await polled.clone().text());
      status = await polled.json();
      if (status.backgroundOperationStateCode === 3) break; // Completed
      await sleep(20);
    }
    assert.equal(status.backgroundOperationStateCode, 3);
    assert.equal(status.backgroundOperationStatusCode, 30); // Succeeded
  });

  it("creates a table as System Customizer and refuses the same write as Basic User", async () => {
    const table = {
      SchemaName: "new_Gizmo", OwnershipType: "OrganizationOwned", IsActivity: false, HasActivities: false, HasNotes: false,
      DisplayName: { LocalizedLabels: [{ Label: "Gizmo", LanguageCode: 1033 }] },
      DisplayCollectionName: { LocalizedLabels: [{ Label: "Gizmos", LanguageCode: 1033 }] },
      Attributes: [{
        "@odata.type": `${CRM}StringAttributeMetadata`, SchemaName: "new_Name", IsPrimaryName: true, MaxLength: 100,
        DisplayName: { LocalizedLabels: [{ Label: "Name", LanguageCode: 1033 }] },
      }],
    };
    const denied = await call(webApi("EntityDefinitions"), { token: await userToken("basic@example.test"), method: "POST", body: table });
    assert.equal(denied.status, 403);
    const created = await call(webApi("EntityDefinitions"), { token: await userToken("customizer@example.test"), method: "POST", body: table });
    assert.equal(created.status, 204);
    assert.ok(created.headers.get("odata-entityid").includes("EntityDefinitions"));
  });

  it("creates a one-to-many relationship from the table the previous test made", async () => {
    const relationship = {
      "@odata.type": `${CRM}OneToManyRelationshipMetadata`, SchemaName: "new_gizmo_widget",
      ReferencedEntity: "widget", ReferencedAttribute: "widgetid", ReferencingEntity: "new_gizmo",
      Lookup: { SchemaName: "new_WidgetId", LogicalName: "new_widgetid", DisplayName: { LocalizedLabels: [{ Label: "Widget", LanguageCode: 1033 }] } },
    };
    const response = await call(webApi("RelationshipDefinitions"), { token: await userToken("customizer@example.test"), method: "POST", body: relationship });
    assert.equal(response.status, 204);
  });

  it("refuses a duplicate of a published rule with the duplicate-detected error", async () => {
    const response = await call(webApi("widgets"), { method: "POST", body: { name: "alpha", status: 1 }, headers: { "MSCRM.SuppressDuplicateDetection": "false" } });
    assert.equal(response.status, 412);
    const body = await response.json();
    assert.equal(body.error.code, "0x80040333");
  });

  it("masks a secured column for a Basic User and shows it to the application user", async () => {
    const masked = await (await call(webApi(`widgets(${WIDGET})?$select=name,secret`), { token: await userToken("basic@example.test") })).json();
    assert.equal(masked.secret ?? null, null);
    const full = await (await call(webApi(`widgets(${WIDGET})?$select=name,secret`))).json();
    assert.equal(full.secret, "classified");
  });

  it("merges two accounts and deactivates the subordinate", async () => {
    const response = await call(webApi("Merge"), {
      method: "POST",
      body: {
        Target: entityRef("account", "accountid", ACCOUNT_A),
        Subordinate: entityRef("account", "accountid", ACCOUNT_B),
        UpdateContent: { "@odata.type": `${CRM}account`, name: "Acme merged" },
        PerformParentingChecks: false,
      },
    });
    assert.ok([200, 204].includes(response.status), `status ${response.status}`);
    assert.equal(store.tableRows("account").find((row) => row.accountid === ACCOUNT_A).name, "Acme merged");
  });

  it("queues a BulkDelete job that deletes the selected widget on a later tick", async () => {
    const response = await call(webApi("BulkDelete"), {
      method: "POST",
      body: { QuerySet: [{ EntityName: "widget", Criteria: { Conditions: [{ AttributeName: "status", Operator: "Equal", Values: [{ Type: "System.Int32", Value: 9 }] }] } }], JobName: "Retire" },
    });
    assert.equal(response.status, 200);
    const { JobId } = await response.json();
    assert.match(JobId, /^[0-9a-f-]{36}$/);
    for (let i = 0; i < 100 && store.tableRows("widget").some((row) => row.widgetid === DOOMED); i++) await sleep(20);
    assert.ok(!store.tableRows("widget").some((row) => row.widgetid === DOOMED));
  });

  it("adds a member to a team with AddMembersTeam", async () => {
    const response = await call(webApi(`teams(${TEAM})/Microsoft.Dynamics.CRM.AddMembersTeam`), {
      method: "POST",
      body: { Members: [{ "@odata.type": `${CRM}systemuser`, ownerid: customizerId }] },
    });
    assert.equal(response.status, 204);
    const idOf = (value) => value?.id ?? value;
    assert.ok(store.tableRows("teammembership").some((row) => idOf(row.teamid) === TEAM && idOf(row.systemuserid) === customizerId));
  });

  it("answers Global Discovery Instances with State as an Int32", async () => {
    const response = await call("/api/discovery/v2.0/Instances");
    assert.equal(response.status, 200);
    const [instance] = (await response.json()).value;
    assert.equal(instance.Id, organizationId);
    assert.equal(instance.State, 0);
    const v9 = await call("/api/discovery/v9.1/$metadata", { token: null });
    assert.equal(v9.status, 200);
    assert.ok((await v9.text()).includes("Instance"));
  });

  it("answers a SOAP WhoAmI with the application user", async () => {
    const body = `<s:Envelope xmlns:s="${NS.s}"><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:WhoAmIRequest" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:a="${NS.a}"><a:Parameters/><a:RequestName>WhoAmI</a:RequestName></request></Execute></s:Body></s:Envelope>`;
    const real = await fetch(`${origin}${ORIGIN_SOAP}`, { method: "POST", headers: { authorization: `Bearer ${appToken}`, "content-type": "text/xml; charset=utf-8" }, body });
    assert.equal(real.status, 200);
    const xml = await real.text();
    assert.ok(xml.includes("WhoAmIResponse"));
    assert.ok(xml.includes(appUserId));
  });

  it("answers an unauthenticated SOAP POST with a 401 that names the authority and resource", async () => {
    const response = await fetch(`${origin}${ORIGIN_SOAP}`, { method: "POST", headers: { "content-type": "text/xml" }, body: "<x/>" });
    assert.equal(response.status, 401);
    const challenge = response.headers.get("www-authenticate");
    assert.equal(challenge, `Bearer authorization_uri="${origin}/${tenantId}", resource_id="${origin}"`);
  });

  it("answers SOAP at the bare Organization.svc path as it answers /web", async () => {
    const bare = `${origin}/XRMServices/2011/Organization.svc`;
    const challenge = await fetch(bare, { method: "POST", headers: { "content-type": "text/xml" }, body: "<x/>" });
    assert.equal(challenge.status, 401);
    const response = await fetch(bare, { method: "POST", headers: { authorization: `Bearer ${appToken}`, "content-type": "text/xml; charset=utf-8" }, body: SOAP_WHOAMI });
    assert.equal(response.status, 200, await response.clone().text());
    const xml = await response.text();
    assert.ok(xml.includes("WhoAmIResponse"));
    assert.ok(xml.includes(appUserId));
  });

  it("creates and retrieves a widget over SOAP", async () => {
    const attribute = (name, value) =>
      `<a:KeyValuePairOfstringanyType><b:key>${name}</b:key><b:value i:type="c:string" xmlns:c="http://www.w3.org/2001/XMLSchema">${value}</b:value></a:KeyValuePairOfstringanyType>`;
    const create = `<s:Envelope xmlns:s="${NS.s}"><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:CreateRequest" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:a="${NS.a}" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic"><a:Parameters><a:KeyValuePairOfstringanyType><b:key>Target</b:key><b:value i:type="a:Entity"><a:Attributes>${attribute("name", "soap-made")}</a:Attributes><a:LogicalName>widget</a:LogicalName></b:value></a:KeyValuePairOfstringanyType></a:Parameters><a:RequestName>Create</a:RequestName></request></Execute></s:Body></s:Envelope>`;
    const sent = await fetch(`${origin}${ORIGIN_SOAP}`, { method: "POST", headers: { authorization: `Bearer ${appToken}`, "content-type": "text/xml; charset=utf-8" }, body: create });
    assert.equal(sent.status, 200, await sent.clone().text());
    const row = store.tableRows("widget").find((item) => item.name === "soap-made");
    assert.ok(row, "the SOAP Create wrote the row");
    const retrieve = `<s:Envelope xmlns:s="${NS.s}"><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:RetrieveRequest" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:a="${NS.a}" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic"><a:Parameters><a:KeyValuePairOfstringanyType><b:key>Target</b:key><b:value i:type="a:EntityReference"><a:Id>${row.widgetid}</a:Id><a:LogicalName>widget</a:LogicalName><a:Name i:nil="true"/></b:value></a:KeyValuePairOfstringanyType></a:Parameters><a:RequestName>Retrieve</a:RequestName></request></Execute></s:Body></s:Envelope>`;
    const read = await fetch(`${origin}${ORIGIN_SOAP}`, { method: "POST", headers: { authorization: `Bearer ${appToken}`, "content-type": "text/xml; charset=utf-8" }, body: retrieve });
    assert.equal(read.status, 200);
    assert.ok((await read.text()).includes("soap-made"));
  });

  it("answers RetrieveMetadataChanges with an entry for widget and a server version stamp", async () => {
    const query = JSON.stringify({ Criteria: { Conditions: [{ PropertyName: "LogicalName", ConditionOperator: "Equals", Value: { Type: "System.String", Value: "widget" } }] } });
    const response = await call(webApi(`RetrieveMetadataChanges(Query=@p1)?${new URLSearchParams({ "@p1": query })}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.ServerVersionStamp, "string");
    assert.ok(body.EntityMetadata.some((entity) => entity.LogicalName === "widget"));
  });

  it("answers RetrieveEntity with the entity metadata builder", async () => {
    const response = await call(webApi(`RetrieveEntity(LogicalName=@n)?${new URLSearchParams({ "@n": "'widget'" })}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.EntityMetadata.LogicalName, "widget");
  });

  it("answers RetrieveAllEntities with every table and a version stamp", async () => {
    const response = await call(webApi("RetrieveAllEntities()"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.EntityMetadata.some((entity) => entity.LogicalName === "widget"));
    assert.match(body.Timestamp, /^\d+!\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });

  it("serves a registry fragment in $metadata", async () => {
    const response = await call(webApi("$metadata"));
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('Name="PublishDuplicateRule"'));
  });

  it("reports the seeded organization id through WhoAmI", async () => {
    const response = await call(webApi("WhoAmI"));
    assert.equal((await response.json()).OrganizationId, organizationId);
  });
});

describe("anonymous extension routes", () => {
  const ANON = "/api/custom/anon";
  const BEARER = "/api/custom/bearer";
  let server;

  before(async () => {
    process.env[SECRET_VAR] = "anonymous-route-secret";
    const store = await new DataStore({ state: fixtureState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [{ appId: APP_ID, displayName: "Anonymous route app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
    });
    const routes = {
      name: "anonymous-routes",
      install: (api) => {
        api.addRoute((pathname) => pathname === ANON, () => ({ status: 200, body: { anonymous: true } }), { anonymous: true });
        api.addRoute((pathname) => pathname === BEARER, () => ({ status: 200, body: { anonymous: false } }));
      },
    };
    server = await startDataverseApi({ store, settings, log: () => {}, extensions: [routes] });
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await server?.close();
  });

  it("an anonymous extension route answers without a bearer; a normal one still returns 401", async () => {
    const open = await fetch(`${server.origin}${ANON}`);
    assert.equal(open.status, 200);
    assert.deepEqual(await open.json(), { anonymous: true });
    const closed = await fetch(`${server.origin}${BEARER}`);
    assert.equal(closed.status, 401);
  });
});
