// Local portals Web API (/_api) against the documented Power Pages and
// Dataverse Web API behaviour (power-pages/configure/web-api-overview,
// read-operations, write-update-delete-operations,
// web-api-http-requests-handle-errors; data-platform/webapi/query/*).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import {
  annotationMatcher,
  parsePrefer,
  parseWebApiRoute,
  webApiErrorResponse,
} from "../lib/webapi-handler.mjs";
import { DataError } from "../lib/data-error.mjs";

const G = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const FORMATTED = "@OData.Community.Display.V1.FormattedValue";
const settingsYaml = (settings) =>
  Object.entries(settings)
    .map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${String(value).replace(/'/g, "''")}'`)
    .join("\n");
const SETTINGS = {
  "Webapi/account/enabled": "true",
  "Webapi/account/fields":
    "name,revenue,industrycode,primarycontactid,statecode,statuscode,createdon,modifiedon,accountnumber,description,employees,account_tags,contact_customer_accounts,openedon",
  "Webapi/contact/enabled": "true",
  "Webapi/contact/fields": "fullname,parentcustomerid,birthdate,emailaddress1",
  "Webapi/tag/enabled": "true",
  "Webapi/tag/fields": "name",
  "Webapi/validationconfiguration/enabled": "true",
  "Webapi/validationconfiguration/fields": "formname,processtype,isenabled,statecode",
  "Webapi/adx_contentsnippet/enabled": "true",
  "Webapi/adx_contentsnippet/fields": "adx_name",
  "Webapi/error/innererror": "true",
};
const fixture = () => ({
  mappings: {
    account: {
      entitySet: "accounts",
      idColumn: "accountid",
      nameColumn: "name",
      alternateKeys: [{ name: "account_number_key", attributes: ["accountnumber"] }],
      recordDefaults: { statecode: 0 },
      stateStatusDefaults: { 0: 1, 1: 2 },
      fields: {
        name: { dataverseType: "nvarchar", maxLength: 40 },
        description: { dataverseType: "memo", maxLength: 2000 },
        revenue: { dataverseType: "money", precision: 2 },
        employees: { dataverseType: "int" },
        industrycode: {
          dataverseType: "picklist",
          options: [
            { value: 1, label: "Accounting" },
            { value: 2, label: "Agriculture" },
          ],
        },
        statecode: { dataverseType: "state", options: [{ value: 0, label: "Active" }, { value: 1, label: "Inactive" }] },
        statuscode: { dataverseType: "status", options: [{ value: 1, label: "Active" }, { value: 2, label: "Inactive" }] },
        primarycontactid: { dataverseType: "lookup", targets: ["contact"] },
        accountnumber: { dataverseType: "nvarchar", autoNumberFormat: "ACC-{SEQNUM:4}" },
        createdon: { dataverseType: "datetime", validForCreate: false, validForUpdate: false },
        modifiedon: { dataverseType: "datetime", validForCreate: false, validForUpdate: false },
        openedon: { dataverseType: "datetime", dateTimeBehavior: "DateOnly", format: "DateOnly" },
      },
      relationships: {
        primarycontactid: { entity: "contact", from: "primarycontactid", to: "contactid", many: false },
        contact_customer_accounts: { entity: "contact", from: "accountid", to: "parentcustomerid", many: true },
        account_tags: {
          entity: "tag",
          from: "accountid",
          to: "tagid",
          many: true,
          intersect: { entity: "account_tag", from: "accountid", to: "tagid" },
        },
      },
    },
    contact: {
      entitySet: "contacts",
      idColumn: "contactid",
      nameColumn: "fullname",
      fields: {
        fullname: { dataverseType: "nvarchar" },
        emailaddress1: { dataverseType: "nvarchar", maxLength: 20 },
        birthdate: { dataverseType: "datetime", dateTimeBehavior: "DateOnly", format: "DateOnly" },
        parentcustomerid: { dataverseType: "customer", targets: ["account"] },
        secretnote: { dataverseType: "nvarchar" },
      },
      relationships: {
        parentcustomerid: { entity: "account", from: "parentcustomerid", to: "accountid", many: false },
      },
    },
    tag: { entitySet: "tags", idColumn: "tagid", nameColumn: "name", fields: { name: { dataverseType: "nvarchar" } } },
    account_tag: { entitySet: "account_tags_intersect", idColumn: "account_tagid" },
    validationconfiguration: {
      entitySet: "validationconfigurations",
      idColumn: "validationconfigurationid",
      fields: {
        formname: { dataverseType: "nvarchar" },
        processtype: { dataverseType: "picklist", options: [{ value: 100000000, label: "Create" }] },
        isenabled: { dataverseType: "bit" },
        statecode: { dataverseType: "state" },
      },
    },
    adx_contentsnippet: { entitySet: "adx_contentsnippets", idColumn: "adx_contentsnippetid" },
  },
  tables: {
    account: [
      {
        accountid: G(1),
        name: "Contoso",
        revenue: 1234.5,
        employees: 12,
        industrycode: 1,
        statecode: 0,
        statuscode: 1,
        accountnumber: "ACC-0001",
        versionnumber: 7,
        primarycontactid: { id: G(11), logical_name: "contact", name: "Ada Lovelace" },
        createdon: "2026-01-02T03:04:05Z",
      },
      { accountid: G(2), name: "Fabrikam", revenue: 50, employees: 3, industrycode: 2, statecode: 0, statuscode: 1, accountnumber: "ACC-0002" },
      { accountid: G(3), name: "Northwind", employees: 30, statecode: 1, statuscode: 2, accountnumber: "ACC-0003" },
    ],
    contact: [
      { contactid: G(11), fullname: "Ada Lovelace", parentcustomerid: { id: G(1), logical_name: "account", name: "Contoso" }, secretnote: "hidden" },
      { contactid: G(12), fullname: "Bob Stone", parentcustomerid: { id: G(1), logical_name: "account", name: "Contoso" } },
      { contactid: G(13), fullname: "Cy Young" },
    ],
    tag: [
      { tagid: G(21), name: "Gold" },
      { tagid: G(22), name: "Silver" },
    ],
    account_tag: [{ account_tagid: G(31), accountid: G(1), tagid: G(21) }],
    validationconfiguration: [
      { validationconfigurationid: G(41), formname: "Product-RW", processtype: 100000000, isenabled: true, statecode: 0 },
    ],
    adx_contentsnippet: [{ adx_contentsnippetid: G(51), adx_name: "Snippet" }],
  },
  settings: { permissionMode: "permissive" },
  // Requests use the configured persona; session mechanics aren't under test here.
  simulator: { mode: "local", pageMode: "local", identityScope: "configured", identity: { id: G(11), roles: [] }, live: {}, endpoints: [] },
});

async function start(t, { settings = SETTINGS, state = fixture(), observed = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-odata-parity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: OData parity\n");
  await fs.writeFile(path.join(directory, "sitesetting.yml"), settingsYaml(settings));
  const app = await createSimulator({ sourceDir: directory, initial: state, watch: false, observed });
  t.after(() => app.close());
  const call = (route, { method = "GET", body, headers = {}, token = true } = {}) =>
    fetch(app.url + route, {
      method,
      headers: {
        ...(token ? { __RequestVerificationToken: app.state().csrf } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (route, options) => {
    const response = await call(route, options);
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json(), url: app.url };
  };
  return { app, call, json };
}

test("route, Prefer and annotation helpers follow the OData conventions", () => {
  assert.deepEqual(parseWebApiRoute("/_api/accounts"), { kind: "collection", set: "accounts" });
  assert.deepEqual(parseWebApiRoute("/_api/accounts()"), { kind: "collection", set: "accounts" });
  assert.deepEqual(parseWebApiRoute("/_api/accounts/$count"), { kind: "count", set: "accounts" });
  assert.deepEqual(parseWebApiRoute(`/_api/accounts(${G(1)})/name/$value`), { kind: "value", set: "accounts", key: G(1), segment: "name" });
  assert.deepEqual(parseWebApiRoute("/_api/accounts(accountnumber='A(1)')"), { kind: "entity", set: "accounts", key: "accountnumber='A(1)'" });
  assert.deepEqual(parseWebApiRoute(`/_api/accounts(${G(1)})/account_tags(${G(21)})/$ref`), {
    kind: "ref",
    set: "accounts",
    key: G(1),
    segment: "account_tags",
    targetKey: G(21),
  });
  assert.equal(parseWebApiRoute("/_api/cloudflow/v1.0/trigger/abc").kind, "cloudflow");
  assert.throws(() => parseWebApiRoute("/_api/accounts/name"), (error) => error.status === 404);
  assert.deepEqual(parsePrefer('odata.maxpagesize=5, odata.include-annotations="OData.Community.Display.V1.FormattedValue",return=representation'), {
    annotations: "OData.Community.Display.V1.FormattedValue",
    representation: true,
  });
  const include = annotationMatcher("Microsoft.Dynamics.CRM.*,-Microsoft.Dynamics.CRM.lookuplogicalname");
  assert.equal(include("Microsoft.Dynamics.CRM.associatednavigationproperty"), true);
  assert.equal(include("Microsoft.Dynamics.CRM.lookuplogicalname"), false);
  assert.equal(include("OData.Community.Display.V1.FormattedValue"), false);
  assert.equal(annotationMatcher("*")("anything"), true);
});

test("error envelope uses the Power Pages codes observed on sandbox and optional innererror", () => {
  const cds = webApiErrorResponse(new DataError("Too long", 400, "StringLengthExceeded", { innerCode: "0x80044331" }), { innerError: true });
  assert.deepEqual(cds.body, {
    error: { code: "9004010D", message: "CDS error occurred.", innererror: { code: "0x80044331", message: "Too long" } },
  });
  assert.equal(cds.headers["X-Sim-Error-Code"], "StringLengthExceeded");
  const hidden = webApiErrorResponse(new DataError("Too long", 400, "StringLengthExceeded", { innerCode: "0x80044331" }), { innerError: false });
  assert.equal(hidden.body.error.innererror, undefined);
  const cases = [
    [new DataError("x", 404, "WebApiTableNotEnabled", { segment: "sample_devices", table: "sample_device" }), 404, "9004010C", "Resource not found for the segment sample_device."],
    [new DataError("x", 404, "WebApiConfigurationTable", { table: "adx_webpage" }), 404, "9004010E", "Configuration table adx_webpage is not supported."],
    [new DataError("x", 400, "InvalidAttribute", { attribute: "foo", table: "account" }), 400, "90040100", "Attribute foo cannot be found for table account."],
    [new DataError("x", 400, "InvalidAttribute", { attribute: "foo", table: "account", phase: "query" }), 400, "9004010A", "An unexpected error occurred while processing the request"],
    [new DataError("x", 400, "UnsupportedQuery", { phase: "query" }), 400, "9004010A", "An unexpected error occurred while processing the request"],
    [new DataError("x", 403, "PermissionDenied", { operation: "read", table: "contact" }), 403, "90040120", "You don't have permission to read the contact table."],
    [new DataError("x", 403, "WebApiFieldNotEnabled", { attribute: "foo", table: "account" }), 403, "90040101", "Attribute foo in table account is not enabled for Web Api."],
    [new DataError("x", 403, "PermissionDenied", { operation: "update", table: "account" }), 403, "90040102", "You don't have permission to update account entity."],
    [new DataError("x", 403, "PermissionDenied", { operation: "create", table: "account" }), 403, "90040103", "You don't have permission to create account entity."],
    [new DataError("x", 403, "PermissionDenied", { operation: "delete", table: "account" }), 403, "90040104", "You don't have permission to delete account entity."],
    [new DataError("x", 403, "PermissionDenied", { operation: "append", table: "account", related: "tag" }), 403, "90040105", "You don't have permission to associate or disassociate table account with tag."],
    // Token failures: a missing token 401, a mismatched one 403 (docs: "Token failures").
    [new DataError("token", 401, "MissingPortalRequestVerificationToken"), 401, "90040107", "token"],
    [new DataError("token", 403, "HttpAntiForgeryException"), 403, "90040107", "token"],
    [new DataError("x", 401, "MissingPortalSessionCookie"), 401, "90040109", "An Invalid session token was passed into the throwing method."],
    [new DataError("x", 400, "UndeclaredNavigationProperty", { phase: "payload" }), 400, "9004010A", "An unexpected error occurred while processing the request"],
    [new DataError("x", 400, "NoAttributesForTableCreate"), 400, "900400FF", "No attributes for Create Table action."],
    [new Error("boom"), 500, "", "An unexpected error occurred while processing the request."],
  ];
  for (const [error, status, code, message] of cases) {
    const response = webApiErrorResponse(error);
    assert.equal(response.status, status, code);
    assert.equal(response.body.error.code, code);
    assert.equal(response.body.error.message, message);
  }
});

test("collection reads return row versions, primary keys, lookup properties and formatted values", async (t) => {
  const { json } = await start(t);
  const { status, body, headers, url } = await json("/_api/accounts?$select=name,revenue,industrycode,_primarycontactid_value,statecode,createdon&$filter=accountid eq " + G(1));
  assert.equal(status, 200);
  // sandbox headers: no OData-Version or Preference-Applied; no-cache; SAMEORIGIN.
  assert.equal(headers.get("odata-version"), null);
  assert.equal(headers.get("cache-control"), "no-cache");
  assert.equal(headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("content-security-policy"), null, "no site policy, no header");
  // sandbox collections carry the context and the CRM count annotations.
  assert.equal(body["@odata.context"], `${url}/_api/$metadata#accounts(name,revenue,industrycode,_primarycontactid_value,statecode,createdon)`);
  assert.equal(body["@Microsoft.Dynamics.CRM.totalrecordcount"], -1);
  assert.equal(body["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"], false);
  assert.match(body["@Microsoft.Dynamics.CRM.globalmetadataversion"], /^\d+$/);
  assert.deepEqual(body.value, [
    {
      "@odata.etag": 'W/"7"',
      name: "Contoso",
      [`revenue${FORMATTED}`]: "1,234.50",
      revenue: 1234.5,
      [`industrycode${FORMATTED}`]: "Accounting",
      industrycode: 1,
      [`_primarycontactid_value${FORMATTED}`]: "Ada Lovelace",
      "_primarycontactid_value@Microsoft.Dynamics.CRM.associatednavigationproperty": "primarycontactid",
      "_primarycontactid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "contact",
      _primarycontactid_value: G(11),
      [`statecode${FORMATTED}`]: "Active",
      statecode: 0,
      [`createdon${FORMATTED}`]: "1/2/2026 3:04 AM",
      createdon: "2026-01-02T03:04:05Z",
      accountid: G(1),
    },
  ]);
  const filtered = await json(
    '/_api/accounts?$select=name&$filter=Microsoft.Dynamics.CRM.In(PropertyName=@p,PropertyValues=["Contoso","Northwind"])&@p=\'name\'&$orderby=name desc',
    { headers: { Prefer: 'odata.include-annotations="Microsoft.Dynamics.CRM.*"' } },
  );
  assert.deepEqual(filtered.body.value.map((row) => row.name), ["Northwind", "Contoso"]);
  assert.equal(filtered.headers.get("preference-applied"), null);
  assert.equal(filtered.body["@Microsoft.Dynamics.CRM.totalrecordcount"], -1, "an explicit Prefer filter keeps the requested CRM annotations");
});

test("select-less collection reads are refused; select-less record reads return the allow-listed columns", async (t) => {
  const { json } = await start(t);
  // sandbox: a collection read without $select names the first column (in
  // property-name order) outside Webapi/<table>/fields.
  const collection = await json("/_api/contacts");
  assert.equal(collection.status, 403);
  assert.deepEqual(collection.body.error, { code: "90040101", message: "Attribute secretnote in table contact is not enabled for Web Api." });
  const { body, url } = await json(`/_api/contacts(${G(13)})`);
  assert.deepEqual(body, {
    "@odata.context": `${url}/_api/$metadata#contacts/$entity`,
    "@odata.etag": body["@odata.etag"],
    contactid: G(13),
    fullname: "Cy Young",
    _parentcustomerid_value: null,
    birthdate: null,
    emailaddress1: null,
  });
  assert.equal(Object.hasOwn(body, "secretnote"), false, "columns outside Webapi/<table>/fields never leave the server");
});

test("$filter grammar: logical, string, lambda and Dataverse functions; unknown identifiers are 400 and disallowed columns 403", async (t) => {
  const { json } = await start(t);
  const names = async (filter) =>
    (await json(`/_api/accounts?$select=name&$orderby=name&$filter=${encodeURIComponent(filter)}`)).body.value.map((row) => row.name);
  assert.deepEqual(await names("revenue gt 100 or employees ge 30"), ["Contoso", "Northwind"]);
  assert.deepEqual(await names("not contains(name,'o')"), ["Fabrikam"]);
  assert.deepEqual(await names("startswith(name,'fab') and endswith(name,'KAM')"), ["Fabrikam"]);
  assert.deepEqual(await names("contains(name,'%wind')"), ["Northwind"], "contains supports SQL wildcards");
  assert.deepEqual(await names("account_tags/any(t:t/name eq 'Gold')"), ["Contoso"]);
  assert.deepEqual(await names("contact_customer_accounts/all(c:startswith(c/fullname,'A') or startswith(c/fullname,'B'))"), ["Contoso", "Fabrikam", "Northwind"]);
  assert.deepEqual(await names("Microsoft.Dynamics.CRM.Between(PropertyName='employees',PropertyValues=['3','12'])"), ["Contoso", "Fabrikam"]);
  assert.deepEqual(await names("statecode eq 0 and industrycode ne null"), ["Contoso", "Fabrikam"]);
  const configurations = await json(
    `/_api/validationconfigurations?$select=formname&$filter=${encodeURIComponent("formname eq 'Product-RW' and statecode eq 0 and isenabled eq true and processtype eq 100000000")}`,
  );
  assert.deepEqual(configurations.body.value.map((row) => row.formname), ["Product-RW"]);
  // Malformed queries answer 400 9004010A with a generic message on sandbox:
  // an unknown identifier (a script that interpolated `undefined`), an
  // unknown column, a lookup logical name in $select, $expand of a column and
  // a path through a non-navigation property. Real but disallowed columns
  // stay 403 90040101.
  const malformed = [
    `/_api/validationconfigurations?$select=formname&$filter=${encodeURIComponent("processtype eq undefined")}`,
    "/_api/accounts?$select=nosuchcolumn",
    "/_api/accounts?$select=name&$orderby=nosuchcolumn",
    "/_api/accounts?$select=name&$filter=nosuchcolumn%20eq%201",
    "/_api/accounts?$select=primarycontactid",
    "/_api/accounts?$select=name&$expand=accountnumber($select=name)",
    `/_api/accounts?$select=name&$filter=${encodeURIComponent("accountnumber/name eq 'x'")}`,
    `/_api/accounts?$select=name&$filter=${encodeURIComponent("name eq")}`,
  ];
  for (const route of malformed) {
    const response = await json(route);
    assert.equal(response.status, 400, route);
    assert.deepEqual(response.body.error, { code: "9004010A", message: "An unexpected error occurred while processing the request" }, route);
  }
  const disallowed = await json(`/_api/contacts?$select=fullname&$filter=${encodeURIComponent("secretnote eq 'hidden'")}`);
  assert.equal(disallowed.status, 403);
  assert.deepEqual(disallowed.body.error, { code: "90040101", message: "Attribute secretnote in table contact is not enabled for Web Api." });
  const expanded = await json(`/_api/accounts(${G(1)})?$select=name&$expand=primarycontactid($select=fullname)`);
  assert.equal(expanded.status, 200, "an expandable navigation property still expands");
});

test("$top, $count (capped at 5000), odata.maxpagesize paging and the $skip restriction", async (t) => {
  const state = fixture();
  state.tables.tag = Array.from({ length: 5002 }, (_, index) => ({ tagid: G(1000 + index), name: `Tag ${index}` }));
  const { json } = await start(t, { state });
  const counted = await json("/_api/tags?$select=name&$count=true", { headers: { Prefer: "odata.maxpagesize=2" } });
  assert.equal(counted.body["@odata.count"], 5000);
  assert.equal(counted.body.value.length, 2);
  assert.equal(counted.headers.get("preference-applied"), null, "sandbox sends no Preference-Applied header");
  assert.match(counted.body["@odata.nextLink"], /\$skiptoken=/);
  const annotated = await json("/_api/tags?$select=name&$count=true&$top=1", {
    headers: { Prefer: 'odata.include-annotations="Microsoft.Dynamics.CRM.totalrecordcount,Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"' },
  });
  assert.equal(annotated.body["@Microsoft.Dynamics.CRM.totalrecordcount"], 5000);
  assert.equal(annotated.body["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"], true);
  const next = await json(new URL(counted.body["@odata.nextLink"]).pathname + new URL(counted.body["@odata.nextLink"]).search);
  assert.equal(next.body.value.length, 2);
  const skip = await json("/_api/tags?$skip=1");
  assert.equal(skip.status, 400);
  assert.equal(skip.body.error.innererror.code, "0x80060888");
  const top = await json("/_api/tags?$select=name&$top=3");
  assert.equal(top.body.value.length, 3);
  assert.equal(top.body["@odata.nextLink"], undefined);
  const count = await (await fetch(counted.body["@odata.nextLink"].replace(/\/_api\/tags\?.*/, "/_api/tags/$count"))).text();
  assert.equal(count, "5000");
});

test("$expand of single- and collection-valued navigation properties with nested options", async (t) => {
  const { json } = await start(t);
  const { body } = await json(
    `/_api/accounts(${G(1)})?$select=name&$expand=primarycontactid($select=fullname),contact_customer_accounts($select=fullname;$orderby=fullname desc;$top=1)`,
  );
  assert.equal(body.name, "Contoso");
  assert.deepEqual(body.primarycontactid, { fullname: "Ada Lovelace", contactid: G(11) });
  assert.equal(body.contact_customer_accounts.length, 1);
  assert.equal(body.contact_customer_accounts[0].fullname, "Bob Stone");
  assert.match(body.contact_customer_accounts[0]["@odata.etag"], /^W\/"\d+"$/);
});

test("$apply groupby and aggregate", async (t) => {
  const { json } = await start(t);
  const { status, body } = await json("/_api/accounts?$apply=groupby((statecode),aggregate(employees with sum as total))");
  assert.equal(status, 200);
  assert.deepEqual(
    body.value.map((row) => [row.statecode, row.total]).sort(),
    [[0, 15], [1, 30]],
  );
});

test("single property, $value, navigation and $count routes", async (t) => {
  const { json, call } = await start(t);
  assert.deepEqual((await json(`/_api/accounts(${G(1)})/name`)).body, { value: "Contoso" });
  assert.equal(await (await call(`/_api/accounts(${G(1)})/name/$value`)).text(), "Contoso");
  assert.equal((await call(`/_api/accounts(${G(3)})/revenue`)).status, 204, "null properties answer 204");
  const related = await json(`/_api/accounts(${G(1)})/contact_customer_accounts?$select=fullname&$orderby=fullname`);
  assert.deepEqual(related.body.value.map((row) => row.fullname), ["Ada Lovelace", "Bob Stone"]);
  const single = await json(`/_api/contacts(${G(11)})/parentcustomerid?$select=name`);
  assert.equal(single.body.name, "Contoso");
  assert.equal(await (await call(`/_api/accounts(${G(1)})/contact_customer_accounts/$count`)).text(), "2");
  assert.equal(await (await call("/_api/accounts/$count")).text(), "3");
  const alternate = await json("/_api/accounts(accountnumber='ACC-0002')?$select=name");
  assert.equal(alternate.body.name, "Fabrikam");
  const missing = await json(`/_api/accounts(${G(9)})`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.innererror.code, "0x80040217");
  const etag = (await json(`/_api/accounts(${G(1)})?$select=name`)).body["@odata.etag"];
  assert.equal((await call(`/_api/accounts(${G(1)})?$select=name`, { headers: { "If-None-Match": etag } })).status, 304);
});

test("writes: create, representation, update, upsert, preconditions, property PUT/DELETE and delete", async (t) => {
  const { json, call, app } = await start(t);
  const created = await call("/_api/accounts", { method: "POST", body: { name: "Litware", revenue: 10.555, industrycode: 2 } });
  assert.equal(created.status, 204);
  const id = created.headers.get("entityid");
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(created.headers.get("odata-entityid"), `${app.url}/_api/accounts(${id})`);
  const row = app.store.snapshot().tables.account.find((item) => item.accountid === id);
  assert.equal(row.revenue, 10.56, "money values round to the column precision");
  assert.equal(row.statecode, 0);
  assert.equal(row.statuscode, 1, "statuscode defaults from statecode");
  assert.match(row.createdon, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(row.accountnumber, "ACC-1000", "autonumber columns follow AutoNumberFormat from seed 1000");
  const represented = await json("/_api/accounts?$select=name", {
    method: "POST",
    body: { name: "Adatum" },
    headers: { Prefer: "return=representation" },
  });
  assert.equal(represented.status, 201);
  assert.equal(represented.body.name, "Adatum");
  assert.equal(represented.headers.get("preference-applied"), null);
  const etag = (await json(`/_api/accounts(${G(1)})?$select=name`)).body["@odata.etag"];
  const stale = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { name: "Contoso 2" }, headers: { "If-Match": 'W/"1"' } });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.error.innererror.code, "0x80060882");
  assert.equal((await call(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { name: "Contoso 2" }, headers: { "If-Match": etag } })).status, 204);
  assert.notEqual((await json(`/_api/accounts(${G(1)})?$select=name`)).body["@odata.etag"], etag, "updates change the row version");
  const upsertId = G(77);
  const upserted = await json(`/_api/accounts(${upsertId})?$select=name`, { method: "PATCH", body: { name: "Upserted" }, headers: { Prefer: "return=representation" } });
  assert.equal(upserted.status, 201);
  assert.equal(upserted.body.accountid, upsertId);
  const noCreate = await json(`/_api/accounts(${G(78)})`, { method: "PATCH", body: { name: "Never" }, headers: { "If-Match": "*" } });
  assert.equal(noCreate.status, 404);
  const noUpdate = await json(`/_api/accounts(${upsertId})`, { method: "PATCH", body: { name: "Never" }, headers: { "If-None-Match": "*" } });
  assert.equal(noUpdate.status, 412);
  const byKey = await call("/_api/accounts(accountnumber='ACC-0002')", { method: "PATCH", body: { name: "Fabrikam 2" } });
  assert.equal(byKey.status, 204);
  assert.equal(app.store.snapshot().tables.account.find((item) => item.accountid === G(2)).name, "Fabrikam 2");
  assert.equal((await call(`/_api/accounts(${G(2)})/description`, { method: "PUT", body: { value: "Described" } })).status, 204);
  assert.equal(app.store.snapshot().tables.account.find((item) => item.accountid === G(2)).description, "Described");
  assert.equal((await call(`/_api/accounts(${G(2)})/description`, { method: "DELETE" })).status, 204);
  assert.equal(app.store.snapshot().tables.account.find((item) => item.accountid === G(2)).description, null);
  assert.equal((await call(`/_api/accounts(${G(2)})`, { method: "DELETE" })).status, 204);
  assert.equal(app.store.snapshot().tables.account.some((item) => item.accountid === G(2)), false);
  const empty = await json("/_api/accounts", { method: "POST", body: {} });
  assert.deepEqual(empty.body.error, { code: "900400FF", message: "No attributes for Create Table action." });
  const collection = await json("/_api/accounts", { method: "PATCH", body: { name: "x" } });
  assert.equal(collection.status, 405);
});

test("write validation follows Dataverse types inside the CDSError envelope", async (t) => {
  const { json } = await start(t);
  const cases = [
    [{ name: 5 }, "0x80048d19", "Cannot convert the literal '5' to the expected type 'Edm.String'."],
    [{ employees: "12" }, "0x80048d19", "Cannot convert the literal '12' to the expected type 'Edm.Int32'."],
    [{ name: "x".repeat(41) }, "0x80044331", "A validation error occurred.  The length of the 'name' attribute of the 'account' entity exceeded the maximum allowed length of '40'."],
    [{ openedon: "2026-02-30" }, "0x80040239", null],
  ];
  for (const [body, innerCode, message] of cases) {
    const response = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, "9004010D");
    assert.equal(response.body.error.message, "CDS error occurred.");
    assert.equal(response.body.error.innererror.code, innerCode);
    if (message) assert.equal(response.body.error.innererror.message, message);
  }
  const dateOnly = await json(`/_api/accounts(${G(1)})?$select=openedon`, { method: "PATCH", body: { openedon: "2026-02-03T22:00:00Z" }, headers: { Prefer: "return=representation" } });
  assert.equal(dateOnly.body.openedon, "2026-02-03");
  const bad = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { name: "" } });
  assert.equal(bad.status, 204, "empty text is stored as null");
});

test("innererror is omitted unless Webapi/error/innererror is true", async (t) => {
  const { json } = await start(t, { settings: { ...SETTINGS, "Webapi/error/innererror": "false" } });
  const response = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { name: 5 } });
  assert.equal(response.status, 400);
  assert.deepEqual(Object.keys(response.body.error).sort(), ["code", "message"]);
});

// Third sandbox and Example commondev (8 October 2026) send innererror {code, message, type}
// with every error, code and message repeating the outer error; the type constants are
// observed (G probes, wave4-analysis.json). Sample sandbox sends none with the same errors
// (the default scope).
const ALL_ERRORS = { webApiInnerError: "all-errors", evidence: "synthetic: every error carries innererror" };

test("observed webApiInnerError all-errors adds innererror to every error envelope", async (t) => {
  const { json } = await start(t, { observed: ALL_ERRORS });
  const unexpected = "An unexpected error occurred while processing the request";
  assert.deepEqual((await json("/_api/ppsimparitymissings?$top=1")).body.error, {
    code: "9004010A",
    message: unexpected,
    innererror: { code: "9004010A", message: unexpected, type: "UnexpectedError" },
  });
  const configuration = "Configuration table adx_webpage is not supported.";
  assert.deepEqual((await json("/_api/adx_webpages?$top=1")).body.error, {
    code: "9004010E",
    message: configuration,
    innererror: { code: "9004010E", message: configuration, type: "ConfigurationResourceNotSupported" },
  });
  const notEnabled = "Resource not found for the segment mspp_webpage.";
  assert.deepEqual((await json("/_api/mspp_webpages")).body.error, {
    code: "9004010C",
    message: notEnabled,
    innererror: { code: "9004010C", message: notEnabled, type: "ResourceDoesNotExists" },
  });
  const column = "Attribute secretnote in table contact is not enabled for Web Api.";
  assert.deepEqual((await json("/_api/contacts?$top=1")).body.error, {
    code: "90040101",
    message: column,
    innererror: { code: "90040101", message: column, type: "AttributePermissionIsMissing" },
  });
  // Dataverse failures keep the Dataverse code and message.
  const cds = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { name: 5 } });
  assert.deepEqual(cds.body.error, {
    code: "9004010D",
    message: "CDS error occurred.",
    innererror: {
      code: "0x80048d19",
      message: "Cannot convert the literal '5' to the expected type 'Edm.String'.",
      type: "CDSError",
    },
  });
});

test("innererror scopes: Webapi/error/innererror false wins, the default keeps it to Dataverse failures", async (t) => {
  const hidden = await start(t, { observed: ALL_ERRORS, settings: { ...SETTINGS, "Webapi/error/innererror": "false" } });
  assert.deepEqual(Object.keys((await hidden.json("/_api/ppsimparitymissings")).body.error).sort(), ["code", "message"]);
  const plain = await start(t);
  assert.deepEqual(Object.keys((await plain.json("/_api/ppsimparitymissings")).body.error).sort(), ["code", "message"]);
  const read = new DataError("x", 403, "PermissionDenied", { operation: "read", table: "account" });
  assert.deepEqual(webApiErrorResponse(read, { innerError: true, innerErrorScope: "all-errors" }).body.error.innererror, {
    code: "90040120",
    message: "You don't have permission to read the account table.",
    type: "EntityPermissionReadIsMissing",
  });
  const unhandled = webApiErrorResponse(new Error("boom"), { innerError: true, innerErrorScope: "all-errors" });
  assert.deepEqual(unhandled.body.error.innererror, { code: "", message: "An unexpected error occurred while processing the request.", type: null }, "a code without a name");
  assert.equal(webApiErrorResponse(read, { innerError: true }).body.error.innererror, undefined);
  const token = new DataError("x", 403, "HttpAntiForgeryException");
  assert.equal(webApiErrorResponse(token, { innerError: true, innerErrorScope: "all-errors" }).body.error.innererror.type, "HttpAntiForgeryException");
  const session = new DataError("x", 401, "MissingPortalSessionCookie");
  assert.equal(webApiErrorResponse(session, { innerError: true, innerErrorScope: "all-errors" }).body.error.innererror.type, "MissingPortalSessionCookie");
});

const anonymousState = (permissions) => {
  const state = fixture();
  state.settings = { permissionMode: "enforce" };
  state.permissions = permissions;
  state.simulator.identity = { id: null, roles: [] };
  return state;
};

test("the table permission check precedes the select requirement of a collection read", async (t) => {
  // Third live: an anonymous select-less read without read permission answers 90040120.
  const denied = await start(t, { state: anonymousState([]) });
  const select = await denied.json("/_api/contacts?$top=1");
  assert.equal(select.status, 403);
  assert.deepEqual(select.body.error, { code: "90040120", message: "You don't have permission to read the contact table." });
  // With read permission the select requirement applies (Sample sandbox: 90040101).
  const granted = await start(t, {
    state: anonymousState([{ id: "public-contacts", entity: "contact", scope: "global", roles: ["Anonymous Users"], operations: ["read"] }]),
  });
  assert.deepEqual((await granted.json("/_api/contacts?$top=1")).body.error, {
    code: "90040101",
    message: "Attribute secretnote in table contact is not enabled for Web Api.",
  });
});

test("Web API responses carry the site's HTTP/* headers and X-Content-Type-Options nosniff", async (t) => {
  // sandbox (anonymous /_api read): the site Content-Security-Policy, X-Frame-Options and
  // nosniff although the site defines no HTTP/X-Content-Type-Options setting.
  const policy = "default-src 'self'; object-src 'none'; connect-src 'self' https://*.example.org";
  const { call } = await start(t, {
    settings: {
      ...SETTINGS,
      "HTTP/Content-Security-Policy": policy,
      "HTTP/Content-Security-Policy/InjectHeader": "true",
      "HTTP/X-Frame-Options": "DENY",
      "HTTP/Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
  // A collection, an error and the plain-text $count.
  for (const route of ["/_api/accounts?$select=name", "/_api/ppsimparitymissings", "/_api/accounts/$count"]) {
    const { headers } = await call(route);
    assert.equal(headers.get("content-security-policy"), policy, route);
    assert.equal(headers.get("x-frame-options"), "DENY", route);
    assert.equal(headers.get("x-content-type-options"), "nosniff", route);
    assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin", route);
    assert.equal(headers.get("cache-control"), "no-cache", route);
  }
  const off = await start(t, {
    settings: { ...SETTINGS, "HTTP/Content-Security-Policy": policy, "HTTP/Content-Security-Policy/InjectHeader": "false" },
  });
  assert.equal((await off.json("/_api/accounts?$select=name")).headers.get("content-security-policy"), null);
});

test("Self, Contact and Account grants give anonymous visitors no read permission", async (t) => {
  // sandbox: a Self grant on the Anonymous Users role still answers 403 90040120 to an
  // anonymous contacts read; such scopes need a signed-in contact.
  const denied = "You don't have permission to read the contact table.";
  for (const scope of ["self", "contact", "account"]) {
    const { json } = await start(t, {
      state: anonymousState([{ id: `anonymous-${scope}`, entity: "contact", scope, roles: ["Anonymous Users"], operations: ["read"] }]),
    });
    const read = await json("/_api/contacts?$select=fullname");
    assert.equal(read.status, 403, scope);
    assert.deepEqual(read.body.error, { code: "90040120", message: denied }, scope);
  }
  // A parent chain counts when it ends in a global grant, not when it ends in Self.
  const chain = (rootScope) =>
    anonymousState([
      { id: "root", entity: "account", scope: rootScope, roles: ["Anonymous Users"], operations: ["read"] },
      {
        id: "child",
        entity: "contact",
        scope: "parent",
        parentPermissionId: "root",
        roles: ["Anonymous Users"],
        operations: ["read"],
        relationship: { entity: "account", from: "parentcustomerid", to: "accountid" },
      },
    ]);
  const viaGlobal = await (await start(t, { state: chain("global") })).json("/_api/contacts?$select=fullname");
  assert.equal(viaGlobal.status, 200);
  assert.deepEqual(viaGlobal.body.value.map((row) => row.fullname).sort(), ["Ada Lovelace", "Bob Stone"]);
  const viaSelf = await (await start(t, { state: chain("self") })).json("/_api/contacts?$select=fullname");
  assert.equal(viaSelf.status, 403);
  // A signed-in contact keeps its Self grant.
  const signedIn = anonymousState([{ id: "own", entity: "contact", scope: "self", roles: ["Authenticated Users"], operations: ["read"] }]);
  signedIn.simulator.identity = { id: G(12), roles: [] };
  const own = await (await start(t, { state: signedIn })).json("/_api/contacts?$select=fullname");
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.value.map((row) => row.fullname), ["Bob Stone"]);
});

test("the OData v3 key form guid'…' is rejected while parsing the URL, before any permission check", async (t) => {
  assert.throws(
    () => parseWebApiRoute(`/_api/contacts(guid'${G(11)}')`),
    (error) => error.status === 400 && error.code === "UnsupportedKeySyntax",
  );
  assert.throws(() => parseWebApiRoute(`/_api/accounts(${G(1)})/account_tags(guid'${G(21)}')/$ref`), (error) => error.status === 400);
  // Example commondev: contacts(guid'…') 400 9004010A, contacts(<guid>) 403 90040120 for
  // an anonymous visitor (G probes, wave4-analysis.json).
  const { json } = await start(t, { state: anonymousState([]), observed: ALL_ERRORS });
  const unexpected = "An unexpected error occurred while processing the request";
  const v3 = await json(`/_api/contacts(guid'${G(11)}')?$select=contactid`);
  assert.equal(v3.status, 400);
  assert.deepEqual(v3.body.error, {
    code: "9004010A",
    message: unexpected,
    innererror: { code: "9004010A", message: unexpected, type: "UnexpectedError" },
  });
  assert.equal(v3.headers.get("x-sim-error-code"), "UnsupportedKeySyntax");
  const denied = "You don't have permission to read the contact table.";
  const v4 = await json(`/_api/contacts(${G(11)})?$select=contactid`);
  assert.equal(v4.status, 403);
  assert.deepEqual(v4.body.error, {
    code: "90040120",
    message: denied,
    innererror: { code: "90040120", message: denied, type: "EntityPermissionReadIsMissing" },
  });
});

test("observed anonymousDataAccess blocked denies anonymous reads that an Anonymous Users grant allows", async (t) => {
  const permissions = [
    { id: "public-accounts", entity: "account", scope: "global", roles: ["Anonymous Users"], operations: ["read"] },
    { id: "public-tags", entity: "tag", scope: "global", roles: ["Anonymous Users"], operations: ["create"] },
    { id: "members", entity: "account", scope: "global", roles: ["Authenticated Users"], operations: ["read"] },
  ];
  const open = await start(t, { state: anonymousState(permissions) });
  assert.equal((await open.json("/_api/accounts?$select=name&$top=1")).status, 200, "the export's grant applies by default");
  const blocked = { anonymousDataAccess: "blocked", evidence: "synthetic: Disable anonymous access" };
  const anonymous = await start(t, { state: anonymousState(permissions), observed: blocked });
  const read = await anonymous.json("/_api/accounts?$select=name&$top=1");
  assert.equal(read.status, 403);
  assert.deepEqual(read.body.error, { code: "90040120", message: "You don't have permission to read the account table." });
  assert.equal((await anonymous.json("/_api/accounts?$top=1")).body.error.code, "90040120", "permission before the select requirement");
  const fetchXml = encodeURIComponent('<fetch><entity name="account"><attribute name="name"/></entity></fetch>');
  assert.equal((await anonymous.json(`/_api/accounts?fetchXml=${fetchXml}`)).body.error.code, "90040120");
  const created = await anonymous.json("/_api/tags", { method: "POST", body: { name: "Bronze" } });
  assert.equal(created.status, 204, "anonymous visitors can still write data");
  const signedIn = anonymousState(permissions);
  signedIn.simulator.identity = { id: G(11), roles: [] };
  const member = await start(t, { state: signedIn, observed: blocked });
  assert.equal((await member.json("/_api/accounts?$select=name&$top=1")).status, 200, "signed-in users are unaffected");
});

test("deep insert, @odata.bind and $ref associate/disassociate", async (t) => {
  const { json, call, app } = await start(t);
  const created = await call("/_api/accounts", {
    method: "POST",
    body: {
      name: "Deep",
      primarycontactid: { fullname: "Deep Contact" },
      contact_customer_accounts: [{ fullname: "Child One" }],
      "account_tags@odata.bind": [`/tags(${G(22)})`],
    },
  });
  assert.equal(created.status, 204);
  const id = created.headers.get("entityid");
  const tables = app.store.snapshot().tables;
  const deepContact = tables.contact.find((row) => row.fullname === "Deep Contact");
  assert.equal(tables.account.find((row) => row.accountid === id).primarycontactid.id, deepContact.contactid);
  assert.equal(tables.contact.find((row) => row.fullname === "Child One").parentcustomerid.id, id);
  assert.ok(tables.account_tag.some((edge) => edge.accountid === id && edge.tagid === G(22)));
  const bound = await call(`/_api/contacts(${G(13)})`, { method: "PATCH", body: { "parentcustomerid@odata.bind": `${app.url}/_api/accounts(${G(3)})` } });
  assert.equal(bound.status, 204);
  assert.equal(app.store.snapshot().tables.contact.find((row) => row.contactid === G(13)).parentcustomerid.id, G(3));
  const foreign = await json(`/_api/contacts(${G(13)})`, { method: "PATCH", body: { "parentcustomerid@odata.bind": `https://other.example/_api/accounts(${G(3)})` } });
  assert.equal(foreign.status, 400);
  assert.equal((await call(`/_api/accounts(${G(1)})/account_tags/$ref`, { method: "POST", body: { "@odata.id": `${app.url}/_api/tags(${G(22)})` } })).status, 204);
  assert.equal(app.store.snapshot().tables.account_tag.filter((edge) => edge.accountid === G(1)).length, 2);
  assert.equal((await call(`/_api/accounts(${G(1)})/account_tags/$ref?$id=${encodeURIComponent(`${app.url}/_api/tags(${G(21)})`)}`, { method: "DELETE" })).status, 204);
  assert.equal((await call(`/_api/accounts(${G(1)})/account_tags(${G(22)})/$ref`, { method: "DELETE" })).status, 204);
  assert.equal(app.store.snapshot().tables.account_tag.some((edge) => edge.accountid === G(1)), false);
  assert.equal((await call(`/_api/contacts(${G(13)})/parentcustomerid/$ref`, { method: "PUT", body: { "@odata.id": `${app.url}/_api/accounts(${G(1)})` } })).status, 204);
  assert.equal(app.store.snapshot().tables.contact.find((row) => row.contactid === G(13)).parentcustomerid.id, G(1));
  assert.equal((await call(`/_api/contacts(${G(13)})/parentcustomerid/$ref`, { method: "DELETE" })).status, 204);
  assert.equal(app.store.snapshot().tables.contact.find((row) => row.contactid === G(13)).parentcustomerid, null);
  const wrongTarget = await json(`/_api/accounts(${G(1)})/account_tags/$ref`, { method: "POST", body: { "@odata.id": `${app.url}/_api/contacts(${G(11)})` } });
  assert.equal(wrongTarget.status, 400);
});

test("alternate keys are unique and duplicate primary keys are rejected", async (t) => {
  // Writing the primary key itself requires it in the Web API column list.
  const { json } = await start(t, {
    settings: { ...SETTINGS, "Webapi/account/fields": `accountid,${SETTINGS["Webapi/account/fields"]}` },
  });
  const duplicateKey = await json("/_api/accounts", { method: "POST", body: { name: "Copy", accountnumber: "ACC-0001" } });
  assert.equal(duplicateKey.status, 412);
  assert.equal(duplicateKey.body.error.innererror.code, "0x80040237");
  const duplicateId = await json("/_api/accounts", { method: "POST", body: { name: "Copy", accountid: G(1) } });
  assert.equal(duplicateId.status, 412);
});

test("anti-forgery tokens, disabled tables, configuration tables, entity set names and cloud flows", async (t) => {
  const { json, call } = await start(t);
  const missing = await json("/_api/accounts", { method: "POST", body: { name: "No token" }, token: false });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, "90040107");
  const mismatch = await json("/_api/accounts", { method: "POST", body: { name: "Bad token" }, token: false, headers: { __RequestVerificationToken: "wrong" } });
  // A token that doesn't match is 403 90040107, which Microsoft's clients refresh and retry on.
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.error.code, "90040107");
  assert.equal(mismatch.body.error.message, "The anti-forgery cookie token and form field token do not match.");
  assert.equal((await call("/_api/accounts?$select=name")).status, 200, "reads need no token");
  const snippet = await json("/_api/adx_contentsnippets");
  assert.equal(snippet.status, 404);
  assert.deepEqual(snippet.body.error, { code: "9004010E", message: "Configuration table adx_contentsnippet is not supported." });
  // Segments are entity set names: an unknown set, a logical name or a function names no
  // entity set and answers 400 9004010A (Third, Second and Example live: /_api/ppsimparitymissings).
  for (const route of ["/_api/ppsimparitymissings?$top=1", "/_api/account", "/_api/WhoAmI"]) {
    const unknown = await json(route);
    assert.equal(unknown.status, 400, route);
    assert.deepEqual(unknown.body.error, { code: "9004010A", message: "An unexpected error occurred while processing the request" }, route);
    assert.equal(unknown.headers.get("x-sim-error-code"), "UnknownEntitySet", route);
  }
  // Power Pages tables every environment has answer like a known table that isn't
  // enabled (Sample sandbox: /_api/mspp_webpages, 404 9004010C naming the logical name).
  const virtualTable = await json("/_api/mspp_webpages");
  assert.equal(virtualTable.status, 404);
  assert.deepEqual(virtualTable.body.error, { code: "9004010C", message: "Resource not found for the segment mspp_webpage." });
  assert.equal((await json("/_api/mspp_websiteaccesses")).body.error.message, "Resource not found for the segment mspp_websiteaccess.");
  assert.equal((await json("/_api/powerpagecomponents")).body.error.message, "Resource not found for the segment powerpagecomponent.");
  const flow = await json("/_api/cloudflow/v1.0/trigger/7f2a2b2c-1111-2222-3333-444455556666", { method: "POST", body: {} });
  assert.equal(flow.status, 501);
  const duplicate = await json("/_api/accounts?$select=name&$select=revenue");
  assert.equal(duplicate.status, 400);
});

test("FetchXML through the Web API: aliases carry AttributeName, nulls are omitted and $count counts matches", async (t) => {
  const { json } = await start(t);
  const xml = `<fetch><entity name="account"><attribute name="name" alias="title"/><attribute name="revenue"/><attribute name="primarycontactid"/><order attribute="name"/><link-entity name="contact" from="contactid" to="primarycontactid" link-type="outer" alias="pc"><attribute name="fullname"/></link-entity></entity></fetch>`;
  const { status, body } = await json(`/_api/accounts?fetchXml=${encodeURIComponent(xml)}&$count=true`);
  assert.equal(status, 200);
  assert.equal(body["@odata.count"], 3);
  const contoso = body.value.find((row) => row.title === "Contoso");
  assert.equal(contoso["title@OData.Community.Display.V1.AttributeName"], "name");
  assert.equal(contoso["pc.fullname"], "Ada Lovelace");
  assert.equal(contoso["pc.fullname@OData.Community.Display.V1.AttributeName"], "fullname");
  assert.equal(contoso._primarycontactid_value, G(11));
  assert.equal(contoso[`_primarycontactid_value${FORMATTED}`], "Ada Lovelace");
  assert.equal(contoso["@odata.etag"], 'W/"7"');
  const northwind = body.value.find((row) => row.title === "Northwind");
  assert.equal(Object.hasOwn(northwind, "revenue"), false, "FetchXML Web API results omit null values");
  const mismatch = await json(`/_api/contacts?fetchXml=${encodeURIComponent(xml)}`);
  assert.equal(mismatch.status, 400);
});

test("table permission denials map to 90040120 (read) and the documented write codes", async (t) => {
  const state = fixture();
  state.settings = { permissionMode: "enforce" };
  state.permissions = [{ id: "tags", entity: "tag", scope: "global", roles: ["Reader"], operations: ["read"] }];
  state.simulator.identity = { id: G(11), roles: ["Reader"] };
  const { json } = await start(t, { state });
  const denied = await json("/_api/accounts?$select=name");
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body.error, { code: "90040120", message: "You don't have permission to read the account table." });
  assert.equal(denied.headers.get("x-sim-error-code"), "PermissionDenied");
  const create = await json("/_api/tags", { method: "POST", body: { name: "Bronze" } });
  assert.deepEqual(create.body.error, { code: "90040103", message: "You don't have permission to create tag entity." });
  const update = await json(`/_api/tags(${G(21)})`, { method: "PATCH", body: { name: "Platinum" } });
  assert.deepEqual(update.body.error, { code: "90040102", message: "You don't have permission to update tag entity." });
  const remove = await json(`/_api/tags(${G(21)})`, { method: "DELETE" });
  assert.deepEqual(remove.body.error, { code: "90040104", message: "You don't have permission to delete tag entity." });
});

test("FetchXML link-entity tables need read permission; lookup names don't depend on the related table", async (t) => {
  const state = fixture();
  state.settings = { permissionMode: "enforce" };
  state.permissions = [{ id: "accounts", entity: "account", scope: "global", roles: ["Reader"], operations: ["read"] }];
  state.simulator.identity = { id: G(11), roles: ["Reader"] };
  const { json } = await start(t, { state });
  // sandbox: reference terms carry their list name although lists are denied.
  const named = await json(`/_api/accounts?$select=name,_primarycontactid_value&$filter=accountid eq ${G(1)}`);
  assert.equal(named.status, 200);
  assert.equal(named.body.value[0][`_primarycontactid_value${FORMATTED}`], "Ada Lovelace");
  // sandbox: 403 90040120 when a joined table has no read permission.
  const xml = '<fetch><entity name="account"><attribute name="name"/><link-entity name="contact" from="contactid" to="primarycontactid" alias="c"><attribute name="fullname"/></link-entity></entity></fetch>';
  const joined = await json(`/_api/accounts?fetchXml=${encodeURIComponent(xml)}`);
  assert.equal(joined.status, 403);
  assert.deepEqual(joined.body.error, { code: "90040120", message: "You don't have permission to read the contact table." });
  const own = await json(`/_api/accounts?fetchXml=${encodeURIComponent('<fetch><entity name="account"><attribute name="name"/></entity></fetch>')}`);
  assert.equal(own.status, 200);
});

test("$expand and navigation reads need read permission on the related table", async (t) => {
  // sandbox: an anonymous $expand of a lookup to an unreadable table answers 403 90040120
  // naming that table (export sets Webapi/SkipRelatedTablePermissions; G probe
  // b-settings-sample-skip-related-expand.json).
  const state = fixture();
  state.settings = { permissionMode: "enforce" };
  state.permissions = [{ id: "accounts", entity: "account", scope: "global", roles: ["Reader"], operations: ["read"] }];
  state.simulator.identity = { id: G(11), roles: ["Reader"] };
  const { json } = await start(t, { state });
  const denied = { code: "90040120", message: "You don't have permission to read the contact table." };
  for (const route of [
    "/_api/accounts?$select=name&$expand=primarycontactid($select=fullname)",
    "/_api/accounts?$select=name&$expand=contact_customer_accounts($select=fullname)",
    `/_api/accounts(${G(1)})?$select=name&$expand=primarycontactid($select=fullname)`,
    `/_api/accounts(${G(1)})/primarycontactid?$select=fullname`,
    `/_api/accounts(${G(1)})/contact_customer_accounts?$select=fullname`,
  ]) {
    const response = await json(route);
    assert.equal(response.status, 403, route);
    assert.deepEqual(response.body.error, denied, route);
  }
  // Without $expand the lookup's own columns stay readable.
  assert.equal((await json(`/_api/accounts?$select=name,_primarycontactid_value`)).status, 200);
  const readable = fixture();
  readable.settings = { permissionMode: "enforce" };
  readable.permissions = [...state.permissions, { id: "contacts", entity: "contact", scope: "global", roles: ["Reader"], operations: ["read"] }];
  readable.simulator.identity = { id: G(11), roles: ["Reader"] };
  const expanded = await (await start(t, { state: readable })).json(
    `/_api/accounts?$select=name&$expand=primarycontactid($select=fullname)&$filter=accountid eq ${G(1)}`,
  );
  assert.equal(expanded.status, 200);
  assert.equal(expanded.body.value[0].primarycontactid.fullname, "Ada Lovelace");
});

test("FetchXML many-to-many traversals need read permission on both tables, not on the intersect", async (t) => {
  const state = fixture();
  state.settings = { permissionMode: "enforce" };
  state.permissions = [
    { id: "accounts", entity: "account", scope: "global", roles: ["Reader"], operations: ["read"] },
    { id: "tags", entity: "tag", scope: "global", roles: ["Reader"], operations: ["read"] },
  ];
  state.simulator.identity = { id: G(11), roles: ["Reader"] };
  const { json } = await start(t, { state });
  // The N:N pattern portal scripts use: an intersect='true' link that selects nothing
  // and leads to the relationship's other table (no table permission targets an intersect).
  const xml =
    '<fetch><entity name="account"><attribute name="name"/>' +
    '<link-entity name="account_tag" from="accountid" to="accountid" visible="false" intersect="true">' +
    '<link-entity name="tag" from="tagid" to="tagid" alias="t"><attribute name="name"/></link-entity>' +
    "</link-entity></entity></fetch>";
  const joined = await json(`/_api/accounts?fetchXml=${encodeURIComponent(xml)}`);
  assert.equal(joined.status, 200);
  assert.deepEqual(
    joined.body.value.map((row) => [row.name, row["t.name"]]),
    [["Contoso", "Gold"]],
  );
  // The tables on both sides still need read permission.
  const accountsOnly = fixture();
  accountsOnly.settings = { permissionMode: "enforce" };
  accountsOnly.permissions = [state.permissions[0]];
  accountsOnly.simulator.identity = { id: G(11), roles: ["Reader"] };
  const denied = await (await start(t, { state: accountsOnly })).json(`/_api/accounts?fetchXml=${encodeURIComponent(xml)}`);
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body.error, { code: "90040120", message: "You don't have permission to read the tag table." });
});

test("lookup names use the related table's primary name column, not a publisher default", async () => {
  const { DataStore } = await import("../lib/data.mjs");
  const { createWebApiFormatter } = await import("../lib/webapi-format.mjs");
  const store = await new DataStore({
    state: {
      mappings: {
        abc_order: { entitySet: "abc_orders", idColumn: "abc_orderid", relationships: { abc_Customer: { entity: "abc_customer", from: "abc_customerid", to: "abc_customerid", many: false } } },
        abc_customer: { entitySet: "abc_customers", idColumn: "abc_customerid" },
        account: { entitySet: "accounts", idColumn: "accountid" },
      },
      tables: {
        abc_order: [{ abc_orderid: "o1", abc_customerid: "c1", parentid: { id: "a1", logical_name: "account" } }],
        abc_customer: [{ abc_customerid: "c1", abc_name: "Custom name" }],
        account: [{ accountid: "a1", name: "Account name" }],
      },
      settings: { permissionMode: "permissive" },
    },
  }).init();
  const formatted = createWebApiFormatter({ store }).formatEntity(store.state.tables.abc_order[0], store.resolveMapping("abc_order"));
  assert.equal(formatted[`_abc_customerid_value${FORMATTED}`], "Custom name", "custom tables use <prefix>_name");
  assert.equal(formatted[`_parentid_value${FORMATTED}`], "Account name", "standard tables use name");
});

test("$filter follows three-valued logic: not, and/or and functions over null are unknown", async (t) => {
  const state = fixture();
  state.tables.account.push({ accountid: G(4), name: "Litware", statecode: 0, statuscode: 1, accountnumber: "ACC-0004" });
  state.tables.validationconfiguration.push(
    { validationconfigurationid: G(42), formname: "Off", processtype: 100000000, isenabled: false, statecode: 0 },
    { validationconfigurationid: G(43), formname: "Unset", processtype: 100000000, statecode: 0 },
  );
  const { json } = await start(t, { state });
  const names = async (route, column = "name") => (await json(route)).body.value.map((row) => row[column]).sort();
  // not null is null: the row without a value matches neither isenabled nor not isenabled.
  assert.deepEqual(await names("/_api/validationconfigurations?$select=formname&$filter=not isenabled", "formname"), ["Off"]);
  assert.deepEqual(await names("/_api/validationconfigurations?$select=formname&$filter=isenabled", "formname"), ["Product-RW"]);
  // A comparison with a null operand is unknown, and so is its negation.
  assert.deepEqual(await names("/_api/accounts?$select=name&$filter=not (employees gt 10)"), ["Fabrikam"]);
  assert.deepEqual(await names("/_api/accounts?$select=name&$filter=employees gt 10 or not (employees gt 10)"), ["Contoso", "Fabrikam", "Northwind"]);
  // Kleene logic: false and unknown is false, true or unknown is true.
  assert.deepEqual(await names("/_api/accounts?$select=name&$filter=(employees gt 10) or name eq 'Litware'"), ["Contoso", "Litware", "Northwind"]);
  assert.deepEqual(await names("/_api/accounts?$select=name&$filter=not (contains(description,'x'))"), []);
  // eq null and ne null are definite.
  assert.deepEqual(await names("/_api/accounts?$select=name&$filter=not (employees eq null)"), ["Contoso", "Fabrikam", "Northwind"]);
});

test("paging links bind to the store's data revision, not a digest of the state", async (t) => {
  const { prepareODataPage } = await import("../lib/odata-paging.mjs");
  const url = new URL("http://127.0.0.1/_api/accounts?$select=name");
  assert.throws(() => prepareODataPage({ url, identity: {}, secret: "s" }), /data revision/);
  const first = prepareODataPage({ url, prefer: "odata.maxpagesize=1", identity: {}, revision: "4.1", secret: "s" });
  const next = new URL(first.nextLink(1));
  assert.equal(prepareODataPage({ url: next, prefer: "odata.maxpagesize=1", identity: {}, revision: "4.1", secret: "s" }).offset, 1);
  assert.throws(() => prepareODataPage({ url: next, prefer: "odata.maxpagesize=1", identity: {}, revision: "5.1", secret: "s" }), /restart the query/);
  // Over HTTP: a committed change invalidates an outstanding link.
  const { json, app } = await start(t);
  const revision = app.store.dataRevision();
  const page = await json("/_api/accounts?$select=name", { headers: { Prefer: "odata.maxpagesize=1" } });
  const link = new URL(page.body["@odata.nextLink"]);
  assert.equal((await json(link.pathname + link.search, { headers: { Prefer: "odata.maxpagesize=1" } })).status, 200);
  await json(`/_api/accounts(${G(2)})`, { method: "PATCH", body: { name: "Fabrikam 2" } });
  assert.notEqual(app.store.dataRevision(), revision);
  assert.equal((await json(link.pathname + link.search, { headers: { Prefer: "odata.maxpagesize=1" } })).status, 400);
});

test("wildcard field lists fail by default; an observed exemption keeps every column", async (t) => {
  const settings = { ...SETTINGS, "Webapi/tag/fields": "*" };
  const enforced = await start(t, { settings });
  const denied = await enforced.json("/_api/tags?$select=name");
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("x-sim-error-code"), "WebApiWildcardDeprecated");
  const exempt = await start(t, { settings, observed: { webApiWildcard: "exempt", evidence: "synthetic exemption" } });
  assert.equal((await exempt.json("/_api/tags?$select=name")).status, 200);
});

test("an entity set name wins over a table whose logical name equals it", async (t) => {
  const state = fixture();
  // A table literally named "tags" must not shadow the tags set of the tag table.
  state.mappings.tags = { entitySet: "tagses", idColumn: "tagsid" };
  state.tables.tags = [];
  const { json } = await start(t, { state });
  const response = await json("/_api/tags?$select=name");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.value.map((row) => row.name).sort(), ["Gold", "Silver"]);
});
