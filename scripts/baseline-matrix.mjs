#!/usr/bin/env node
// Generates the baseline scenario matrix (component × variation × state × persona) from the
// fixture site manifest. Scenario steps use the native Power Pages control contracts (control ids
// are column logical names; the submit control is named `…$InsertButton`/`…$UpdateButton`;
// lookups use `.launchentitylookup`, `.clearlookupfield`; lists use the entity-list markup) and
// the fixture record aliases ({id:item1} …). Project-specific parts (origin, browser bridge, hooks,
// synthetic contact) come from a project file merged in with --project.
//
//   node scripts/baseline-matrix.mjs --out <matrix.json> [--manifest examples/project/baseline/site-manifest.json] [--project <project.json>]
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `verify` is the probe the live side repeats until the portal's permission cache reflects the role change.
const SIGNED_IN = "a[href*='/Account/Login/LogOff'], a[href*='SignOut'], a[href*='LogOff']";
const verify = (goto, expect) => ({ steps: [{ goto }, { wait: 1000 }], expect, attempts: 12, delay: 15000 });
const PERSONAS = {
  editor: { roles: ["Baseline Editors"], verify: verify("/baseline/item-create/", { present: ["#pqvd_name", SIGNED_IN] }) },
  reader: { roles: ["Baseline Readers"], verify: verify("/baseline/item-create/", { absent: ["#pqvd_name"], present: [SIGNED_IN] }) },
  "contact-scope": { roles: ["Baseline Contact Scope"], verify: verify("/baseline/item-edit/?id={id:item1}", { present: ["#pqvd_name", SIGNED_IN] }) },
  "account-scope": { roles: ["Baseline Account Scope"], verify: verify("/baseline/item-edit/?id={id:item1}", { present: ["#pqvd_name", SIGNED_IN] }) },
  "parent-scope": { roles: ["Baseline Parent Scope"], verify: verify("/baseline/item-edit/?id={id:item1}", { present: ["#pqvd_name", SIGNED_IN] }) },
  // Lists render their table shell whatever the roles, so "none" is verified on the edit form of a readable record.
  none: { roles: [], verify: verify("/baseline/item-edit/?id={id:item1}", { absent: ["#pqvd_name"], present: [SIGNED_IN] }) },
  anonymous: { anonymous: true, verify: verify("/baseline/item-create/", { absent: [SIGNED_IN] }) },
};
const SUBMIT = "input[name$='InsertButton'], input[name$='UpdateButton']";
const SIGN_IN = [".login-heading-section"];
const FORM = "form#liquid_form, form[id$='_form'], form";
const PLUGIN_STAGES = ["prevalidation", "preoperation", "postoperation"];

const scenario = (id, parts, steps, expect, extra = {}) => ({ id, ...parts, steps, expect: { absent: SIGN_IN, ...expect }, ...extra });

function basicFormScenarios(record) {
  const out = [];
  const parts = { component: "basic-form", variation: record.variation ?? record.name, persona: "editor" };
  const page = record.path;
  const mode = /insert/i.test(record.variation ?? "") || /Insert/.test(record.name) ? "insert" : /read/i.test(record.variation ?? record.name) ? "read-only" : "edit";
  const idSuffix = (state, persona = "editor") => `${record.slug}/${state}/${persona}`;
  if (mode === "insert") {
    out.push(scenario(`basic-form/${idSuffix("empty")}`, { ...parts, state: "empty" }, [{ goto: page }], { present: [FORM] }));
    out.push(scenario(`basic-form/${idSuffix("insert")}`, { ...parts, state: "insert" }, [{ goto: page }, { fill: "#pqvd_name", value: "Baseline inserted item" }, { fill: "#pqvd_code", value: "I-NEW-{id:run}" }, { fill: "#pqvd_required", value: "required value" }, { click: SUBMIT }, { wait: { navigation: true } }], {}));
    out.push(scenario(`basic-form/${idSuffix("required-missing")}`, { ...parts, state: "required-missing" }, [{ goto: page }, { click: SUBMIT }, { wait: 1500 }], { present: [FORM] }));
    out.push(scenario(`basic-form/${idSuffix("regex-error")}`, { ...parts, state: "regex-error" }, [{ goto: page }, { fill: "#pqvd_name", value: "Baseline regex" }, { fill: "#pqvd_code", value: "I-RX-{id:run}" }, { fill: "#pqvd_required", value: "x" }, { fill: "#pqvd_text", value: "regex should fail 1" }, { click: SUBMIT }, { wait: 1500 }], { present: [FORM] }));
    out.push(scenario(`basic-form/${idSuffix("range-error")}`, { ...parts, state: "range-error" }, [{ goto: page }, { fill: "#pqvd_name", value: "Baseline range" }, { fill: "#pqvd_code", value: "I-RG-{id:run}" }, { fill: "#pqvd_required", value: "x" }, { fill: "#pqvd_wholenumber", value: "5000" }, { click: SUBMIT }, { wait: 1500 }], { present: [FORM] }));
    for (const stage of PLUGIN_STAGES) out.push(scenario(`basic-form/${idSuffix(`plugin-error-create-${stage}`)}`, { ...parts, state: `plugin-error-create-${stage}` }, [{ goto: page }, { fill: "#pqvd_name", value: `Baseline plugin ${stage}` }, { fill: "#pqvd_code", value: `I-PL-${stage.slice(0, 3)}-{id:run}` }, { fill: "#pqvd_required", value: "x" }, { fill: "#pqvd_text", value: `plugin-fail-create-${stage}` }, { click: SUBMIT }, { wait: { navigation: true } }], {}));
    out.push(scenario(`basic-form/${idSuffix("rule-error")}`, { ...parts, state: "rule-error" }, [{ goto: page }, { fill: "#pqvd_name", value: "Baseline rule error" }, { fill: "#pqvd_code", value: "I-RE-{id:run}" }, { fill: "#pqvd_required", value: "x" }, { fill: "#pqvd_ruleerror", value: "600" }, { click: SUBMIT }, { wait: { navigation: true } }], {}));
    for (const persona of ["reader", "none", "anonymous"]) out.push(scenario(`basic-form/${idSuffix("permission-denied", persona)}`, { ...parts, persona, state: "permission-denied" }, [{ goto: page }], { absent: persona === "anonymous" ? [] : SIGN_IN }));
  } else if (mode === "edit") {
    out.push(scenario(`basic-form/${idSuffix("populated")}`, { ...parts, state: "populated" }, [{ goto: `${page}?id={id:item1}` }], { present: [FORM, "#pqvd_name"] }));
    out.push(scenario(`basic-form/${idSuffix("minimal")}`, { ...parts, state: "minimal" }, [{ goto: `${page}?id={id:item2}` }], { present: [FORM] }));
    out.push(scenario(`basic-form/${idSuffix("inactive-record")}`, { ...parts, state: "inactive-record" }, [{ goto: `${page}?id={id:item3}` }], {}));
    out.push(scenario(`basic-form/${idSuffix("hidden-by-rule")}`, { ...parts, state: "hidden-by-rule" }, [{ goto: `${page}?id={id:item2}` }], { present: [FORM] }));
    out.push(scenario(`basic-form/${idSuffix("save-text")}`, { ...parts, state: "save-text" }, [{ goto: `${page}?id={id:item1}` }, { fill: "#pqvd_text", value: "edited by baseline" }, { click: SUBMIT }, { wait: { navigation: true } }], {}));
    out.push(scenario(`basic-form/${idSuffix("required-missing")}`, { ...parts, state: "required-missing" }, [{ goto: `${page}?id={id:item1}` }, { clear: "#pqvd_required" }, { click: SUBMIT }, { wait: 1500 }], { present: [FORM] }));
    for (const stage of PLUGIN_STAGES) out.push(scenario(`basic-form/${idSuffix(`plugin-error-update-${stage}`)}`, { ...parts, state: `plugin-error-update-${stage}` }, [{ goto: `${page}?id={id:item1}` }, { fill: "#pqvd_text", value: `plugin-fail-update-${stage}` }, { click: SUBMIT }, { wait: { navigation: true } }], {}));
    out.push(scenario(`basic-form/${idSuffix("plugin-mutation")}`, { ...parts, state: "plugin-mutation" }, [{ goto: `${page}?id={id:item1}` }, { fill: "#pqvd_ticker", value: "  mut  " }, { fill: "#pqvd_textarea", value: "mutate-me" }, { click: SUBMIT }, { wait: { navigation: true } }, { goto: `${page}?id={id:item1}` }], { present: [FORM] }));
    out.push(scenario(`basic-form/${idSuffix("lookup-dialog-open")}`, { ...parts, state: "lookup-dialog-open" }, [{ goto: `${page}?id={id:item1}` }, { click: "#pqvd_parentid_lookupmodal_launch, button.launchentitylookup[aria-label*='Parent']" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 1500 }], { present: [".modal"] }));
    out.push(scenario(`basic-form/${idSuffix("lookup-search")}`, { ...parts, state: "lookup-search" }, [{ goto: `${page}?id={id:item1}` }, { click: "button.launchentitylookup[aria-label*='Parent']" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { fill: ".modal.in input.query, .modal.show input.query", value: "Two" }, { press: ".modal.in input.query, .modal.show input.query", key: "Enter" }, { wait: 1500 }], { present: [".modal"] }));
    out.push(scenario(`basic-form/${idSuffix("lookup-select")}`, { ...parts, state: "lookup-select" }, [{ goto: `${page}?id={id:item1}` }, { click: "button.launchentitylookup[aria-label*='Parent']" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 1500 }, { click: ".modal.in table tbody tr:nth-child(2), .modal.show table tbody tr:nth-child(2)" }, { click: ".modal.in button.primary, .modal.show button.primary" }, { wait: 1000 }], { present: [FORM] }));
    out.push(scenario(`basic-form/${idSuffix("lookup-clear")}`, { ...parts, state: "lookup-clear" }, [{ goto: `${page}?id={id:item1}` }, { click: "button.clearlookupfield[aria-label*='Parent']" }, { wait: 800 }], { present: [FORM] }));
    out.push(scenario(`basic-form/${idSuffix("note-add")}`, { ...parts, state: "note-add" }, [{ goto: `${page}?id={id:item1}` }, { click: ".entity-notes .add-note, a.addnote, button.addnote" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { fill: ".modal.in textarea, .modal.show textarea", value: "note added by baseline" }, { click: ".modal.in button.primary, .modal.show button.primary, .modal.in .btn-primary, .modal.show .btn-primary" }, { wait: 2500 }], { present: [FORM] }));
    for (const persona of ["reader", "contact-scope", "account-scope", "parent-scope", "none", "anonymous"]) out.push(scenario(`basic-form/${idSuffix("permission", persona)}`, { ...parts, persona, state: "permission" }, [{ goto: `${page}?id={id:item1}` }], { absent: persona === "anonymous" ? [] : SIGN_IN }));
    out.push(scenario(`basic-form/${idSuffix("contact-scope-foreign", "contact-scope")}`, { ...parts, persona: "contact-scope", state: "contact-scope-foreign" }, [{ goto: `${page}?id={id:item4}` }], {}));
  } else {
    out.push(scenario(`basic-form/${idSuffix("read-only")}`, { ...parts, state: "read-only" }, [{ goto: `${page}?id={id:item1}` }], { present: [FORM] }));
    for (const persona of ["reader", "none"]) out.push(scenario(`basic-form/${idSuffix("read-only", persona)}`, { ...parts, persona, state: "read-only" }, [{ goto: `${page}?id={id:item1}` }], {}));
  }
  return out;
}

function listScenarios(record) {
  const out = [];
  const parts = { component: "list", variation: record.variation ?? record.name, persona: "editor" };
  const page = record.path;
  const s = (state, steps, expect = {}, persona = "editor") => out.push(scenario(`list/${record.slug}/${state}/${persona}`, { ...parts, persona, state }, steps, expect));
  const grid = ".entitylist, .entity-grid, [data-view-layouts]";
  s("default", [{ goto: page }, { wait: { selector: `${grid} table, ${grid} .table`, state: "visible" } }, { wait: 1500 }], { present: [grid] });
  s("view-selector", [{ goto: page }, { wait: 1500 }, { click: ".view-toolbar .dropdown-toggle, .entitylist .view-selector .dropdown-toggle, .btn-group .dropdown-toggle" }, { wait: 600 }, { click: ".dropdown-menu a:has-text('All'), .dropdown-menu li:nth-child(2) a" }, { wait: 2000 }], { present: [grid] });
  s("search", [{ goto: page }, { wait: 1500 }, { fill: ".entitylist-search input, input.query, input[placeholder*='Search']", value: "*Alpha" }, { press: ".entitylist-search input, input.query, input[placeholder*='Search']", key: "Enter" }, { wait: 2000 }], { present: [grid] });
  s("paging", [{ goto: page }, { wait: 1500 }, { click: ".pagination li:nth-child(3) a, .pagination a[data-page='2'], .pagination li.next a" }, { wait: 2000 }], { present: [grid] });
  s("sort", [{ goto: page }, { wait: 1500 }, { click: "th a[data-logicalname='pqvd_code'], th a:has-text('Code'), th:nth-child(2) a" }, { wait: 2000 }], { present: [grid] });
  if (/modal/i.test(record.variation ?? "")) {
    s("modal-details", [{ goto: page }, { wait: 1500 }, { click: "tr .details-link, tr a.details-link, tr .launch-modal" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 2500 }], { present: [".modal"] });
    s("modal-create", [{ goto: page }, { wait: 1500 }, { click: ".toolbar a.create-action, a.create-action, .btn.create-action" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 2500 }], { present: [".modal"] });
    s("modal-edit", [{ goto: page }, { wait: 1500 }, { click: "tr .edit-link, tr a.edit-link" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 2500 }], { present: [".modal"] });
    s("modal-delete", [{ goto: page }, { wait: 1500 }, { click: "tr .delete-link, tr a.delete-link" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 1000 }], { present: [".modal"] });
  }
  if (/filter/i.test(record.variation ?? "")) {
    s("filter-text", [{ goto: page }, { wait: 1500 }, { fill: ".entitylist-filter input[type='text'], .filter-text input", value: "*Alpha" }, { click: ".entitylist-filter button[type='submit'], .filter-submit, button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
    s("filter-dropdown", [{ goto: page }, { wait: 1500 }, { select: ".entitylist-filter select", label: "Green" }, { click: ".entitylist-filter button[type='submit'], button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
    s("filter-checkbox", [{ goto: page }, { wait: 1500 }, { check: ".entitylist-filter input[type='checkbox']" }, { click: ".entitylist-filter button[type='submit'], button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
    s("filter-reset", [{ goto: page }, { wait: 1500 }, { click: ".entitylist-filter button[type='submit'], button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
  }
  for (const persona of ["reader", "contact-scope", "none", "anonymous"]) s("permission", [{ goto: page }, { wait: 1500 }], { absent: persona === "anonymous" ? [] : SIGN_IN }, persona);
  return out;
}

function multistepScenarios(record) {
  const out = [];
  const parts = { component: "multistep-form", variation: record.variation ?? record.name, persona: "editor" };
  const page = record.path;
  const s = (state, steps, expect = {}) => out.push(scenario(`multistep-form/${record.slug}/${state}/editor`, { ...parts, state }, steps, expect));
  s("step1", [{ goto: page }], { present: [FORM] });
  s("step1-submit", [{ goto: page }, { fill: "#pqvd_name", value: "Baseline multistep {id:run}" }, { fill: "#pqvd_code", value: "MS-{id:run}" }, { fill: "#pqvd_text", value: "step one" }, { click: "input[name$='NextButton'], " + SUBMIT }, { wait: { navigation: true } }], {});
  s("step2-back", [{ goto: page }, { fill: "#pqvd_name", value: "Baseline multistep back {id:run}" }, { fill: "#pqvd_code", value: "MB-{id:run}" }, { click: "input[name$='NextButton'], " + SUBMIT }, { wait: { navigation: true } }, { click: "input[name$='PreviousButton']" }, { wait: { navigation: true } }], {});
  s("resume", [{ goto: page }, { fill: "#pqvd_name", value: "Baseline resume {id:run}" }, { fill: "#pqvd_code", value: "MR-{id:run}" }, { click: "input[name$='NextButton'], " + SUBMIT }, { wait: { navigation: true } }, { goto: page }], {});
  return out;
}

export function buildMatrix(manifest, project = {}) {
  const slugOf = (record) => (record.path ?? record.name).replace(/^\/baseline\//, "").replace(/\/$/, "").replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "root";
  const scenarios = [];
  for (const record of manifest.records) {
    const r = { ...record, slug: slugOf(record) };
    if (!record.path) continue;
    if (record.kind === "basicform") scenarios.push(...basicFormScenarios(r));
    else if (record.kind === "list") scenarios.push(...listScenarios(r));
    else if (record.kind === "advancedform") scenarios.push(...multistepScenarios(r));
  }
  const seen = new Set();
  const unique = scenarios.filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
  return {
    version: 1,
    origin: project.origin ?? "https://example.invalid",
    live: project.live,
    hooks: project.hooks,
    writeScope: { paths: ["^/baseline/", "^/_services/", "^/_portal/"], entitySets: ["pqvd_baselineitems", "pqvd_baselinechilds", "pqvd_baselineparents", "annotations"] },
    personas: Object.fromEntries(Object.entries(PERSONAS).map(([name, persona]) => [name, { ...persona, ...(persona.anonymous ? {} : { mirageContact: project.mirageContact }) }])),
    mirage: { preset: "baseline" },
    settle: { quietMs: 1200, timeout: 30000 },
    generatedAt: new Date().toISOString().slice(0, 10),
    scenarios: unique,
  };
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, manifest: { type: "string" }, project: { type: "string" } } });
  if (!values.out) throw new Error("--out is required");
  const manifest = JSON.parse(await fs.readFile(values.manifest ?? path.join(root, "examples/project/baseline/site-manifest.json"), "utf8"));
  const project = values.project ? JSON.parse(await fs.readFile(values.project, "utf8")) : {};
  const matrix = buildMatrix(manifest, project);
  await fs.writeFile(values.out, JSON.stringify(matrix, null, 2) + "\n");
  const by = {};
  for (const item of matrix.scenarios) by[item.component] = (by[item.component] ?? 0) + 1;
  console.log(JSON.stringify({ out: values.out, scenarios: matrix.scenarios.length, byComponent: by }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
