#!/usr/bin/env node
// Generates the baseline inventories from the catalogs, the fixture definitions and the exported
// solution. Every Dataverse row declares the catalog states it exercises using the catalog's own
// state strings; "states not exercised" is the catalog list minus those declarations, and every such
// state must carry a reason from STATE_REASONS (the script fails otherwise). Rerun after any fixture
// change, provisioning export or plugin read-back:
//
//   node examples/project/baseline/plugins.mjs --connection <private connection.json> --verify
//   node scripts/baseline-inventory.mjs
//
// Inputs: examples/project/baseline/{generate.mjs, dataverse/*.json, plugins.json, plugins-readback.json,
// site-manifest.json, solution/**}. Outputs: mirage/docs/baseline/dataverse-inventory.md,
// mirage/docs/baseline/power-pages-inventory.md. Deterministic: no clock, sorted inputs.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "examples/project/baseline";
const EXPORT = `${FIXTURE}/solution`;
const GEN = `${FIXTURE}/generate.mjs`;
const SITE = `${FIXTURE}/site.mjs`;
const PLUGINS = `${FIXTURE}/plugins.json`;
const READBACK = `${FIXTURE}/plugins-readback.json`;
const EXTRAS = `${FIXTURE}/dataverse/extras.json`;
const docs = path.join(root, "mirage/docs/baseline");
const abs = (relative) => path.join(root, relative);
const read = async (relative) => JSON.parse(await fs.readFile(abs(relative), "utf8"));
const text = (relative) => fs.readFile(abs(relative), "utf8");
const list = async (relative, filter = () => true) => (await fs.readdir(abs(relative)).catch(() => [])).filter(filter).sort();

// --- small XML helpers (the export is machine-written, one element per line) -----------------------
const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
const attrsOf = (open) => Object.fromEntries([...open.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const bare = (id) => String(id ?? "").replace(/[{}]/g, "").toLowerCase();

async function loadExport(tables, classids) {
  const kindOf = Object.fromEntries(Object.entries(classids).map(([kind, id]) => [id.toUpperCase(), kind]));
  const attributes = [];
  const keys = [];
  const forms = [];
  const views = [];
  for (const table of tables) {
    const base = `${EXPORT}/Entities/${table}`;
    const entity = await text(`${base}/Entity.xml`);
    for (const [, body] of entity.matchAll(/<attribute PhysicalName="[^"]+">([\s\S]*?)\n {8}<\/attribute>/g)) {
      const get = (name) => tag(body, name);
      attributes.push({
        table, name: get("LogicalName"), type: get("Type"), format: get("Format") ?? "", required: get("RequiredLevel"),
        maxLength: get("MaxLength"), min: get("MinValue"), max: get("MaxValue"), accuracy: get("Accuracy"), default: get("AppDefaultValue"),
        update: get("ValidForUpdateApi"), create: get("ValidForCreateApi"), secured: get("IsSecured") === "1", source: get("SourceType"),
        behavior: get("Behavior"), autoNumber: get("AutoNumberFormat") || "", custom: get("IsCustomField") === "1", optionSet: get("OptionSetName"),
        lookupStyle: get("LookupStyle"), display: /<displayname description="([^"]*)"/.exec(body)?.[1], searchable: get("IsSearchable") === "1", sortable: get("IsSortableEnabled") === "1", formula: /<(FormulaDefinitionFileName|CalculationOf)>/.test(body),
        canModifyRequired: get("CanModifyRequirementLevelSettings"),
        stateOptions: [...body.matchAll(/<state value="(\d+)" defaultstatus="(\d+)"/g)].map((m) => ({ value: m[1], defaultStatus: m[2] })),
        statusOptions: [...body.matchAll(/<status value="(\d+)" state="(\d+)"[^>]*>\s*<labels>\s*<label description="([^"]*)"/g)].map((m) => ({ value: m[1], state: m[2], label: m[3] })),
      });
    }
    for (const [, body] of entity.matchAll(/<EntityKey>([\s\S]*?)<\/EntityKey>/g)) keys.push({ table, name: tag(body, "LogicalName"), columns: [...body.matchAll(/<AttributeName>([^<]+)</g)].map((m) => m[1]) });
    for (const folder of await list(`${base}/FormXml`)) for (const file of await list(`${base}/FormXml/${folder}`, (f) => f.endsWith(".xml"))) {
      const xml = await text(`${base}/FormXml/${folder}/${file}`);
      forms.push({ table, folder, file: `${base}/FormXml/${folder}/${file}`, id: bare(tag(xml, "formid")), name: /<LocalizedName description="([^"]*)"/.exec(xml)?.[1], activation: tag(xml, "FormActivationState"), ...parseForm(xml, kindOf) });
    }
    for (const file of await list(`${base}/SavedQueries`, (f) => f.endsWith(".xml"))) {
      const xml = await text(`${base}/SavedQueries/${file}`);
      views.push({
        table, file: `${base}/SavedQueries/${file}`, id: bare(tag(xml, "savedqueryid")), name: /<LocalizedName description="([^"]*)"/.exec(xml)?.[1],
        queryType: Number(tag(xml, "querytype")), isDefault: tag(xml, "isdefault") === "1", isQuickFind: tag(xml, "isquickfindquery") === "1",
        cells: [...xml.matchAll(/<cell ([^>]*?)\/>/g)].map((m) => attrsOf(m[1])), orders: [...xml.matchAll(/<order ([^>]*?)\/>/g)].map((m) => attrsOf(m[1])),
        links: (xml.match(/<link-entity /g) ?? []).length, filters: (xml.match(/<condition /g) ?? []).length,
        quickFindFields: [.../<filter [^>]*isquickfindfields="1"[^>]*>([\s\S]*?)<\/filter>/.exec(xml)?.[1]?.matchAll(/<condition attribute="([^"]+)"/g) ?? []].map((m) => m[1]),
      });
    }
  }
  const workflows = [];
  for (const file of await list(`${EXPORT}/Workflows`, (f) => f.endsWith(".xaml.data.xml"))) {
    const data = await text(`${EXPORT}/Workflows/${file}`);
    const xaml = await text(`${EXPORT}/Workflows/${file.replace(/\.data\.xml$/, "")}`);
    workflows.push({
      file: `${EXPORT}/Workflows/${file}`, xamlFile: `${EXPORT}/Workflows/${file.replace(/.data.xml$/, "")}`, id: bare(/WorkflowId="([^"]+)"/.exec(data)?.[1]), name: /Name="([^"]+)"/.exec(data)?.[1],
      category: tag(data, "Category"), type: tag(data, "Type"), state: tag(data, "StateCode"), triggerScope: tag(data, "ProcessTriggerScope"), triggerForm: bare(tag(data, "ProcessTriggerFormId")),
      activities: [...new Set([...xaml.matchAll(/<(?:mcwc|mxswa):(Set\w+)/g)].map((m) => m[1]))].sort(), clears: /Value="\[Nothing\]"/.test(xaml),
    });
  }
  const steps = [];
  for (const file of await list(`${EXPORT}/SdkMessageProcessingSteps`, (f) => f.endsWith(".xml"))) {
    const xml = await text(`${EXPORT}/SdkMessageProcessingSteps/${file}`);
    steps.push({ file: `${EXPORT}/SdkMessageProcessingSteps/${file}`, id: bare(/SdkMessageProcessingStepId="([^"]+)"/.exec(xml)?.[1]), invocationSource: Number(tag(xml, "InvocationSource")), stateInExport: /<StateCode>/.test(xml) });
  }
  const relationships = [];
  for (const file of await list(`${EXPORT}/Other/Relationships`, (f) => f.endsWith(".xml"))) {
    const xml = await text(`${EXPORT}/Other/Relationships/${file}`);
    for (const [, name, body] of xml.matchAll(/<EntityRelationship Name="([^"]+)">([\s\S]*?)<\/EntityRelationship>/g)) {
      const get = (key) => tag(body, key);
      const relationship = { file: `${EXPORT}/Other/Relationships/${file}`, name, type: get("EntityRelationshipType"), referenced: get("ReferencedEntityName"), referencing: get("ReferencingEntityName"), attribute: get("ReferencingAttributeName"), hierarchical: get("IsHierarchical") === "1", cascade: Object.fromEntries(["Assign", "Delete", "Archive", "Reparent", "Share", "Unshare"].map((action) => [action, get(`Cascade${action}`)])) };
      if (tables.includes(relationship.referencing) || tables.includes(relationship.referenced)) relationships.push(relationship);
    }
  }
  const solution = await text(`${EXPORT}/Other/Solution.xml`);
  const allMissing = [...solution.matchAll(/<MissingDependency>([\s\S]*?)<\/MissingDependency>/g)].map((m) => ({ required: attrsOf(/<Required ([^>]*)\/>/.exec(m[1])?.[1] ?? ""), dependent: attrsOf(/<Dependent ([^>]*)\/>/.exec(m[1])?.[1] ?? "") }));
  // System-layer requirements (unmodified platform columns the solution lists itself) are present on every import; provision.mjs applies the same rule.
  const missing = allMissing.filter((m) => !/^System \(/.test(m.required.solution ?? ""));
  const systemMissing = allMissing.length - missing.length;
  const roots = [...solution.matchAll(/<RootComponent ([^>]*)\/>/g)].map((m) => attrsOf(m[1]));
  const security = await text(`${EXPORT}/Other/FieldSecurityProfiles.xml`);
  const permissions = [...security.matchAll(/<FieldPermission>([\s\S]*?)<\/FieldPermission>/g)].map((m) => ({ table: tag(m[1], "EntityName"), column: tag(m[1], "AttributeName"), read: tag(m[1], "CanRead"), update: tag(m[1], "CanUpdate"), create: tag(m[1], "CanCreate"), readUnmasked: tag(m[1], "CanReadUnmasked") }));
  return { attributes, keys, forms, views, workflows, steps, relationships, missing, systemMissing, roots, permissions, profileName: /<FieldSecurityProfile name="([^"]+)"/.exec(security)?.[1] };
}

// Walks tabs → columns → sections → cells → controls of one exported FormXml.
function parseForm(xml, kindOf) {
  const out = { formAttrs: attrsOf(/<form\b([^>]*)>/.exec(xml)?.[1] ?? ""), tabs: [], columns: [], sections: [], cells: [], controls: [] };
  let tab = null, section = null, cell = null;
  const re = /<(\/?)(tab|column|section|cell|control)\b([^>]*?)(\/?)>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const [, close, name, raw, selfClose] = m;
    if (close) { if (name === "tab") tab = null; if (name === "section") section = null; if (name === "cell") cell = null; continue; }
    const attrs = attrsOf(raw);
    if (name === "tab") out.tabs.push(tab = { attrs });
    else if (name === "column") out.columns.push({ attrs, tab });
    else if (name === "section") out.sections.push(section = { attrs, tab });
    else if (name === "cell") { out.cells.push(cell = { attrs, section, tab, control: null, label: selfClose ? null : /^\s*<labels>\s*<label description="([^"]*)"/.exec(xml.slice(re.lastIndex, re.lastIndex + 300))?.[1] }); if (selfClose) cell = null; }
    else {
      let params = "";
      if (!selfClose) { const end = xml.indexOf("</control>", re.lastIndex); params = xml.slice(re.lastIndex, end); re.lastIndex = end + 10; }
      const control = { attrs, params, kind: kindOf[(attrs.classid ?? "").toUpperCase()], cell, section, tab };
      out.controls.push(control);
      if (cell) cell.control = control;
    }
  }
  return out;
}
const param = (control, name) => tag(control.params, name);

async function loadFixture() {
  const generate = await import(pathToFileURL(abs(GEN)).href);
  const extras = await read(EXTRAS);
  const manifest = await read(`${FIXTURE}/dataverse/manifest.json`);
  const plugins = await read(PLUGINS);
  const readback = await read(READBACK).catch(() => null);
  const site = await read(`${FIXTURE}/site-manifest.json`);
  const tables = manifest.tables.filter((table) => !table.existing).map((table) => table.name);
  const exported = await loadExport(tables, generate.CLASSIDS);
  // Which fixture pages render which Dataverse form (basic forms and multistep steps name forms).
  const formPages = new Map();
  const addPage = (form, page) => (formPages.get(form) ?? formPages.set(form, new Set()).get(form)).add(page);
  // Each basic form and multistep step folder holds the record yml and its metadata yml; the record yml
  // names the Dataverse form (adx_formname). A basic form without a page of its own is a dialog opened
  // from the folders whose yml reference its id (subgrid/lookup metadata, action buttons).
  const folders = [];
  const ownFolder = async (dir, suffix, idKey) => {
    const files = await list(dir, (f) => f.endsWith(".yml"));
    const own = files.find((f) => f.endsWith(suffix));
    if (!own) return;
    const yml = await text(`${dir}/${own}`);
    folders.push({ id: new RegExp(`${idKey}: (\\S+)`).exec(yml)?.[1], formName: /adx_formname: (.+)/.exec(yml)?.[1]?.trim(), all: (await Promise.all(files.map((f) => text(`${dir}/${f}`)))).join("\n") });
  };
  for (const dir of await list(`${FIXTURE}/site/basic-forms`)) await ownFolder(`${FIXTURE}/site/basic-forms/${dir}`, ".basicform.yml", "adx_entityformid");
  for (const form of await list(`${FIXTURE}/site/advanced-forms`)) for (const dir of await list(`${FIXTURE}/site/advanced-forms/${form}/advanced-form-steps`)) await ownFolder(`${FIXTURE}/site/advanced-forms/${form}/advanced-form-steps/${dir}`, ".advancedformstep.yml", "adx_webformstepid");
  const records = new Map(site.records.map((record) => [record.id, record]));
  for (const folder of folders) {
    const record = records.get(folder.id);
    if (!record || !folder.formName) continue;
    if (record.path) addPage(folder.formName, record.path);
    else for (const opener of folders.filter((other) => other !== folder && other.all.includes(folder.id))) if (records.get(opener.id)?.path) addPage(folder.formName, `${records.get(opener.id).path} (dialog)`);
  }
  return { generate, extras, manifest, plugins, readback, site, tables, exported, formPages };
}

const pagesFor = (formPages, ...names) => [...new Set(names.flatMap((name) => [...(formPages.get(name) ?? [])]))].sort();
const brief = (names, limit = 6) => (names.length > limit ? `${names.slice(0, limit).join(", ")} … (${names.length} in all)` : names.join(", "));
const unique = (values) => [...new Set(values)];

// --- column type of an exported attribute ---------------------------------------------------------
function columnItem(a) {
  if (a.type === "primarykey") return "dv.column.uniqueidentifier";
  if (a.type === "state") return "dv.column.state";
  if (a.type === "status") return "dv.column.status";
  if (a.type === "owner") return "dv.column.lookup.owner";
  if (!a.custom || a.name.endsWith("_base")) return null; // other platform columns; *_base are platform-generated currency columns
  switch (a.type) {
    case "nvarchar":
      if (a.source === "1") return "dv.column.calculated";
      if (a.source === "2") return "dv.column.rollup";
      if (a.source === "3") return "dv.column.formula";
      if (a.autoNumber) return "dv.column.string.autonumber";
      return `dv.column.string.${a.format}`;
    case "ntext": return a.format === "richtext" ? "dv.column.string.richtext" : "dv.column.memo";
    case "int": return `dv.column.integer.${a.format}`;
    case "decimal": return "dv.column.decimal";
    case "float": return "dv.column.double";
    case "money": return "dv.column.money";
    case "bigint": return "dv.column.bigint";
    case "datetime": return { 1: "dv.column.datetime.userlocal", 2: "dv.column.datetime.dateonly", 3: "dv.column.datetime.tzindependent" }[a.behavior];
    case "picklist": return a.optionSet ? "dv.column.choice.global" : "dv.column.choice.local";
    case "multiselectpicklist": return "dv.column.choices.multiselect";
    case "bit": return "dv.column.boolean";
    case "lookup": return a.lookupStyle === "polymorphic" ? "dv.column.lookup.polymorphic" : "dv.column.lookup";
    case "customer": return "dv.column.lookup.customer";
    case "image": return "dv.column.image";
    case "file": return "dv.column.file";
    default: return null;
  }
}
const NUMERIC = new Set(["int", "decimal", "float", "money"]);
// File and image values are written through the upload messages, never Create/Update, so every such column is
// exported ValidForCreateApi 0 / ValidForUpdateApi 0 (learn-file-column-data); that is not a read-only setting.
const UPLOADED = new Set(["file", "image"]);
const REQUIRED = { none: "optional", required: "required", systemrequired: "required", recommended: "recommended" };
function attributeFacts(a) {
  const facts = [`${a.type}${a.format ? `/${a.format}` : ""}`, `RequiredLevel ${a.required}`];
  if (a.maxLength && !["image", "file"].includes(a.type)) facts.push(`MaxLength ${a.maxLength}`);
  if (a.min !== undefined && NUMERIC.has(a.type)) facts.push(`${a.min}..${a.max}`);
  if (["image", "file"].includes(a.type) && a.max) facts.push(`max ${a.max} KB`);
  if (a.accuracy) facts.push(`Accuracy ${a.accuracy}`);
  if (a.default) facts.push(`AppDefaultValue ${a.default}`);
  if (a.update === "0") facts.push(`ValidForUpdateApi 0${a.create === "0" ? ", ValidForCreateApi 0" : ""}`);
  if (a.source && a.source !== "0") facts.push(`SourceType ${a.source}`);
  if (a.behavior) facts.push(`Behavior ${a.behavior}`);
  if (a.autoNumber) facts.push(`AutoNumberFormat ${a.autoNumber}`);
  if (a.secured) facts.push("IsSecured 1");
  if (a.stateOptions.length) facts.push(`defaultstatus per state ${a.stateOptions.map((s) => `${s.value}→${s.defaultStatus}`).join(", ")}`);
  if (a.statusOptions.length) facts.push(`status reasons ${a.statusOptions.map((s) => `${s.value} "${s.label}" (state ${s.state})`).join(", ")}`);
  return facts.join(", ");
}

function dataverseRows(data, catalog) {
  const { generate, extras, plugins, readback, exported, formPages, tables } = data;
  const tableOf = (file) => generate.FORMS.find((form) => form.file === file).table;
  const [ITEM, PARENT, CHILD] = [tableOf("item-main"), tableOf("parent-main"), tableOf("child-main")];
  const rows = [];
  const problems = [];
  // States are filtered to the catalog item's own list; anything else in the declaration is a bug.
  const add = (id, fixture, file, anchor, states, site, extra = {}) => {
    const item = catalog.get(id);
    if (!item) return problems.push(`row for unknown catalog item ${id}`);
    const bad = states.filter((state) => !(item.states ?? []).includes(state));
    if (bad.length) problems.push(`${id}: declared states not in the catalog: ${bad.join(", ")}`);
    rows.push({ catalog: id, fixture, file, anchor, states: unique(states).filter((state) => (item.states ?? []).includes(state)), site: site ?? [], ...extra });
  };
  const keep = (id, states) => states.filter((state) => (catalog.get(id)?.states ?? []).includes(state));
  const pages = Object.fromEntries([ITEM, PARENT, CHILD].map((table) => [table, pagesFor(formPages, ...generate.FORMS.filter((form) => form.table === table && (form.type ?? 2) === 2).map((form) => form.name))]));
  const itemPages = pages[ITEM];
  const fixtureFormIds = new Set(generate.FORMS.map((form) => form.id));
  const fixtureForms = exported.forms.filter((form) => fixtureFormIds.has(form.id));
  const formFile = (id) => exported.forms.find((form) => form.id === id)?.file;
  const itemMain = exported.forms.find((form) => form.id === generate.FORMS.find((f) => f.file === "item-main").id);
  const entityFile = (table) => `${EXPORT}/Entities/${table}/Entity.xml`;
  const bound = (a) => fixtureForms.filter((form) => form.table === a.table).flatMap((form) => form.controls.filter((control) => control.attrs.datafieldname === a.name).map((control) => ({ form, control })));
  const formsOf = (a) => { const names = unique(bound(a).map(({ form }) => form.name)); return names.length ? `on fixture form(s) ${names.join(", ")}` : "on no fixture form"; };
  const extrasColumn = (a) => extras.columns.find((column) => column.table === a.table && column.name === a.name);

  const defaultedByRule = new Set(extras.businessRules.flatMap((rule) => rule.actions.filter((action) => action.type === "setDefault").map((action) => `${rule.table}.${action.field}`)));
  // Columns: one row per catalog column type and state signature, read from Entity.xml and the exported fixture forms.
  const columnStates = (a) => {
    const states = [REQUIRED[a.required]];
    if (a.maxLength && ["nvarchar", "ntext"].includes(a.type)) states.push("max-length");
    if (a.min !== undefined && NUMERIC.has(a.type)) states.push("min", "max");
    if (a.accuracy) states.push("precision");
    if (a.default || defaultedByRule.has(`${a.table}.${a.name}`)) states.push("default-value");
    if (["image", "file"].includes(a.type) && a.max) states.push("max-size");
    const uses = bound(a);
    if ((a.update === "0" && a.create === "0" && !UPLOADED.has(a.type)) || uses.some(({ control }) => control.attrs.disabled === "true")) states.push("read-only");
    if (uses.some(({ control }) => control.cell?.attrs.visible === "false")) states.push("hidden");
    return states;
  };
  const groups = new Map();
  for (const a of exported.attributes) {
    const id = columnItem(a);
    if (!id || !catalog.has(id)) continue;
    const states = keep(id, columnStates(a));
    const key = `${id}|${states.join(",")}`;
    (groups.get(key) ?? groups.set(key, { id, states, attributes: [] }).get(key)).attributes.push(a);
  }
  for (const { id, states, attributes } of [...groups.values()]) {
    const notes = attributes.map((a) => {
      const requested = extrasColumn(a)?.maxLength;
      const control = bound(a).map(({ control }) => `${control.attrs.disabled === "true" ? "disabled " : ""}${control.cell?.attrs.visible === "false" ? "hidden " : ""}`).find(Boolean);
      return `${a.table}.${a.name} (${attributeFacts(a)}${requested && a.maxLength && String(requested) !== a.maxLength ? `; extras.json requested maxLength ${requested}, the API ignored it and the export records ${a.maxLength}` : ""}${control ? `; form control ${control.trim()}${/disabled/.test(control) && a.format === "text" ? " (the seed list's \"locked\" state: a form-level disabled control)" : ""}` : ""}${defaultedByRule.has(`${a.table}.${a.name}`) ? "; default set by the business rule Set Default Value" : ""}${UPLOADED.has(a.type) && a.update === "0" ? "; ValidFor 0 is the upload-only API shape of every file/image column (learn-file-column-data), not counted as read-only" : ""}; ${formsOf(a)})`;
    });
    const pending = attributes.every((a) => extrasColumn(a)?.manual && !a.formula);
    add(id, notes.join("; ") + (pending ? " — definition not set (manual maker-portal step pending)" : ""), entityFile(attributes[0].table), attributes[0].name, pending ? [] : states, unique(attributes.flatMap((a) => pages[a.table] ?? [])), pending ? { pending: true } : {});
  }
  for (const column of extras.columns.filter((c) => c.manual && !exported.attributes.some((a) => a.table === c.table && a.name === c.name))) {
    const id = [...generate.ITEM_COLUMNS, ...generate.PARENT_COLUMNS].find((c) => c.name === column.name && c.extras?.manual)?.catalog;
    if (id) add(id, `${column.table}.${column.name} — not in the export (manual maker-portal step pending)`, GEN, column.name, [], pages[column.table] ?? [], { pending: true });
  }
  const datetimes = exported.attributes.filter((a) => a.custom && a.type === "datetime");
  add("dv.column.datetime.format", datetimes.map((a) => `${a.name} (Format ${a.format}, Behavior ${a.behavior})`).join("; "), entityFile(ITEM), datetimes[0]?.name, datetimes.map((a) => (a.format === "date" ? "date-only" : "date-and-time")), itemPages);

  // Column states, read from the export.
  const custom = exported.attributes.filter((a) => a.custom && !a.name.endsWith("_base"));
  const names = (list) => brief(list.map((a) => `${a.table === ITEM ? "" : `${a.table}.`}${a.name}`));
  const byRequired = (level) => exported.attributes.filter((a) => a.required === level);
  add("dv.state.required.none", `RequiredLevel none on ${names(custom.filter((a) => a.required === "none"))}`, entityFile(ITEM), "RequiredLevel", ["optional"], itemPages);
  add("dv.state.required.systemrequired", `RequiredLevel systemrequired in the export: ${byRequired("systemrequired").map((a) => `${a.table}.${a.name}`).join(", ")} (platform columns; custom columns cannot use this level)`, entityFile(ITEM), "systemrequired", ["required"], itemPages);
  add("dv.state.required.applicationrequired", `RequiredLevel required (ApplicationRequired) on ${byRequired("required").map((a) => `${a.table}.${a.name}`).join(", ")}`, entityFile(ITEM), "pqvd_required", ["required"], itemPages);
  add("dv.state.required.recommended", `RequiredLevel recommended on ${byRequired("recommended").map((a) => `${a.table}.${a.name}`).join(", ")}`, entityFile(ITEM), "pqvd_recommended", ["recommended"], itemPages);
  const notUpdatable = custom.filter((a) => a.update === "0");
  add("dv.state.valid-for", notUpdatable.map((a) => `${a.name} (${a.type}${a.source && a.source !== "0" ? ` SourceType ${a.source}` : ""}, ValidForUpdateApi 0, ValidForCreateApi ${a.create}${UPLOADED.has(a.type) ? "; not counted: file/image values are written through InitializeFileBlocksUpload/UploadBlock/CommitFileBlocksUpload, never Create/Update, so every such column carries these flags (learn-file-column-data)" : ""})`).join("; "), entityFile(ITEM), "pqvd_notupdatable", notUpdatable.filter((a) => !UPLOADED.has(a.type)).map((a) => (a.create === "1" ? "create-only" : "read-only")), itemPages);
  const disabled = fixtureForms.flatMap((form) => form.controls.filter((c) => c.attrs.disabled === "true" && c.attrs.datafieldname).map((c) => `${c.attrs.id} on ${form.name}`));
  add("dv.state.form.disabled", `<control disabled="true"> in the exported fixture forms: ${unique(disabled).join(", ")}. The seed list's "locked" state is this form-level disabled control (pqvd_readonly); Dataverse has no separate column-level lock.`, formFile(itemMain.id), "pqvd_readonly", disabled.length ? ["read-only"] : [], itemPages);
  const hiddenCells = fixtureForms.flatMap((form) => form.cells.filter((c) => c.attrs.visible === "false" && c.control?.attrs.datafieldname).map((c) => c.control.attrs.id));
  add("dv.state.form.hidden", `<cell visible="false"> on ${unique(hiddenCells).join(", ")}`, formFile(itemMain.id), "pqvd_hidden", hiddenCells.length ? ["hidden"] : [], itemPages);
  const noLabel = fixtureForms.flatMap((form) => form.cells.filter((c) => c.attrs.showlabel === "false" && c.control?.attrs.datafieldname).map((c) => `${c.control.attrs.id} (${form.name})`));
  add("dv.state.form.label-hidden", `<cell showlabel="false"> on bound controls: ${brief(unique(noLabel))}`, formFile(itemMain.id), "pqvd_nolabel", noLabel.length ? ["label-hidden"] : [], itemPages);
  const defaults = custom.filter((a) => a.default);
  add("dv.state.default-value", [...defaults.map((a) => `${a.name} AppDefaultValue ${a.default}`), ...[...defaultedByRule].map((key) => `${key.split(".")[1]} via business rule Set Default Value`)].join("; "), entityFile(ITEM), defaults[0]?.name, defaults.length ? ["default-value"] : [], itemPages);
  const lengths = custom.filter((a) => a.maxLength && ["nvarchar", "ntext"].includes(a.type));
  add("dv.state.max-length", `MaxLength on ${lengths.length} columns, e.g. ${lengths.slice(0, 4).map((a) => `${a.name} ${a.maxLength}`).join(", ")}`, entityFile(ITEM), "MaxLength", ["max-length"], itemPages);
  const ranges = custom.filter((a) => NUMERIC.has(a.type) && a.min !== undefined);
  add("dv.state.min-max", ranges.slice(0, 5).map((a) => `${a.name} ${a.min}..${a.max}`).join("; "), entityFile(ITEM), "MinValue", ["min", "max"], itemPages);
  const precise = custom.filter((a) => a.accuracy);
  add("dv.state.precision", precise.map((a) => `${a.name} Accuracy ${a.accuracy}`).join("; "), entityFile(ITEM), "Accuracy", ["precision"], itemPages);
  const secured = custom.filter((a) => a.secured);
  add("dv.state.secured", secured.map((a) => `${a.name} IsSecured 1`).join("; "), entityFile(ITEM), secured[0]?.name, secured.length ? ["secured"] : [], itemPages);
  const searchable = exported.attributes.filter((a) => a.searchable);
  add("dv.state.searchable-sortable", `IsSearchable 1 on ${searchable.map((a) => `${a.table}.${a.name}`).join(", ")}; IsSortableEnabled 1 on ${exported.attributes.filter((a) => a.sortable).length} columns`, entityFile(ITEM), "IsSearchable", [...(searchable.length ? ["searchable"] : []), ...(exported.attributes.some((a) => a.sortable) ? ["sortable"] : [])], itemPages);
  for (const key of exported.keys) add("dv.key.alternate", `${key.table}.${key.name} on ${key.columns.join(", ")} (EntityKey in the export); index status Active is reported by provision.mjs checkKeys after provisioning`, `${FIXTURE}/provision.mjs`, "checkKeys", ["active"], itemPages);

  // Form types: the exported forms of the fixture tables (fixture forms and the platform-created ones).
  const formsIn = (folder) => exported.forms.filter((form) => form.folder === folder);
  const formText = (list) => list.map((form) => `${form.name} (${form.table}, ${fixtureFormIds.has(form.id) ? "fixture" : "platform-created"}, FormActivationState ${form.activation ?? "n/a"})`).join("; ");
  add("dv.form-type.main", formText(formsIn("main")), itemMain.file, "formid", formsIn("main").map((form) => (form.activation === "0" ? "inactive" : "active")), itemPages);
  add("dv.form-type.activation-state", formText(formsIn("main")), itemMain.file, "formid", formsIn("main").map((form) => (form.activation === "0" ? "inactive" : "active")), itemPages);
  const cards = formsIn("card");
  const duplicates = cards.filter((card) => formsIn("main").some((main) => main.table === card.table && main.name === card.name));
  add("dv.form-type.card", `${formText(cards)}${duplicates.length ? `; same name as a main form: ${duplicates.map((form) => form.name).join(", ")}` : ""}`, cards.find((card) => fixtureFormIds.has(card.id))?.file, "formid", [], pages[PARENT]);
  add("dv.form-type.quick-view", `${formText(formsIn("quick"))}; read-only is inherent to type 6 (catalog note)`, formsIn("quick").find((form) => fixtureFormIds.has(form.id))?.file, "formid", ["read-only"], itemPages);

  // Form elements, read from the exported fixture forms.
  const all = (key) => fixtureForms.flatMap((form) => form[key].map((entry) => ({ ...entry, form })));
  const F = formFile(itemMain.id);
  add("dv.formxml.form", `${fixtureForms.length} fixture forms; <form> attributes: ${unique(fixtureForms.map((form) => Object.entries(form.formAttrs).map(([k, v]) => `${k}="${v}"`).join(" "))).join(" | ")}`, F, "form", [...(fixtureForms.some((form) => form.formAttrs.maxWidth) ? ["max-width"] : []), ...(fixtureForms.some((form) => form.formAttrs.showImage === "true") ? ["show-image"] : [])], itemPages);
  const tabs = all("tabs");
  const tabStates = tabs.flatMap(({ attrs }) => [attrs.expanded === "false" ? "collapsed" : "expanded", attrs.visible === "false" ? "hidden" : null, attrs.showlabel === "false" ? "label-hidden" : "label", attrs.availableforphone === "false" ? "hidden-on-phone" : null, attrs.locklevel && attrs.locklevel !== "0" ? "locked" : null].filter(Boolean));
  add("dv.formxml.tab", `${tabs.length} tabs; ${brief(unique(tabs.filter(({ attrs }) => attrs.expanded === "false" || attrs.visible === "false" || attrs.showlabel === "false").map(({ attrs, form }) => `${attrs.name}${attrs.expanded === "false" ? " expanded=false" : ""}${attrs.visible === "false" ? " visible=false" : ""}${attrs.showlabel === "false" ? " showlabel=false" : ""} (${form.name})`)))}`, F, "tab", tabStates, itemPages);
  const columns = all("columns");
  add("dv.formxml.tab.column", `widths ${unique(columns.map(({ attrs }) => attrs.width)).join(", ")}`, F, "column", columns.some(({ attrs }) => attrs.width) ? ["width"] : [], itemPages);
  const sections = all("sections");
  const sectionStates = sections.flatMap(({ attrs }) => [attrs.showlabel === "false" ? "label-hidden" : "label-visible", attrs.visible === "false" ? "hidden" : null, attrs.columns ? `columns-${attrs.columns.length}` : null, attrs.availableforphone === "false" ? "hidden-on-phone" : null, attrs.locklevel && attrs.locklevel !== "0" ? "locked" : null, attrs.celllabelposition ? `label-position-${attrs.celllabelposition.toLowerCase()}` : null, attrs.celllabelalignment ? `label-align-${attrs.celllabelalignment.toLowerCase()}` : null].filter(Boolean));
  add("dv.formxml.section", `${sections.length} sections; columns attribute values ${unique(sections.map(({ attrs }) => attrs.columns)).join(", ")}; celllabelposition ${unique(sections.map(({ attrs }) => attrs.celllabelposition)).join(", ")}; hidden: ${sections.filter(({ attrs }) => attrs.visible === "false").map(({ attrs }) => attrs.name).join(", ")}; unlabelled: ${brief(unique(sections.filter(({ attrs }) => attrs.showlabel === "false").map(({ attrs }) => attrs.name)))}`, F, "section", sectionStates, itemPages);
  add("dv.formxml.row", "rows chunked per section column count", F, "row", [], itemPages);
  const cells = all("cells");
  const cellStates = cells.flatMap(({ attrs, control }) => [attrs.showlabel === "false" ? "label-hidden" : null, attrs.colspan ? "colspan" : null, attrs.rowspan ? "rowspan" : null, attrs.visible === "false" ? "hidden" : null, attrs.availableforphone === "false" ? "hidden-on-phone" : null, attrs.locklevel && attrs.locklevel !== "0" ? "locked" : null, control?.attrs.disabled === "true" ? "read-only" : null].filter(Boolean));
  const cellNote = (predicate) => brief(unique(cells.filter(predicate).map(({ attrs, control }) => control?.attrs.id ?? (attrs.userspacer ? "spacer" : attrs.id))), 4);
  add("dv.formxml.cell", `colspan: ${cellNote(({ attrs }) => attrs.colspan)}; rowspan: ${cellNote(({ attrs }) => attrs.rowspan)}; visible=false: ${cellNote(({ attrs }) => attrs.visible === "false")}; showlabel=false: ${cellNote(({ attrs }) => attrs.showlabel === "false")}; disabled control: ${cellNote(({ control }) => control?.attrs.disabled === "true")}`, F, "cell", cellStates, itemPages);
  const relabelled = cells.filter(({ control, form, label }) => {
    const a = control?.attrs.datafieldname && exported.attributes.find((x) => x.table === form.table && x.name === control.attrs.datafieldname);
    return a && label && label !== a.display;
  });
  add("dv.formxml.label", `${cells.filter(({ label }) => label).length} cells carry <labels>; label differs from the column display name on ${brief(unique(relabelled.map(({ control, label }) => `${control.attrs.id} "${label}"`)), 5)}`, F, "pqvd_relabelled", cells.some(({ label }) => label) ? ["label"] : [], itemPages);
  const controls = all("controls");
  const unbound = controls.filter(({ attrs }) => !attrs.datafieldname || attrs.isunbound === "true");
  add("dv.formxml.control", `${controls.length} controls; disabled="true": ${unique(controls.filter(({ attrs }) => attrs.disabled === "true").map(({ attrs }) => attrs.id)).join(", ")}; without datafieldname: ${unique(unbound.map(({ attrs }) => attrs.id)).join(", ")}`, F, "control", [...(controls.some(({ attrs }) => attrs.disabled === "true") ? ["disabled"] : []), ...(unbound.length ? ["unbound"] : []), ...(controls.some(({ attrs }) => attrs.isrequired === "true") ? ["required-on-form"] : [])], itemPages);
  const subgrids = controls.filter((c) => c.kind === "subgrid");
  const subgridStates = subgrids.flatMap((c) => [param(c, "RelationshipName") ? "related-only" : null, param(c, "ViewId") ? "default-view" : null, param(c, "EnableViewPicker") === "true" ? (param(c, "ViewIds") ? "selected-views" : "all-views") : null, param(c, "EnableViewPicker") === "true" ? "view-picker" : null, param(c, "EnableQuickFind") === "false" ? "search-box-hidden" : null, param(c, "ChartGridMode") === "Chart" ? "chart-only" : null, param(c, "RecordsPerPage") ? "max-rows" : null].filter(Boolean));
  add("dv.formxml.subgrid", subgrids.map((c) => `${c.attrs.id} on ${c.form.name} (RelationshipName ${param(c, "RelationshipName")}, EnableViewPicker ${param(c, "EnableViewPicker")}, EnableQuickFind ${param(c, "EnableQuickFind")}, RecordsPerPage ${param(c, "RecordsPerPage")})`).join("; "), F, "subgrid_children", subgridStates, unique([...itemPages, ...pages[PARENT]]));
  const quickViews = controls.filter((c) => c.kind === "quickview");
  add("dv.formxml.quick-view", quickViews.map((c) => `${c.attrs.id} bound to ${c.attrs.datafieldname} (ControlMode ${param(c, "ControlMode")})`).join("; "), F, "quickview_parent", [...(quickViews.length ? ["read-only"] : []), ...(quickViews.some((c) => c.cell?.attrs.showlabel === "false") ? ["label-hidden"] : [])], itemPages);
  const iframes = controls.filter((c) => c.kind === "iframe");
  add("dv.formxml.iframe", iframes.map((c) => `${c.attrs.id} (Url ${param(c, "Url")}, PassParameters ${param(c, "PassParameters")}, Security ${param(c, "Security")})`).join("; "), F, "IFRAME_baseline", iframes.flatMap((c) => [param(c, "Url") ? "url" : null, param(c, "PassParameters") === "true" ? "pass-parameters" : null, param(c, "Security") === "true" ? "cross-frame-restricted" : null].filter(Boolean)), itemPages);
  const webResources = controls.filter((c) => c.kind === "webresource");
  const ownResource = exported.roots.some((r) => r.type === "61" && webResources.some((c) => param(c, "Url") === r.schemaName));
  add("dv.formxml.web-resource", webResources.map((c) => `${c.attrs.id} (Url ${param(c, "Url")}${ownResource ? ", a web resource root component of the fixture solution" : ""})`).join("; "), F, "WebResource_baseline", [], itemPages);
  const spacers = cells.filter(({ attrs }) => attrs.userspacer === "true");
  if (spacers.length) add("dv.formxml.spacer", `${spacers.length} cell(s) with userspacer="true" and no control`, F, "userspacer", [], itemPages);
  const notes = controls.filter((c) => c.kind === "notes");
  if (notes.length) add("dv.formxml.timeline-notes", `${notes.map((c) => c.attrs.id).join(", ")} (no parameters)`, F, "notescontrol", [], itemPages);
  // Control kinds: every CLASSIDS kind with a catalog item, as used by the exported item main form.
  for (const [kind, classid] of Object.entries(generate.CLASSIDS)) {
    const id = `dv.control.${kind}`;
    if (!catalog.has(id)) continue;
    const uses = itemMain.controls.filter((c) => c.kind === kind);
    if (!uses.length) continue;
    const attributes = uses.map((c) => exported.attributes.find((a) => a.table === ITEM && a.name === c.attrs.datafieldname)).filter(Boolean);
    const states = ["classid", ...attributes.flatMap((a) => [a.maxLength && ["nvarchar", "ntext"].includes(a.type) ? "max-length" : null, NUMERIC.has(a.type) && a.min !== undefined ? "min" : null, NUMERIC.has(a.type) && a.max !== undefined ? "max" : null, a.accuracy ? "precision" : null, a.default ? "default-value" : null, a.type === "datetime" ? (a.format === "date" ? "date-only" : "date-and-time") : null].filter(Boolean)), ...uses.flatMap((c) => [param(c, "DefaultViewId") ? "default-view" : null, param(c, "FilterRelationshipName") ? "related-filter" : null].filter(Boolean))];
    add(id, `classid ${classid} on ${brief(unique(uses.map((c) => c.attrs.id)), 8)}`, itemMain.file, classid, keep(id, states), itemPages);
  }

  // Views: every exported SavedQuery of the fixture tables, by query type.
  const fixtureViewIds = new Set(generate.VIEWS.map((view) => view.id));
  const adjustments = extras.platformViewAdjustments;
  const origin = (view) => {
    if (fixtureViewIds.has(view.id)) return "fixture view";
    const adjustment = adjustments.find((entry) => entry.table === view.table && entry.queryType === view.queryType);
    if (adjustment) return adjustment.retainDefault ? "platform view, definition retained (the generator writes no Quick Find file)" : `platform view, definition adjusted from ${adjustment.fetchFile}`;
    return "platform-created with the table";
  };
  const viewText = (views) => views.map((view) => `${view.name} (${view.table}, ${view.id.slice(0, 8)}, ${origin(view)}${view.isDefault ? ", isdefault" : ""})`).join("; ");
  const listPages = ["/baseline/item-list/", "/baseline/item-list-filters/", "/baseline/item-edit/ (subgrid, lookups)"];
  const typeItems = new Map([...catalog.values()].map((item) => [Number(/SavedQuery\.QueryType=(\d+)/.exec(item.where ?? "")?.[1]), item.id]).filter(([type]) => !Number.isNaN(type)));
  const unmapped = [];
  for (const type of unique(exported.views.map((view) => view.queryType)).sort((a, b) => a - b)) {
    const views = exported.views.filter((view) => view.queryType === type);
    if (!typeItems.has(type)) { unmapped.push(...views); continue; }
    const quickFind = type === 4 ? `. The exported Quick Find views are the platform defaults, unadjusted: search fields ${views.map((view) => `${view.table} ${view.quickFindFields.join("+") || "none"}`).join(", ")}; columns ${unique(views.flatMap((view) => view.cells.map((cell) => `${cell.name} ${cell.width}`))).join(", ")}. generate.mjs writes no Quick Find definition (extras.json marks the platform view retainDefault; provision.mjs records platform-default-retained), so no other view row counts these views` : "";
    add(typeItems.get(type), `${viewText(views)}${quickFind}`, views[0].file, "querytype", [], type === 4 ? ["/baseline/item-list/ (search)"] : listPages);
  }
  const defaultViews = exported.views.filter((view) => view.isDefault && view.queryType === 0);
  const twoDefaults = tables.filter((table) => defaultViews.filter((view) => view.table === table).length > 1);
  add("dv.view.isdefault", `${viewText(defaultViews)}${twoDefaults.length ? `. The export carries more than one isdefault public view on ${twoDefaults.join(", ")} (Learn customize-entity-views: only one active public view can be default; view state is not exported, so which one is active is OPEN until a savedquery read-back)` : ""}`, defaultViews[0]?.file, "isdefault", defaultViews.length ? ["default"] : [], listPages);
  const quickFinds = exported.views.filter((view) => view.isQuickFind);
  add("dv.view.isquickfindquery", viewText(quickFinds), quickFinds[0]?.file, "isquickfindquery", [], ["/baseline/item-list/ (search)"]);
  // Views whose definition the fixture sets: its own views and the applied platform-view adjustments (retainDefault ones are platform defaults).
  const fixtureViews = exported.views.filter((view) => fixtureViewIds.has(view.id) || adjustments.some((a) => !a.retainDefault && a.table === view.table && a.queryType === view.queryType));
  add("dv.view.layoutxml.grid", `${fixtureViews.length} fixture or adjusted views (${fixtureViews.filter((view) => fixtureViewIds.has(view.id)).length} fixture, ${fixtureViews.filter((view) => !fixtureViewIds.has(view.id)).length} adjusted platform views; the ${adjustments.filter((entry) => entry.retainDefault).length} retained platform Quick Find views are not counted) carry <grid name="resultset">`, fixtureViews[0]?.file, "layoutxml", [], ["/baseline/item-list/"]);
  const viewCells = fixtureViews.flatMap((view) => view.cells);
  add("dv.view.layoutxml.cell", `widths ${unique(viewCells.map((cell) => cell.width)).sort((a, b) => a - b).join(", ")}`, fixtureViews[0]?.file, "cell", [viewCells.some((cell) => cell.width) ? "width" : null, viewCells.some((cell) => cell.disableSorting === "1") ? "sort-disabled" : null, viewCells.some((cell) => cell.imageproviderwebresource) ? "icon-provider" : null].filter(Boolean), ["/baseline/item-list/"]);
  add("dv.view.fetchxml.columns", `${fixtureViews.length} views; up to ${Math.max(...fixtureViews.map((view) => view.cells.length))} layout columns`, fixtureViews[0]?.file, "fetchxml", [], ["/baseline/item-list/"]);
  const orders = fixtureViews.flatMap((view) => view.orders);
  add("dv.view.fetchxml.order", unique(fixtureViews.filter((view) => view.orders.length).map((view) => `${view.name}: ${view.orders.map((o) => `${o.attribute} ${o.descending === "true" ? "desc" : "asc"}`).join(", ")}`)).join("; "), fixtureViews[0]?.file, "order", unique(orders.map((o) => (o.descending === "true" ? "descending" : "ascending"))), ["/baseline/item-list/"]);
  add("dv.view.fetchxml.filter", `${fixtureViews.filter((view) => view.filters).length} views with conditions, ${fixtureViews.filter((view) => !view.filters).length} without`, fixtureViews[0]?.file, "filter", [], ["/baseline/item-list/"]);
  const linked = fixtureViews.filter((view) => view.links);
  if (linked.length) add("dv.view.fetchxml.link-entity", linked.map((view) => view.name).join("; "), linked[0].file, "link-entity", [], ["/baseline/item-list/"]);
  const ppCovered = (id) => (data.site.records ?? []).some((record) => (record.catalog ?? []).includes(id));
  add("dv.view.powerpages.list", `lists on /baseline/item-list* (Power Pages inventory: pp.list.views ${ppCovered("pp.list.views") ? "exercised" : "not exercised"}, pp.list.sorting ${ppCovered("pp.list.sorting") ? "exercised" : "not exercised"}, pp.list.pagesize ${ppCovered("pp.list.pagesize") ? "exercised" : "not exercised"}, pp.list.modern ${ppCovered("pp.list.modern") ? "exercised" : "not exercised"})`, SITE, "list", [ppCovered("pp.list.views") ? "multiple-views" : null, ppCovered("pp.list.sorting") ? "sorting" : null, ppCovered("pp.list.pagesize") ? "paging" : null, ppCovered("pp.list.modern") ? "infinite-scroll" : null].filter(Boolean), ["/baseline/item-list/"]);
  add("dv.view.powerpages.subgrid", `${subgrids.map((c) => `${c.attrs.id} (ViewId ${param(c, "ViewId")})`).join("; ")}`, F, "subgrid_children", [], itemPages);

  // Business rules: extras.json declarations cross-checked with the exported workflows.
  const SCOPE = { 2: "entity" };
  const exportedScope = (workflow) => SCOPE[workflow.triggerScope] ?? (workflow.triggerForm ? "form" : "all-forms");
  const ACTIONS = { visibility: "SetVisibility", lock: "SetDisplayMode", required: "SetFieldRequiredLevel", setDefault: "SetDefaultValue", setValue: "SetAttributeValue", clearValue: "SetAttributeValue", error: "SetMessage" };
  const rules = extras.businessRules.map((rule) => {
    const workflow = exported.workflows.find((w) => w.id === bare(rule.id));
    const types = unique([...rule.actions, ...(rule.otherwise ?? [])].map((action) => action.type));
    const mismatch = !workflow ? ["not in the export"] : [
      exportedScope(workflow) !== rule.scope ? `export scope ${exportedScope(workflow)}` : null,
      rule.scope === "form" && workflow.triggerForm !== bare(rule.formId) ? "export form differs" : null,
      ...types.filter((type) => !workflow.activities.includes(ACTIONS[type]) || (type === "clearValue" && !workflow.clears)).map((type) => `no ${ACTIONS[type]} for ${type}`),
      workflow.category !== "2" ? `Category ${workflow.category}` : null,
    ].filter(Boolean);
    if (mismatch.length) problems.push(`business rule ${rule.name}: ${mismatch.join(", ")}`);
    return { ...rule, types, workflow, mismatch };
  });
  const ruleText = (list) => list.map((rule) => `${rule.name} (${rule.id.slice(0, 8)}, ProcessTriggerScope ${rule.workflow?.triggerScope}${rule.workflow?.triggerForm ? `, form ${rule.workflow.triggerForm.slice(0, 8)}` : ""}, StateCode ${rule.workflow?.state})`).join("; ");
  const ruleFile = (list) => list[0]?.workflow?.file ?? EXTRAS;
  const sideStates = (list) => unique(list.flatMap((rule) => (rule.scope === "entity" ? ["server-side", "client-side"] : ["client-side"])));
  for (const scope of ["entity", "all-forms", "form"]) {
    const list = rules.filter((rule) => rule.scope === scope && !rule.mismatch.length);
    if (list.length) add(`dv.br.scope.${scope}`, ruleText(list), ruleFile(list), "ProcessTriggerScope", sideStates(list), itemPages);
  }
  const ACTION_ITEMS = { visibility: "visibility", lock: "lock-unlock", required: "required", setDefault: "set-default", setValue: "set-value", clearValue: "clear-value", error: "show-error" };
  for (const [type, item] of Object.entries(ACTION_ITEMS)) {
    const list = rules.filter((rule) => rule.types.includes(type) && !rule.mismatch.length);
    if (!list.length) continue;
    const fields = unique(list.flatMap((rule) => [...rule.actions, ...(rule.otherwise ?? [])].filter((action) => action.type === type).map((action) => action.field)));
    add(`dv.br.action.${item}`, `${ruleText(list)} on ${fields.join(", ")} (xaml ${ACTIONS[type]}${type === "clearValue" ? ' Value="[Nothing]"' : ""})`, list[0].workflow.xamlFile, ACTIONS[type], keep(`dv.br.action.${item}`, sideStates(list)), itemPages);
  }
  const touched = unique(rules.flatMap((rule) => [...rule.actions, ...(rule.otherwise ?? [])].map((action) => action.field))).map((field) => [field, rules.filter((rule) => [...rule.actions, ...(rule.otherwise ?? [])].some((action) => action.field === field))]).filter(([, list]) => list.length > 1);
  if (touched.length) add("dv.br.execution-order", `${touched.map(([field, list]) => `${field} is changed by ${list.map((rule) => `${rule.name} (${rule.scope} scope)`).join(" and ")}`).join("; ")}. Learn gives no ordering contract between rules; ordering requires native observations and is not asserted by this metadata inventory`, EXTRAS, "businessRules", [], itemPages);
  const conditions = unique(rules.map((rule) => `${Object.keys(rule.when).find((k) => k !== "field")} ${rule.when.field}`));
  add("dv.br.condition", conditions.join("; "), EXTRAS, "when", [], itemPages);
  add("dv.br.storage", `${rules.length} rules exported as workflows (Category ${unique(rules.map((rule) => rule.workflow?.category)).join("/")}, Type ${unique(rules.map((rule) => rule.workflow?.type)).join("/")}), StateCode ${unique(rules.map((rule) => rule.workflow?.state)).join("/")}`, ruleFile(rules), "StateCode", unique(rules.map((rule) => (rule.workflow?.state === "1" ? "active" : "inactive"))), itemPages);
  add("dv.br.powerpages", "Learn (basic-forms#considerations): basic forms do not support business rules; the fixture carries rules for explicit native comparison of actual portal behavior", EXTRAS, "businessRules", [], itemPages);

  // Plugins: plugins.json (what was registered) + plugins-readback.json (what Dataverse reports) + the export.
  const steps = plugins.steps.map((step) => ({ ...step, read: readback?.steps.find((r) => r.id === step.id), exported: exported.steps.find((s) => s.id === step.id) }));
  if (!readback) problems.push(`${READBACK} is missing; run plugins.mjs --verify`);
  const RB = READBACK;
  const modeName = (mode) => (mode === 1 ? "asynchronous" : "synchronous");
  const stepText = (list) => list.map((step) => `${step.message} ${step.read?.stage ?? step.stage}/rank ${step.read?.rank ?? step.rank} (${step.kind})`).join("; ");
  for (const stage of [10, 20, 40]) {
    const list = steps.filter((step) => step.read?.stage === stage);
    add(`dv.plugin.stage.${stage}`, stepText(list), RB, "stage", unique(list.map((step) => modeName(step.read.mode))), itemPages);
  }
  for (const message of unique(steps.map((step) => step.message))) add(`dv.plugin.message.${message.toLowerCase()}`, stepText(steps.filter((step) => step.message === message)), PLUGINS, message, [], itemPages);
  const readSteps = steps.filter((step) => step.read?.found);
  add("dv.plugin.mode", readSteps.filter((step) => step.read.mode === 1).map((step) => `${step.message} ${step.read.stage} mode 1, asyncautodelete ${step.read.asyncAutoDelete}`).join("; ") + `; ${readSteps.filter((step) => step.read.mode === 0).length} steps mode 0`, RB, "mode", unique(readSteps.map((step) => modeName(step.read.mode))), itemPages);
  const mutation = steps.filter((step) => step.kind === "mutate");
  if (mutation.length) add("dv.plugin.mutation", `${stepText(mutation)} rewrite pqvd_ticker (upper/trim) and pqvd_textarea (\`mutate-me\`) in the Target before the write`, "examples/project/components/DataversePlugins/BaselineRules.cs", "BaselineRules", ["input mutation"], itemPages);
  const impersonated = readSteps.filter((step) => step.read.impersonation !== "calling-user");
  if (impersonated.length) add("dv.plugin.impersonation", impersonated.map((step) => `${step.message} ${step.read.stage}/rank ${step.read.rank}: impersonatinguserid = ${step.read.impersonation} (read back)`).join("; "), RB, "impersonation", [], itemPages);
  const ranks = unique(readSteps.map((step) => step.read.rank)).sort((a, b) => a - b);
  add("dv.plugin.rank", ranks.map((rank) => `rank ${rank}: ${stepText(readSteps.filter((step) => step.read.rank === rank))}`).join(" — "), RB, "rank", [], itemPages);
  const filtered = readSteps.filter((step) => step.read.filteringAttributes);
  add("dv.plugin.filtering-attributes", filtered.map((step) => `${step.message} ${step.read.stage}/rank ${step.read.rank}: ${step.read.filteringAttributes}`).join("; "), RB, "filteringAttributes", [], itemPages);
  const imaged = readSteps.filter((step) => step.read.images.length);
  add("dv.plugin.images", imaged.map((step) => `${step.message} ${step.read.stage}: ${step.read.images.map((image) => `${image.type} ${image.name} (${image.attributes})`).join(", ")}`).join("; "), RB, "images", unique(imaged.flatMap((step) => step.read.images.map((image) => (image.type === "PostImage" ? "post-image" : "pre-image")))), itemPages);
  const failing = steps.filter((step) => step.kind === "fail");
  add("dv.plugin.invalid-plugin-exception", `InvalidPluginExecutionException on sentinel plugin-fail-<message>-<stage> from ${failing.length} steps (${unique(failing.map((step) => step.message)).join(", ")})`, "examples/project/components/DataversePlugins/BaselineRules.cs", "BaselineRules", failing.length ? ["error"] : [], itemPages);
  const configured = readSteps.filter((step) => step.read.configuration);
  add("dv.plugin.configuration", unique(configured.map((step) => step.read.configuration)).map((value) => `unsecure configuration \`${value}\` on ${stepText(configured.filter((step) => step.read.configuration === value))}`).join("; "), RB, "configuration", [], itemPages);
  const disabledSteps = readSteps.filter((step) => step.read.statecode === 1);
  add("dv.plugin.state", `read back: ${readSteps.filter((step) => step.read.statecode === 0).length} steps statecode 0; ${disabledSteps.map((step) => `${step.message} ${step.read.stage}/rank ${step.read.rank} statecode ${step.read.statecode} statuscode ${step.read.statuscode}`).join("; ") || "none disabled"}${exported.steps.some((s) => s.stateInExport) ? "" : " (the solution export carries no StateCode for steps)"}`, RB, "statecode", unique(readSteps.map((step) => (step.read.statecode === 1 ? "disabled" : "enabled"))), itemPages);
  const sources = unique(readSteps.map((step) => step.read.invocationSource)).sort();
  const exportAgrees = readSteps.every((step) => step.exported?.invocationSource === step.read.invocationSource);
  add("dv.plugin.invocation-source", sources.map((value) => `${value} (${{ "-1": "Internal", 0: "Parent", 1: "Child" }[value]}) on ${stepText(readSteps.filter((step) => step.read.invocationSource === value))}`).join(" — ") + ` — read back; the export ${exportAgrees ? "agrees step for step" : "DIFFERS"}. plugins.mjs does not set invocationsource, so these are the values the platform assigned (learn-sdkstep-table: -1 Internal, 0 Parent, 1 Child)`, RB, "invocationSource", [], itemPages);

  // Relationships, from Other/Relationships/*.xml. Fixture relationships are those whose referencing attribute is a
  // custom lookup/customer column; the rest (owner, business unit, currency, file attachment, created/modified by)
  // come with the tables and are listed only as platform context.
  const lookups = new Map(custom.filter((a) => ["lookup", "customer"].includes(a.type)).map((a) => [`${a.table}.${a.name}`, a]));
  const ownRelationships = exported.relationships.filter((r) => lookups.has(`${r.referencing}.${r.attribute}`));
  const platformRelationships = exported.relationships.filter((r) => !ownRelationships.includes(r));
  const kindOf = (r) => (r.referenced === r.referencing ? "self-referential" : lookups.get(`${r.referencing}.${r.attribute}`).type === "customer" ? "customer" : lookups.get(`${r.referencing}.${r.attribute}`).lookupStyle === "polymorphic" ? "multi-table" : "simple");
  const relationshipPages = (list) => unique(list.flatMap((r) => [...(pages[r.referencing] ?? []), ...(pages[r.referenced] ?? [])])).sort();
  const oneToMany = ownRelationships.filter((r) => r.type === "OneToMany");
  if (oneToMany.length) add("dv.relationship.one-to-many", `${oneToMany.map((r) => `${r.name}: ${r.referenced} 1:N ${r.referencing}.${r.attribute} (${kindOf(r)}${r.hierarchical ? ", IsHierarchical 1" : ""})`).join("; ")}; ${platformRelationships.length} platform relationships come with the tables and are not counted`, oneToMany[0].file, oneToMany[0].name, oneToMany.map(kindOf), relationshipPages(oneToMany));
  const manyToMany = ownRelationships.filter((r) => r.type === "ManyToMany");
  if (manyToMany.length) add("dv.relationship.many-to-many", manyToMany.map((r) => r.name).join("; "), manyToMany[0].file, manyToMany[0].name, ["native"], relationshipPages(manyToMany));
  const DELETE = { Cascade: "cascade", RemoveLink: "remove-link", Restrict: "restrict" };
  const platformRestrict = platformRelationships.filter((r) => r.cascade.Delete === "Restrict").map((r) => r.name);
  if (oneToMany.length) add("dv.relationship.cascade.delete", `${oneToMany.map((r) => `${r.name} CascadeDelete ${r.cascade.Delete} (CascadeArchive ${r.cascade.Archive})`).join("; ")}${platformRestrict.length ? `; platform relationships with Restrict, not counted: ${platformRestrict.join(", ")}` : ""}`, oneToMany[0].file, "CascadeDelete", oneToMany.map((r) => DELETE[r.cascade.Delete]).filter(Boolean), relationshipPages(oneToMany));
  const OWNERSHIP = { NoCascade: "no-cascade", Cascade: "cascade", Active: "active", UserOwned: "user-owned" };
  const ownershipValues = (r) => ["Assign", "Share", "Unshare", "Reparent"].map((action) => `${action} ${r.cascade[action]}`);
  if (oneToMany.length) add("dv.relationship.cascade.ownership", unique(oneToMany.map((r) => ownershipValues(r).join(", "))).map((values) => `${values} on ${oneToMany.filter((r) => ownershipValues(r).join(", ") === values).map((r) => r.name).join(", ")}`).join("; "), oneToMany[0].file, "CascadeAssign", oneToMany.flatMap((r) => ["Assign", "Share", "Unshare", "Reparent"].map((action) => OWNERSHIP[r.cascade[action]])).filter(Boolean), relationshipPages(oneToMany));

  // Solution dependencies, from Solution.xml.
  const tableRoots = exported.roots.filter((r) => r.type === "1" && tables.includes(r.schemaName));
  add("dv.solution.dependencies", `${exported.missing.length} MissingDependency entries outside the System layer (${exported.systemMissing} System-layer entries, present on every import); fixture tables as root components with behavior ${unique(tableRoots.map((r) => r.behavior)).join("/")} (all subcomponents, so statecode/statuscode/createdon/modifiedon/ownerid/primary keys travel with the tables); web resource root ${exported.roots.filter((r) => r.type === "61").map((r) => r.schemaName).join(", ")}${exported.missing.length ? `; missing: ${exported.missing.map((m) => `${m.required.schemaName ?? m.required.displayName} (type ${m.required.type}, solution ${m.required.solution}) required by ${m.dependent.schemaName ?? m.dependent.displayName}`).join("; ")}` : ""}`, `${EXPORT}/Other/Solution.xml`, "MissingDependencies", exported.missing.length ? ["missing-dependency"] : ["self-contained"], []);

  // Column security, from FieldSecurityProfiles.xml.
  add("dv.security.profile", `${exported.profileName} (${exported.permissions.length} column permission(s), no members)`, `${EXPORT}/Other/FieldSecurityProfiles.xml`, "FieldSecurityProfile", [], itemPages);
  for (const [permission, field] of [["read", "read"], ["update", "update"], ["create", "create"]]) {
    const denied = exported.permissions.filter((p) => p[field] === "0");
    add(`dv.security.permission.${permission}`, denied.map((p) => `${p.table}.${p.column} Can${permission[0].toUpperCase()}${permission.slice(1)} 0`).join("; "), `${EXPORT}/Other/FieldSecurityProfiles.xml`, `Can${permission[0].toUpperCase()}${permission.slice(1)}`, denied.length ? [`${permission}-denied`] : [], itemPages);
  }
  add("dv.security.permission.read-unmasked", exported.permissions.map((p) => `${p.table}.${p.column} CanReadUnmasked ${p.readUnmasked}`).join("; "), `${EXPORT}/Other/FieldSecurityProfiles.xml`, "CanReadUnmasked", [], itemPages);
  // State reasons that cite export values (read here so they cannot drift from the export).
  const owners = exported.attributes.filter((a) => a.type === "owner");
  const statecodes = exported.attributes.filter((a) => a.type === "state");
  const customReasons = exported.attributes.filter((a) => a.type === "status").flatMap((a) => a.statusOptions.filter((o) => !statecodes.find((s) => s.table === a.table)?.stateOptions.some((st) => st.defaultStatus === o.value)).map((o) => `${a.table} ${o.value} (state ${o.state})`));
  const localChoices = exported.attributes.filter((a) => columnItem(a) === "dv.column.choice.local");
  const globalDefaults = exported.attributes.filter((a) => columnItem(a) === "dv.column.choice.global" && a.default);
  const dynamicReasons = {
    "dv.column.lookup.owner": {
      recommended: `not varied: ownerid is exported RequiredLevel systemrequired with CanModifyRequirementLevelSettings ${unique(owners.map((a) => `${a.canModifyRequired} on ${a.table}`)).join(", ")}, so the managed property would allow a change; the fixture keeps the platform level because every user/team-owned row has an owner (the platform assigns the calling user when none is given, see default-value), so a recommended owner would not change what a portal form can save. OPEN: a recommended owner marker is not exercised by this fixture and requires separate native qualification`,
    },
    "dv.column.status": {
      "default-value": `not varied: the export carries the default status reason per state on statecode (${statecodes.map((a) => `${a.table}: ${a.stateOptions.map((o) => `<state value="${o.value}" defaultstatus="${o.defaultStatus}">`).join(" ")}`).join("; ")}; StateOptionMetadata.DefaultStatus, learn-stateoption-defaultstatus). These are the platform defaults; the custom reasons ${customReasons.join(", ") || "(none)"} are not defaults. OPEN: make a custom reason the default of its state (UpdateStateValue with DefaultStatusCode) in provision.mjs and re-export`,
    },
    "dv.column.choice.local": {
      "default-value": `OPEN: ${localChoices.map((a) => a.name).join(", ")} is exported without AppDefaultValue, while ${globalDefaults.map((a) => `${a.name} carries AppDefaultValue ${a.default}`).join(", ")} (row dv.column.choice.global), so a metadata default on a choice is exercised only on the global-option-set column. A local choice differs only in owning its options (OptionSetMetadata IsGlobal false); PicklistAttributeMetadata.DefaultFormValue applies to both. Resolve: add a default to the pqvd_localchoice extras in generate.mjs and pass DefaultFormValue in the provision.mjs localchoice case (lense/dataverse/manifest.mjs already does for global choices), then re-provision`,
    },
  };
  return { rows, problems, unmapped, dynamicReasons };
}

// Reasons for catalog states a row set does not exercise. Keys: "<item id>" → { state: reason } or
// "*<area>" → { state: reason } as a fallback for every item of that area. Reasons are specific: platform-
// enforced, not expressible by API, covered elsewhere (with the row id), or OPEN with what resolves it.
const SAME_FAMILY = (state) => `covered elsewhere: ${state} is a form/metadata property independent of the column format (see dv.state.${state === "hidden" ? "form.hidden" : state === "read-only" ? "form.disabled" : state === "required" ? "required.applicationrequired" : "required.recommended"} on text columns)`;
const STRING_DEFAULT = "covered elsewhere: this column type has no metadata default (AppDefaultValue exists only on Yes/No and Choice columns, learn-column-definitions); a default comes from a business rule Set Default Value or column mapping (catalog dv.state.default-value), which the fixture exercises once, on the text column pqvd_defaultbyrule (rows dv.column.string.text and dv.br.action.set-default)";
const STATE_REASONS = {
  "*column-type": {
    required: SAME_FAMILY("required"), recommended: SAME_FAMILY("recommended"), hidden: SAME_FAMILY("hidden"), "read-only": SAME_FAMILY("read-only"),
    "default-value": STRING_DEFAULT, optional: "covered elsewhere: requirement level none is exercised by dv.state.required.none",
  },
  "dv.column.string.autonumber": { "read-only": "OPEN: the autonumber control is disabled on the form but the column stays ValidForUpdateApi 1 (Learn create-auto-number-attributes: values can be set on create); a read-only autonumber needs IsValidForUpdate false, which provision.mjs does not set" },
  "dv.column.bigint": { "read-only": "OPEN: pqvd_bigint is exported ValidForUpdateApi 1 and its form control is enabled; the catalog's read-only state applies to platform Time Stamp columns (versionnumber), which are not on fixture forms" },
  "dv.column.state": { "read-only": "platform-enforced: statecode is changed only through SetState/Update of statecode, never through the form control; the catalog state is inherent, not configured, and the fixture form control is enabled (OPEN: native form rendering requires separate qualification)" },
  "dv.column.uniqueidentifier": { "read-only": "platform-enforced: primary keys are ValidForUpdateApi 0 (see row dv.column.uniqueidentifier facts); not placed on a form" },
  "dv.column.image": { optional: "covered by the row: entityimage RequiredLevel none", "read-only": "OPEN: no disabled image control in the fixture forms; add disabled=true to the entityimage cell in generate.mjs", hidden: "OPEN: no hidden image cell; add visible=false in generate.mjs" },
  "dv.column.file": { hidden: "OPEN: no hidden file cell; add visible=false in generate.mjs", "read-only": "OPEN: ValidForCreateApi 0 / ValidForUpdateApi 0 on pqvd_file is the upload-only API shape of every File column (values go through InitializeFileBlocksUpload/UploadBlock/CommitFileBlocksUpload, learn-file-column-data), not a read-only setting, and the pqvd_file control on the item main form is disabled=\"false\"; add disabled=true to a pqvd_file cell in generate.mjs" },
  "dv.column.lookup.owner": { "default-value": "platform-enforced: ownerid defaults to the creating user; there is no metadata default to configure", optional: "platform-enforced: ownerid is SystemRequired", "read-only": SAME_FAMILY("read-only"), hidden: SAME_FAMILY("hidden") },
  "dv.column.lookup.customer": { "default-value": STRING_DEFAULT },
  "dv.column.lookup.polymorphic": { "default-value": STRING_DEFAULT },
  "dv.column.lookup": { "default-value": STRING_DEFAULT },
  "dv.column.choices.multiselect": {},
  "dv.column.memo": { "default-value": STRING_DEFAULT },
  "dv.column.datetime.format": {},
  "dv.state.secured": { masked: "OPEN: no masking rule is configured (CanReadUnmasked 0 without a rule has no effect, learn-column-security); add a secured masking rule and a column using it" },
  "dv.state.valid-for": {},
  "dv.state.searchable-sortable": { sortable: "not varied: IsSortableEnabled is 0 on every exported column (platform default); OPEN until a column sets it" },
  "dv.key.alternate": {
    pending: "platform-enforced transient: EntityKeyIndexStatus Pending precedes Active while the asynchronous index job runs (learn-alternate-keys); not a stable fixture state",
    "in-progress": "platform-enforced transient: EntityKeyIndexStatus InProgress during the asynchronous index job (learn-alternate-keys)",
    failed: "OPEN: needs duplicate key values when the index job runs; not attempted because it disables upsert by key for the data provisioning",
  },
  "dv.form-type.main": { default: "not expressible in the export: no default-form marker is carried on main systemforms (form order is per app/security role); Power Pages renders forms by name (pp-basic-forms)", inactive: "OPEN: every main form is FormActivationState 1; inactive-form behavior requires a page naming an inactive form and a native capture" },
  "dv.form-type.activation-state": { inactive: "OPEN: every main form is FormActivationState 1; see dv.form-type.main" },
  "dv.form-type.quick-view": { "hidden-when-lookup-empty": "runtime state, not configuration: requires rendering an item without pqvd_parentid and observing the native result" },
  "dv.formxml.form": { "max-width": "OPEN: no fixture form sets maxWidth; set it on one form in generate.mjs", "show-image": "OPEN: every fixture form sets showImage=\"false\"; set showImage=\"true\" on one form in generate.mjs" },
  "dv.formxml.tab": { "hidden-on-phone": "OPEN: no availableforphone=\"false\" tab; add it in generate.mjs", locked: "OPEN: tabs carry no locklevel; add locklevel=\"1\" in generate.mjs" },
  "dv.formxml.section": {
    "columns-3": "OPEN: no three-column section; add columns=\"111\" in generate.mjs", "columns-4": "OPEN: no four-column section; add columns=\"1111\" in generate.mjs",
    "hidden-on-phone": "OPEN: no availableforphone=\"false\" section; add it in generate.mjs", locked: "OPEN: sections carry no locklevel; add locklevel=\"1\" in generate.mjs",
    "label-position-left": "OPEN: every section uses celllabelposition=\"Top\"; add Left in generate.mjs",
    "label-align-left": "OPEN: no celllabelalignment attribute; add it in generate.mjs", "label-align-center": "OPEN: no celllabelalignment attribute; add it in generate.mjs", "label-align-right": "OPEN: no celllabelalignment attribute; add it in generate.mjs",
  },
  "dv.formxml.cell": { "hidden-on-phone": "OPEN: no availableforphone=\"false\" cell; add it in generate.mjs", locked: "OPEN: fixture cells carry no locklevel other than the platform card forms' locklevel=\"0\"; add locklevel=\"1\" in generate.mjs" },
  "dv.formxml.control": { "required-on-form": "OPEN: no control carries isrequired=\"true\"; requirement comes from column metadata and business rules (dv.br.action.required)" },
  "dv.formxml.subgrid": { "view-picker": "OPEN: both subgrids set EnableViewPicker false; add a subgrid with the view picker in generate.mjs", "all-views": "OPEN: needs EnableViewPicker true without ViewIds", "selected-views": "OPEN: needs EnableViewPicker true with ViewIds", "search-box-hidden": "OPEN: both subgrids set EnableQuickFind true", "chart-only": "OPEN: no ChartGridMode; chart-only subgrid rendering requires a configured fixture and native qualification" },
  "dv.formxml.quick-view": { "hidden-when-lookup-empty": "runtime state, not configuration: requires rendering an item without pqvd_parentid and observing the native result", "label-hidden": "OPEN: the quick view cell shows its label; add showlabel=false in generate.mjs" },
  "dv.formxml.iframe": { "pass-parameters": "OPEN: IFRAME_baseline sets PassParameters false; set true in generate.mjs" },
  "dv.formxml.timeline-notes": Object.fromEntries(["create-enabled", "attachment-location", "mime-restricted", "max-file-size"].map((state) => [state, "covered elsewhere: these are Power Pages Basic Form Metadata Notes settings (Power Pages inventory pp.bfmeta.notes.*); the Dataverse notescontrol carries no parameters"])),
  "dv.control.lookup": { "default-view": "OPEN: no lookup control sets DefaultViewId; lookups use the table's Lookup view (dv.view.querytype.lookup)", "related-filter": "OPEN: no lookup control sets FilterRelationshipName" },
  "dv.control.picklist": {},
  "dv.view.layoutxml.cell": { "sort-disabled": "OPEN: no view cell sets disableSorting=\"1\"", "icon-provider": "OPEN: no view cell sets imageproviderwebresource (needs a JavaScript web resource)" },
  "dv.view.isdefault": {},
  "dv.view.powerpages.list": { "infinite-scroll": "covered elsewhere: infinite scroll belongs to modern lists (pp.list.modern), which the Power Pages inventory reports as not exercised" },
  "dv.view.powerpages.subgrid": { "read-only": "OPEN: both fixture subgrids have Basic Form Metadata actions (Power Pages inventory pp.bfmeta.type.subgrid); a read-only subgrid needs a form subgrid without metadata" },
  "dv.br.storage": { inactive: "OPEN: every exported rule is StateCode 1 (activated); whether the portal ignores a Draft rule (StateCode 0) requires a separately configured draft fixture and native comparison" },
  "dv.plugin.stage.10": { asynchronous: "platform-enforced: only PostOperation supports asynchronous steps (learn-register-plugin)" },
  "dv.plugin.stage.20": { asynchronous: "platform-enforced: only PostOperation supports asynchronous steps (learn-register-plugin)" },
  "dv.relationship.one-to-many": { "self-referential": "OPEN: no fixture lookup targets its own table (every exported fixture relationship has distinct referenced and referencing tables); add a self-referential lookup, e.g. pqvd_baselineitem to pqvd_baselineitem, to the manifest relationships in generate.mjs" },
  "dv.relationship.cascade.delete": { restrict: "OPEN: no fixture relationship sets CascadeDelete Restrict (only the platform relationships listed on the row do, and the fixture does not configure them); set cascade: { Delete: \"Restrict\" } on one manifest relationship in generate.mjs (lense/dataverse/manifest.mjs accepts it) and re-provision" },
  "dv.relationship.cascade.ownership": Object.fromEntries(["cascade", "active", "user-owned"].map((state) => [state, "OPEN: every fixture relationship keeps NoCascade for Assign, Share, Unshare and Reparent (the manifest default); set one of them in a manifest relationship cascade in generate.mjs and re-provision (learn-cascading lists Active, Cascade, NoCascade, UserOwned)"])),
  "dv.solution.dependencies": { "missing-dependency": "not exercised by design: a fixture with a missing dependency fails to import into a clean environment (learn-dependency-tracking); the export is checked to carry none" },
  "dv.security.permission.read-unmasked": { masked: "OPEN: no masking rule is configured, so CanReadUnmasked 0 has no visible effect (learn-column-security)" },
};

// Items without rows: why the fixture does not carry them.
const ITEM_REASONS = {
  "dv.column.string.json": "platform-enforced: Json format strings exist only on elastic (non-relational) tables.",
  "dv.column.string.versionnumber": "platform-enforced: platform-managed format; not creatable on a custom column.",
  "dv.relationship.many-to-many": "OPEN: the export has no ManyToMany relationship (every <EntityRelationshipType> under solution/Other/Relationships is OneToMany); Power Pages subgrids can associate through N:N (pp-basic-form-subgrid), so add an N:N relationship to the manifest relationships in generate.mjs and re-provision.",
  "dv.column.partylist": "platform-enforced: party lists exist only on activity tables; Learn: not supported in basic forms.",
  "dv.column.prompt": "not expressible by API: prompt columns cannot be created or imported by API (Learn).",
  "dv.column.entityname": "platform-enforced: platform-managed attribute type (owner/lookup type columns); not creatable.",
  "dv.column.virtual": "platform-enforced: platform-managed virtual attributes (formatted values); not creatable.",
  "dv.column.managedproperty": "platform-enforced: platform-managed; not creatable.",
  "dv.form-type.quick-create": "not consumed by Power Pages (Learn: main forms only); not part of the fixture.",
  "dv.form-type.mobile": "not consumed by Power Pages.",
  "dv.form-type.dashboard": "not consumed by Power Pages.",
  "dv.form-type.powerpages-basic-form-mode": "covered elsewhere: Power Pages inventory (basic form modes).",
  "dv.form-type.powerpages-multistep": "covered elsewhere: Power Pages inventory (multistep form).",
  "dv.formxml.header": "not rendered by Power Pages: header/footer sections are model-driven app chrome.",
  "dv.formxml.footer": "not rendered by Power Pages: header/footer sections are model-driven app chrome.",
  "dv.formxml.hiddencontrols": "not rendered by Power Pages: model-driven designer bookkeeping.",
  "dv.formxml.events-libraries": "not rendered by Power Pages: model-driven form scripts; Power Pages ignores form libraries.",
  "dv.formxml.navigation": "not rendered by Power Pages: model-driven navigation bar.",
  "dv.formxml.custom-control": "covered elsewhere: PCF bindings are covered by the demo's code-component pages, outside this baseline.",
  "dv.pp.metadata.tab-section-label": "covered elsewhere: Power Pages inventory (basic form metadata section/tab labels).",
  "dv.pp.basic-form.attachments": "covered elsewhere: Power Pages inventory (attach file).",
  "dv.br.action.recommendation": "platform-enforced: model-driven app only (Learn); not applicable to Power Pages.",
  "dv.br.unsupported-columns": "documentation fact (multi-select/file/language not usable in rules); nothing to exercise.",
  "dv.plugin.stage.internal": "platform-enforced: internal stages are not registrable (learn-sdkstep-table marks them internal use only).",
  "dv.plugin.deployment": "server deployment only; nothing to exercise.",
  "dv.security.eligibility": "documentation fact (which columns can be secured).",
  "dv.security.calculated-leak": "documentation fact; the fixture's calculated column has no formula.",
  "dv.view.state": "not expressible in the export: Learn (customize-entity-views) says view state is not included in solutions and imported views are active; deactivation is an Update of statecode. OPEN: a savedquery statecode read-back (like plugins-readback.json) would record it.",
  "dv.view.other-columns": "not varied: the fixture sets Name, FetchXml, LayoutXml, QueryType and IsDefault only; ColumnSetXml/LayoutJson/ConditionalFormatting/AdvancedGroupBy/RoleDisplayConditionsXml stay platform defaults. OPEN if a Power Pages behaviour depends on them.",
  "dv.view.querytype.copilot": "not expressible: Learn lists CopilotView without a value and the platform created none for the fixture tables.",
};
const VIEW_TYPE_REASON = "not expressible by API: Learn (customize-entity-views#create-views) requires QueryType 0 for new views, and the platform created no view of this type for the fixture tables (none in the export).";
const SYNC_REASON = "platform-enforced: only PostOperation supports asynchronous steps (learn-register-plugin)";

function reasonFor(item, state) {
  const own = STATE_REASONS[item.id]?.[state];
  if (own) return own;
  if (item.id.startsWith("dv.plugin.stage.") && state === "asynchronous") return SYNC_REASON;
  return STATE_REASONS[`*${item.area}`]?.[state];
}

const escapeCell = (value) => String(value ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");

function powerPagesRows({ site }) {
  const rows = new Map();
  for (const record of site.records) for (const id of record.catalog ?? []) (rows.get(id) ?? rows.set(id, []).get(id)).push(record);
  return rows;
}

async function main() {
  const data = await loadFixture();
  const dataverse = await read("mirage/docs/baseline/catalog/dataverse.json");
  const powerPages = await read("mirage/docs/baseline/catalog/power-pages.json");
  const catalog = new Map(dataverse.items.map((item) => [item.id, item]));
  const { rows: dvRows, problems, unmapped, dynamicReasons } = dataverseRows(data, catalog);
  const covered = new Map();
  for (const row of dvRows) (covered.get(row.catalog) ?? covered.set(row.catalog, []).get(row.catalog)).push(row);
  const exercisedIds = [...covered].filter(([, rows]) => rows.some((row) => !row.pending)).map(([id]) => id);
  const pendingIds = [...covered].filter(([, rows]) => rows.every((row) => row.pending)).map(([id]) => id);
  const notCovered = dataverse.items.filter((item) => !covered.has(item.id));
  const lines = [];
  let stateGaps = 0;
  for (const area of unique(dataverse.items.map((item) => item.area))) {
    lines.push(`## ${area}`, "", "| Catalog item | Catalog states | Fixture | Where (file#anchor) | States exercised | Visible on |", "| --- | --- | --- | --- | --- | --- |");
    for (const item of dataverse.items.filter((entry) => entry.area === area)) {
      const rows = covered.get(item.id);
      if (!rows) {
        const reason = ITEM_REASONS[item.id] ?? (/SavedQuery\.QueryType=/.test(item.where ?? "") ? VIEW_TYPE_REASON : null);
        if (!reason) problems.push(`${item.id}: no fixture row and no reason`);
        lines.push(`| \`${item.id}\` ${escapeCell(item.name)} | ${escapeCell((item.states ?? []).join(", "))} | — | — | — | ${escapeCell(reason ?? "MISSING REASON")} |`);
        continue;
      }
      for (const row of rows) lines.push(`| \`${item.id}\` ${escapeCell(item.name)} | ${escapeCell((item.states ?? []).join(", "))} | ${escapeCell(row.fixture)} | \`${row.file}#${row.anchor}\` | ${escapeCell(row.states.join(", ") || "—")}${row.pending ? " (pending the manual step)" : ""} | ${escapeCell(row.site.join(", ") || "—")} |`);
      const declared = new Set(rows.flatMap((row) => row.states));
      const missing = (item.states ?? []).filter((state) => !declared.has(state));
      if (rows.every((row) => row.pending)) continue;
      for (const state of missing) {
        const reason = dynamicReasons[item.id]?.[state] ?? reasonFor(item, state);
        if (!reason) problems.push(`${item.id}: state ${state} not exercised and no reason`);
        stateGaps += 1;
        lines.push(`| ↳ \`${item.id}\` state not exercised | ${escapeCell(state)} | — | — | ${escapeCell(reason ?? "MISSING REASON")} | — |`);
      }
    }
    lines.push("");
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
    return;
  }
  const { exported } = data;
  const fixtureViews = exported.views.length;
  const header = [
    "# Dataverse customization inventory", "",
    "Generated by `scripts/baseline-inventory.mjs` from `mirage/docs/baseline/catalog/dataverse.json`, the fixture definitions in `examples/project/baseline/` and the exported solution in `examples/project/baseline/solution/`. Each row declares the catalog states it exercises (catalog state strings, derived from the export, `extras.json` and `plugins-readback.json`); every catalog state no row declares is listed on a \"state not exercised\" row with its reason. \"Visible on\" names fixture pages under `/baseline/` of the demo site. Do not edit by hand.", "",
    `Catalog items: ${dataverse.items.length}. Exercised: ${exercisedIds.length}. Pending a manual maker-portal step: ${pendingIds.length} (${pendingIds.join(", ")}). Without a fixture row: ${notCovered.length} (reason in each row's last column). States not exercised on exercised items: ${stateGaps} (one row each, with its reason).`, "",
    `Solution export: ${exported.roots.length} root components, ${exported.missing.length} MissingDependency entries in \`${EXPORT}/Other/Solution.xml\`${exported.missing.length ? `: ${exported.missing.map((m) => `${m.required.schemaName ?? m.required.displayName} (type ${m.required.type}, solution ${m.required.solution})`).join(", ")}` : " (the fixture tables are root components with behavior 0, so their platform columns such as statecode/createdon/ownerid travel with them; Learn dependency-tracking-solution-components: export warns about missing components and import fails without them)"}. ${fixtureViews} exported views${unmapped.length ? `; without a query-type catalog item: ${unmapped.map((view) => `${view.name} (querytype ${view.queryType})`).join(", ")}` : ", every one listed under a view query-type row"}.`, "",
  ];
  const manual = ["## Manual steps (maker portal only)", "", "Dataverse rejects scripted rollup definitions (\"FormulaDefinition is not valid Xaml\") and Learn states formulas are defined only in the maker portal, so these two steps are documented procedures; the provisioning script verifies their result and the rows above stay \"pending\" until then.", "", "1. Rollup column `pqvd_baselineparent.pqvd_rollup`: make.powerapps.com → Tables → Baseline Parent → Columns → New column, display name `Rollup`, data type Whole number, behaviour Rollup → related table Baseline Item (relationship Parent), aggregate COUNT → Save. Expected: `node examples/project/baseline/provision.mjs --connection <file>` reports the column as `exists`; after `--export` the column appears in `examples/project/baseline/solution/Entities/pqvd_baselineparent/Entity.xml`; then re-add it to the Baseline Parent form and the Active Baseline Parents view in generate.mjs.", "2. Calculated column `pqvd_baselineitem.pqvd_calculated`: open the column → Calculation → action Set `Calculated` to `Concat(pqvd_code, \" \", pqvd_text)` → Save and activate. Expected: `Entity.xml` shows a FormulaDefinition for the column and the item edit page renders the computed value read-only.", ""];
  await fs.writeFile(path.join(docs, "dataverse-inventory.md"), [...header, ...lines, ...manual].join("\n"));

  const ppRows = powerPagesRows(data);
  const notExpressed = new Map();
  for (const entry of data.site.notExpressed ?? []) for (const id of entry.catalog) notExpressed.set(id, entry.reason);
  for (const entry of data.site.documentationOnly ?? []) for (const id of entry.catalog ?? []) notExpressed.set(id, `documentation only: ${entry.reason}`);
  const caveats = new Map();
  for (const entry of data.site.caveats ?? []) for (const id of entry.catalog ?? []) caveats.set(id, entry.reason);
  const pp = ["# Power Pages configuration inventory", "", "Generated by `scripts/baseline-inventory.mjs` from `mirage/docs/baseline/catalog/power-pages.json` and `examples/project/baseline/site-manifest.json` (written by `examples/project/baseline/site.mjs`). One row per catalog item; fixture records are the site records that exercise it. Do not edit by hand.", "", `Catalog items: ${powerPages.items.length}. Exercised: ${[...ppRows.keys()].filter((id) => powerPages.items.some((item) => item.id === id)).length}. Not exercised: ${powerPages.items.filter((item) => !ppRows.has(item.id)).length}.`, ""];
  for (const component of unique(powerPages.items.map((item) => item.component))) {
    pp.push(`## ${component}`, "", "| Catalog item | Field | Fixture records (kind: name, variation) | Visible on |", "| --- | --- | --- | --- |");
    for (const item of powerPages.items.filter((entry) => entry.component === component)) {
      const records = ppRows.get(item.id);
      if (!records) {
        pp.push(`| \`${item.id}\` ${escapeCell(item.name)} | ${escapeCell(item.field ?? "")} | — ${escapeCell(notExpressed.get(item.id) ? `(${notExpressed.get(item.id)})` : "OPEN: not exercised")} | — |`);
        continue;
      }
      const recordText = records.map((record) => `${record.kind}: ${record.name}${record.variation ? ` (${record.variation})` : ""}`).join("; ");
      const recordPages = unique(records.map((record) => record.path).filter(Boolean)).sort().join(", ");
      pp.push(`| \`${item.id}\` ${escapeCell(item.name)} | ${escapeCell(item.field ?? "")} | ${escapeCell(recordText)} (\`${SITE}\`)${caveats.has(item.id) ? ` — caveat: ${escapeCell(caveats.get(item.id))}` : ""} | ${escapeCell(recordPages || "—")} |`);
    }
    pp.push("");
  }
  await fs.writeFile(path.join(docs, "power-pages-inventory.md"), pp.join("\n"));
  console.log(JSON.stringify({ dataverse: { items: dataverse.items.length, exercised: exercisedIds.length, pending: pendingIds.length, withoutRow: notCovered.length, statesNotExercised: stateGaps, rows: dvRows.length, missingDependencies: exported.missing.length, views: fixtureViews }, powerPages: { items: powerPages.items.length, exercised: ppRows.size } }));
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
