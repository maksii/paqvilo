// Masking rules on secured columns (Learn create-manage-masking-rules, column-level-security#display-masked-data,
// optional-parameters#return-unmasked-data): a reader with Read gets the masked value; UnMaskedData=true returns the clear
// value only with CanReadUnmasked (1 One Record: single-record reads; 3 All Records: every read); every principal,
// System Administrators included, reads masked values until it asks. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN, CUST, readFixture } from "./read-projection-fixture.mjs";
import { dispatchSdkCall } from "../lib/plugin-clr.mjs";

const ITEM = "77777777-7777-4777-8777-000000000001";
const SECRET = "TOP-SECRET-123", MASKED = "*".repeat(SECRET.length);
const mappings = { x_item: { logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
  fields: { x_name: { dataverseType: "nvarchar" }, x_secret: { dataverseType: "nvarchar", columnMetadata: { isSecured: true } } } } };
const tables = { x_item: [{ x_itemid: ITEM, x_name: "Invented", x_secret: SECRET, statecode: 0, statuscode: 1 }] };
const fx = encodeURIComponent('<fetch><entity name="x_item"><attribute name="x_secret"/></entity></fetch>');

// CUST gets a profile with Read allowed and the given CanReadUnmasked; x_item.x_secret gets a rule masking every character.
async function setup(t, { unmasked = 0, expression = "." } = {}) {
  const f = await readFixture(t, { mappings, tables });
  const { store } = f;
  const user = store.state.tables.systemuser.find((row) => String(row.applicationid ?? "").toLowerCase() === CUST);
  const PROFILE = "77777777-7777-4777-8777-0000000000a1", RULE = "77777777-7777-4777-8777-0000000000b1";
  await store.transact(() => {
    store.state.tables.fieldsecurityprofile.push({ fieldsecurityprofileid: PROFILE, name: "Invented profile" });
    store.state.tables.systemuserprofiles.push({ systemuserprofileid: "77777777-7777-4777-8777-0000000000a2", systemuserid: { id: user.systemuserid }, fieldsecurityprofileid: { id: PROFILE } });
    store.state.tables.fieldpermission.push({ fieldpermissionid: "77777777-7777-4777-8777-0000000000a3", fieldsecurityprofileid: { id: PROFILE }, entityname: "x_item", attributelogicalname: "x_secret", cancreate: 0, canread: 4, canupdate: 0, canreadunmasked: unmasked });
    (store.state.tables.maskingrule ??= []).push({ maskingruleid: RULE, name: "x_InventedAll", regularexpression: expression, maskedcharacter: "*" });
    (store.state.tables.attributemaskingrule ??= []).push({ attributemaskingruleid: "77777777-7777-4777-8777-0000000000b2", entityname: "x_item", attributelogicalname: "x_secret", maskingruleid: { id: RULE, logical_name: "maskingrule" } });
  });
  const read = async (path, as = CUST) => {
    const response = await f.request("GET", path, undefined, {}, as);
    const text = await response.text();
    assert.equal(response.status, 200, `${path}: ${text}`);
    return JSON.parse(text);
  };
  const single = async (query = "", as = CUST) => (await read(`/x_items(${ITEM})?$select=x_secret${query}`, as)).x_secret;
  const many = async (query = "", as = CUST) => (await read(`/x_items?$select=x_secret${query}`, as)).value[0].x_secret;
  const fetched = async (query = "", as = CUST) => (await read(`/x_items?fetchXml=${fx}${query}`, as)).value[0].x_secret;
  return { ...f, read, single, many, fetched };
}

test("a reader with CanRead and a masking rule gets the masked value on every read route", async (t) => {
  const f = await setup(t);
  assert.equal(await f.single(), MASKED);
  assert.equal(await f.many(), MASKED);
  assert.equal(await f.fetched(), MASKED);
  assert.equal((await f.read(`/x_items(${ITEM})/x_secret`)).value, MASKED);
  assert.equal(await (await f.request("GET", `/x_items(${ITEM})/x_secret/$value`, undefined, {}, CUST)).text(), MASKED);
});

// Learn web-service-error-codes 0x80041155 CannotFilterOnMaskedAttribute: a masked column is never a filter (or order) operand,
// so prefix probes cannot recover the stored value.
test("a filter, $apply filter, $orderby or FetchXML condition/order on a masked column answers 400 0x80041155", async (t) => {
  const f = await setup(t);
  const refused = async (path) => {
    const response = await f.request("GET", path, undefined, {}, CUST);
    const body = await response.json();
    assert.equal(response.status, 400, path);
    assert.equal(body.error.code, "0x80041155", path);
    assert.match(body.error.message, /Filtering on masked attributes without the read unmasked column permission is not allowed/);
  };
  await refused(`/x_items?$select=x_name&$filter=startswith(x_secret,'TOP')`);
  await refused(`/x_items?$apply=filter(startswith(x_secret,'TOP'))/aggregate($count as n)`);
  await refused(`/x_items?$select=x_name&$orderby=x_secret`);
  for (const inner of [`<filter><condition attribute="x_secret" operator="like" value="TOP%"/></filter>`, `<order attribute="x_secret"/>`]) {
    await refused(`/x_items?fetchXml=${encodeURIComponent(`<fetch><entity name="x_item"><attribute name="x_name"/>${inner}</entity></fetch>`)}`);
  }
  // A caller that reads the clear value may filter: a System Administrator with UnMaskedData, CanReadUnmasked All Records.
  assert.equal((await f.read(`/x_items?$select=x_name&$filter=startswith(x_secret,'TOP')&UnMaskedData=true`, ADMIN)).value.length, 1);
});

test("CanReadUnmasked 3 with UnMaskedData filters on the clear value; One Record does not unmask a collection filter", async (t) => {
  const all = await setup(t, { unmasked: 3 });
  assert.equal((await all.read(`/x_items?$select=x_name&$filter=x_secret eq '${SECRET}'&UnMaskedData=true`)).value.length, 1);
  const one = await setup(t, { unmasked: 1 });
  const response = await one.request("GET", `/x_items?$select=x_name&$filter=x_secret eq '${SECRET}'&UnMaskedData=true`, undefined, {}, CUST);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "0x80041155");
});

test("UnMaskedData=true with CanReadUnmasked 0 still returns masked", async (t) => {
  const f = await setup(t, { unmasked: 0 });
  assert.equal(await f.single("&UnMaskedData=true"), MASKED);
  assert.equal(await f.many("&UnMaskedData=true"), MASKED);
});

test("CanReadUnmasked 1 unmasks a single Retrieve but not RetrieveMultiple", async (t) => {
  const f = await setup(t, { unmasked: 1 });
  assert.equal(await f.single("&UnMaskedData=true"), SECRET);
  assert.equal((await f.read(`/x_items(${ITEM})/x_secret?UnMaskedData=true`)).value, SECRET);
  assert.equal(await f.single(), MASKED, "without the parameter the value stays masked");
  assert.equal(await f.many("&UnMaskedData=true"), MASKED);
  assert.equal(await f.fetched("&UnMaskedData=true"), MASKED);
});

test("CanReadUnmasked 3 unmasks collections and FetchXML", async (t) => {
  const f = await setup(t, { unmasked: 3 });
  assert.equal(await f.many("&UnMaskedData=true"), SECRET);
  assert.equal(await f.fetched("&UnMaskedData=true"), SECRET);
  assert.equal(await f.many(), MASKED);
});

test("a System Administrator reads masked values until it asks for UnMaskedData", async (t) => {
  const f = await setup(t);
  assert.equal(await f.single("", ADMIN), MASKED);
  assert.equal(await f.many("&UnMaskedData=true", ADMIN), SECRET);
});

test("unmaskeddata (wrong case) answers 0x80060888", async (t) => {
  const f = await setup(t, { unmasked: 3 });
  const response = await f.request("GET", `/x_items?$select=x_secret&unmaskeddata=true`, undefined, {}, CUST);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "0x80060888");
  assert.match(body.error.message, /The query parameter unmaskeddata is not supported/);
});

test("a regex JS cannot compile reads null with MASKING_RULE_UNSUPPORTED", async (t) => {
  const f = await setup(t, { expression: "(?i)secret" });
  assert.equal(await f.single(), null);
  assert.ok(f.api.fieldSecurity.diagnostics().some((entry) => entry.code === "MASKING_RULE_UNSUPPORTED" && entry.column === "x_secret"));
});

test("each match of the expression becomes one masked character", async (t) => {
  const f = await setup(t, { expression: "[A-Z]+" });
  assert.equal(await f.single(), "*-*-123");
});

test("SOAP Retrieve honours the UnMaskedData request parameter", async (t) => {
  const f = await setup(t, { unmasked: 1 });
  const envelope = (unmask) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><Execute xmlns="http://schemas.microsoft.com/xrm/2011/Contracts/Services"><request i:type="a:RetrieveRequest" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><a:Parameters xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic"><a:KeyValuePairOfstringanyType><b:key>Target</b:key><b:value i:type="a:EntityReference"><a:Id>${ITEM}</a:Id><a:LogicalName>x_item</a:LogicalName><a:Name i:nil="true"/></b:value></a:KeyValuePairOfstringanyType><a:KeyValuePairOfstringanyType><b:key>ColumnSet</b:key><b:value i:type="a:ColumnSet"><a:AllColumns>false</a:AllColumns><a:Columns xmlns:c="http://schemas.microsoft.com/2003/10/Serialization/Arrays"><c:string>x_secret</c:string></a:Columns></b:value></a:KeyValuePairOfstringanyType>${unmask ? '<a:KeyValuePairOfstringanyType><b:key>UnMaskedData</b:key><b:value i:type="c:boolean" xmlns:c="http://www.w3.org/2001/XMLSchema">true</b:value></a:KeyValuePairOfstringanyType>' : ""}</a:Parameters><a:RequestId i:nil="true"/><a:RequestName>Retrieve</a:RequestName></request></Execute></s:Body></s:Envelope>`;
  // The SOAP endpoint (/XRMServices/2011/Organization.svc/web) takes the same bearer; the dot segments leave /api/data/v9.2.
  const send = async (unmask) => {
    const response = await f.request("POST", "/../../../XRMServices/2011/Organization.svc/web", envelope(unmask), {
      "content-type": "text/xml; charset=utf-8", soapaction: "http://schemas.microsoft.com/xrm/2011/Contracts/Services/IOrganizationService/Execute" }, CUST);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return text;
  };
  assert.doesNotMatch(await send(false), new RegExp(SECRET));
  assert.match(await send(true), new RegExp(SECRET));
});

test("the exported read projection applies masking to an SDK-shaped row", async (t) => {
  const f = await setup(t, { unmasked: 1 });
  const user = f.store.state.tables.systemuser.find((row) => String(row.applicationid ?? "").toLowerCase() === CUST);
  const project = (options) => f.api.records.projectRow({ user, identity: {} }, "x_item", { x_itemid: ITEM, x_secret: SECRET, x_name: "Invented" }, options);
  assert.equal(project({}).x_secret, MASKED);
  assert.equal(project({ unmask: true }).x_secret, SECRET);
  assert.equal(project({ unmask: true, single: false }).x_secret, MASKED);
  assert.deepEqual(Object.keys(project({ select: ["x_name"] })).sort(), ["x_itemid", "x_name"]);
});

// Learn create-manage-masking-rules: "Audit log shows masked values in the before-and-after update events".
test("audit details show the masked old and new values of a masked column", async (t) => {
  const f = await setup(t);
  await f.store.transact(() => {
    for (const row of f.store.state.tables.organization) row.isauditenabled = true;
    f.store.state.mappings.x_item.dataverseMetadata = { ...f.store.state.mappings.x_item.dataverseMetadata, IsAuditEnabled: { Value: true } };
  });
  const NEXT = "NEW-SECRET-456";
  await f.json(await f.request("PATCH", `/x_items(${ITEM})`, { x_secret: NEXT }), 200);
  await f.store.flushCommittedEvents?.();
  await f.store.queue;
  const admin = f.store.state.tables.systemuser.find((row) => String(row.applicationid ?? "").toLowerCase() === ADMIN);
  const history = f.api.registry.find({ name: "RetrieveRecordChangeHistory", kind: "function", binding: "unbound" });
  const answer = await history.handle({ origin: "http://localhost", version: "v9.2", user: admin, params: { Target: { "@odata.id": `x_items(${ITEM})` } } });
  const detail = answer.body.AuditDetailCollection.AuditDetails.find((item) => item.NewValue && Object.hasOwn(item.NewValue, "x_secret"));
  assert.ok(detail, "the update was audited");
  assert.equal(detail.NewValue.x_secret, "*".repeat(NEXT.length));
  assert.equal(detail.OldValue.x_secret, MASKED);
});

// Learn optional-parameters#return-unmasked-data: request["UnMaskedData"] = true on Retrieve and RetrieveMultiple, under the
// same CanReadUnmasked rule as the Web API.
test("SDK Retrieve and RetrieveMultiple honour the UnMaskedData request parameter", async (t) => {
  const execute = (f, requestName, values) => {
    const user = f.store.state.tables.systemuser.find((row) => String(row.applicationid ?? "").toLowerCase() === CUST);
    const profile = { userId: user.systemuserid, evidence: "invented masking test", grants: [{ entity: "x_item", operations: ["read"] }] };
    return JSON.stringify(dispatchSdkCall({ store: f.store, profile, message: { method: "Execute", userId: profile.userId,
      arguments: [{ $type: "OrganizationRequest", requestName, parameters: { $type: "ParameterCollection", values } }] } }));
  };
  const retrieve = (unmask) => ({ Target: { $type: "EntityReference", logicalName: "x_item", id: ITEM }, ColumnSet: { $type: "ColumnSet", allColumns: true }, ...(unmask ? { UnMaskedData: true } : {}) });
  const query = (unmask) => ({ Query: { $type: "QueryExpression", entityName: "x_item", columnSet: { $type: "ColumnSet", allColumns: true } }, ...(unmask ? { UnMaskedData: true } : {}) });
  const one = await setup(t, { unmasked: 1 });
  assert.match(execute(one, "Retrieve", retrieve(true)), new RegExp(SECRET));
  assert.doesNotMatch(execute(one, "Retrieve", retrieve(false)), new RegExp(SECRET));
  assert.doesNotMatch(execute(one, "RetrieveMultiple", query(true)), new RegExp(SECRET), "One Record does not unmask RetrieveMultiple");
  const all = await setup(t, { unmasked: 3 });
  assert.match(execute(all, "RetrieveMultiple", query(true)), new RegExp(SECRET));
  assert.doesNotMatch(execute(all, "RetrieveMultiple", query(false)), new RegExp(SECRET));
  const none = await setup(t, { unmasked: 0 });
  assert.doesNotMatch(execute(none, "Retrieve", retrieve(true)), new RegExp(SECRET), "without CanReadUnmasked the value stays masked");
});
