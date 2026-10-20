// Dataverse search through the Web API and the legacy endpoints: searchquery, searchsuggest, searchautocomplete, searchstatus,
// the /api/search/v1.0 and v2.0 routes, the search-disabled error and the privilege rule. Invented schema and loopback only.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";

const ADMIN_APP = "22222222-2222-2222-2222-222222222222";
const BASIC_APP = "33333333-3333-3333-3333-333333333333";
const NOROLE_APP = "44444444-4444-4444-4444-444444444444";
const SECRET_VAR = "PAQVILO_DATAVERSE_SEARCH_TEST_SECRET";
const DISABLED_CODE = "0x80048d0b";
const DISABLED_MESSAGE = "Dataverse Search feature is disabled for this organization.";

const text = { dataverseType: "nvarchar" };
const int = { dataverseType: "int" };
const lookup = { dataverseType: "lookup" };
const searchable = { dataverseType: "nvarchar", columnMetadata: { isSearchable: true } };
const widgetId = (n) => `a0000000-0000-4000-8000-00000000000${n}`;
const gadgetId = (n) => `b0000000-0000-4000-8000-00000000000${n}`;

// widget: name and description are searchable (Solution IsSearchable). gadget: its Quick Find view searches label.
function fixture() {
  const mappings = {
    widget: {
      logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
      fields: {
        name: searchable, description: searchable, priority: int,
        ownerid: lookup, owninguser: lookup, owningteam: lookup, owningbusinessunit: lookup,
      },
      relationships: {},
    },
    gadget: {
      logicalName: "gadget", entitySet: "gadgets", idColumn: "gadgetid", nameColumn: "name",
      fields: { name: text, label: text, priority: int, ownerid: lookup, owninguser: lookup, owningteam: lookup, owningbusinessunit: lookup },
      relationships: {},
    },
  };
  const tables = {
    widget: [
      { widgetid: widgetId(1), name: "Contoso Pharmaceuticals", description: "Blue widget for medicine", priority: 2 },
      { widgetid: widgetId(2), name: "Contoso Logistics", description: "Red gadget shipping", priority: 1 },
      { widgetid: widgetId(3), name: "Fabrikam Widget", description: "Contoso reseller note", priority: 3 },
      { widgetid: widgetId(4), name: "Northwind Store", description: "Plain item", priority: 0 },
    ],
    gadget: [
      { gadgetid: gadgetId(1), name: "Gizmo", label: "Contoso kit", priority: 2 },
      { gadgetid: gadgetId(2), name: "Gizmo Two", label: "Northwind kit", priority: 5 },
    ],
  };
  return { mappings, tables };
}

// The Quick Find view of gadget: its like-condition on label is the "Find by" column.
// The widget searches its name and description; a Web API entity with no SearchColumns would search the primary name only.
const WIDGET = [{ Name: "widget", SearchColumns: ["name", "description"] }];

const QUICK_FIND = {
  id: "gadget-quickfind", entity: "gadget", name: "Quick Find", queryType: 4,
  fetchXml: '<fetch><entity name="gadget"><attribute name="name" /><filter type="or"><condition attribute="label" operator="like" value="{0}" /></filter></entity></fetch>',
};

const setSearchFlag = (store, value) => {
  const rows = (store.state.tables.organization ??= []);
  if (!rows.length) rows.push({ organizationid: "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f" });
  rows[0].isexternalsearchindexenabled = value;
};

async function start() {
  process.env[SECRET_VAR] = "dataverse-search-test-secret";
  const store = await new DataStore({ state: emptyState() }).init();
  const { mappings, tables } = fixture();
  Object.assign(store.state.mappings, mappings);
  Object.assign(store.state.tables, tables);
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      { appId: ADMIN_APP, displayName: "Admin client", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] },
      { appId: BASIC_APP, displayName: "Basic client", secretEnvironmentVariable: SECRET_VAR, roles: ["Basic User"] },
      { appId: NOROLE_APP, displayName: "No-role client", secretEnvironmentVariable: SECRET_VAR, roles: [] },
    ],
  });
  const api = await startDataverseApi({ store, change: (fn) => fn(), settings, log: () => {}, schema: () => ({ views: [QUICK_FIND] }) });
  const clientFor = async (appId) => {
    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: appId,
        client_secret: process.env[SECRET_VAR],
        scope: `${api.origin}/.default`,
      }),
    });
    const authorization = `Bearer ${(await response.json()).access_token}`;
    // path is a full path (for example /api/data/v9.2/searchquery) or a path below /api/data/v9.2/ when it starts with "$".
    return (path, { method = "POST", body } = {}) =>
      fetch(`${api.origin}${path}`, {
        method,
        headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
  };
  return {
    store,
    origin: api.origin,
    admin: await clientFor(ADMIN_APP),
    basic: await clientFor(BASIC_APP),
    noRole: await clientFor(NOROLE_APP),
    async close() {
      delete process.env[SECRET_VAR];
      await api.close();
    },
  };
}

const WEB = "/api/data/v9.2/";
// The Web API response carries its result as a JSON string in response.
async function webCall(client, action, body) {
  const response = await client(`${WEB}${action}`, { body });
  const json = await response.json();
  return { status: response.status, inner: json.response === undefined ? json : JSON.parse(json.response), json };
}

describe("Dataverse search", () => {
  let dv;
  before(async () => {
    dv = await start();
  });
  after(async () => {
    await dv?.close();
  });

  it("answers any and all modes over the indexed columns", async () => {
    const any = await webCall(dv.admin, "searchquery", { search: "contoso widget", entities: JSON.stringify(WIDGET) });
    assert.equal(any.status, 200);
    assert.equal(any.inner.Count, -1);
    assert.deepEqual(any.inner.Value.map((hit) => hit.Id).sort(), [widgetId(1), widgetId(2), widgetId(3)].sort());
    // Two matched terms outrank one: Logistics (contoso only) comes last.
    assert.equal(any.inner.Value.at(-1).Id, widgetId(2));
    assert.equal(any.inner.Value[0].EntityName, "widget");
    assert.equal(any.inner.Value[0].ObjectTypeCode, 0);
    assert.equal(any.inner.Error, null);
    assert.equal(any.inner.QueryContext, null);

    const all = await webCall(dv.admin, "searchquery", { search: "contoso widget", entities: JSON.stringify(WIDGET), options: "{'searchmode': 'all'}" });
    assert.deepEqual(all.inner.Value.map((hit) => hit.Id).sort(), [widgetId(1), widgetId(3)].sort());
  });

  it("matches a trailing wildcard and scopes the search to SearchColumns", async () => {
    const wildcard = await webCall(dv.admin, "searchquery", { search: "north*", entities: JSON.stringify(WIDGET) });
    assert.deepEqual(wildcard.inner.Value.map((hit) => hit.Id), [widgetId(4)]);
    // Only the name is searched: the description match "widget" on widget 1 is not a hit.
    const named = await webCall(dv.admin, "searchquery", { search: "widget", entities: JSON.stringify([{ Name: "widget", SearchColumns: ["name"] }]) });
    assert.deepEqual(named.inner.Value.map((hit) => hit.Id), [widgetId(3)]);
  });

  it("limits the search to the entities list and includes a Quick Find table", async () => {
    // An entity without SearchColumns is searched on its primary name only, so the label search needs its column named.
    const primaryOnly = await webCall(dv.admin, "searchquery", { search: "contoso", entities: JSON.stringify([{ Name: "gadget" }]) });
    assert.equal(primaryOnly.inner.Value.length, 0);
    const onlyGadgets = await webCall(dv.admin, "searchquery", { search: "contoso", entities: JSON.stringify([{ Name: "gadget", SearchColumns: ["label"] }]) });
    assert.deepEqual(onlyGadgets.inner.Value.map((hit) => [hit.EntityName, hit.Id]), [["gadget", gadgetId(1)]]);
    // Without entities every indexed table is searched: three widgets and the gadget whose label names Contoso.
    const everything = await webCall(dv.admin, "searchquery", { search: "contoso", count: true });
    assert.equal(everything.inner.Count, 4);
  });

  it("applies the top-level $filter to every searched table", async () => {
    const filtered = await webCall(dv.admin, "searchquery", { search: "contoso", filter: "priority ge 2", entities: JSON.stringify(WIDGET) });
    assert.deepEqual(filtered.inner.Value.map((hit) => hit.Id).sort(), [widgetId(1), widgetId(3)].sort());
  });

  it("pages with skip and top, counts all matches, and orders by the orderby clauses", async () => {
    const page = await webCall(dv.admin, "searchquery", {
      search: "contoso", entities: JSON.stringify(WIDGET), orderby: JSON.stringify(["priority desc"]), top: 1, skip: 1, count: true,
    });
    assert.equal(page.inner.Count, 3);
    assert.equal(page.inner.Value.length, 1);
    // priority desc: widget 3 (3), widget 1 (2), widget 2 (1); skip 1 leaves widget 1.
    assert.equal(page.inner.Value[0].Id, widgetId(1));
  });

  it("returns value facets over every match and highlights the matched words", async () => {
    const result = await webCall(dv.admin, "searchquery", { search: "contoso", facets: JSON.stringify(["entityname,count:10"]) });
    assert.deepEqual(result.inner.Facets.entityname.map((entry) => [entry.value, entry.count]), [["widget", 3], ["gadget", 1]]);
    const byPriority = await webCall(dv.admin, "searchquery", { search: "contoso", entities: JSON.stringify(WIDGET), facets: JSON.stringify(["priority,count:10"]) });
    assert.deepEqual(byPriority.inner.Facets.priority.map((entry) => [entry.value, entry.count]), [[1, 1], [2, 1], [3, 1]]);
    const pharma = result.inner.Value.find((hit) => hit.Id === widgetId(1));
    assert.deepEqual(pharma.Highlights.name, ["{crmhit}Contoso{/crmhit} Pharmaceuticals"]);
    assert.equal(pharma.Attributes.name, "Contoso Pharmaceuticals");
  });

  it("answers suggest from the primary name with a three-character minimum", async () => {
    const suggestions = await webCall(dv.admin, "searchsuggest", { search: "Cont", entities: JSON.stringify(WIDGET) });
    assert.equal(suggestions.inner.Value.length, 2);
    assert.equal(suggestions.inner.Value[0].Text, "{crmhit}Contoso{/crmhit} Pharmaceuticals");
    assert.equal(suggestions.inner.Value[0].Document.name, "Contoso Pharmaceuticals");
    const top = await webCall(dv.admin, "searchsuggest", { search: "Cont", top: 1, entities: JSON.stringify(WIDGET) });
    assert.equal(top.inner.Value.length, 1);
    const short = await webCall(dv.admin, "searchsuggest", { search: "Co" });
    assert.equal(short.status, 400);
  });

  it("completes the last typed word with the most frequent indexed match", async () => {
    const completed = await webCall(dv.admin, "searchautocomplete", { search: "Con", entities: JSON.stringify(WIDGET) });
    assert.equal(completed.inner.Value, "{crmhit}contoso{/crmhit}");
    assert.equal(completed.inner.Error, null);
  });

  it("refuses a search over 100 characters and an unindexed entity with the documented messages", async () => {
    const long = await webCall(dv.admin, "searchquery", { search: "x".repeat(101) });
    assert.equal(long.status, 400);
    assert.deepEqual(long.json.error, { code: "0x800401ff", message: "Search Text Length Exceeded." });
    const unknown = await webCall(dv.admin, "searchquery", { search: "contoso", entities: JSON.stringify([{ name: "contoso_nothing" }]) });
    assert.equal(unknown.status, 400);
    assert.deepEqual(unknown.json.error, { code: "0x80060201", message: "Invalid Search Entity - contoso_nothing." });
  });

  it("gives a caller without read privilege no rows, not an error", async () => {
    const none = await webCall(dv.noRole, "searchquery", { search: "contoso", count: true });
    assert.equal(none.status, 200);
    assert.deepEqual(none.inner.Value, []);
    assert.equal(none.inner.Count, 0);
    const basic = await webCall(dv.basic, "searchquery", { search: "contoso", count: true });
    assert.equal(basic.status, 200);
    assert.equal(basic.inner.Count, 0);
  });

  it("answers the legacy v1.0 query, suggest and autocomplete shapes", async () => {
    const query = await dv.admin(`/api/search/v1.0/query`, {
      body: { search: "contoso", entities: ["widget"], top: 2, returntotalrecordcount: true, filter: "widget:priority ge 2" },
    });
    const body = await query.json();
    assert.equal(query.status, 200);
    assert.equal(body.totalrecordcount, 2);
    assert.equal(body.value.length, 2);
    assert.equal(body.value[0]["@search.entityname"], "widget");
    // Equal scores keep the store order: widget 1 (name) then widget 3 (description).
    assert.equal(body.value[0]["@search.objectid"], widgetId(1));
    assert.deepEqual(body.value[0]["@search.highlights"], { name: ["{crmhit}Contoso{/crmhit} Pharmaceuticals"] });
    assert.deepEqual(body.value[1]["@search.highlights"], { description: ["{crmhit}Contoso{/crmhit} reseller note"] });

    const suggest = await (await dv.admin(`/api/search/v1.0/suggest`, { body: { search: "Cont", entities: ["widget"] } })).json();
    assert.equal(suggest.value.length, 2);
    assert.equal(suggest.value[0].text, "{crmhit}Contoso{/crmhit} Pharmaceuticals");

    const autocomplete = await (await dv.admin(`/api/search/v1.0/autocomplete`, { body: { search: "Con" } })).json();
    assert.equal(autocomplete.value, "{crmhit}contoso{/crmhit}");
  });

  it("answers the v2.0 endpoints with the Web API bodies", async () => {
    const response = await dv.admin(`/api/search/v2.0/query`, { body: { search: "contoso", count: true, entities: JSON.stringify(WIDGET) } });
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.match(json["@odata.context"], /searchqueryResponse$/);
    assert.equal(JSON.parse(json.response).Count, 3);
  });

  it("answers the search status: provisioned while on, not provisioned when off", async () => {
    const on = await (await dv.admin(`${WEB}searchstatus`, { method: "GET" })).json();
    const status = JSON.parse(on.response).value;
    assert.equal(status.status, "provisioned");
    assert.ok(status.entitystatusresults.some((entry) => entry.entitylogicalname === "widget"));
    assert.equal(status.entitystatusresults.find((entry) => entry.entitylogicalname === "gadget").searchableindexedfieldinfomap.label.indexfieldname, "label");
  });

  it("GetSearchInformation reports relevance support for indexed tables", async () => {
    const info = async (xml) => {
      const response = await dv.admin(`${WEB}GetSearchInformation(Fetchxml=@fx)?@fx=${encodeURIComponent(xml)}`, { method: "GET" });
      return { status: response.status, json: await response.json() };
    };
    const indexed = await info('<fetch><entity name="widget"><attribute name="name" /></entity></fetch>');
    assert.equal(indexed.status, 200);
    assert.match(indexed.json["@odata.context"], /GetSearchInformationResponse$/);
    assert.deepEqual(
      { wildcard: indexed.json.CanAllowLeadingWildCardSearch, relevance: indexed.json.CanSupportedByRelevanceSearch },
      { wildcard: "false", relevance: "true" },
    );
    // An entity that is not an indexed table (no column is searchable and it is not a default table) is not relevance-searched.
    const plain = await info('<fetch><entity name="contoso_nothing" /></fetch>');
    assert.equal(plain.json.CanSupportedByRelevanceSearch, "false");
    const linked = await info('<fetch><entity name="widget"><link-entity name="contoso_nothing" from="a" to="b" /></entity></fetch>');
    assert.equal(linked.json.CanSupportedByRelevanceSearch, "false");
  });

  it("GetSearchInformation refuses malformed FetchXML", async () => {
    const response = await dv.admin(`${WEB}GetSearchInformation(Fetchxml=@fx)?@fx=${encodeURIComponent('<fetch><entity name="widget">')}`, { method: "GET" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "0x80040203");
  });

  it("refuses the query, suggest and autocomplete with the disabled error when search is off", async () => {
    setSearchFlag(dv.store, false);
    try {
      for (const action of ["searchquery", "searchsuggest", "searchautocomplete"]) {
        const response = await dv.admin(`${WEB}${action}`, { body: { search: "contoso" } });
        const json = await response.json();
        assert.equal(response.status, 400, action);
        assert.deepEqual(json.error, { code: DISABLED_CODE, message: DISABLED_MESSAGE }, action);
      }
      const legacy = await dv.admin(`/api/search/v1.0/query`, { body: { search: "contoso" } });
      assert.equal(legacy.status, 400);
      assert.equal((await legacy.json()).error.code, DISABLED_CODE);
      const status = JSON.parse((await (await dv.admin(`${WEB}searchstatus`, { method: "GET" })).json()).response).value;
      assert.deepEqual(status, { status: "notprovisioned", lockboxstatus: "Unknown" });
    } finally {
      setSearchFlag(dv.store, true);
    }
  });
});
