// Schema-driven scaffold (lib/scaffold-data.mjs) on a synthetic portal and
// synthetic solution XML.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { importSolutionData } from "../lib/solution-data.mjs";
import { referencedTables, scaffoldData, scaffoldId } from "../lib/scaffold-data.mjs";
import { schemaFieldIndex, schemaViolations, formatViolations } from "../lib/schema-validation.mjs";
import { DataStore } from "../lib/data.mjs";
import YAML from "yaml";

const attribute = (name, type, extra = "") => `<attribute PhysicalName="${name}"><Type>${type}</Type><LogicalName>${name}</LogicalName>${extra}</attribute>`;
const label = (text) => `<labels><label description="${text}" languagecode="1033" /></labels>`;
const option = (value, text) => `<option value="${value}">${label(text)}</option>`;
const stateStatus =
  attribute("statecode", "state", `<optionset><OptionSetType>state</OptionSetType><states><state value="0" defaultstatus="1" invariantname="Active">${label("Active")}</state><state value="1" defaultstatus="2" invariantname="Inactive">${label("Inactive")}</state></states></optionset>`) +
  attribute("statuscode", "status", `<optionset><OptionSetType>status</OptionSetType><statuses><status value="1" state="0">${label("Open")}</status><status value="2" state="1">${label("Closed")}</status></statuses></optionset>`);
const system = ["createdon", "modifiedon", "createdby", "modifiedby", "ownerid"].map((name) => attribute(name, name.endsWith("on") ? "datetime" : "lookup")).join("");
const entity = (name, set, attributes) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><attributes>${attribute(`${name}id`, "primarykey")}${attributes}${stateStatus}${system}</attributes><EntitySetName>${set}</EntitySetName></entity></EntityInfo></Entity>`;
const relationship = (schema, child, parent, lookup) =>
  `<EntityRelationship Name="${schema}"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>${child}</ReferencingEntityName><ReferencedEntityName>${parent}</ReferencedEntityName><ReferencingAttributeName>${lookup}</ReferencingAttributeName><EntityRelationshipRoles><EntityRelationshipRole><RelationshipRoleType>1</RelationshipRoleType><NavigationPropertyName>${lookup}</NavigationPropertyName></EntityRelationshipRole><EntityRelationshipRole><RelationshipRoleType>0</RelationshipRoleType><NavigationPropertyName>${schema}</NavigationPropertyName></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship>`;
const nameAttribute = (name, required = true) => attribute(name, "nvarchar", `<DisplayMask>PrimaryName|ValidForForm</DisplayMask><RequiredLevel>${required ? "required" : "none"}</RequiredLevel><MaxLength>100</MaxLength>`);
const solutionXml = `<ImportExportXml><Entities>${[
  entity("account", "accounts", nameAttribute("name")),
  entity("contact", "contacts", nameAttribute("fullname", false) + attribute("firstname", "nvarchar") + attribute("lastname", "nvarchar") + attribute("emailaddress1", "nvarchar") + attribute("parentcustomerid", "customer")),
  entity(
    "x_case",
    "x_cases",
    nameAttribute("x_name") +
      attribute("x_casenumber", "nvarchar", "<RequiredLevel>required</RequiredLevel><AutoNumberFormat>CASE-{SEQNUM:4}</AutoNumberFormat>") +
      attribute("x_priority", "picklist", `<RequiredLevel>required</RequiredLevel><optionset><OptionSetType>picklist</OptionSetType><options>${option(1, "Low")}${option(2, "High")}</options></optionset>`) +
      attribute("x_due", "datetime") +
      attribute("x_flag", "bit") +
      attribute("x_customer", "lookup", "<RequiredLevel>required</RequiredLevel>") +
      attribute("x_category", "lookup", "<RequiredLevel>required</RequiredLevel>") +
      attribute("x_parentcase", "lookup"),
  ),
  entity("x_note", "x_notes", nameAttribute("x_name") + attribute("x_case", "lookup", "<RequiredLevel>required</RequiredLevel>")),
  entity("x_category", "x_categories", nameAttribute("x_name")),
].join("")}</Entities><EntityRelationships>${[
  relationship("x_case_customer", "x_case", "account", "x_customer"),
  relationship("x_case_category", "x_case", "x_category", "x_category"),
  relationship("x_case_parent", "x_case", "x_case", "x_parentcase"),
  relationship("x_note_case", "x_note", "x_case", "x_case"),
  relationship("contact_customer_accounts", "contact", "account", "parentcustomerid"),
].join("")}</EntityRelationships></ImportExportXml>`;

const portal = {
  forms: [{ id: "form-1", entityName: "x_case" }],
  lists: [{ id: "list-1", entityName: "x_case" }],
  records: [
    { kind: "advancedformstep", adx_targetentitylogicalname: "x_note" },
    { kind: "webrole", id: "role-auth", name: "Authenticated Users", adx_authenticatedusersrole: true },
    { kind: "webrole", id: "role-manager", name: "Case Managers" },
    { kind: "webrole", id: "role-anon", name: "Anonymous Users", adx_anonymoususersrole: true },
  ],
  templates: {
    list: { source: '{% fetchxml q %}<fetch><entity name="x_note"><link-entity name="contact" from="contactid" to="x_owner"/></entity></fetch>{% endfetchxml %}{{ entities.size }}{% assign c = entities["x_case"][id] %}{{ entities.unknown_table }}' },
  },
  snippets: {},
  pages: [{ id: "page-1", formId: "form-1", html: "", js: "" }],
  settings: { "Webapi/x_case/enabled": "true", "Webapi/x_off/enabled": "false" },
  siteMarkers: [{ name: "Case form", pageId: "page-1" }],
};

async function metadata(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-scaffold-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "solution.xml");
  await fs.writeFile(file, solutionXml);
  return { dir, file, data: await importSolutionData([file]) };
}

test("referencedTables collects forms, advanced form steps, lists, FetchXML, Liquid entities, Web API settings and site markers", () => {
  const found = referencedTables(portal);
  assert.deepEqual([...found.keys()], ["contact", "unknown_table", "x_case", "x_note"]);
  assert.deepEqual([...found.get("x_case")].sort(), ["form", "liquid", "list", "sitemarker", "webapi"]);
  assert.deepEqual([...found.get("x_note")].sort(), ["fetchxml", "form"]);
  assert.equal(found.has("size"), false);
  assert.equal(found.has("x_off"), false);
});

test("scaffold rows follow metadata: required columns, option labels, autonumbers, state/status, bound lookups and personas", async (t) => {
  const { data } = await metadata(t);
  const result = scaffoldData({ portal, schema: data.schema, profile: "smoke", seed: "test-seed" });
  assert.deepEqual(Object.keys(result.tables).sort(), ["account", "adx_webrole_contact", "contact", "x_case", "x_category", "x_note"]);
  assert.deepEqual(result.report.addedForRequiredLookups, ["x_category"]);
  assert.deepEqual(result.report.referencedWithoutMetadata, ["unknown_table"]);
  const cases = result.tables.x_case;
  assert.equal(cases.length, 3);
  assert.equal(cases[0].x_caseid, scaffoldId("test-seed", "x_case:1"));
  assert.equal(cases[0].x_name, "x_case 1");
  assert.deepEqual(cases.map((row) => row.x_casenumber), ["CASE-0001", "CASE-0002", "CASE-0003"]);
  assert.deepEqual(cases[1].x_priority, { value: 2, label: "High" });
  assert.equal(cases[0].statecode, 0);
  assert.deepEqual(cases[0].statuscode, { value: 1, label: "Open" });
  assert.deepEqual(cases[2].x_customer, { id: scaffoldId("test-seed", "account:3"), logical_name: "account", name: "account 3" });
  assert.equal(cases[0].x_category.logical_name, "x_category");
  assert.equal(cases[0].x_parentcase, undefined, "the first row has no parent");
  assert.equal(cases[1].x_parentcase.id, cases[0].x_caseid);
  // smoke writes required columns only; dev adds optional ones.
  assert.equal(cases[0].x_due, undefined);
  const dev = scaffoldData({ portal, schema: data.schema, profile: "dev", seed: "test-seed" });
  assert.equal(dev.tables.x_case.length, 25);
  assert.equal(dev.tables.x_case[0].x_due, "2026-01-05T08:00:00Z");
  assert.equal(typeof dev.tables.x_case[0].x_flag, "boolean");
  for (const row of result.tables.x_note) assert.ok(cases.some((item) => item.x_caseid === row.x_case.id));
  // One persona per non-anonymous web role, with membership and an account.
  assert.deepEqual(result.personas.map((persona) => persona.role), ["Authenticated Users", "Case Managers"]);
  assert.deepEqual(result.contactRoles.map((entry) => entry.roleId), ["role-auth", "role-manager"]);
  const persona = result.tables.contact.find((row) => row.contactid === result.personas[1].contactId);
  assert.equal(persona.parentcustomerid.id, result.personas[1].accountId);
  // Deterministic and valid against the field lists and option sets.
  assert.deepEqual(scaffoldData({ portal, schema: data.schema, profile: "smoke", seed: "test-seed" }).tables, result.tables);
  const index = schemaFieldIndex(data.schema, Object.keys(result.tables));
  assert.deepEqual(formatViolations(schemaViolations(dev.tables, index, { idColumn: (table) => dev.idColumns[table] })), []);
  const store = await new DataStore({ state: { tables: result.tables, mappings: data.mappings, permissions: [], plugins: [], settings: { permissionMode: "permissive" } } }).init();
  assert.equal(store.rows("x_case").length, 3);
  assert.throws(() => scaffoldData({ portal, schema: data.schema, profile: "huge" }), /Unknown scaffold profile/);
});

// --- data scaffold: portal resolution like serve ---------------------------

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const scaffoldCli = async (args) =>
  JSON.parse((await promisify(execFile)(process.execPath, [cli, "data", "scaffold", "--profile", "smoke", "--seed", "cli-seed", ...args])).stdout);

/** A minimal portal export (web-pages/ marks it as a portal extract) with one web role and the Web API setting for x_case. */
async function writePortal(dir) {
  await fs.mkdir(path.join(dir, "web-pages"), { recursive: true });
  await fs.writeFile(path.join(dir, "website.yml"), "adx_name: Scaffold\nadx_websiteid: site\n");
  await fs.writeFile(path.join(dir, "webrole.yml"), "- adx_webroleid: 7a7a7a7a-0000-0000-0000-000000000001\n  adx_name: Members\n");
  await fs.writeFile(path.join(dir, "sitesetting.yml"), "- adx_name: Webapi/x_case/enabled\n  adx_value: true\n");
  return dir;
}

/** An unpacked solution tree (Other/Solution.xml) carrying the synthetic metadata. */
async function writeSolution(dir) {
  await fs.mkdir(path.join(dir, "Other"), { recursive: true });
  await fs.writeFile(path.join(dir, "Other", "Solution.xml"), "<ImportExportXml><SolutionManifest><UniqueName>scaffold</UniqueName></SolutionManifest></ImportExportXml>");
  await fs.writeFile(path.join(dir, "Other", "Customizations.xml"), solutionXml);
  return dir;
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-scaffold-cli-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("data scaffold with --source and explicit --solution-root bootstraps a state and merges additively", async (t) => {
  const dir = await workspace(t);
  const source = await writePortal(path.join(dir, "portal"));
  const solution = await writeSolution(path.join(dir, "solution"));
  const state = path.join(dir, "state.json");
  const first = await scaffoldCli(["--source", source, "--solution-root", solution, "--state", state]);
  assert.equal(first.bootstrapped, true);
  assert.deepEqual(first.resolution, { kind: "source", solutionRoots: "explicit" });
  assert.equal(first.source, path.resolve(source));
  assert.deepEqual(first.solutionRoots, [path.resolve(solution)]);
  assert.equal(first.rows.x_case.added, 3);
  assert.equal(first.addedMemberships, 1);
  const second = await scaffoldCli(["--source", source, "--solution-root", solution, "--state", state]);
  assert.equal(second.bootstrapped, false);
  assert.deepEqual(second.rows.x_case, { added: 0, alreadyPresent: 3 });
  assert.equal(second.addedMemberships, 0);
  const saved = JSON.parse(await fs.readFile(state, "utf8"));
  assert.equal(saved.provenance.scaffold.profile, "smoke");
  assert.equal(saved.simulator.contactRoles.length, 1);
});

test("data scaffold with --source discovers solution repositories next to the portal repository", async (t) => {
  const dir = await workspace(t);
  const repository = path.join(dir, "portal-repo");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  const source = await writePortal(path.join(repository, "portal"));
  const solution = await writeSolution(path.join(dir, "solution-repo"));
  const result = await scaffoldCli(["--source", source, "--state", path.join(dir, "state.json")]);
  assert.deepEqual(result.resolution, { kind: "source", solutionRoots: "discovered" });
  // Compare canonical paths (temporary directories may surface as 8.3 short names).
  assert.deepEqual(await Promise.all(result.solutionRoots.map((root) => fs.realpath(root))), [await fs.realpath(solution)]);
  assert.equal(result.rows.x_case.added, 3);
});

test("data scaffold with --project and --portal uses the project's portal source and solutions", async (t) => {
  const dir = await workspace(t);
  await writePortal(path.join(dir, "portals", "main"));
  await writePortal(path.join(dir, "portals", "other"));
  await writeSolution(path.join(dir, "solutions", "core"));
  const project = path.join(dir, "mirage.project.yml");
  await fs.writeFile(
    project,
    "version: 2\ndefaultPortal: main\nportals:\n  - id: main\n    path: portals/main\n  - id: other\n    path: portals/other\nsolutions:\n  - id: core\n    path: solutions/core\n",
  );
  const result = await scaffoldCli(["--project", project, "--portal", "other", "--state", path.join(dir, "state.json")]);
  assert.equal(result.resolution.kind, "project");
  assert.equal(result.resolution.portal, "other");
  assert.equal(result.source, await fs.realpath(path.join(dir, "portals", "other")));
  assert.deepEqual(result.solutionRoots, [await fs.realpath(path.join(dir, "solutions", "core"))]);
  assert.equal(result.rows.x_case.added, 3);
  await assert.rejects(scaffoldCli(["--project", project, "--source", dir, "--state", path.join(dir, "x.json")]), /either --project or --source/);
});

test("data scaffold with --site, --env and --repo resolves the toolkit catalogue's portal source", async (t) => {
  const dir = await workspace(t);
  // The catalogue (paqvilo.config.yml) names the default site and its source path below the repository root.
  const catalogue = YAML.parse(await fs.readFile(fileURLToPath(new URL("../../paqvilo.config.yml", import.meta.url)), "utf8"));
  const site = catalogue.defaultSite ?? Object.keys(catalogue.sites)[0];
  const env = Object.keys(catalogue.sites[site].environments ?? { dev: {} })[0];
  const source = await writePortal(path.join(dir, catalogue.sites[site].source));
  const solution = await writeSolution(path.join(dir, "solution"));
  const result = await scaffoldCli(["--site", site, "--env", env, "--repo", dir, "--solution-root", solution, "--state", path.join(dir, "state.json")]);
  assert.deepEqual(result.resolution, { kind: "catalogue", site, env, solutionRoots: "explicit" });
  assert.equal(path.resolve(result.source), path.resolve(source));
  assert.equal(result.rows.x_case.added, 3);
});

test("personas get web role memberships as contactRoles and as the data model's intersect rows; exported site tables are not generated", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-scaffold-roles-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Metadata that also defines the web role table, referenced by a template.
  const file = path.join(dir, "solution.xml");
  await fs.writeFile(file, solutionXml.replace("<Entities>", `<Entities>${entity("adx_webrole", "adx_webroles", nameAttribute("adx_name"))}`));
  const { schema } = await importSolutionData([file]);
  const withRoles = { ...portal, templates: { ...portal.templates, roles: { source: "{% assign roles = entities['adx_webrole'] %}" } } };
  for (const [format, table, roleColumn] of [
    [undefined, "adx_webrole_contact", "adx_webroleid"],
    ["enhanced", "powerpagecomponent_mspp_webrole_contact", "powerpagecomponentid"],
  ]) {
    const result = scaffoldData({ portal: { ...withRoles, format }, schema, profile: "smoke", seed: "roles" });
    assert.equal(result.tables.adx_webrole, undefined, "exported web roles stay with the site tables");
    assert.deepEqual(result.report.derivedFromExport, ["adx_webrole"]);
    const rows = result.tables[table];
    assert.equal(rows.length, result.contactRoles.length);
    assert.deepEqual(
      rows.map((row) => [row.contactid, row[roleColumn]]),
      result.contactRoles.map((entry) => [entry.contactId, entry.roleId]),
    );
    assert.equal(rows[0][`${table}id`], scaffoldId("roles", `${table}:${rows[0].contactid}:${rows[0][roleColumn]}`));
    assert.equal(result.idColumns[table], `${table}id`);
    assert.deepEqual(result.report.memberships, { table, rows: 2 });
    const other = format === "enhanced" ? "adx_webrole_contact" : "powerpagecomponent_mspp_webrole_contact";
    assert.equal(result.tables[other], undefined);
  }
});
