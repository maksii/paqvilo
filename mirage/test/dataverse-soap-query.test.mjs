// QueryExpression, QueryByAttribute and BulkDelete QuerySet to FetchXML. Invented
// schema and GUIDs only; the output is run through DataStore.fetchXml as well.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { DataError } from "../lib/data-error.mjs";
import { fromBulkDeleteJson, fromQueryByAttribute, toFetchXml } from "../lib/dataverse-soap-query.mjs";

const text = { dataverseType: "nvarchar" };

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    fields: { name: text, code: text, price: { dataverseType: "money" }, status: { dataverseType: "int" } },
  };
  state.mappings.gadget = {
    logicalName: "gadget", entitySet: "gadgets", idColumn: "gadgetid", nameColumn: "name",
    fields: { name: text, widgetid: { dataverseType: "lookup" } },
  };
  state.tables.widget = [
    { widgetid: "w-1", name: "Redmond", code: "R-1", price: 10, status: 1 },
    { widgetid: "w-2", name: "Seattle", code: "S-1", price: 3, status: 2 },
    { widgetid: "w-3", name: "Old Bellevue", code: "B-1", price: 7, status: 1 },
    { widgetid: "w-4", name: "Redmond East", code: "R-2", price: 20, status: null },
  ];
  state.tables.gadget = [
    { gadgetid: "g-1", name: "G-red", widgetid: "w-1" },
    { gadgetid: "g-2", name: "G-seattle", widgetid: "w-2" },
  ];
  return state;
}

const condition = (operator, values = [], attributeName = "name") => ({ attributeName, operator, values });
const where = (...conditions) => ({ entityName: "widget", criteria: { filterOperator: "And", conditions } });
const conditionXml = (operator, values = [], attributeName = "name") => toFetchXml(where(condition(operator, values, attributeName)));

test("numeric ConditionOperator values resolve to the documented FetchXML operators", () => {
  const expected = [[0, "eq"], [8, "in"], [25, "on"], [33, "last-x-days"], [41, "eq-userid"], [49, "like"], [75, "under"], [87, "contain-values"]];
  for (const [value, op] of expected) assert.match(conditionXml(value, ["x"]), new RegExp(`operator="${op}"`));
  assert.match(conditionXml("EqualUserId"), /operator="eq-userid"\/>/);
  assert.match(conditionXml("LastXDays", ["3"]), /operator="last-x-days" value="3"\/>/);
});

test("operators without a FetchXML equivalent fail with the invalid-operator inner code", () => {
  for (const operator of [45, 46, 47, 48, 52, 89, "Bogus"]) {
    assert.throws(() => conditionXml(operator, ["x"]), (error) => {
      assert.ok(error instanceof DataError);
      assert.equal(error.status, 400);
      assert.equal(error.details.innerCode, "0x80040203");
      return true;
    });
  }
});

test("single values use the value attribute, lists and pairs use value elements, no-value operators have none", () => {
  assert.equal(conditionXml("Equal", ["Redmond"]), '<fetch><entity name="widget"><filter type="and"><condition attribute="name" operator="eq" value="Redmond"/></filter></entity></fetch>');
  assert.match(conditionXml("In", ["a", "b"]), /<condition attribute="name" operator="in"><value>a<\/value><value>b<\/value><\/condition>/);
  assert.match(conditionXml("Between", [6, 20]), /operator="between"><value>6<\/value><value>20<\/value>/);
  assert.match(conditionXml("Null"), /<condition attribute="name" operator="null"\/>/);
  assert.match(conditionXml("Today"), /<condition attribute="name" operator="today"\/>/);
  assert.match(conditionXml("EqualUserId", [], "ownerid"), /<condition attribute="ownerid" operator="eq-userid"\/>/);
  assert.match(toFetchXml(where({ attributeName: "price", operator: "GreaterThan", compareColumns: true, values: ["status"] })), /<condition attribute="price" operator="gt" valueof="status"\/>/);
});

test("text operators keep their wildcards and Contains wraps and escapes the value", () => {
  assert.match(conditionXml("BeginsWith", ["Old"]), /operator="begins-with" value="Old"/);
  assert.match(conditionXml("DoesNotEndWith", ["ing"]), /operator="not-end-with" value="ing"/);
  assert.match(conditionXml("Like", ["R%"]), /operator="like" value="R%"/);
  assert.match(conditionXml("Contains", ["a%_[b"]), /operator="like" value="%a\[%\]\[_\]\[\[\]b%"/);
  assert.match(conditionXml("DoesNotContain", ["x"]), /operator="not-like" value="%x%"/);
});

test("nested filters keep their And/Or types and order", () => {
  const xml = toFetchXml({
    entityName: "widget",
    criteria: {
      filterOperator: "And",
      conditions: [condition("Equal", ["Redmond"])],
      filters: [{ filterOperator: 1, conditions: [condition("GreaterThan", [5], "price"), condition("Null", [], "status")], filters: [] }],
    },
  });
  assert.equal(xml, '<fetch><entity name="widget"><filter type="and"><condition attribute="name" operator="eq" value="Redmond"/><filter type="or"><condition attribute="price" operator="gt" value="5"/><condition attribute="status" operator="null"/></filter></filter></entity></fetch>');
});

test("link entities map names, aliases, nested link criteria and every JoinOperator", () => {
  const xml = toFetchXml({
    entityName: "widget",
    columnSet: { allColumns: false, columns: ["name"] },
    linkEntities: [{
      linkFromEntityName: "widget", linkFromAttributeName: "widgetid", linkToEntityName: "gadget", linkToAttributeName: "widgetid",
      joinOperator: "LeftOuter", entityAlias: "g", columns: { allColumns: false, columns: ["name"] },
      linkCriteria: { filterOperator: "And", conditions: [{ entityName: "g", attributeName: "name", operator: "Like", values: ["G%"] }], filters: [] },
      linkEntities: [],
    }],
  });
  assert.equal(xml, '<fetch><entity name="widget"><attribute name="name"/><link-entity name="gadget" from="widgetid" to="widgetid" link-type="outer" alias="g"><attribute name="name"/><filter type="and"><condition entityname="g" attribute="name" operator="like" value="G%"/></filter></link-entity></entity></fetch>');

  const linkType = (joinOperator) => toFetchXml({ entityName: "widget", linkEntities: [{ linkToEntityName: "gadget", linkToAttributeName: "widgetid", linkFromAttributeName: "widgetid", joinOperator }] });
  const expected = [["Inner", "inner"], ["Any", "any"], ["NotAny", "not any"], ["All", "all"], ["NotAll", "not all"], ["Exists", "exists"], ["In", "in"], ["MatchFirstRowUsingCrossApply", "matchfirstrowusingcrossapply"]];
  for (const [name, linkTypeValue] of expected) assert.match(linkType(name), new RegExp(`link-type="${linkTypeValue}"`));
  assert.match(linkType(6), /link-type="any"/);
  assert.match(linkType(undefined), /link-type="inner"/);
  assert.throws(() => linkType("Sideways"), (error) => error.details.innerCode === "0x80040203");
});

test("paging, top, distinct, no-lock and order attributes escape the paging cookie", () => {
  const cookie = '<cookie page="3"><name last="a&b"/></cookie>';
  assert.equal(
    toFetchXml({ entityName: "widget", distinct: true, noLock: true, orders: [{ attributeName: "name", orderType: "Descending" }], pageInfo: { count: 2, pageNumber: 3, pagingCookie: cookie, returnTotalRecordCount: true } }),
    '<fetch distinct="true" no-lock="true" page="3" count="2" paging-cookie="&lt;cookie page=&quot;3&quot;&gt;&lt;name last=&quot;a&amp;b&quot;/&gt;&lt;/cookie&gt;" returntotalrecordcount="true"><entity name="widget"><order attribute="name" descending="true"/></entity></fetch>',
  );
  assert.equal(toFetchXml({ entityName: "widget", topCount: 5, columnSet: { allColumns: true } }), '<fetch top="5"><entity name="widget"><all-attributes/></entity></fetch>');
});

test("QueryByAttribute becomes Equal conditions joined with And", () => {
  const model = fromQueryByAttribute({ entityName: "widget", attributes: ["name", "status"], values: ["Redmond", 2], columnSet: { allColumns: true } });
  assert.equal(toFetchXml(model), '<fetch><entity name="widget"><all-attributes/><filter type="and"><condition attribute="name" operator="eq" value="Redmond"/><condition attribute="status" operator="eq" value="2"/></filter></entity></fetch>');
  assert.throws(() => fromQueryByAttribute({ entityName: "widget", attributes: ["name"], values: [] }), (error) => error.status === 400);
});

test("BulkDelete JSON QuerySet maps conditions, values and nested filters", () => {
  const model = fromBulkDeleteJson({
    EntityName: "widget",
    Criteria: {
      FilterOperator: "And",
      Conditions: [{ AttributeName: "status", Operator: "Equal", Values: [{ Type: "System.Int32", Value: 2 }] }],
      Filters: [{ FilterOperator: "Or", Conditions: [{ AttributeName: "name", Operator: "BeginsWith", Values: [{ Type: "System.String", Value: "Old" }] }], Filters: [] }],
    },
  });
  assert.equal(toFetchXml(model), '<fetch><entity name="widget"><filter type="and"><condition attribute="status" operator="eq" value="2"/><filter type="or"><condition attribute="name" operator="begins-with" value="Old"/></filter></filter></entity></fetch>');
});

test("generated FetchXML runs through DataStore.fetchXml", async () => {
  const store = await new DataStore({ state: fixtureState() }).init();
  const admin = { admin: true };
  const names = (result) => result.entities.map((row) => row.name).sort();

  const filtered = fromBulkDeleteJson({
    EntityName: "widget",
    Criteria: { FilterOperator: "And", Conditions: [{ AttributeName: "status", Operator: "Equal", Values: [{ Value: 1 }] }], Filters: [] },
  });
  assert.deepEqual(names(store.fetchXml(toFetchXml(filtered), admin)), ["Old Bellevue", "Redmond"]);

  const contains = where(condition("Contains", ["Redmond"]));
  assert.deepEqual(names(store.fetchXml(toFetchXml(contains), admin)), ["Redmond", "Redmond East"]);

  const linked = toFetchXml({
    entityName: "widget",
    columnSet: { allColumns: false, columns: ["name"] },
    linkEntities: [{ linkToEntityName: "gadget", linkToAttributeName: "widgetid", linkFromAttributeName: "widgetid", joinOperator: "Inner", entityAlias: "g", columns: { allColumns: false, columns: ["name"] } }],
  });
  const joined = store.fetchXml(linked, admin);
  assert.equal(joined.entities.length, 2);

  const page = store.fetchXml(toFetchXml({ entityName: "widget", columnSet: { allColumns: true }, orders: [{ attributeName: "name", orderType: "Ascending" }], pageInfo: { count: 2, pageNumber: 1, returnTotalRecordCount: true } }), admin);
  assert.equal(page.entities.length, 2);
  assert.equal(page.total_record_count, 4);
  assert.equal(page.more_records, true);
});
