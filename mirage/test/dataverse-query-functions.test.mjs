// Dataverse identity query functions (Microsoft.Dynamics.CRM.*) and the portal parity
// of the shared condition operators. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { CRM_FUNCTIONS, compileOperator } from "../lib/dataverse-conditions.mjs";
import { compileODataPredicate, parseODataExpression } from "../lib/odata-query.mjs";
import { DataStore, emptyState } from "../lib/data.mjs";

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.parse("2026-10-19T12:00:00Z");
const mapping = { logicalName: "invented_item" };

const calls = [];
const dataverse = {
  userId: ID(1),
  businessUnitId: ID(10),
  teamIds: [ID(20)],
  hierarchy(table, column, recordId, mode) {
    calls.push({ table, column, recordId, mode });
    if (recordId === ID(99)) return null;
    if (mode === "above") return new Set([ID(4)]);
    if (mode === "eq-or-above") return new Set([ID(4), ID(5)]);
    if (mode === "under") return new Set([ID(6)]);
    return new Set([ID(5), ID(6)]);
  },
  userHierarchy: (userId) => (userId === ID(1) ? new Set([ID(2)]) : new Set()),
};

const identityOf = (dv) => (dv ? { dataverse: dv, systemUserId: ID(1) } : {});

function predicateFor(expression, { identity = identityOf(dataverse), options } = {}) {
  const ast = parseODataExpression(expression, options);
  return compileODataPredicate(ast, mapping, {
    dialect: "dataverse",
    identity,
    navigate: () => null,
    definition: () => undefined,
    settings: {},
    now: NOW,
  });
}

const row = (fields) => ({ accountid: ID(5), ownerid: ID(1), owningbusinessunit: ID(10), ...fields });

test("query functions that need the Dataverse identity are inert for portal identities", () => {
  const expression = "Microsoft.Dynamics.CRM.EqualBusinessId(PropertyName='owningbusinessunit')";
  assert.throws(
    () => predicateFor(expression, { identity: {} })(row({})),
    (error) =>
      error.code === "UnsupportedQuery" &&
      error.message === "FetchXML operator eq-businessid is not supported locally: the portal application user's business unit is not modelled.",
  );
  assert.throws(
    () => predicateFor("Microsoft.Dynamics.CRM.Under(PropertyName='accountid',PropertyValue='" + ID(5) + "')", {
      identity: {},
    })(row({})),
    (error) =>
      error.code === "UnsupportedQuery" &&
      error.message === "FetchXML operator under is not supported locally: hierarchy operators need hierarchical relationship metadata.",
  );
  assert.throws(() => compileOperator("eq-userteams", { identity: {} }), /team membership of the portal application user is not modelled/);
});

test("business unit and team functions compare the caller's identity", () => {
  assert.equal(predicateFor("Microsoft.Dynamics.CRM.EqualBusinessId(PropertyName='owningbusinessunit')")(row({})), true);
  assert.equal(predicateFor("Microsoft.Dynamics.CRM.EqualBusinessId(PropertyName='owningbusinessunit')")(row({ owningbusinessunit: ID(11) })), false);
  assert.equal(predicateFor("Microsoft.Dynamics.CRM.NotEqualBusinessId(PropertyName='owningbusinessunit')")(row({ owningbusinessunit: ID(11) })), true);
  assert.equal(predicateFor("Microsoft.Dynamics.CRM.EqualUserTeams(PropertyName='ownerid')")(row({ ownerid: ID(20) })), true);
  assert.equal(predicateFor("Microsoft.Dynamics.CRM.EqualUserTeams(PropertyName='ownerid')")(row({})), false);
  assert.equal(predicateFor("Microsoft.Dynamics.CRM.EqualUserOrUserTeams(PropertyName='ownerid')")(row({})), true);
  assert.equal(predicateFor("Microsoft.Dynamics.CRM.EqualUserOrUserTeams(PropertyName='ownerid')")(row({ ownerid: ID(20) })), true);
  assert.equal(predicateFor("Microsoft.Dynamics.CRM.EqualUserOrUserTeams(PropertyName='ownerid')")(row({ ownerid: ID(9) })), false);
  assert.equal(predicateFor("Microsoft.Dynamics.CRM.EqualUserOrUserTeams(PropertyName='ownerid')")(row({ ownerid: null })), false);
});

test("user hierarchy functions add the caller's reporting users and teams", () => {
  const hierarchy = predicateFor("Microsoft.Dynamics.CRM.EqualUserOrUserHierarchy(PropertyName='ownerid')");
  assert.equal(hierarchy(row({ ownerid: ID(2) })), true);
  assert.equal(hierarchy(row({ ownerid: ID(20) })), false);
  const withTeams = predicateFor("Microsoft.Dynamics.CRM.EqualUserOrUserHierarchyAndTeams(PropertyName='ownerid')");
  assert.equal(withTeams(row({ ownerid: ID(20) })), true);
  assert.equal(withTeams(row({ ownerid: ID(2) })), true);
  assert.equal(withTeams(row({ ownerid: ID(9) })), false);
});

test("EqualUserAuthContext matches nothing on the Dataverse path and is unsupported on the portal path", () => {
  const expression = "Microsoft.Dynamics.CRM.EqualUserAuthContext(PropertyName='name')";
  assert.equal(predicateFor(expression)(row({ name: "anything" })), false);
  assert.equal(predicateFor(expression)(row({ name: null })), false);
  assert.throws(
    () => predicateFor(expression, { identity: {} })(row({ name: "anything" })),
    (error) =>
      error.code === "UnsupportedQuery" &&
      error.message === "FetchXML operator eq-userauthcontext is not supported locally: the portal application user's authentication contexts are not modelled.",
  );
});

test("hierarchy functions pass the table, column, record and mode to the router lookup", () => {
  calls.length = 0;
  const cases = [
    ["Above", "above", [ID(4)], ID(5)],
    ["AboveOrEqual", "eq-or-above", [ID(4), ID(5)], ID(5)],
    ["Under", "under", [ID(6)], ID(5)],
    ["UnderOrEqual", "eq-or-under", [ID(5), ID(6)], ID(5)],
  ];
  for (const [name, mode, members] of cases) {
    const predicate = predicateFor(`Microsoft.Dynamics.CRM.${name}(PropertyName='accountid',PropertyValue='${ID(5)}')`);
    for (const id of members) assert.equal(predicate(row({ accountid: id })), true, `${name} keeps ${id}`);
    assert.equal(predicate(row({ accountid: ID(77) })), false, `${name} rejects others`);
    assert.deepEqual(calls.at(-1), { table: "invented_item", column: "accountid", recordId: ID(5), mode });
  }
});

test("NotUnder keeps every record outside the under set, including the referenced record", () => {
  const predicate = predicateFor(`Microsoft.Dynamics.CRM.NotUnder(PropertyName='accountid',PropertyValue='${ID(5)}')`);
  assert.equal(predicate(row({ accountid: ID(6) })), false);
  assert.equal(predicate(row({ accountid: ID(5) })), true);
  assert.equal(predicate(row({ accountid: ID(77) })), true);
});

test("a table without a hierarchical relationship answers with the documented inner error", () => {
  assert.throws(
    () => predicateFor(`Microsoft.Dynamics.CRM.Above(PropertyName='accountid',PropertyValue='${ID(99)}')`)(row({})),
    (error) =>
      error.code === "InvalidQuery" &&
      error.status === 400 &&
      error.details?.innerCode === "0x80040203" &&
      error.message === "The entity does not have a hierarchical relationship.",
  );
});

test("every Web API query function compiles with the Dataverse identity", () => {
  const identityOperators = new Set([
    "above", "eq-or-above", "under", "eq-or-under", "not-under",
    "eq-useroruserhierarchy", "eq-useroruserhierarchyandteams",
    "eq-useroruserteams", "eq-userteams", "eq-businessid", "ne-businessid",
  ]);
  for (const [name, spec] of Object.entries(CRM_FUNCTIONS)) {
    if (!spec.operator) continue;
    const values =
      spec.values === "list" ? ["1", "2"]
        : spec.values === "pair" ? ["3", "2026"]
          : spec.values === "one" ? (identityOperators.has(spec.operator) ? [ID(5)] : spec.operator.startsWith("on") ? ["2026-10-01"] : ["3"])
            : [];
    assert.doesNotThrow(
      () => compileOperator(spec.operator, { values, identity: identityOf(dataverse), settings: {}, now: NOW }),
      name,
    );
  }
});

function fetchStore() {
  const state = emptyState();
  state.settings.permissionMode = "permissive";
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    fields: { name: { dataverseType: "nvarchar" }, owningbusinessunit: { dataverseType: "lookup" }, ownerid: { dataverseType: "lookup" } },
  };
  state.tables.widget = [
    { widgetid: ID(101), name: "own", owningbusinessunit: ID(10), ownerid: ID(1) },
    { widgetid: ID(102), name: "other", owningbusinessunit: ID(11), ownerid: ID(9) },
    { widgetid: ID(103), name: "team", owningbusinessunit: ID(11), ownerid: ID(20) },
    { widgetid: ID(6), name: "child", owningbusinessunit: ID(11), ownerid: ID(9) },
  ];
  return new DataStore({ state });
}
const fetchNames = (store, filter, identity) =>
  store.fetchXml(
    `<fetch><entity name="widget"><attribute name="name"/><filter>${filter}</filter></entity></fetch>`,
    identity,
  ).entities.map((entity) => entity.name).sort();

test("FetchXML identity operators without identity.dataverse keep the portal errors", () => {
  const store = fetchStore();
  const portal = { systemUserId: ID(1) };
  assert.throws(
    () => fetchNames(store, '<condition attribute="owningbusinessunit" operator="eq-businessid"/>', portal),
    (error) =>
      error.code === "UnsupportedQuery" &&
      error.status === 400 &&
      error.message === "FetchXML operator eq-businessid is not supported locally: the portal application user's business unit is not modelled.",
  );
  assert.throws(
    () => fetchNames(store, `<condition attribute="widgetid" operator="under" value="${ID(5)}"/>`, portal),
    (error) =>
      error.code === "UnsupportedQuery" &&
      error.status === 400 &&
      error.message === "FetchXML operator under is not supported locally: hierarchy operators need hierarchical relationship metadata.",
  );
});

test("FetchXML identity operators evaluate for a Dataverse caller", () => {
  const store = fetchStore();
  const caller = { systemUserId: ID(1), dataverse };
  assert.deepEqual(fetchNames(store, '<condition attribute="owningbusinessunit" operator="eq-businessid"/>', caller), ["own"]);
  assert.deepEqual(fetchNames(store, '<condition attribute="ownerid" operator="eq-userteams"/>', caller), ["team"]);
  calls.length = 0;
  assert.deepEqual(fetchNames(store, `<condition attribute="widgetid" operator="under" value="${ID(5)}"/>`, caller), ["child"]);
  assert.deepEqual(calls.at(-1), { table: "widget", column: "widgetid", recordId: ID(5), mode: "under" });
});

test("the not operator cannot negate a query function when the Dataverse records layer opts in", () => {
  const source = "not Microsoft.Dynamics.CRM.Today(PropertyName='createdon')";
  assert.doesNotThrow(() => parseODataExpression(source));
  assert.throws(
    () => parseODataExpression(source, { rejectNotOnQueryFunctions: true }),
    (error) =>
      error.code === "InvalidQuery" &&
      error.details?.innerCode === "0x80060888" &&
      error.message === "Not operator along with the Custom Named Condition operators is not allowed",
  );
  assert.doesNotThrow(() =>
    parseODataExpression("not (accountid eq '1')", { rejectNotOnQueryFunctions: true }),
  );
});
