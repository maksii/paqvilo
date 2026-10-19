// $expand rules and expanded-collection links for the simulated Dataverse Web API. Invented schema only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataError } from "../lib/data-error.mjs";
import { parseExpand } from "../lib/odata-query.mjs";
import { decodeSkipToken } from "../lib/dataverse-odata.mjs";
import { assertExpand, assertExpandText, childLinks } from "../lib/dataverse-expand.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const ID = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const PAGING = "Only $select and $filter clause can be provided while doing $expand on many-to-one relationship or nested one-to-many relationship.";

// Invented schema: widget has gadgets (one-to-many), tags (N:N) and a lookup to gadget.
const gadget = { logicalName: "gadget", entitySet: "gadgets", relationships: {} };
const tag = { logicalName: "tag", entitySet: "tags", relationships: {} };
const widget = {
  logicalName: "widget",
  entitySet: "widgets",
  relationships: {
    widget_gadgets: { many: true, target: gadget },
    widget_tags: { many: true, intersect: { entity: "widget_tag" }, target: tag },
    primarygadgetid: { many: false, target: gadget },
  },
};
gadget.relationships.owninguser = { many: false, target: tag };

const resolve = (mapping, navigation) => mapping.relationships?.[navigation] ?? null;

function expectError(fn, message, innerCode = "0x80060888") {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DataError);
    assert.equal(error.status, 400);
    assert.equal(error.details?.innerCode, innerCode);
    assert.equal(error.message, message);
    return true;
  });
}

test("documented single-level and nested expands with $select and $filter pass", () => {
  const items = parseExpand("widget_gadgets($select=name;$filter=name eq 'a';$orderby=name desc),primarygadgetid($select=name)");
  assert.doesNotThrow(() => assertExpand(items, widget, resolve));
  const nested = parseExpand("widget_gadgets($select=name;$filter=name eq 'a';$expand=owninguser($select=name))");
  assert.doesNotThrow(() => assertExpand(nested, widget, resolve));
});

test("more than 15 expand options is rejected and 15 is accepted, nested options included", () => {
  const flat = Array.from({ length: 15 }, () => "primarygadgetid").join(",");
  const lookups = { primarygadgetid: { many: false, target: gadget } };
  const lookupMapping = { logicalName: "w", relationships: lookups };
  assert.doesNotThrow(() => assertExpand(parseExpand(flat), lookupMapping, resolve));
  const sixteen = Array.from({ length: 16 }, () => "primarygadgetid").join(",");
  expectError(() => assertExpand(parseExpand(sixteen), lookupMapping, resolve), "The number of $expand options exceeded the limit of 15."); // unverified: text
  const nestedCount = Array.from({ length: 8 }, () => "primarygadgetid($expand=primarygadgetid)").join(",");
  expectError(() => assertExpand(parseExpand(nestedCount), lookupMapping, resolve), "The number of $expand options exceeded the limit of 15."); // unverified: text
});

test("$top or $orderby on a collection child is rejected only when the query nests", () => {
  assert.doesNotThrow(() => assertExpand(parseExpand("widget_gadgets($top=2;$orderby=name)"), widget, resolve));
  expectError(() => assertExpand(parseExpand("widget_gadgets($top=2),primarygadgetid($expand=owninguser)"), widget, resolve), PAGING);
  expectError(() => assertExpand(parseExpand("widget_gadgets($orderby=name;$expand=owninguser)"), widget, resolve), PAGING);
  expectError(() => assertExpand(parseExpand("primarygadgetid($expand=owninguser),widget_gadgets($top=1)"), widget, resolve), PAGING);
});

test("a nested one-to-many child with $top is rejected even when its parent is single-valued", () => {
  const tree = { logicalName: "root", relationships: { widget: { many: false, target: widget } } };
  expectError(() => assertExpand(parseExpand("widget($expand=widget_gadgets($top=1))"), tree, resolve), PAGING);
});

test("nested expansion under an N:N navigation is rejected with the navigation name", () => {
  expectError(
    () => assertExpand(parseExpand("widget_tags($select=name;$expand=owninguser)"), widget, resolve),
    "The navigation property 'widget_tags' cannot be expanded. Only many-to-one relationships are supported for nested expansion.",
  );
  assert.doesNotThrow(() => assertExpand(parseExpand("widget_tags($select=name)"), widget, resolve));
});

test("$ref is accepted on a lookup and rejected on a collection", () => {
  const ref = (navigation) => ({ ...parseExpand(navigation)[0], ref: true });
  assert.doesNotThrow(() => assertExpand([ref("primarygadgetid")], widget, resolve));
  expectError(() => assertExpand([ref("widget_gadgets")], widget, resolve), "Expand with $ref is only supported on lookup type navigation property.");
});

test("$skip, $count, $search and $levels inside an expand option are rejected", () => {
  for (const option of ["$skip=1", "$count=true", "$search='x'", "$levels=2"]) {
    expectError(() => assertExpandText(`widget_gadgets(${option})`), `The expand option ${option.split("=")[0]} is not supported in $expand.`); // unverified: text
  }
  assert.doesNotThrow(() => assertExpandText("widget_gadgets($select=name;$top=2;$skiptoken=x)"));
});

test("an unknown navigation property is rejected", () => {
  assert.throws(() => assertExpand(parseExpand("nosuch"), widget, resolve), (error) => {
    assert.ok(error instanceof DataError);
    assert.equal(error.code, "InvalidAttribute");
    return error.message === "Could not find a navigation property named 'nosuch' on widget.";
  });
});

test("collection child link without nesting carries the options and no $skiptoken", () => {
  const [item] = parseExpand("widget_gadgets($select=name;$filter=name eq 'a';$top=2)");
  const link = childLinks(ORIGIN, VERSION, "widgets", ID, "widget_gadgets", item, { nested: false, token: { pageNumber: 2, lastId: ID, firstId: ID, idColumn: "gadgetid", countOfRecords: 2 } });
  assert.equal(link.key, "widget_gadgets@odata.nextLink");
  assert.equal(link.url, `${ORIGIN}/api/data/v9.2/widgets(${ID})/widget_gadgets?$select=name&$filter=name eq 'a'&$top=2`);
});

test("nested child link with a token carries the $skiptoken and its countOfRecords", () => {
  const [item] = parseExpand("widget_gadgets($select=name;$expand=owninguser($select=name))");
  const token = { pageNumber: 2, lastId: ID, firstId: ID, idColumn: "gadgetid", countOfRecords: 1 };
  const link = childLinks(ORIGIN, VERSION, "widgets", ID, "widget_gadgets", item, { nested: true, token });
  const prefix = `${ORIGIN}/api/data/v9.2/widgets(${ID})/widget_gadgets?$select=name&$expand=owninguser($select=name)&$skiptoken=`;
  assert.ok(link.url.startsWith(prefix), link.url);
  const skiptoken = new URL(link.url).searchParams.get("$skiptoken");
  assert.deepEqual(decodeSkipToken(skiptoken), { pageNumber: 2, lastId: ID, firstId: ID, idColumn: "gadgetid", countOfRecords: 1 });
});

test("nested link without a token has no $skiptoken", () => {
  const [item] = parseExpand("widget_gadgets($expand=owninguser)");
  const link = childLinks(ORIGIN, VERSION, "widgets", ID, "widget_gadgets", item, { nested: true });
  assert.equal(link.url, `${ORIGIN}/api/data/v9.2/widgets(${ID})/widget_gadgets?$expand=owninguser`);
});
