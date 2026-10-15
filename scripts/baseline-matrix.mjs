#!/usr/bin/env node
// Generates the baseline scenario matrix (component × variation × state × persona) from the
// fixture site manifest. Scenario steps use the native Power Pages control contracts (control ids
// are column logical names; the submit control is named `…$InsertButton`/`…$UpdateButton`;
// lookups use `.launchentitylookup`, `.clearlookupfield` (the Contact lookup: the item edit form renders the Parent lookup as a dropdown per its metadata); lists use the entity-list markup) and
// the fixture record aliases ({id:${T.record}} …). Project-specific parts (origin, browser bridge, hooks,
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
const verify = (goto, expect) => ({ steps: [{ goto }, { wait: 1000 }], expect, attempts: 40, delay: 15000 }); // the portal's permission cache took over 5 min after a site upload (run 5)
const PERSONAS = {
  editor: { roles: ["Baseline Editors"], verify: verify("/baseline/item-create/", { present: ["#pqvd_name", SIGNED_IN] }) },
  reader: { roles: ["Baseline Readers"], verify: verify("/baseline/item-create/", { absent: ["#pqvd_name"], present: [SIGNED_IN] }) },
  "contact-scope": { roles: ["Baseline Contact Scope"], verify: verify("/baseline/item-edit/?id={id:${T.record}}", { present: ["#pqvd_name", SIGNED_IN] }) },
  "account-scope": { roles: ["Baseline Account Scope"], verify: verify("/baseline/item-edit/?id={id:${T.record}}", { present: ["#pqvd_name", SIGNED_IN] }) },
  "parent-scope": { roles: ["Baseline Parent Scope"], verify: verify("/baseline/item-edit/?id={id:${T.record}}", { present: ["#pqvd_name", SIGNED_IN] }) },
  // Lists render their table shell whatever the roles, so "none" is verified on the edit form of a readable record.
  none: { roles: [], verify: verify("/baseline/item-edit/?id={id:${T.record}}", { absent: ["#pqvd_name"], present: [SIGNED_IN] }) },
  anonymous: { anonymous: true, verify: verify("/baseline/item-create/", { absent: [SIGNED_IN] }) },
};
const SUBMIT = "input[name$='InsertButton'], input[name$='UpdateButton']";
const SIGN_IN = [".login-heading-section"];
const FORM = "form#liquid_form, form[id$='_form'], form";
const PLUGIN_STAGES = ["prevalidation", "preoperation", "postoperation"];

const scenario = (id, parts, steps, expect, extra = {}) => ({ id, ...parts, steps, expect: { absent: SIGN_IN, ...expect }, ...extra });

// Per-table fixture facts the scenarios need: which records to open, which fields an insert fills, and
// which behaviours (validation columns, plugin steps, business rules, lookups, notes) the table carries.
// Records whose variation names a query parameter (`?itemid=<id>`, `?code=`, `?returnurl=`) are opened with it.
const QUERY_VALUES = { itemid: "{id:item1}", parentid: "{id:parent1}", id: "{id:item1}", code: "I-001", returnurl: "%2Fbaseline%2F" };
// Inline upload payloads for forms that require an attachment: a 1×1 PNG and a one-page PDF; the capture runner keeps
// the ones the input's `accept` admits.
const UPLOADS = [
  { name: "baseline.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" },
  { name: "baseline.pdf", mimeType: "application/pdf", base64: "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0+PmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1MiAwMDAwMCBuIAowMDAwMDAwMTAxIDAwMDAwIG4gCnRyYWlsZXI8PC9TaXplIDQvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgoxNjAKJSVFT0YK" },
];
const attach = (selector = "input[type='file']") => ({ upload: selector, files: UPLOADS });
const recordQuery = (record) => {
  const match = /\?(\w+)=/.exec(record.variation ?? "");
  return match ? `?${match[1]}=${QUERY_VALUES[match[1]] ?? ""}` : "";
};
const TABLES = {
  pqvd_baselineitem: { record: "item1", minimal: "item2", inactive: "item3", foreign: "item4", insert: (name, code) => [{ fill: "#pqvd_name", value: name }, { fill: "#pqvd_code", value: code }, { fill: "#pqvd_required", value: "required value" }], required: "#pqvd_required", text: "#pqvd_text", validation: true, plugins: true, rules: true, lookup: "Contact", notes: true },
  pqvd_baselinechild: { record: "child1", minimal: "child2", inactive: "child3", foreign: "child4", insert: (name) => [{ fill: "#pqvd_name", value: name }, { fill: "#pqvd_sortorder", value: "10" }], required: "#pqvd_name", text: "#pqvd_note", validation: false, plugins: false, rules: false, lookup: null, notes: false },
  contact: { record: "tester", minimal: "tester", inactive: "tester", foreign: "other", insert: (name) => [{ fill: "#jobtitle", value: name }], required: "#jobtitle", text: "#telephone1", validation: false, plugins: false, rules: false, lookup: null, notes: false },
  pqvd_baselineparent: { record: "parent1", minimal: "parent2", inactive: "parent2", foreign: "parent2", insert: (name, code) => [{ fill: "#pqvd_name", value: name }, { fill: "#pqvd_code", value: code }], required: "#pqvd_name", text: "#pqvd_description", validation: false, plugins: false, rules: false, lookup: null, notes: false },
};

// The non-editor personas (reader, none, anonymous, the scope personas) render the same denial or read-only page
// on every record of a kind, so they run only on the representative pages the project names (`personaPages`).
const personaPage = (record, project) => !project.personaPages || project.personaPages.includes(record.path);
// Validation, plugin, lookup and note behaviours do not depend on a form's presentation options, so they run only on the
// canonical form of each table (`behaviourPages`); a variant form captures the states its own configuration changes.
const behaviourPage = (record, project) => !project.behaviourPages || project.behaviourPages.includes(record.path);

function basicFormScenarios(record, project = {}) {
  const out = [];
  const personas = personaPage(record, project);
  const full = behaviourPage(record, project);
  const T = TABLES[record.table] ?? TABLES.pqvd_baselineitem;
  // A form with auto-generated steps shows one tab per step: Next moves on, the submit button is on the last tab.
  const stepped = (record.catalog ?? []).includes("pp.basicform.auto-generate-steps");
  // A form redirecting to an external URL ends its insert scenario off the site: the hostname is the evidence.
  const external = (record.catalog ?? []).includes("pp.basicform.redirect-external-url");
  const NEXT = "input[name$='NextButton']";
  const tabs = project.formTabs?.[record.formName ?? record.form ?? ""] ?? project.formTabs?.default ?? 1;
  const submit = stepped ? [...Array(Math.max(0, tabs - 1)).fill([{ click: NEXT, dispatch: true }, { wait: 1500 }]).flat(), { click: SUBMIT }] : [{ click: SUBMIT }];
  const firstStep = stepped ? [{ click: NEXT, dispatch: true }] : [...submit];
  const parts = { component: "basic-form", variation: record.variation ?? record.name, persona: "editor" };
  const page = record.path + recordQuery(record);
  const mode = /insert/i.test(record.variation ?? "") || /Insert/.test(record.name) ? "insert" : /read/i.test(record.variation ?? record.name) ? "read-only" : "edit";
  const idSuffix = (state, persona = "editor") => `${record.slug}/${state}/${persona}`;
  if (mode === "insert") {
    out.push(scenario(`basic-form/${idSuffix("empty")}`, { ...parts, state: "empty" }, [{ goto: page }], { present: [FORM] }));
    const attachments = (record.catalog ?? []).includes("pp.basicform.attach-file") ? [attach()] : [];
    out.push(scenario(`basic-form/${idSuffix("insert")}`, { ...parts, state: "insert" }, [{ goto: page }, ...T.insert("Baseline inserted item", "I-NEW-{id:run}"), ...attachments, ...submit, { wait: { navigation: true } }], external ? { leavesOrigin: true } : {}));
    if (full || stepped) out.push(scenario(`basic-form/${idSuffix("required-missing")}`, { ...parts, state: "required-missing" }, [{ goto: page }, ...firstStep, { wait: 1500 }], { present: [FORM] }));
    if (full && T.validation) out.push(scenario(`basic-form/${idSuffix("regex-error")}`, { ...parts, state: "regex-error" }, [{ goto: page }, ...T.insert("Baseline regex", "I-RX-{id:run}"), { fill: "#pqvd_text", value: "regex should fail 1" }, ...submit, { wait: 1500 }], { present: [FORM] }));
    if (full && T.validation) out.push(scenario(`basic-form/${idSuffix("range-error")}`, { ...parts, state: "range-error" }, [{ goto: page }, ...T.insert("Baseline range", "I-RG-{id:run}"), { fill: "#pqvd_wholenumber", value: "5000" }, ...submit, { wait: 1500 }], { present: [FORM] }));
    if (full && T.plugins) for (const stage of PLUGIN_STAGES) out.push(scenario(`basic-form/${idSuffix(`plugin-error-create-${stage}`)}`, { ...parts, state: `plugin-error-create-${stage}` }, [{ goto: page }, ...T.insert(`Baseline plugin ${stage}`, `I-PL-${stage.slice(0, 3)}-{id:run}`), { fill: "#pqvd_text", value: `plugin-fail-create-${stage}` }, ...submit, { wait: { navigation: true } }], {}));
    if (full && T.rules) out.push(scenario(`basic-form/${idSuffix("rule-error")}`, { ...parts, state: "rule-error" }, [{ goto: page }, ...T.insert("Baseline rule error", "I-RE-{id:run}"), { fill: "#pqvd_ruleerror", value: "600" }, ...submit, { wait: { navigation: true } }], {}));
    if (personas) for (const persona of ["reader", "none", "anonymous"]) out.push(scenario(`basic-form/${idSuffix("permission-denied", persona)}`, { ...parts, persona, state: "permission-denied" }, [{ goto: page }], { absent: persona === "anonymous" ? [] : SIGN_IN }));
  } else if (mode === "edit") {
    out.push(scenario(`basic-form/${idSuffix("populated")}`, { ...parts, state: "populated" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }], { present: [FORM, "#pqvd_name"] }));
    if (full) out.push(scenario(`basic-form/${idSuffix("minimal")}`, { ...parts, state: "minimal" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.minimal}}` }], { present: [FORM] }));
    if (full) out.push(scenario(`basic-form/${idSuffix("inactive-record")}`, { ...parts, state: "inactive-record" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.inactive}}` }], {}));
    if (full && T.rules) out.push(scenario(`basic-form/${idSuffix("hidden-by-rule")}`, { ...parts, state: "hidden-by-rule" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.minimal}}` }], { present: [FORM] }));
    out.push(scenario(`basic-form/${idSuffix("save-text")}`, { ...parts, state: "save-text" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }, { fill: T.text, value: "edited by baseline" }, ...submit, { wait: { navigation: true } }], {}));
    if (full) out.push(scenario(`basic-form/${idSuffix("required-missing")}`, { ...parts, state: "required-missing" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }, { clear: T.required }, ...firstStep, { wait: 1500 }], { present: [FORM] }));
    if (full && T.plugins) for (const stage of PLUGIN_STAGES) out.push(scenario(`basic-form/${idSuffix(`plugin-error-update-${stage}`)}`, { ...parts, state: `plugin-error-update-${stage}` }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }, { fill: "#pqvd_text", value: `plugin-fail-update-${stage}` }, ...submit, { wait: { navigation: true } }], {}));
    if (full && T.plugins) out.push(scenario(`basic-form/${idSuffix("plugin-mutation")}`, { ...parts, state: "plugin-mutation" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }, { fill: "#pqvd_ticker", value: "  mut  " }, { fill: "#pqvd_textarea", value: "mutate-me" }, ...submit, { wait: { navigation: true } }, { wait: 6000 }, { goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }], { present: [FORM] }));
    if (full && T.lookup) out.push(scenario(`basic-form/${idSuffix("lookup-dialog-open")}`, { ...parts, state: "lookup-dialog-open" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }, { click: `button.launchentitylookup[aria-label*='${T.lookup}']` }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 1500 }], { present: [".modal"] }));
    if (full && T.lookup) out.push(scenario(`basic-form/${idSuffix("lookup-search")}`, { ...parts, state: "lookup-search" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }, { click: `button.launchentitylookup[aria-label*='${T.lookup}']` }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { fill: ".modal.in input.query, .modal.show input.query", value: "*Other" }, { press: ".modal.in input.query, .modal.show input.query", key: "Enter" }, { wait: 1500 }], { present: [".modal"] }));
    if (full && T.lookup) out.push(scenario(`basic-form/${idSuffix("lookup-select")}`, { ...parts, state: "lookup-select" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }, { click: `button.launchentitylookup[aria-label*='${T.lookup}']` }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 1500 }, { click: ".modal.in table tbody tr:nth-child(2), .modal.show table tbody tr:nth-child(2)" }, { click: ".modal.in button.primary, .modal.show button.primary" }, { wait: 1000 }], { present: [FORM] }));
    if (full && T.lookup) out.push(scenario(`basic-form/${idSuffix("lookup-clear")}`, { ...parts, state: "lookup-clear" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }, { click: `button.clearlookupfield[aria-label*='${T.lookup}']` }, { wait: 800 }], { present: [FORM] }));
    if (full && T.notes) out.push(scenario(`basic-form/${idSuffix("note-add")}`, { ...parts, state: "note-add" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }, { wait: { selector: "a.addnote:visible, .entity-notes .add-note:visible", state: "visible" } }, { click: "a.addnote:visible, .entity-notes .add-note:visible" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { fill: ".modal.in textarea, .modal.show textarea", value: "note added by baseline" }, { click: ".modal.in button.primary, .modal.show button.primary, .modal.in .btn-primary, .modal.show .btn-primary" }, { wait: 2500 }], { present: [FORM] }));
    if (personas) for (const persona of ["reader", "contact-scope", "account-scope", "parent-scope", "none", "anonymous"]) out.push(scenario(`basic-form/${idSuffix("permission", persona)}`, { ...parts, persona, state: "permission" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }], { absent: persona === "anonymous" ? [] : SIGN_IN }));
    if (personas) out.push(scenario(`basic-form/${idSuffix("contact-scope-foreign", "contact-scope")}`, { ...parts, persona: "contact-scope", state: "contact-scope-foreign" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.foreign}}` }], {}));
  } else {
    // A deactivated basic form record renders no form on live: whatever the page shows is the evidence.
    const inactiveForm = (record.catalog ?? []).includes("pp.basicform.statecode");
    out.push(scenario(`basic-form/${idSuffix("read-only")}`, { ...parts, state: "read-only" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }], inactiveForm ? {} : { present: [FORM] }));
    if (personas) for (const persona of ["reader", "none"]) out.push(scenario(`basic-form/${idSuffix("read-only", persona)}`, { ...parts, persona, state: "read-only" }, [{ goto: `${page}${page.includes("?") ? "&" : "?"}id={id:${T.record}}` }], {}));
  }
  return out;
}

function listScenarios(record, project = {}) {
  const out = [];
  const parts = { component: "list", variation: record.variation ?? record.name, persona: "editor" };
  const page = record.path;
  const s = (state, steps, expect = {}, persona = "editor") => out.push(scenario(`list/${record.slug}/${state}/${persona}`, { ...parts, persona, state }, steps, expect));
  const grid = ".entitylist, .entity-grid, [data-view-layouts]";
  // A deactivated list record renders no grid (the live page shows the Liquid error): only its default state applies.
  if (record.catalog?.includes("pp.list.statecode")) {
    s("default", [{ goto: page }, { wait: 1500 }], {});
    return out;
  }
  s("default", [{ goto: page }, { wait: { selector: `${grid} table, ${grid} .table`, state: "visible" } }, { wait: 1500 }], { present: [grid] });
  // The view selector and the search box exist only when the list record configures them.
  if (record.catalog?.includes("pp.list.views.selector")) s("view-selector", [{ goto: page }, { wait: 1500 }, { click: ".view-toolbar .dropdown-toggle, .entitylist .view-selector .dropdown-toggle, .btn-group .dropdown-toggle" }, { wait: 600 }, { click: ".dropdown-menu a:has-text('All'), .dropdown-menu li:nth-child(2) a" }, { wait: 2000 }], { present: [grid] });
  if (record.catalog?.includes("pp.list.searchenabled")) s("search", [{ goto: page }, { wait: 1500 }, { fill: ".entitylist-search input, input.query, input[placeholder*='Search']", value: "*Alpha" }, { press: ".entitylist-search input, input.query, input[placeholder*='Search']", key: "Enter" }, { wait: 2000 }], { present: [grid] });
  // Calendar and map lists render no grid table: paging and sorting apply to grid lists only.
  const gridList = !record.catalog?.some((id) => /^pp\.list\.(?:calendar|map)\./.test(id));
  // A list filtered to the portal user's records or account shows fewer rows than a page on the fixture data: no paging.
  const scoped = record.catalog?.some((id) => /^pp\.list\.filter(?:account|portaluser)$/.test(id));
  if (gridList && !scoped && record.catalog?.includes("pp.list.pagesize")) s("paging", [{ goto: page }, { wait: 1500 }, { click: ".pagination li:nth-child(3) a, .pagination a[data-page='2'], .pagination li.next a" }, { wait: 2000 }], { present: [grid] });
  if (gridList) s("sort", [{ goto: page }, { wait: 1500 }, { click: "th a[data-logicalname='pqvd_code'], th a:has-text('Code'), th:nth-child(2) a" }, { wait: 2000 }], { present: [grid] });
  if (/modal/i.test(record.variation ?? "")) {
    s("modal-details", [{ goto: page }, { wait: 1500 }, { click: "tr .details-link, tr a.details-link, tr .launch-modal" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 2500 }], { present: [".modal"] });
    s("modal-create", [{ goto: page }, { wait: 1500 }, { click: ".toolbar a.create-action, a.create-action, .btn.create-action" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 2500 }], { present: [".modal"] });
    s("modal-edit", [{ goto: page }, { wait: 1500 }, { click: "tr button[aria-label='action menu'], tr .dropdown-toggle" }, { wait: 500 }, { click: "tr .dropdown-menu .edit-link, tr .dropdown-menu a.edit-link" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 2500 }], { present: [".modal"] });
    s("modal-delete", [{ goto: page }, { wait: 1500 }, { click: "tr button[aria-label='action menu'], tr .dropdown-toggle" }, { wait: 500 }, { click: "tr .dropdown-menu .delete-link, tr .dropdown-menu a.delete-link" }, { wait: { selector: ".modal.in, .modal.show", state: "visible" } }, { wait: 1000 }], { present: [".modal"] });
  }
  // Each filter state needs the filter type the list's definition declares (the horizontal list carries only the text filter).
  const filter = (id) => record.catalog?.includes(id);
  if (filter("pp.listfilter.definition")) {
    if (filter("pp.listfilter.text")) s("filter-text", [{ goto: page }, { wait: 1500 }, { fill: ".entitylist-filter input[type='text'], .filter-text input", value: "*Alpha" }, { click: ".entitylist-filter button[type='submit'], .filter-submit, button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
    if (filter("pp.listfilter.visualization.dropdown")) s("filter-dropdown", [{ goto: page }, { wait: 1500 }, { select: ".entitylist-filter select", label: "Beta" }, { click: ".entitylist-filter button[type='submit'], button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
    if (filter("pp.listfilter.visualization.checkbox")) s("filter-checkbox", [{ goto: page }, { wait: 1500 }, { check: ".entitylist-filter input[type='checkbox']" }, { click: ".entitylist-filter button[type='submit'], button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
    s("filter-reset", [{ goto: page }, { wait: 1500 }, { click: ".entitylist-filter button[type='submit'], button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
  }
  if (personaPage(record, project)) for (const persona of ["reader", "contact-scope", "none", "anonymous"]) s("permission", [{ goto: page }, { wait: 1500 }], { absent: persona === "anonymous" ? [] : SIGN_IN }, persona);
  return out;
}

function multistepScenarios(record, steps = []) {
  const out = [];
  const parts = { component: "multistep-form", variation: record.variation ?? record.name, persona: "editor" };
  // The record-identifying query parameter a multistep page needs (`?id=`, `?parentid=`, `?code=`) is named by one of
  // its own step records (the manifest names each step's parent form).
  const own = steps.filter((step) => step.form === record.name);
  const loadStep = own.find((step) => /\?(?:id|parentid|code)=/.test(step.variation ?? ""));
  const page = record.path + (recordQuery(record) || (loadStep ? recordQuery(loadStep) : ""));
  // Fields filled on the first step come from that step's target table.
  const first = own[0];
  const T = TABLES[first?.table] ?? TABLES.pqvd_baselineitem;
  const s = (state, steps, expect = {}) => out.push(scenario(`multistep-form/${record.slug}/${state}/editor`, { ...parts, state }, steps, expect));
  // Step forms of one table differ in the fields they show: fills are optional, the required ones are on every form.
  const readOnlyStep = (first?.catalog ?? []).includes("pp.msstep.mode.readonly");
  const insert = (name, code) => readOnlyStep ? [] : [...T.insert(name, code), { fill: T.text, value: "step one" }, ...((first?.catalog ?? []).includes("pp.msstep.attachfile") ? [attach()] : [])].map((step) => ({ ...step, optional: true }));
  s("step1", [{ goto: page }], { present: [FORM] });
  s("step1-submit", [{ goto: page }, ...insert("Baseline multistep {id:run}", "MS-{id:run}"), { click: "input[name$='NextButton'], " + SUBMIT }, { wait: { navigation: true } }], {});
  s("step2-back", [{ goto: page }, ...insert("Baseline multistep back {id:run}", "MB-{id:run}"), { click: "input[name$='NextButton'], " + SUBMIT }, { wait: { navigation: true } }, { click: "input[name$='PreviousButton']" }, { wait: { navigation: true } }], {});
  s("resume", [{ goto: page }, ...insert("Baseline resume {id:run}", "MR-{id:run}"), { click: "input[name$='NextButton'], " + SUBMIT }, { wait: { navigation: true } }, { goto: page }], {});
  return out;
}

export function buildMatrix(manifest, project = {}) {
  const slugOf = (record) => (record.path ?? record.name).replace(/^\/baseline\//, "").replace(/\/$/, "").replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "root";
  const scenarios = [];
  for (const record of manifest.records) {
    const r = { ...record, slug: slugOf(record) };
    if (!record.path) continue;
    if (record.kind === "basicform") scenarios.push(...basicFormScenarios(r, project));
    else if (record.kind === "list") scenarios.push(...listScenarios(r, project));
    else if (record.kind === "advancedform") scenarios.push(...multistepScenarios(r, manifest.records.filter((item) => item.kind === "advancedformstep")));
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
