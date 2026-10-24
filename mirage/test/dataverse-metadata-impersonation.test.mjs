// Metadata writes under impersonation (dataverse-metadata-relationships.mjs requireMetadataPrivilege): the impersonator
// needs prvActOnBehalfOfAnotherUser and the privileges that apply are the intersection of the impersonator's and the
// impersonated user's.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";

const APP = "77777777-7777-4777-8777-777777777777";
const NOBODY = "77777777-7777-4777-8777-7777777777b1";
const CUSTOMIZER = "77777777-7777-4777-8777-7777777777b2";
const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const table = (schema) => ({
  "@odata.type": "#Microsoft.Dynamics.CRM.EntityMetadata", SchemaName: schema, DisplayName: label(schema), DisplayCollectionName: label(`${schema}s`),
  Description: label(""), OwnershipType: "OrganizationOwned", IsActivity: false, HasNotes: false, HasActivities: false,
  Attributes: [{ "@odata.type": "#Microsoft.Dynamics.CRM.StringAttributeMetadata", SchemaName: "new_Name", IsPrimaryName: true, MaxLength: 100, FormatName: { Value: "Text" }, DisplayName: label("Name") }],
});

// One server for the file: each test writes differently named components.
const secret = `PAQVILO_METADATA_IMPERSONATION_${process.pid}`;
let store, server, request;
after(async () => { delete process.env[secret]; await server?.close(); });
before(async () => {
  process.env[secret] = "invented-secret";
  store = await new DataStore({ state: emptyState() }).init();
  const settings = dataverseSettings({ enabled: true,
    applications: [{ appId: APP, displayName: "Invented admin app", secretEnvironmentVariable: secret, roles: ["System Administrator"] }],
    users: [{ objectId: NOBODY, fullname: "No Roles", domainname: "noroles@example.test", roles: [] },
      { objectId: CUSTOMIZER, fullname: "Customizer", domainname: "customizer@example.test", roles: ["System Customizer"] }] });
  server = await startDataverseApi({ store, settings, extensions: EXTENSIONS, log: () => {} });
  const token = (await (await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP, client_secret: "invented-secret", scope: `${server.origin}/.default` }) })).json()).access_token;
  request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${server.origin}/api/data/v9.2${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
});

test("an administrator impersonating a user without privileges cannot write metadata", async () => {
  const as = { CallerObjectId: NOBODY };
  for (const [path, body] of [["/EntityDefinitions", table("new_denied")],
    ["/GlobalOptionSetDefinitions", { "@odata.type": "#Microsoft.Dynamics.CRM.OptionSetMetadata", Name: "new_deniedset", DisplayName: label("Set"), Options: [{ Value: 1, Label: label("A") }] }],
    ["/PublishAllXml", {}]]) {
    const response = await request("POST", path, body, as);
    assert.equal(response.status, 403, `${path}: ${JSON.stringify(response.json)}`);
    assert.equal(response.json.error.code, "0x80040220");
    assert.match(response.json.error.message, /^Principal user \(Id=[0-9a-f-]{36}, type=8, roleCount=0, privilegeCount=0, .*is missing prv\w+ privilege/);
  }
  assert.equal(store.state.mappings.new_denied, undefined, "a refused write leaves no table");
  assert.equal(store.state.dataverse?.globalOptionSets?.new_deniedset, undefined, "a refused write leaves no option set");
});

test("an administrator impersonating a customizer writes metadata (both hold the privilege)", async () => {
  const response = await request("POST", "/EntityDefinitions", table("new_allowed"), { CallerObjectId: CUSTOMIZER });
  assert.equal(response.status, 204, JSON.stringify(response.json));
  assert.equal(store.state.mappings.new_allowed.dataverseMetadata.createdByMetadataApi, true);
});
