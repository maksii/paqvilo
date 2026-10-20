// All installed extensions contribute to one EDM model. SDK parsers need every referenced type declared, including
// nested structured parameters of internal-only messages. Invented mappings and loopback only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { createOperationRegistry } from "../lib/dataverse-operations.mjs";
import { parseSolutionXml } from "../lib/solution-xml.mjs";
import { platformCsdl } from "../lib/dataverse-operation-contracts.mjs";

test("platform contracts preserve native parameter order, optionality and collection overloads without changing custom APIs", () => {
  const registry = createOperationRegistry();
  const handle = () => ({ status: 204 });
  registry.register({ name: "RetrieveFilteredForms", kind: "function", binding: "collection", entity: "systemform", handle });
  registry.register({ name: "RetrieveUnpublished", kind: "function", binding: "entity", entity: "savedquery", handle });
  registry.register({ name: "RetrieveUnpublished", kind: "function", binding: "entity", entity: "systemform", handle });
  registry.register({ name: "new_CustomPing", kind: "action", binding: "unbound", signature: { params: [["customPayload", "Edm.Int32"]], response: [["reply", "Edm.String"]] }, handle });
  const collection = registry.find({ name: "RetrieveFilteredForms", kind: "function", binding: "collection", entity: "systemform" });
  const form = parseSolutionXml(`<Schema>${collection.csdl}</Schema>`).children.find((node) => node.name === "Function");
  assert.deepEqual(form.children.filter((node) => node.name === "Parameter").map((node) => [node.attrs.Name, node.attrs.Type]), [["entityset", "Collection(mscrm.systemform)"], ["EntityLogicalName", "Edm.String"], ["FormType", "Edm.Int32"], ["User", "mscrm.systemuser"]]);
  assert.equal(form.children[0].attrs.Nullable, "false");
  assert.equal(collection.handle, handle);
  for (const entity of ["savedquery", "systemform"]) {
    const op = registry.find({ name: "RetrieveUnpublished", kind: "function", binding: "entity", entity });
    assert.match(op.csdl, new RegExp(`<ReturnType Type="mscrm\\.${entity}"`));
  }
  const custom = registry.find({ name: "new_CustomPing", kind: "action", binding: "unbound" });
  assert.match(custom.csdl, /Name="customPayload" Type="Edm.Int32"/);
  assert.match(registry.csdlFragments(), /Name="new_CustomPingResponse"/);
  const metadata = platformCsdl('<Function Name="RetrieveMetadataChanges"><Parameter Name="Query" Type="mscrm.EntityQueryExpression" /></Function>');
  const operation = parseSolutionXml(`<Schema>${metadata}</Schema>`).children.find((node) => node.name === "Function");
  assert.deepEqual(operation.children.filter((node) => node.name === "Parameter").map((node) => node.attrs.Name), ["Query", "DeletedMetadataFilters", "ClientVersionStamp", "AppModuleId", "RetrieveAllSettings"]);
  assert.equal(operation.children[0].children[0].attrs.Term, "Org.OData.Core.V1.OptionalParameter");
});

test("the complete extension catalogue declares every referenced CSDL type", async () => {
  let api;
  const state = emptyState();
  state.tables.solution = [{ solutionid: "22222222-1111-4111-8111-111111111111", uniquename: "new_contract", version: "1.0.0.0" }];
  const store = await new DataStore({ state }).init();
  const secretVariable = "PAQVILO_METADATA_CONTRACT_SECRET", appId = "33333333-1111-4111-8111-111111111111";
  process.env[secretVariable] = "invented-contract-secret";
  const server = await startDataverseApi({
    store, settings: dataverseSettings({ enabled: true, applications: [{ appId, displayName: "Contract fixture", secretEnvironmentVariable: secretVariable, roles: ["System Administrator"] }] }), log() {},
    extensions: [...EXTENSIONS, { name: "metadata-integrity-capture", install(value) { api = value; } }],
  });
  try {
    const xml = api.metadata.csdl();
    const declarations = [...xml.matchAll(/<(?:EntityType|ComplexType|EnumType)\b[^>]*\bName="([^"]+)"/g)].map((match) => match[1]);
    const known = new Set(declarations);
    const references = [...xml.matchAll(/\b(?:Type|BaseType|EntityType)="(?:Collection\()?mscrm\.([\w]+)/g)].map((match) => match[1]);
    assert.ok(references.length > 200, "the real registry contributes its operations and nested types");
    assert.deepEqual([...new Set(references)].filter((name) => !known.has(name)).sort(), [], "no undeclared type may reach SDK metadata parsers");
    for (const name of ["QueryExpression", "QueryBase", "AttributeMapping", "CreateVirtualConnectorTableMetadata", "RetrieveSharedPrincipalsAndAccessResponse"]) {
      assert.equal(declarations.filter((value) => value === name).length, 1, `${name} has one declaration`);
    }
    assert.match(xml, /<ComplexType Name="QueryExpression" BaseType="mscrm.QueryBase">/);
    assert.match(xml, /<Property Name="Criteria" Type="mscrm.FilterExpression"/);
    assert.match(xml, /<Property Name="VirtualTableColumns" Type="Collection\(mscrm.VirtualTableColumnCandidate\)"/);
    const tokenResponse = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: appId, client_secret: process.env[secretVariable], scope: `${server.origin}/.default` }),
    });
    assert.equal(tokenResponse.status, 200);
    const token = (await tokenResponse.json()).access_token;
    const request = (path, body) => fetch(`${server.origin}/api/data/v9.2${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const role = store.tableRows("role").find((row) => row.name === "System Administrator");
    const privileges = await request(`/RetrieveRolePrivilegesRole(RoleId=${role.roleid})`);
    assert.equal(privileges.status, 200);
    assert.ok((await privileges.json()).RolePrivileges.length > 0);
    assert.equal((await request("/RetrieveAppsWithDelegatedAccessPermissions", { cloud: 0 })).status, 200);
    assert.equal((await request("/RetrieveAppsWithDelegatedAccessPermissions(cloud=0)")).status, 404, "an action does not acquire a function route");
    const translation = await request("/solutions/Microsoft.Dynamics.CRM.ExportTranslation", { SolutionName: "new_contract" });
    assert.equal(translation.status, 200);
    assert.ok((await translation.json()).ExportTranslationFile.length > 0);
    assert.equal((await request("/ExportTranslation", { SolutionName: "new_contract" })).status, 404, "collection binding controls dispatch");
  } finally {
    delete process.env[secretVariable];
    await server.close();
  }
});
