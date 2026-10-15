#!/usr/bin/env node
// Generates the baseline scenario matrix (component × variation × state × persona) from the
// fixture site manifest. Scenario steps use the native Power Pages control contracts (control ids
// are column logical names; the submit control is named `…$InsertButton`/`…$UpdateButton`;
// lookups use `.launchentitylookup`, `.clearlookupfield` (the Contact lookup: the item edit form renders the Parent lookup as a dropdown per its metadata); lists use the entity-list markup) and
// the fixture record aliases ({id:item1} …). Project-specific parts (origin, browser bridge, hooks,
// synthetic contact) come from a project file merged in with --project.
//
//   node scripts/baseline-matrix.mjs --out <matrix.json> [--manifest examples/project/baseline/site-manifest.json] [--project <project.json>]
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `verify` is the set of probes the live side repeats until the portal's permission cache reflects the role change: every
// probe must pass in one attempt. The portal refreshes its cache per page and the previous persona lingers on the pages
// not probed yet (run 5b: the role-less persona was denied the edit form while the modal list still served the reader's
// rows), so each persona is told apart from the editor and from the persona captured before it (run order: editor, reader,
// none, contact-scope, account-scope, parent-scope, anonymous) with the fixture's table permissions:
// item1 is the tester contact's and the fixture account's; item5 is the account's only (contact-scope is denied it, account-scope
// edits it); item4 is another contact's (parent2); the parent-scope role reads items only through their parent (read only, so
// the edit form renders read-only), so item11, which has no parent, is denied to it while the reader's global read opens it.
const SIGNED_IN = "a[href*='/Account/Login/LogOff'], a[href*='SignOut'], a[href*='LogOff']";
const UPDATE = "input[name$='UpdateButton']";
const probe = (goto, expect) => ({ steps: [{ goto }, { wait: 1500 }], expect });
const edit = (alias) => `/baseline/item-edit/?id={id:${alias}}`;
// The live side clears the portal cache after each persona switch (`live.refresh`), so the probes only cover the
// seconds the portal needs to reload; without a refresh the permission cache lagged minutes to over an hour (runs 5-6b).
const verify = (...probes) => ({ probes, attempts: 8, delay: 10000, settleMs: 3000 });
const PERSONAS = {
  editor: { roles: ["Baseline Editors"], verify: verify(probe("/baseline/item-create/", { present: ["#pqvd_name", SIGNED_IN] }), probe(edit("item7"), { present: ["#pqvd_name", UPDATE] })) },
  reader: { roles: ["Baseline Readers"], verify: verify(probe("/baseline/item-create/", { absent: ["#pqvd_name"], present: [SIGNED_IN] }), probe(edit("item1"), { present: ["#pqvd_name[readonly]"], absent: [UPDATE] })) },
  // Lists render their table shell whatever the roles: "none" is verified on the edit form of a readable record and on the
  // modal list's grid data (no rows once the role-less contact is in effect; the reader before it saw every item).
  none: { roles: [], verify: verify(probe(edit("item1"), { absent: ["#pqvd_name"], present: [SIGNED_IN] }), probe("/baseline/item-list-modal/", { absent: ["tr[data-id]"], present: [SIGNED_IN] })) },
  "contact-scope": { roles: ["Baseline Contact Scope"], verify: verify(probe(edit("item1"), { present: ["#pqvd_name", UPDATE] }), probe(edit("item7"), { absent: ["#pqvd_name"], present: [SIGNED_IN] }), probe(edit("item5"), { absent: ["#pqvd_name"], present: [SIGNED_IN] })) },
  // `account` marks the persona whose contact belongs to the fixture account (persona.mjs sets parentcustomerid): lists
  // filtered by account run their editor states under it.
  "account-scope": { roles: ["Baseline Account Scope"], account: true, verify: verify(probe(edit("item5"), { present: ["#pqvd_name", UPDATE] }), probe(edit("item7"), { absent: ["#pqvd_name"], present: [SIGNED_IN] })) },
  "parent-scope": { roles: ["Baseline Parent Scope"], verify: verify(probe(edit("item1"), { present: ["#pqvd_name[readonly]"], absent: [UPDATE] }), probe(edit("item11"), { absent: ["#pqvd_name"], present: [SIGNED_IN] })) },
  anonymous: { anonymous: true, verify: verify(probe("/baseline/item-create/", { absent: [SIGNED_IN] })) },
};
const SUBMIT = "input[name$='InsertButton'], input[name$='UpdateButton']";
const SIGN_IN = [".login-heading-section"];
const FORM = "form#liquid_form, form[id$='_form'], form";
const MODAL = ".modal.in, .modal.show";
const within = (prefix) => MODAL.split(", ").map((selector) => `${prefix} ${selector}`).join(", ");
const PLUGIN_STAGES = ["prevalidation", "preoperation", "postoperation"];

// `watch` names control ids whose visibility and value the reference reports after the capture.
const scenario = (id, parts, steps, expect, extra = {}) => ({ id, ...parts, steps, expect: { absent: SIGN_IN, ...expect }, ...extra });

// Per-table fixture facts the scenarios need: which records to open, which fields an insert fills, and
// which behaviours (plugin steps, business rules, lookups, notes) the table carries. Validation states come from
// the form's metadata records (regex, range and required-message rules live on the forms that carry them).
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
// `ruled`: a record on which the hide-by-flag rule's condition holds (flag false) and the hidden-by-rule column has a value.
const TABLES = {
  pqvd_baselineitem: { record: "item1", minimal: "item2", inactive: "item3", foreign: "item7", actionRecords: ["item9", "item10", "item11"], ruled: "item8", insert: (name, code) => [{ fill: "#pqvd_name", value: name }, { fill: "#pqvd_code", value: code }, { fill: "#pqvd_required", value: "required value" }], required: "#pqvd_required", text: "#pqvd_text", plugins: true, rules: true, lookup: "Contact", notes: true },
  pqvd_baselinechild: { record: "child1", minimal: "child2", inactive: "child5", foreign: "child4", insert: (name) => [{ fill: "#pqvd_name", value: name }, { fill: "#pqvd_sortorder", value: "10" }], required: "#pqvd_name", text: "#pqvd_note", plugins: false, rules: false, lookup: null, notes: false },
  contact: { record: "tester", minimal: "tester", inactive: "tester", foreign: "other", insert: (name) => [{ fill: "#jobtitle", value: name }], required: "#jobtitle", text: "#telephone1", plugins: false, rules: false, lookup: null, notes: false },
  pqvd_baselineparent: { record: "parent1", minimal: "parent2", inactive: "parent3", foreign: "parent2", insert: (name, code) => [{ fill: "#pqvd_name", value: name }, { fill: "#pqvd_code", value: code }], required: "#pqvd_name", text: "#pqvd_description", plugins: false, rules: false, lookup: null, notes: false },
};

// The non-editor personas (reader, none, anonymous, the scope personas) render the same denial or read-only page
// on every record of a kind, so they run only on the representative pages the project names (`personaPages`).
const personaPage = (record, project) => !project.personaPages || project.personaPages.includes(record.path);
// Validation, plugin, lookup and note behaviours do not depend on a form's presentation options, so they run only on the
// canonical form of each table (`behaviourPages`); a variant form captures the states its own configuration changes.
const behaviourPage = (record, project) => !project.behaviourPages || project.behaviourPages.includes(record.path);
const cites = (record, pattern) => (record.catalog ?? []).some((id) => (pattern instanceof RegExp ? pattern.test(id) : id === pattern));

function basicFormScenarios(record, project = {}, metadata = [], context = {}) {
  const out = [];
  const personas = personaPage(record, project);
  const full = behaviourPage(record, project);
  const T = TABLES[record.table] ?? TABLES.pqvd_baselineitem;
  // A form with auto-generated steps shows one tab per step: Next moves on, the submit button is on the last tab.
  const stepped = cites(record, "pp.basicform.auto-generate-steps");
  // A form redirecting to an external URL ends its insert scenario off the site: the hostname is the evidence.
  const external = cites(record, "pp.basicform.redirect-external-url");
  // Captcha for authenticated users is never bypassed: the insert stays on the form with the captcha validation state.
  const captcha = cites(record, "pp.basicform.captcha-authenticated");
  const NEXT = "input[name$='NextButton']";
  const tabs = project.formTabs?.[record.formName ?? record.form ?? ""] ?? project.formTabs?.default ?? 1;
  const submit = stepped ? [...Array(Math.max(0, tabs - 1)).fill([{ click: NEXT, dispatch: true, optional: true }, { wait: 1500 }]).flat(), { click: SUBMIT }] : [{ click: SUBMIT }];
  const firstStep = stepped ? [{ click: NEXT, dispatch: true }] : [...submit];
  const parts = { component: "basic-form", variation: record.variation ?? record.name, persona: "editor" };
  const page = record.path + recordQuery(record);
  const mode = /insert/i.test(record.variation ?? "") || /Insert/.test(record.name) ? "insert" : /read/i.test(record.variation ?? record.name) ? "read-only" : "edit";
  const idSuffix = (state, persona = "editor") => `${record.slug}/${state}/${persona}`;
  const open = (alias) => `${page}${page.includes("?") ? "&" : "?"}id={id:${alias}}`;
  // Validation rules configured on this form's metadata records (manifest `basicformmetadata`, linked by `form`): the
  // value that violates each rule, with the fields an insert needs or the record an edit opens.
  const rules = (fillBefore, openFirst) => {
    const states = [];
    for (const meta of metadata) {
      const field = `#${meta.name}`;
      if (cites(meta, "pp.bfmeta.attribute.validation.regex")) states.push(["regex-error", [{ fill: field, value: "regex should fail 1" }]]);
      if (cites(meta, "pp.bfmeta.attribute.validation.range.message")) states.push(["range-error", [{ fill: field, value: "5000" }]]);
      if (cites(meta, "pp.bfmeta.attribute.validation.required.message")) states.push(["required-message", [{ clear: field }]]);
    }
    for (const [state, violate] of states) out.push(scenario(`basic-form/${idSuffix(state)}`, { ...parts, state }, [...openFirst, ...fillBefore(state), ...violate, ...submit, { wait: 1500 }], { present: [FORM] }));
  };
  if (mode === "insert") {
    out.push(scenario(`basic-form/${idSuffix("empty")}`, { ...parts, state: "empty" }, [{ goto: page }], { present: [FORM] }));
    const attachments = cites(record, "pp.basicform.attach-file") ? [attach()] : [];
    // The attach forms redirect to the saved record's edit page (the uploaded note shows there): a rejected upload or
    // submit stays on the insert form, so the capture fails instead of reporting a page that never saved.
    const saved = attachments.length ? { urlPattern: "[?&]id=[0-9a-f-]{36}", present: ["#pqvd_name"], absent: [...SIGN_IN, ".validation-summary:visible"] } : {};
    out.push(scenario(`basic-form/${idSuffix(captcha ? "insert-captcha" : "insert")}`, { ...parts, state: captcha ? "insert-captcha" : "insert" }, [{ goto: page }, ...T.insert("Baseline inserted item", "I-NEW-{id:run}"), ...attachments, ...submit, { wait: { navigation: true } }], external ? { leavesOrigin: true } : captcha ? { present: [FORM] } : saved));
    if (full || stepped) out.push(scenario(`basic-form/${idSuffix("required-missing")}`, { ...parts, state: "required-missing" }, [{ goto: page }, ...firstStep, { wait: 1500 }], { present: [FORM] }));
    rules((state) => T.insert(`Baseline ${state}`, `I-${state.replace(/-.*/, "").toUpperCase()}-{id:run}`), [{ goto: page }]);
    if (full && T.plugins) for (const stage of PLUGIN_STAGES) out.push(scenario(`basic-form/${idSuffix(`plugin-error-create-${stage}`)}`, { ...parts, state: `plugin-error-create-${stage}` }, [{ goto: page }, ...T.insert(`Baseline plugin ${stage}`, `I-PL-${stage.slice(0, 3)}-{id:run}`), { fill: "#pqvd_text", value: `plugin-fail-create-${stage}` }, ...submit, { wait: { navigation: true } }], {}));
    // The rule's error action fires above 500; the live portal saves the record (basic forms run no business rules): `watch` shows the value.
    if (full && T.rules) out.push(scenario(`basic-form/${idSuffix("rule-error")}`, { ...parts, state: "rule-error" }, [{ goto: page }, ...T.insert("Baseline rule error", "I-RE-{id:run}"), { fill: "#pqvd_ruleerror", value: "600" }, ...submit, { wait: { navigation: true } }], {}, { watch: ["pqvd_ruleerror"] }));
    if (personas) for (const persona of ["reader", "none", "anonymous"]) out.push(scenario(`basic-form/${idSuffix("permission-denied", persona)}`, { ...parts, persona, state: "permission-denied" }, [{ goto: page }], { absent: persona === "anonymous" ? [] : SIGN_IN }));
    // The scope personas hold Create on their scope: the insert form may render for them.
    if (personas) for (const persona of ["contact-scope", "account-scope", "parent-scope"]) out.push(scenario(`basic-form/${idSuffix("permission", persona)}`, { ...parts, persona, state: "permission" }, [{ goto: page }], {}));
  } else if (mode === "edit") {
    out.push(scenario(`basic-form/${idSuffix("populated")}`, { ...parts, state: "populated" }, [{ goto: open(T.record) }], { present: [FORM, "#pqvd_name"] }));
    if (full) out.push(scenario(`basic-form/${idSuffix("minimal")}`, { ...parts, state: "minimal" }, [{ goto: open(T.minimal) }], { present: [FORM] }));
    if (full) out.push(scenario(`basic-form/${idSuffix("inactive-record")}`, { ...parts, state: "inactive-record" }, [{ goto: open(T.inactive) }], {}));
    // The configured record-not-found message renders when the page has no (or an empty or malformed) id; a well-formed id
    // no record has (`missing`, the zero GUID) renders the platform exception instead (live, 2026-10-15).
    if (cites(record, "pp.basicform.record-not-found-message")) {
      out.push(scenario(`basic-form/${idSuffix("record-not-found")}`, { ...parts, state: "record-not-found" }, [{ goto: page }], {}));
      out.push(scenario(`basic-form/${idSuffix("record-missing-id")}`, { ...parts, state: "record-missing-id" }, [{ goto: open("missing") }], {}));
    }
    if (full && T.rules) out.push(scenario(`basic-form/${idSuffix("hidden-by-rule")}`, { ...parts, state: "hidden-by-rule" }, [{ goto: open(T.ruled) }], { present: [FORM] }, { watch: ["pqvd_hiddenbyrule", "pqvd_flag"] }));
    out.push(scenario(`basic-form/${idSuffix("save-text")}`, { ...parts, state: "save-text" }, [{ goto: open(T.record) }, { fill: T.text, value: "edited by baseline" }, ...submit, { wait: { navigation: true } }], {}));
    // Variants that change the validation summary (links, header, CSS) show it on a missing required value.
    if (full || /summary/i.test(record.variation ?? "")) out.push(scenario(`basic-form/${idSuffix("required-missing")}`, { ...parts, state: "required-missing" }, [{ goto: open(T.record) }, { clear: T.required }, ...firstStep, { wait: 1500 }], { present: [FORM] }));
    rules(() => [], [{ goto: open(T.record) }]);
    if (full && T.plugins) for (const stage of PLUGIN_STAGES) out.push(scenario(`basic-form/${idSuffix(`plugin-error-update-${stage}`)}`, { ...parts, state: `plugin-error-update-${stage}` }, [{ goto: open(T.record) }, { fill: "#pqvd_text", value: `plugin-fail-update-${stage}` }, ...submit, { wait: { navigation: true } }], {}));
    // The live portal serves the record from its read cache for a few seconds after the save (run 7a: pre-save values 3 s
    // later; the plugin's write showed after 4 s and a navigation), so the reload waits 6 s and expects the plugin's text.
    // The update postback re-renders the posted values (the ticker is upper-cased on the client), so the plugin's write
    // ("mutate-me" → "mutated by plugin" on the text area) shows only when the record is reopened after the save.
    // Run 7 A2: the reload 16 s after the save still served the pre-save record, so the scenario clears the portal cache
    // with the project's live refresh steps; optional, because Mirage has no clear-cache control (the click is skipped).
    const clearCache = (project.live?.refresh?.steps ?? []).map((step) => ({ ...step, optional: true }));
    const mutate = [{ goto: open(T.record) }, { fill: "#pqvd_ticker", value: "  mut  " }, { fill: "#pqvd_textarea", value: "mutate-me" }, ...submit, { wait: { navigation: true } }];
    if (full && T.plugins) out.push(scenario(`basic-form/${idSuffix("plugin-mutation")}`, { ...parts, state: "plugin-mutation" }, [...mutate, { wait: 6000 }, ...clearCache, { goto: open(T.record) }, { wait: 1500 }], { present: [FORM, "textarea#pqvd_textarea:has-text('mutated by plugin')"] }, { watch: ["pqvd_ticker", "pqvd_textarea"] }));
    if (full && T.plugins) out.push(scenario(`basic-form/${idSuffix("plugin-mutation-postback")}`, { ...parts, state: "plugin-mutation-postback" }, mutate, { present: [FORM] }, { watch: ["pqvd_ticker", "pqvd_textarea"] }));
    if (full && T.lookup) out.push(scenario(`basic-form/${idSuffix("lookup-dialog-open")}`, { ...parts, state: "lookup-dialog-open" }, [{ goto: open(T.record) }, { click: `button.launchentitylookup[aria-label*='${T.lookup}']` }, { wait: { selector: MODAL, state: "visible" } }, { wait: 1500 }], { present: [".modal"] }));
    if (full && T.lookup) out.push(scenario(`basic-form/${idSuffix("lookup-search")}`, { ...parts, state: "lookup-search" }, [{ goto: open(T.record) }, { click: `button.launchentitylookup[aria-label*='${T.lookup}']` }, { wait: { selector: MODAL, state: "visible" } }, { fill: ".modal.in input.query, .modal.show input.query", value: "*Other" }, { press: ".modal.in input.query, .modal.show input.query", key: "Enter" }, { wait: 1500 }], { present: [".modal"] }));
    if (full && T.lookup) out.push(scenario(`basic-form/${idSuffix("lookup-select")}`, { ...parts, state: "lookup-select" }, [{ goto: open(T.record) }, { click: `button.launchentitylookup[aria-label*='${T.lookup}']` }, { wait: { selector: MODAL, state: "visible" } }, { wait: 1500 }, { click: ".modal.in table tbody tr:nth-child(2), .modal.show table tbody tr:nth-child(2)" }, { click: ".modal.in button.primary, .modal.show button.primary" }, { wait: 1000 }], { present: [FORM] }, { watch: ["pqvd_contactid_name"] }));
    if (full && T.lookup) out.push(scenario(`basic-form/${idSuffix("lookup-clear")}`, { ...parts, state: "lookup-clear" }, [{ goto: open(T.record) }, { click: `button.clearlookupfield[aria-label*='${T.lookup}']` }, { wait: 800 }], { present: [FORM] }, { watch: ["pqvd_contactid_name"] }));
    if (full && T.notes) out.push(scenario(`basic-form/${idSuffix("note-add")}`, { ...parts, state: "note-add" }, [{ goto: open(T.record) }, { wait: { selector: "a.addnote:visible, .entity-notes .add-note:visible", state: "visible" } }, { click: "a.addnote:visible, .entity-notes .add-note:visible" }, { wait: { selector: MODAL, state: "visible" } }, { fill: ".modal.in textarea, .modal.show textarea", value: "note added by baseline" }, { click: ".modal.in button.primary, .modal.show button.primary, .modal.in .btn-primary, .modal.show .btn-primary" }, { wait: 2500 }], { present: [FORM] }));
    // Form actions (basic form settings): the delete dialog opens and stays open; activate/deactivate post without a
    // dialog when the settings require no confirmation (the fixture reset restores the record's state).
    if (cites(record, "pp.basicform.action.delete")) out.push(scenario(`basic-form/${idSuffix("delete-dialog")}`, { ...parts, state: "delete-dialog" }, [{ goto: open(T.record) }, { click: "button.delete-link" }, { wait: { selector: ".modal-delete.in, .modal-delete.show", state: "visible" } }, { wait: 1000 }], { present: [".modal-delete"] }));
    // State actions run on a row reserved for this variant (T.actionRecords, deactivated in the fixture): the portal's
    // record cache would otherwise serve one variant's state change to the next capture of a shared record.
    const own = T.actionRecords?.[context.actionSlot?.get(record.path) ?? 0] ?? T.inactive;
    if (cites(record, "pp.basicform.action.activate")) out.push(scenario(`basic-form/${idSuffix("activate")}`, { ...parts, state: "activate" }, [{ goto: open(own) }, { click: "button.activate-link" }, { wait: 3000 }], {}));
    if (cites(record, "pp.basicform.action.deactivate")) out.push(scenario(`basic-form/${idSuffix("deactivate")}`, { ...parts, state: "deactivate" }, [{ goto: open(own) }, { click: "button.activate-link", optional: true }, { wait: 3000 }, { click: "button.deactivate-link" }, { wait: 3000 }], {}));
    if (cites(record, "pp.basicform.action.create-related-record")) out.push(scenario(`basic-form/${idSuffix("create-related-dialog")}`, { ...parts, state: "create-related-dialog" }, [{ goto: open(T.record) }, { click: "button.create-related-record-link" }, { wait: { selector: MODAL, state: "visible" } }, { wait: 2500 }], { present: [".modal"] }));
    // Subgrid associate (lookup dialog) and disassociate (the first row's action menu; no confirmation configured).
    for (const meta of metadata.filter((m) => cites(m, "pp.bfmeta.subgrid.action.associate"))) out.push(scenario(`basic-form/${idSuffix("associate-dialog")}`, { ...parts, state: "associate-dialog" }, [{ goto: open(T.record) }, { click: `#${meta.name} a.action` }, { wait: { selector: MODAL, state: "visible" } }, { wait: 2500 }], { present: [".modal"] }));
    for (const meta of metadata.filter((m) => cites(m, "pp.bfmeta.subgrid.action.disassociate"))) out.push(scenario(`basic-form/${idSuffix("disassociate")}`, { ...parts, state: "disassociate" }, [{ goto: open(T.record) }, { click: `#${meta.name} tr[data-id] button[aria-label='action menu']` }, { wait: 500 }, { click: `#${meta.name} tr[data-id] a.disassociate-link` }, { wait: 3000 }], { present: [FORM] }));
    // A lookup with a form for create offers "New" in its dialog, which opens the create form dialog.
    for (const meta of metadata.filter((m) => cites(m, "pp.bfmeta.attribute.lookup.formforcreate"))) {
      const launch = [{ goto: open(T.record) }, { click: `.control[data-logical-name='${meta.name}'] button.launchentitylookup` }, { wait: { selector: within(`#${meta.name}_lookupmodal`), state: "visible" } }, { wait: 1500 }];
      out.push(scenario(`basic-form/${idSuffix("lookup-dialog-open")}`, { ...parts, state: "lookup-dialog-open" }, launch, { present: [".modal"] }));
      out.push(scenario(`basic-form/${idSuffix("lookup-create-dialog")}`, { ...parts, state: "lookup-create-dialog" }, [...launch, { click: `#${meta.name}_lookupmodal button.new-value` }, { wait: 2500 }], { present: [".modal"] }));
    }
    if (personas) for (const persona of ["reader", "contact-scope", "account-scope", "parent-scope", "none", "anonymous"]) out.push(scenario(`basic-form/${idSuffix("permission", persona)}`, { ...parts, persona, state: "permission" }, [{ goto: open(T.record) }], { absent: persona === "anonymous" ? [] : SIGN_IN }));
    if (personas) out.push(scenario(`basic-form/${idSuffix("contact-scope-foreign", "contact-scope")}`, { ...parts, persona: "contact-scope", state: "contact-scope-foreign" }, [{ goto: open(T.foreign) }], {}));
  } else {
    // A deactivated basic form record renders no form on live: whatever the page shows is the evidence.
    const inactiveForm = cites(record, "pp.basicform.statecode");
    out.push(scenario(`basic-form/${idSuffix("read-only")}`, { ...parts, state: "read-only" }, [{ goto: open(T.record) }], inactiveForm ? {} : { present: [FORM] }));
    if (personas) for (const persona of ["reader", "contact-scope", "account-scope", "parent-scope", "none", "anonymous"]) out.push(scenario(`basic-form/${idSuffix("read-only", persona)}`, { ...parts, persona, state: "read-only" }, [{ goto: open(T.record) }], {}));
  }
  return out;
}

function listScenarios(record, project = {}) {
  const out = [];
  // A list filtered by the signed-in contact's account shows rows only for the persona whose contact has one.
  const editor = cites(record, "pp.list.filteraccount") ? Object.entries(PERSONAS).find(([, persona]) => persona.account)?.[0] ?? "editor" : "editor";
  const parts = { component: "list", variation: record.variation ?? record.name, persona: editor };
  const page = record.path;
  const s = (state, steps, expect = {}, persona = editor) => out.push(scenario(`list/${record.slug}/${state}/${persona}`, { ...parts, persona, state }, steps, expect));
  const grid = ".entitylist, .entity-grid, [data-view-layouts]";
  // A deactivated list record renders no grid (the live page shows the Liquid error): only its default state applies.
  if (cites(record, "pp.list.statecode")) {
    s("default", [{ goto: page }, { wait: 1500 }], {});
    return out;
  }
  s("default", [{ goto: page }, { wait: { selector: `${grid} table, ${grid} .table`, state: "visible" } }, { wait: 1500 }], { present: [grid] });
  // The view selector and the search box exist only when the list record configures them.
  if (cites(record, "pp.list.views.selector")) s("view-selector", [{ goto: page }, { wait: 1500 }, { click: ".view-toolbar .dropdown-toggle, .entitylist .view-selector .dropdown-toggle, .btn-group .dropdown-toggle" }, { wait: 600 }, { click: ".dropdown-menu a:has-text('All'), .dropdown-menu li:nth-child(2) a" }, { wait: 2000 }], { present: [grid] });
  if (cites(record, "pp.list.searchenabled")) s("search", [{ goto: page }, { wait: 1500 }, { fill: ".entitylist-search input, input.query, input[placeholder*='Search']", value: "*Alpha" }, { press: ".entitylist-search input, input.query, input[placeholder*='Search']", key: "Enter" }, { wait: 2000 }], { present: [grid] });
  // Calendar and map lists render no grid table: paging and sorting apply to grid lists only.
  const gridList = !cites(record, /^pp\.list\.(?:calendar|map)\./);
  // A list filtered to the portal user's records or account shows fewer rows than a page on the fixture data: no paging.
  const scoped = cites(record, /^pp\.list\.filter(?:account|portaluser)$/);
  if (gridList && !scoped && cites(record, "pp.list.pagesize")) s("paging", [{ goto: page }, { wait: 1500 }, { click: ".pagination li:nth-child(3) a, .pagination a[data-page='2'], .pagination li.next a" }, { wait: 2000 }], { present: [grid] });
  if (gridList) s("sort", [{ goto: page }, { wait: 1500 }, { click: "th a[data-logicalname='pqvd_code'], th a:has-text('Code'), th:nth-child(2) a" }, { wait: 2000 }], { present: [grid] });
  // The OData feed is a document of its own under /_odata/<entity set name>.
  if (record.odataEntitySet) s("feed", [{ goto: `/_odata/${record.odataEntitySet}` }], {});
  if (/modal/i.test(record.variation ?? "")) {
    s("modal-details", [{ goto: page }, { wait: 1500 }, { click: "tr .details-link, tr a.details-link, tr .launch-modal" }, { wait: { selector: MODAL, state: "visible" } }, { wait: 2500 }], { present: [".modal"] });
    s("modal-create", [{ goto: page }, { wait: 1500 }, { click: ".toolbar a.create-action, a.create-action, .btn.create-action" }, { wait: { selector: MODAL, state: "visible" } }, { wait: 2500 }], { present: [".modal"] });
    s("modal-edit", [{ goto: page }, { wait: 1500 }, { click: "tr button[aria-label='action menu'], tr .dropdown-toggle" }, { wait: 500 }, { click: "tr .dropdown-menu .edit-link, tr .dropdown-menu a.edit-link" }, { wait: { selector: MODAL, state: "visible" } }, { wait: 2500 }], { present: [".modal"] });
    s("modal-delete", [{ goto: page }, { wait: 1500 }, { click: "tr button[aria-label='action menu'], tr .dropdown-toggle" }, { wait: 500 }, { click: "tr .dropdown-menu .delete-link, tr .dropdown-menu a.delete-link" }, { wait: { selector: MODAL, state: "visible" } }, { wait: 1000 }], { present: [".modal"] });
  }
  // Each filter state needs the filter type the list's definition declares (the horizontal list carries only the text filter).
  const filter = (id) => cites(record, id);
  if (filter("pp.listfilter.definition")) {
    if (filter("pp.listfilter.text")) s("filter-text", [{ goto: page }, { wait: 1500 }, { fill: ".entitylist-filter input[type='text'], .filter-text input", value: "*Alpha" }, { click: ".entitylist-filter button[type='submit'], .filter-submit, button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
    if (filter("pp.listfilter.visualization.dropdown")) s("filter-dropdown", [{ goto: page }, { wait: 1500 }, { select: ".entitylist-filter select", label: "Beta" }, { click: ".entitylist-filter button[type='submit'], button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
    if (filter("pp.listfilter.visualization.checkbox")) s("filter-checkbox", [{ goto: page }, { wait: 1500 }, { check: ".entitylist-filter input[type='checkbox']" }, { click: ".entitylist-filter button[type='submit'], button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
    s("filter-reset", [{ goto: page }, { wait: 1500 }, { click: ".entitylist-filter button[type='submit'], button:has-text('Apply')" }, { wait: 2000 }], { present: [grid] });
  }
  if (personaPage(record, project)) for (const persona of ["reader", "contact-scope", "account-scope", "parent-scope", "none", "anonymous"]) s("permission", [{ goto: page }, { wait: 1500 }], { absent: persona === "anonymous" ? [] : SIGN_IN }, persona);
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

// Pages that host no form, list or multistep form (the root index, page-rule pages, template, Liquid and bound pages,
// the pushpin web file) render once, opened with the query their variation names (`?id=<id>` for a page whose read form
// takes its record from the query string); a page with a web page access control rule renders for each persona the rule
// names, the first role persona it leaves out and the anonymous visitor (every signed-in persona holds Administrators,
// whose site-wide grant-change rule overrides restrict-read, so only the visitor can show the rule's effect). Every page
// copy carries the page name; the pushpin is an image.
function pageScenarios(record, manifest) {
  const out = [];
  const rule = manifest.records.find((r) => r.kind === "webpagerule" && r.path === record.path);
  const template = manifest.records.find((r) => r.kind === "pagetemplate" && r.path === record.path);
  const parts = { component: "page", variation: rule ? `${record.name}: ${rule.variation}` : template ? `${record.name}: ${template.variation}` : record.name };
  const expectText = record.kind === "webfile" ? {} : { text: [record.name] };
  if (!rule) {
    out.push(scenario(`page/${record.slug}/render/editor`, { ...parts, persona: "editor", state: "render" }, [{ goto: record.path + recordQuery(record) }], expectText));
    return out;
  }
  const named = Object.entries(PERSONAS).filter(([, persona]) => persona.roles?.some((role) => rule.roles?.includes(role))).map(([name]) => name);
  const excluded = Object.entries(PERSONAS).find(([name, persona]) => persona.roles?.length && !named.includes(name))?.[0];
  const restrictRead = cites(rule, "pp.pagerule.right.restrictread");
  for (const persona of [...named, ...(excluded ? [excluded] : []), "anonymous"]) {
    const expect = restrictRead && !named.includes(persona) ? {} : expectText;
    // The anonymous visitor of a restrict-read page lands on the sign-in page (run 7a: 302 → /SignIn?ReturnUrl=…); a
    // grant-change-only page renders for it. `signIn` tells the live runner not to treat the sign-in page as a failure.
    const anonymous = restrictRead ? { present: SIGN_IN, absent: [], signIn: true } : { ...expect, absent: [] };
    out.push(scenario(`page/${record.slug}/access/${persona}`, { ...parts, persona, state: "access" }, [{ goto: record.path }], persona === "anonymous" ? anonymous : expect));
  }
  return out;
}

export function buildMatrix(manifest, project = {}) {
  const slugOf = (record) => (record.path ?? record.name).replace(/^\/baseline\//, "").replace(/\/$/, "").replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "root";
  const scenarios = [];
  const actionPages = manifest.records.filter((r) => r.kind === "basicform" && r.path && (r.catalog ?? []).some((id) => /^pp.basicform.action.(?:activate|deactivate)$/.test(id))).map((r) => r.path);
  const context = { actionSlot: new Map(actionPages.map((page, index) => [page, index])) };
  const hosted = new Set(manifest.records.filter((r) => ["basicform", "list", "advancedform"].includes(r.kind) && r.path).map((r) => r.path));
  for (const record of manifest.records) {
    const r = { ...record, slug: slugOf(record) };
    if (!record.path) continue;
    if (record.kind === "basicform") scenarios.push(...basicFormScenarios(r, project, manifest.records.filter((m) => m.kind === "basicformmetadata" && m.form === record.name), context));
    else if (record.kind === "list") scenarios.push(...listScenarios(r, project));
    else if (record.kind === "advancedform") scenarios.push(...multistepScenarios(r, manifest.records.filter((item) => item.kind === "advancedformstep")));
    else if ((record.kind === "webpage" || record.kind === "webfile") && !hosted.has(record.path)) scenarios.push(...pageScenarios(r, manifest));
  }
  const seen = new Set();
  const unique = scenarios.filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
  return {
    version: 1,
    origin: project.origin ?? "https://example.invalid",
    live: project.live,
    hooks: project.hooks,
    writeScope: { paths: ["^/baseline/", "^/_services/", "^/_portal/", "^/_api/"], entitySets: ["pqvd_baselineitems", "pqvd_baselinechilds", "pqvd_baselineparents", "annotations"] },
    // The project's `mirageIdentity` mirrors what the live portal shows for the signed-in tester (name, parent account,
    // the base roles it holds besides the baseline ones); Mirage personas carry those roles on top of their own.
    personas: Object.fromEntries(Object.entries(PERSONAS).map(([name, { account, ...persona }]) => [name, { ...persona, ...(persona.roles && project.mirageIdentity?.roles ? { roles: [...persona.roles, ...project.mirageIdentity.roles] } : {}), ...(persona.anonymous ? {} : { mirageContact: project.mirageContact }) }])),
    mirage: { preset: "baseline", ...(project.mirageIdentity ? { identity: { contactId: project.mirageContact, ...(project.mirageIdentity.contactId ? { liveContactId: project.mirageIdentity.contactId } : {}), contact: project.mirageIdentity.contact ?? {}, roles: project.mirageIdentity.roles ?? [] } } : {}) },
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
