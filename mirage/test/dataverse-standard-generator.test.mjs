// Generator for mirage/lib/dataverse-standard-tables.json: page parser, file builder and page
// loader, run on an invented Learn-layout fixture. Nothing here fetches from the network: the
// loader gets a fake fetch and a temporary cache.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COMMIT,
  PREFIXED_TABLES,
  TABLES,
  buildStandardFile,
  loadPages,
  parseEntityPage,
} from "../../scripts/dataverse-standard-tables.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures", "standard-entity-page.md"), "utf8");
const COMMIT = "c3a8c43bfabbbbf1b6dd018fbb37bce6f6b7cd59";

test("parseEntityPage reads table facts, columns, choices and read-only flags", () => {
  const parsed = parseEntityPage(fixture, "fx_widget");
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.table.schemaName, "FxWidget");
  assert.equal(parsed.table.entitySet, "fx_widgets");
  assert.equal(parsed.table.primaryIdAttribute, "fx_widgetid");
  assert.equal(parsed.table.ownershipType, "UserOwned");
  assert.deepEqual(parsed.table.labels, { 1033: "Widget" });

  const a = parsed.attributes;
  assert.equal(a.fx_widgetid.type, "primarykey");
  assert.equal(a.fx_name.type, "nvarchar");
  assert.equal(a.fx_name.maxLength, 100);
  assert.equal(a.fx_name.format, "text");
  assert.equal(a.fx_name.imeMode, "auto");
  assert.equal(a.fx_name.isLocalizable, false);
  assert.equal(a.fx_name.requiredLevel, "applicationrequired");
  assert.equal(a.fx_name.validForCreate, true);

  assert.equal(a.fx_active.type, "bit");
  assert.equal(a.fx_active.appDefaultValue, "0");
  assert.equal(a.fx_active.optionSetName, "fx_widget_fx_active");
  assert.deepEqual(a.fx_active.optionSet, {
    type: "bit",
    isGlobal: false,
    options: [{ value: 0, labels: { 1033: "No" } }, { value: 1, labels: { 1033: "Yes" } }],
  });

  assert.equal(a.fx_category.optionSet, undefined, "a global set is referenced by name, not inlined");
  assert.equal(a.fx_category.optionSetName, "fx_sharedcategory");
  assert.equal(a.fx_category.appDefaultValue, "1");
  assert.deepEqual(parsed.optionSets.fx_sharedcategory, {
    name: "fx_sharedcategory",
    type: "picklist",
    isGlobal: true,
    options: [{ value: 1, labels: { 1033: "Basic" } }, { value: 2, labels: { 1033: "Premium" } }],
  });

  assert.equal(a.statecode.type, "state");
  assert.deepEqual(a.statecode.optionSet.states, [
    { value: 0, labels: { 1033: "Active" }, defaultStatus: 1, invariantName: "Active" },
    { value: 1, labels: { 1033: "Inactive" }, defaultStatus: 2, invariantName: "Inactive" },
  ]);
  assert.equal(a.statuscode.type, "status");
  assert.deepEqual(a.statuscode.optionSet.statuses[0], { value: 1, labels: { 1033: "Open" }, state: 0 });

  assert.equal(a.fx_parentid.type, "lookup");
  assert.deepEqual(a.fx_parentid.targets, ["fx_widget"]);

  assert.equal(a.fx_createdcalc.validForCreate, false);
  assert.equal(a.fx_createdcalc.validForUpdate, false);
  assert.equal(a.fx_createdcalc.validForRead, true);

  assert.equal(a.adx_legacyflag, undefined, "excluded-prefix columns are dropped");
  assert.equal(parsed.excludedColumns, 1);
});

test("parseEntityPage keeps each relationship block as its page states it", () => {
  const { relationships } = parseEntityPage(fixture, "fx_widget");
  const many = relationships.find((rel) => rel.kind === "many-to-one");
  assert.equal(many.schemaName, "fx_widget_parent");
  assert.equal(many.referencingEntity, "fx_widget");
  assert.equal(many.referencedAttribute, "fx_widgetid");
  assert.equal(many.referencingNavigation, "fx_parentid");
  assert.equal(many.isHierarchical, undefined, "an empty IsHierarchical cell is not guessed");
  assert.equal(many.cascade.assign, "Cascade");
  assert.equal(many.cascade.rollupView, "NoCascade");

  const parts = relationships.find((rel) => rel.schemaName === "fx_part_widget");
  assert.equal(parts.kind, "one-to-many");
  assert.equal(parts.referencingEntity, "fx_part");
  assert.equal(parts.referencedNavigation, "fx_parts");
});

test("buildStandardFile merges both sides and keeps only relationships inside the table list", () => {
  const { file, problems, stats } = buildStandardFile({ fx_widget: fixture }, { commit: COMMIT });
  assert.deepEqual(problems, []);
  assert.equal(file.commit, COMMIT);
  assert.equal(file.licence, "CC-BY-4.0");
  assert.equal(file.source.descriptionsOmitted, true);
  assert.deepEqual(Object.keys(file.relationships), ["fx_widget_parent"]);

  const rel = file.relationships.fx_widget_parent;
  assert.equal(rel.type, "one-to-many");
  assert.equal(rel.referencingEntity, "fx_widget");
  assert.equal(rel.referencedEntity, "fx_widget");
  assert.equal(rel.referencingAttribute, "fx_parentid");
  assert.equal(rel.referencedAttribute, "fx_widgetid");
  assert.equal(rel.referencingNavigation, "fx_parentid");
  assert.equal(rel.referencedNavigation, "fx_children");

  assert.equal(file.tables.fx_widget.attributes.adx_legacyflag, undefined);
  assert.equal(file.optionSets.fx_sharedcategory.isGlobal, true);
  assert.equal(stats.excludedColumns, 1);
  assert.equal(stats.relationships, 1);
});

test("unmapped Learn types are reported as problems, not guessed", () => {
  const broken = fixture.replace("|Type|Boolean|", "|Type|Geometry|");
  const { problems } = buildStandardFile({ fx_widget: broken }, { commit: COMMIT });
  assert.ok(problems.some((problem) => problem.includes("unmapped Type Geometry")), problems.join("\n"));
});

test("loadPages fetches a missing page once and reads the cache afterwards", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "standard-tables-"));
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    return { ok: true, text: async () => fixture };
  };
  try {
    const tables = ["fx_widget", "fx_part"];
    const pages = await loadPages(COMMIT, { cacheRoot: dir, fetchFn, tables });
    assert.deepEqual(Object.keys(pages), tables);
    assert.equal(urls.length, 2);
    assert.equal(
      urls[0],
      `https://raw.githubusercontent.com/MicrosoftDocs/powerapps-docs/${COMMIT}/powerapps-docs/developer/data-platform/reference/entities/fx_widget.md`,
    );
    await loadPages(COMMIT, { cacheRoot: dir, fetchFn, tables });
    assert.equal(urls.length, 2, "the second load reads the cache");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the checked-in standard file is pinned to the commit and covers the 161 tables and the 6 allow-listed prefixed tables", () => {
  assert.equal(TABLES.length, 161);
  assert.equal(PREFIXED_TABLES.length, 6);
  const file = JSON.parse(fs.readFileSync(path.join(here, "..", "lib", "dataverse-standard-tables.json"), "utf8"));
  assert.equal(file.commit, DEFAULT_COMMIT);
  assert.equal(file.licence, "CC-BY-4.0");
  assert.deepEqual(Object.keys(file.tables).sort(), [...TABLES, ...PREFIXED_TABLES].sort());
  assert.deepEqual(file.source.prefixedTables, PREFIXED_TABLES);
});

// An invented msdyn_ page: the fixture renamed to msdyn_sample, with its legacy column under the msdyn_ prefix.
const msdynSample = () => fixture.replaceAll("fx_widget", "msdyn_sample").replaceAll("adx_legacyflag", "msdyn_legacyflag");

test("an allow-listed prefixed table keeps its prefixed columns", () => {
  const { file, stats } = buildStandardFile({ msdyn_sample: msdynSample() }, { commit: COMMIT, prefixedTables: ["msdyn_sample"] });
  assert.ok(file.tables.msdyn_sample.attributes.msdyn_legacyflag, "the msdyn_ column survives");
  assert.equal(stats.excludedColumns, 0);
});

test("a prefixed column on a standard table is still dropped", () => {
  const page = fixture.replaceAll("adx_legacyflag", "msdyn_legacyflag");
  const { file, stats } = buildStandardFile({ fx_widget: page }, { commit: COMMIT, prefixedTables: ["msdyn_sample"] });
  assert.equal(file.tables.fx_widget.attributes.msdyn_legacyflag, undefined);
  assert.equal(stats.excludedColumns, 1);
});

test("a relationship to an allow-listed table is kept", () => {
  const page = msdynSample();
  const allowed = buildStandardFile({ msdyn_sample: page }, { commit: COMMIT, prefixedTables: ["msdyn_sample"] });
  assert.deepEqual(Object.keys(allowed.file.relationships), ["msdyn_sample_parent"]);
  const notAllowed = buildStandardFile({ msdyn_sample: page }, { commit: COMMIT, prefixedTables: [] });
  assert.deepEqual(Object.keys(notAllowed.file.relationships), []);
});

test("a relationship through a dropped column is dropped", () => {
  const page = fixture.replaceAll("fx_parentid", "msdyn_parentid");
  const { file } = buildStandardFile({ fx_widget: page }, { commit: COMMIT, prefixedTables: ["msdyn_sample"] });
  assert.deepEqual(Object.keys(file.relationships), []);
});
