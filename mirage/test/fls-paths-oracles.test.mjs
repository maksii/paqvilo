// Column security on every query path: a navigation, lambda, $expand option, $apply step or FetchXML link-entity/root
// condition, order or aggregate over a secured column must not tell a right guess from a wrong one. Hidden columns (no read
// permission) evaluate as null; masked columns (read with a masking rule, no unmask) are refused as operands with 400
// 0x80041155 (CannotFilterOnMaskedAttribute). Lookups cannot be secured, so joins still work. CUST is a System Customizer.
import test from "node:test";
import assert from "node:assert/strict";
import { CUST, readFixture } from "./read-projection-fixture.mjs";
import { localOrganizationService } from "../lib/local-organization-service.mjs";
import { createConnectorRuntime } from "../lib/connector-runtime.mjs";

const ITEM = "77777777-7777-4777-8777-000000000001", ITEM2 = "77777777-7777-4777-8777-000000000003";
const CHILD = "77777777-7777-4777-8777-000000000002", CHILD2 = "77777777-7777-4777-8777-000000000004";
const SECRET = "TOP-SECRET-123", CSECRET = "CHILD-SECRET-9", WRONG = "WRONG-GUESS-00";
const mappings = {
  x_item: { logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
    relationships: { x_item_children: { entity: "x_child", from: "x_itemid", to: "x_itemid", many: true } },
    fields: { x_name: { dataverseType: "nvarchar" }, x_secret: { dataverseType: "nvarchar", columnMetadata: { isSecured: true } } } },
  x_child: { logicalName: "x_child", entitySet: "x_children", idColumn: "x_childid", nameColumn: "x_name",
    relationships: { x_itemid: { entity: "x_item", from: "x_itemid", to: "x_itemid", many: false } },
    fields: { x_name: { dataverseType: "nvarchar" }, x_itemid: { dataverseType: "lookup" }, x_csecret: { dataverseType: "nvarchar", columnMetadata: { isSecured: true } } } },
};
const tables = {
  x_item: [{ x_itemid: ITEM, x_name: "A", x_secret: SECRET, statecode: 0, statuscode: 1 },
    { x_itemid: ITEM2, x_name: "B", x_secret: "AAA-LOW", statecode: 0, statuscode: 1 }],
  x_child: [{ x_childid: CHILD, x_name: "C1", x_itemid: { id: ITEM, logical_name: "x_item" }, x_csecret: CSECRET, statecode: 0, statuscode: 1 },
    { x_childid: CHILD2, x_name: "C2", x_itemid: { id: ITEM2, logical_name: "x_item" }, x_csecret: "ZZZ", statecode: 0, statuscode: 1 }],
};

// masked: CUST reads both secrets (canread 4, canreadunmasked 0) and a rule masks every character; hidden: no profile.
async function setup(t, mode) {
  const f = await readFixture(t, { mappings, tables });
  if (mode === "masked") {
    const { store } = f;
    const user = store.state.tables.systemuser.find((row) => String(row.applicationid ?? "").toLowerCase() === CUST);
    const PROFILE = "77777777-7777-4777-8777-0000000000a1", RULE = "77777777-7777-4777-8777-0000000000b1";
    await store.transact(() => {
      store.state.tables.fieldsecurityprofile.push({ fieldsecurityprofileid: PROFILE, name: "Invented profile" });
      store.state.tables.systemuserprofiles.push({ systemuserprofileid: "77777777-7777-4777-8777-0000000000a2", systemuserid: { id: user.systemuserid }, fieldsecurityprofileid: { id: PROFILE } });
      for (const [entity, column, n] of [["x_item", "x_secret", "a3"], ["x_child", "x_csecret", "a4"]])
        store.state.tables.fieldpermission.push({ fieldpermissionid: `77777777-7777-4777-8777-0000000000${n}`, fieldsecurityprofileid: { id: PROFILE }, entityname: entity, attributelogicalname: column, cancreate: 0, canread: 4, canupdate: 0, canreadunmasked: 0 });
      (store.state.tables.maskingrule ??= []).push({ maskingruleid: RULE, name: "x_InventedAll", regularexpression: ".", maskedcharacter: "*" });
      (store.state.tables.attributemaskingrule ??= []).push(
        { attributemaskingruleid: "77777777-7777-4777-8777-0000000000b2", entityname: "x_item", attributelogicalname: "x_secret", maskingruleid: { id: RULE, logical_name: "maskingrule" } },
        { attributemaskingruleid: "77777777-7777-4777-8777-0000000000b3", entityname: "x_child", attributelogicalname: "x_csecret", maskingruleid: { id: RULE, logical_name: "maskingrule" } });
    });
  }
  // The answer as status and body, with the guess itself (echoed in next links) blanked out.
  const answer = async (path, guess = "") => {
    const response = await f.request("GET", path, undefined, {}, CUST);
    const text = await response.text();
    return { status: response.status, body: guess ? text.replaceAll(encodeURIComponent(guess), "?").replaceAll(guess, "?") : text };
  };
  return { ...f, answer };
}

const q = encodeURIComponent;
const fx = (set, xml) => `/${set}?fetchXml=${q(xml)}`;
// [name, guess the right value is, build(guess)]
const GUESSES = [
  ["$filter navigation", SECRET, (g) => `/x_children?$select=x_name&$filter=${q(`x_itemid/x_secret eq '${g}'`)}`],
  ["$filter lambda any", CSECRET, (g) => `/x_items?$select=x_name&$filter=${q(`x_item_children/any(c:c/x_csecret eq '${g}')`)}`],
  ["$filter lambda all", CSECRET, (g) => `/x_items?$select=x_name&$filter=${q(`x_item_children/all(c:c/x_csecret ne '${g}')`)}`],
  ["$expand $filter", CSECRET, (g) => `/x_items?$select=x_name&$expand=${q(`x_item_children($select=x_name;$filter=x_csecret eq '${g}')`)}`],
  ["$expand then navigation $filter", SECRET, (g) => `/x_children?$select=x_name&$expand=${q("x_itemid($select=x_name)")}&$filter=${q(`x_itemid/x_secret eq '${g}'`)}`],
  ["$apply navigation filter", SECRET, (g) => `/x_children?$apply=${q(`filter(x_itemid/x_secret eq '${g}')/aggregate($count as n)`)}`],
  ["$filter root", SECRET, (g) => `/x_items?$select=x_name&$filter=${q(`x_secret eq '${g}'`)}`],
  ["FetchXML root condition", SECRET, (g) => fx("x_items", `<fetch><entity name="x_item"><attribute name="x_name"/><filter><condition attribute="x_secret" operator="eq" value="${g}"/></filter></entity></fetch>`)],
  ["FetchXML link-entity condition", SECRET, (g) => fx("x_children", `<fetch><entity name="x_child"><attribute name="x_name"/><link-entity name="x_item" from="x_itemid" to="x_itemid" alias="p"><filter><condition attribute="x_secret" operator="eq" value="${g}"/></filter></link-entity></entity></fetch>`)],
  ["FetchXML entityname condition", SECRET, (g) => fx("x_children", `<fetch><entity name="x_child"><attribute name="x_name"/><link-entity name="x_item" from="x_itemid" to="x_itemid" alias="p"/><filter><condition entityname="p" attribute="x_secret" operator="eq" value="${g}"/></filter></entity></fetch>`)],
];
const linkOrder = (descending) => fx("x_children", `<fetch><entity name="x_child"><attribute name="x_name"/><link-entity name="x_item" from="x_itemid" to="x_itemid" alias="p"><order attribute="x_secret" descending="${descending}"/></link-entity></entity></fetch>`);

test("a hidden column on a navigation, lambda, $expand, $apply or FetchXML path cannot tell a right guess from a wrong one", async (t) => {
  const f = await setup(t, "hidden");
  for (const [name, right, build] of GUESSES) {
    const a = await f.answer(build(right), right), b = await f.answer(build(WRONG), WRONG);
    assert.equal(a.status, 200, `${name}: ${a.body}`);
    assert.deepEqual(a, b, name);
    assert.doesNotMatch(a.body, /TOP-SECRET|CHILD-SECRET|AAA-LOW/, name);
  }
  assert.deepEqual(await f.answer(linkOrder(false)), await f.answer(linkOrder(true)), "FetchXML link-entity order");
  // Lookups are join keys and are never nulled: the child still reaches its parent.
  const joined = JSON.parse((await f.answer(`/x_children?$select=x_name&$expand=${q("x_itemid($select=x_name)")}&$orderby=x_name`)).body);
  assert.deepEqual(joined.value.map((row) => [row.x_name, row.x_itemid?.x_name]), [["C1", "A"], ["C2", "B"]]);
});

test("a navigation groupby or aggregate over a hidden column answers 403", async (t) => {
  const f = await setup(t, "hidden");
  for (const path of [
    `/x_children?$apply=${q("groupby((x_itemid/x_secret))")}`,
    `/x_children?$apply=${q("groupby((x_name),aggregate(x_itemid/x_secret with max as m))")}`,
    fx("x_children", '<fetch aggregate="true"><entity name="x_child"><link-entity name="x_item" from="x_itemid" to="x_itemid" alias="p"><attribute name="x_secret" aggregate="max" alias="m"/></link-entity></entity></fetch>'),
  ]) {
    const { status, body } = await f.answer(path);
    assert.equal(status, 403, `${path}: ${body}`);
    assert.equal(JSON.parse(body).error.code, "0x8004f508");
    assert.doesNotMatch(body, /TOP-SECRET|AAA-LOW/);
  }
});

test("a masked column on any of those paths, an order or an aggregate answers 400 0x80041155 for any guess", async (t) => {
  const f = await setup(t, "masked");
  const refused = async (path, guess) => {
    const { status, body } = await f.answer(path, guess);
    assert.equal(status, 400, `${path}: ${body}`);
    assert.equal(JSON.parse(body).error.code, "0x80041155", path);
    return body;
  };
  for (const [name, right, build] of GUESSES) assert.equal(await refused(build(right), right), await refused(build(WRONG), WRONG), name);
  await refused(linkOrder(false));
  // Only filtering is documented; min/max/groupby over the clear value are assumed to be the same order and equality oracle.
  for (const apply of ["aggregate(x_secret with max as m)", "aggregate(x_secret with min as m)", "groupby((x_secret))", "groupby((x_name),aggregate(x_secret with max as m))"])
    await refused(`/x_items?$apply=${q(apply)}`);
  await refused(`/x_children?$apply=${q("groupby((x_itemid/x_secret))")}`);
  await refused(`/x_items?$select=x_name&$expand=${q("x_item_children($select=x_name;$orderby=x_csecret)")}`);
  for (const xml of [
    '<fetch aggregate="true"><entity name="x_item"><attribute name="x_secret" aggregate="max" alias="m"/></entity></fetch>',
    '<fetch aggregate="true"><entity name="x_item"><attribute name="x_secret" groupby="true" alias="g"/><attribute name="x_itemid" aggregate="count" alias="n"/></entity></fetch>',
  ]) await refused(fx("x_items", xml));
  // A presence count reads nothing of the clear value and is not refused.
  const counted = await f.answer(fx("x_items", '<fetch aggregate="true"><entity name="x_item"><attribute name="x_secret" aggregate="countcolumn" alias="n"/></entity></fetch>'));
  assert.equal(counted.status, 200, counted.body);
});

test("a FetchXML presence count over a masked column is allowed and answers the count itself", async (t) => {
  const f = await setup(t, "masked");
  const counted = await f.answer(fx("x_items", '<fetch aggregate="true"><entity name="x_item"><attribute name="x_secret" aggregate="countcolumn" alias="n"/></entity></fetch>'));
  assert.equal(JSON.parse(counted.body).value[0].n, 2);
});

test("FetchXML distinct over a masked column answers 400 0x80041155", async (t) => {
  const f = await setup(t, "masked");
  for (const inner of ['<attribute name="x_secret"/>', "<all-attributes/>"]) {
    const { status, body } = await f.answer(fx("x_items", `<fetch distinct="true"><entity name="x_item">${inner}</entity></fetch>`));
    assert.equal(status, 400, body);
    assert.equal(JSON.parse(body).error.code, "0x80041155");
  }
  assert.equal((await f.answer(fx("x_items", '<fetch distinct="true"><entity name="x_item"><attribute name="x_name"/></entity></fetch>'))).status, 200);
});

test("the SDK service applies the same rules: masked operands answer 0x80041155, hidden ones cannot tell a guess", async (t) => {
  const service = (f) => {
    const user = f.store.state.tables.systemuser.find((row) => String(row.applicationid ?? "").toLowerCase() === CUST);
    return localOrganizationService(f.store, { userId: user.systemuserid, evidence: "invented FLS test", grants: [{ entity: "x_item", operations: ["read"] }, { entity: "x_child", operations: ["read"] }] });
  };
  const condition = (g) => `<fetch><entity name="x_child"><attribute name="x_name"/><link-entity name="x_item" from="x_itemid" to="x_itemid" alias="p"><filter><condition attribute="x_secret" operator="eq" value="${g}"/></filter></link-entity></entity></fetch>`;
  const masked = service(await setup(t, "masked"));
  const refused = (run) => assert.throws(run, (e) => e.status === 400 && e.details?.innerCode === "0x80041155");
  for (const g of [SECRET, WRONG]) {
    refused(() => masked.fetch(condition(g)));
    refused(() => masked.query("x_item", { $select: "x_name", $filter: `x_secret eq '${g}'` }));
  }
  refused(() => masked.query("x_item", { $select: "x_name", $orderby: "x_secret" }));
  refused(() => masked.fetch('<fetch aggregate="true"><entity name="x_item"><attribute name="x_secret" aggregate="max" alias="m"/></entity></fetch>'));
  refused(() => masked.fetch('<fetch distinct="true"><entity name="x_item"><attribute name="x_secret"/></entity></fetch>'));
  const hidden = service(await setup(t, "hidden"));
  const names = (answer) => JSON.stringify((answer.entities ?? answer.value).map((row) => row.x_name));
  assert.equal(names(hidden.fetch(condition(SECRET))), names(hidden.fetch(condition(WRONG))));
  assert.equal(names(hidden.query("x_item", { $select: "x_name", $filter: `x_secret eq '${SECRET}'` })), names(hidden.query("x_item", { $select: "x_name", $filter: `x_secret eq '${WRONG}'` })));
});

// One FetchXML reader: the column-security rule reads the same decoded document the engine runs, so character references,
// attribute order and whitespace cannot spell a masked column past it. CDATA is not FetchXML the engine accepts; both
// guesses still answer alike.
const SPELLINGS = [
  (g) => `<condition attribute="x&#95;secret" operator="eq" value="${g}"/>`,
  (g) => `<condition attribute="x&#x5F;secret" operator="eq" value="${g}"/>`,
  (g) => `<condition attribute="x_secr&#101;t" operator="eq" value="${g}"/>`,
  (g) => `<condition operator="eq" value="${g}" attribute="x_secret"/>`,
  (g) => `<condition\n  attribute = 'x_secret'\toperator='eq'  value='${g}' />`,
  (g) => `<condition attribute="x_secret" operator="eq"><value><![CDATA[${g}]]></value></condition>`,
  (g) => `<condition attribute="x_secret" operator="in"><value>${g}</value><value>&#65;</value></condition>`,
];
const spelled = (inner) => `<fetch><entity name="x_item"><attribute name="x_name"/><filter>${inner}</filter></entity></fetch>`;
const ENCODED_AGGREGATES = [
  '<fetch aggregate="true"><entity name="x_item"><attribute name="x&#95;secret" aggregate="max" alias="m"/></entity></fetch>',
  '<fetch aggregate="true"><entity name="x_item"><attribute alias="g" groupby="true" name="x&#x5f;secret"/><attribute name="x_name" aggregate="count" alias="n"/></entity></fetch>',
];
const custUser = (f) => f.store.state.tables.systemuser.find((row) => String(row.applicationid ?? "").toLowerCase() === CUST);

test("an entity-encoded or respelled FetchXML operand on a masked column is refused on the Web API, the SDK and List rows", async (t) => {
  const f = await setup(t, "masked");
  const principal = { userId: custUser(f).systemuserid, evidence: "invented FLS test", grants: [{ entity: "x_item", operations: ["read"] }] };
  const sdk = localOrganizationService(f.store, principal);
  const connectors = createConnectorRuntime({ store: f.store });
  const outcome = async (run) => {
    try { return { ok: JSON.stringify(await run()) }; } catch (error) { return { status: error.status, code: error.details?.innerCode ?? error.code }; }
  };
  for (const spell of SPELLINGS) {
    const answers = [];
    for (const g of [SECRET, WRONG]) {
      const xml = spelled(spell(g));
      answers.push([await f.answer(fx("x_items", xml), g), await outcome(() => sdk.fetch(xml)),
        await outcome(() => connectors.invoke({ connectorId: "shared_commondataserviceforapps", operationId: "ListRecords", parameters: { entityName: "x_items", fetchXml: xml }, context: { principal } }))]);
    }
    assert.deepEqual(answers[0], answers[1], spell("?"));
    const [web, viaSdk, viaList] = answers[0];
    assert.notEqual(web.status, 200, `${spell("?")}: ${web.body}`);
    assert.equal(viaSdk.ok, undefined, spell("?"));
    assert.equal(viaList.ok, undefined, spell("?"));
    if (!/CDATA/.test(spell("?"))) assert.deepEqual([JSON.parse(web.body).error.code, viaSdk.code, viaList.code], ["0x80041155", "0x80041155", "0x80041155"], spell("?"));
  }
  for (const xml of [...ENCODED_AGGREGATES, '<fetch distinct="true"><entity name="x_item"><attribute name="x&#95;secret"/></entity></fetch>']) {
    assert.equal(JSON.parse((await f.answer(fx("x_items", xml))).body).error.code, "0x80041155", xml);
    assert.equal((await outcome(() => sdk.fetch(xml))).code, "0x80041155", xml);
  }
});

test("an entity-encoded FetchXML aggregate on a hidden column answers the same 403 as the plain spelling", async (t) => {
  const f = await setup(t, "hidden");
  const sdk = localOrganizationService(f.store, { userId: custUser(f).systemuserid, evidence: "invented FLS test", grants: [{ entity: "x_item", operations: ["read"] }] });
  for (const xml of ENCODED_AGGREGATES) {
    const web = await f.answer(fx("x_items", xml));
    assert.equal(web.status, 403, web.body);
    assert.throws(() => sdk.fetch(xml), (e) => e.status === 403 && e.details?.innerCode === "0x8004f508");
  }
});

test("InitializeFrom and ExportRetainedData answer masked values and refuse a masked FetchXML operand", async (t) => {
  const f = await setup(t, "masked");
  const MAP = "77777777-7777-4777-8777-0000000000c1";
  await f.store.transact(() => {
    (f.store.state.tables.entitymap ??= []).push({ entitymapid: MAP, sourceentityname: "x_item", targetentityname: "x_child" });
    (f.store.state.tables.attributemap ??= []).push({ attributemapid: "77777777-7777-4777-8777-0000000000c2", entitymapid: { id: MAP }, sourceattributename: "x_secret", targetattributename: "x_csecret" });
    f.store.state.dataverse = { ...(f.store.state.dataverse ?? {}), retained: { x_item: [{ x_itemid: ITEM, x_name: "Archived", x_secret: SECRET }] } };
  });
  const moniker = q(JSON.stringify({ "@odata.id": `x_items(${ITEM})` }));
  const initialized = await f.answer(`/InitializeFrom(EntityMoniker=@p0,TargetEntityName=@p1,TargetFieldType=@p2)?@p0=${moniker}&@p1='x_child'&@p2='All'`);
  assert.equal(initialized.status, 200, initialized.body);
  assert.equal(JSON.parse(initialized.body).x_csecret, "*".repeat(SECRET.length));
  const exportOf = async (xml) => {
    const response = await f.request("POST", "/ExportRetainedData", { FetchXml: xml, LayoutXml: "" }, {}, CUST);
    return { status: response.status, body: await response.text() };
  };
  const exported = await exportOf('<fetch><entity name="x_item"><attribute name="x_name"/><attribute name="x_secret"/></entity></fetch>');
  assert.equal(exported.status, 200, exported.body);
  const id = JSON.parse(exported.body).ExportedExcelId;
  const workbook = Buffer.from(f.store.state.tables.retaineddataexcel.find((row) => row.retaineddataexcelid === id).excelcontent, "base64").toString();
  assert.match(workbook, /Archived/);
  assert.doesNotMatch(workbook, /TOP-SECRET/);
  const right = await exportOf(spelled(`<condition attribute="x&#95;secret" operator="eq" value="${SECRET}"/>`));
  const wrong = await exportOf(spelled(`<condition attribute="x&#95;secret" operator="eq" value="${WRONG}"/>`));
  assert.equal(right.status, 400, right.body);
  assert.equal(JSON.parse(right.body).error.code, "0x80041155");
  assert.deepEqual(right, wrong);
});

test("ExecuteCosmosSqlQuery answers masked values and refuses a masked WHERE or ORDER BY operand", async (t) => {
  const elastic = { x_el: { logicalName: "x_el", entitySet: "x_els", idColumn: "x_elid", nameColumn: "x_name", tableType: "Elastic",
    fields: { x_name: { dataverseType: "nvarchar" }, partitionid: { dataverseType: "nvarchar" }, x_secret: { dataverseType: "nvarchar", columnMetadata: { isSecured: true } } } } };
  const f = await readFixture(t, { mappings: elastic, tables: { x_el: [{ x_elid: ITEM, x_name: "A", partitionid: "p", x_secret: SECRET, statecode: 0, statuscode: 1 }] } });
  const PROFILE = "77777777-7777-4777-8777-0000000000a1", RULE = "77777777-7777-4777-8777-0000000000b1";
  await f.store.transact(() => {
    f.store.state.tables.fieldsecurityprofile.push({ fieldsecurityprofileid: PROFILE, name: "Invented profile" });
    f.store.state.tables.systemuserprofiles.push({ systemuserprofileid: "77777777-7777-4777-8777-0000000000a2", systemuserid: { id: custUser(f).systemuserid }, fieldsecurityprofileid: { id: PROFILE } });
    f.store.state.tables.fieldpermission.push({ fieldpermissionid: "77777777-7777-4777-8777-0000000000a3", fieldsecurityprofileid: { id: PROFILE }, entityname: "x_el", attributelogicalname: "x_secret", cancreate: 0, canread: 4, canupdate: 0, canreadunmasked: 0 });
    (f.store.state.tables.maskingrule ??= []).push({ maskingruleid: RULE, name: "x_InventedAll", regularexpression: ".", maskedcharacter: "*" });
    (f.store.state.tables.attributemaskingrule ??= []).push({ attributemaskingruleid: "77777777-7777-4777-8777-0000000000b2", entityname: "x_el", attributelogicalname: "x_secret", maskingruleid: { id: RULE, logical_name: "maskingrule" } });
  });
  const cosmos = async (sql) => {
    const query = new URLSearchParams({ "@p0": `'${sql.replaceAll("'", "''")}'`, "@p1": "'x_el'" });
    const response = await f.request("GET", `/ExecuteCosmosSqlQuery(QueryText=@p0,EntityLogicalName=@p1)?${query}`, undefined, {}, CUST);
    return { status: response.status, body: await response.text() };
  };
  const all = await cosmos("SELECT c.props.x_name, c.props.x_secret FROM c");
  assert.equal(all.status, 200, all.body);
  assert.doesNotMatch(all.body, /TOP-SECRET/);
  assert.match(all.body, /\*{14}/);
  const right = await cosmos(`SELECT c.props.x_name FROM c WHERE c.props.x_secret = '${SECRET}'`);
  const wrong = await cosmos(`SELECT c.props.x_name FROM c WHERE c.props.x_secret = '${WRONG}'`);
  assert.equal(right.status, 400, right.body);
  assert.equal(JSON.parse(right.body).error.code, "0x80041155");
  assert.deepEqual(right, wrong);
  assert.equal((await cosmos("SELECT c.props.x_name FROM c ORDER BY c.props.x_secret DESC")).status, 400);
});
