import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";
import { webFormsForm } from "../lib/platform-manifest.mjs";

// Synthetic contact form exercising one control of each kind. The record store and the
// schema are local fixtures; nothing is read from a portal.
const ID = "c0000000-0000-4000-8000-000000000001";
const record = {
  contactid: ID,
  fullname: "Ada",
  emailaddress1: "ada@example.invalid",
  telephone1: "",
  description: "Notes",
  notes: "Fixed",
  preferred: 2,
  donotemail: false,
  parentcustomerid: { id: "a0000000-0000-4000-8000-000000000001", logical_name: "account", name: "Org" },
  birthdate: "2020-01-02",
};
const fields = [
  { name: "fullname", label: "Full name", dataverseType: "nvarchar", maxLength: 100, required: true },
  { name: "emailaddress1", label: "E-mail", dataverseType: "nvarchar", format: "email", maxLength: 100 },
  { name: "telephone1", label: "Phone", dataverseType: "nvarchar", format: "phone", maxLength: 50 },
  { name: "description", label: "Description", dataverseType: "memo", maxLength: 2000, rowspan: 1 },
  { name: "notes", label: "Notes", dataverseType: "memo", maxLength: 2000, rowspan: 2, readOnly: true },
  { name: "preferred", label: "Preferred", dataverseType: "picklist", required: true, options: [{ value: 1, label: "Email" }, { value: 2, label: "Phone" }] },
  { name: "donotemail", label: "Do not e-mail", dataverseType: "boolean", controlClassId: "{3EF39988-22BB-4F0B-BBBE-64B5A3748AEE}", options: [{ value: 0, label: "Allow" }, { value: 1, label: "Do not allow" }] },
  { name: "parentcustomerid", label: "Company", dataverseType: "lookup", lookupTargets: ["account"] },
  { name: "birthdate", label: "Birthday", dataverseType: "datetime", format: "date", dateTimeBehavior: "TimeZoneIndependent" },
];
const layout = [
  {
    name: "general",
    columns: [
      {
        sections: [
          { name: "details", label: "Details", showLabel: true, rows: fields.map((field) => [{ name: field.name, label: field.label, rowspan: field.rowspan }]) },
          { name: "", label: "", showLabel: false, rows: [] },
        ],
      },
    ],
  },
];
async function render(mode) {
  const store = {
    resolveMapping: (entity) =>
      entity === "account"
        ? { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" }
        : { entitySet: "contacts", idColumn: "contactid", relationships: { parentcustomerid_account: { from: "parentcustomerid", entity: "account", many: false } } },
    get: async () => record,
    query: async () => ({ value: [] }),
  };
  const portal = { forms: [{ id: "form", name: "Contact", mode }], records: [], website: { id: "site" }, pages: [] };
  const schemas = { form: { entity: "contact", title: "Contact", fields, layout } };
  return renderComponent("entityform", "form", { user: { id: "current" }, request: { params: { id: ID } } }, { portal, store, schemas });
}
const element = (html, pattern) => {
  const match = html.match(pattern);
  assert.ok(match, `missing ${pattern}`);
  return match[0];
};

test("edit form: string, e-mail, phone and memo boxes carry the platform handlers and required-field labels", async () => {
  const html = await render(100000001);
  const name = element(html, /<input [^>]*id="fullname"[^>]*>/);
  assert.match(name, / aria-required="true" title="Full name is a required field." aria-label="Full name"/);
  assert.match(name, / onkeypress="javascript:return LengthError\(this, event\);"/);
  const email = element(html, /<input [^>]*id="emailaddress1"[^>]*>/);
  assert.match(email, / type="email"/);
  assert.match(email, / ondblclick="launchEmail\(this.value\);"/);
  assert.match(email, / onkeypress="javascript:return LengthError/);
  const phone = element(html, /<input [^>]*id="telephone1"[^>]*>/);
  assert.match(phone, / type="text"/);
  assert.match(phone, / placeholder="Provide a telephone number"/);
  // rows = rowspan * 3 - 2 (MemoControlTemplate), with the LimitInput/LimitPaste handlers.
  const memo = element(html, /<textarea [^>]*id="description"[^>]*>/);
  assert.match(memo, / rows="1"/);
  assert.match(memo, / onkeydown="javascript:return LimitInput\(this, event\);" oninput="javascript:return LimitInput\(this, event\);" onpaste="javascript:return LimitPaste\(this, event\);"/);
  assert.match(element(html, /<textarea [^>]*id="notes"[^>]*>/), / rows="4"[^>]*class="textarea form-control  readonly"[^>]*readonly="readonly"/);
  // A field-level read-only cell has no validator container.
  assert.match(html, /<label for="notes" id="notes_label" class="field-label">Notes<\/label><\/div>/);
  // Option sets: an empty "Select" option, required="" on a required dropdown.
  const picklist = element(html, /<select [^>]*id="preferred"[^>]*>.*?<\/select>/);
  assert.match(picklist, /class="form-control picklist " onchange="setIsDirty\(this.id\);" required=""><option value="" label="Select" aria-label="Select"><\/option><option value="1">Email<\/option><option selected="selected" value="2">Phone<\/option>/);
  // Section titles are h3 headings; an unnamed section has no data-name.
  assert.match(html, /<legend class="section-title"><h3>Details<\/h3><\/legend><table role="presentation" data-name="details"/);
  assert.match(html, /<fieldset><table role="presentation" class="section">/);
  // Date columns state their solution DateTimeBehavior.
  assert.match(element(html, /<input [^>]*id="birthdate"[^>]*>/), / data-type="date"[^>]*data-behavior="TimeZoneIndependent"/);
  // The panel keeps its default button handler.
  assert.match(html, /id="EntityFormPanel"[^>]*onkeypress="javascript:return WebForm_FireDefaultButton\(event, 'UpdateButton'\)"/);
});

test("read-only form: MakeControlsReadonly marks labels, validators, summary and controls; lists are disabled", async () => {
  const html = await render(100000002);
  assert.match(html, /<div id="EntityFormControl_form_EntityFormView" class="form-readonly entity-form" readonly="readonly">/);
  assert.match(html, /<div id="ValidationSummaryEntityFormControl_form_EntityFormView" [^>]*role="alert" style="display:none;" readonly="readonly"><\/div>/);
  assert.match(html, /<label for="fullname" id="fullname_label" class="field-label" readonly="readonly">Full name<\/label>/);
  // Validators stay (read-only) and register with the page; the WebForms shell then submits through WebForm_OnSubmit.
  assert.match(html, /<span id="RequiredFieldValidatorfullname" style="display:none;" readonly="readonly">\*<\/span>/);
  assert.match(webFormsForm({ content: html }), /<form method="post" action="\/" onsubmit="javascript:return WebForm_OnSubmit\(\);" id="liquid_form">/);
  // Text boxes: the attribute only; the "readonly" class stays field-level.
  const name = element(html, /<input [^>]*id="fullname"[^>]*>/);
  assert.match(name, / class="text form-control " /);
  assert.match(name, / readonly="readonly"/);
  assert.doesNotMatch(name, /aria-required/);
  assert.match(element(html, /<textarea [^>]*id="notes"[^>]*>/), /class="textarea form-control  readonly"/);
  // Dropdowns: aspNetDisabled, disabled and readonly, every option kept, no aria-disabled.
  const picklist = element(html, /<select [^>]*id="preferred"[^>]*>.*?<\/select>/);
  assert.match(
    picklist,
    /^<select name="[^"]*" id="preferred" class="aspNetDisabled form-control picklist " onchange="setIsDirty\(this.id\);" disabled="disabled" readonly="readonly"><option value="" label="Select" aria-label="Select"><\/option><option value="1">Email<\/option><option selected="selected" value="2">Phone<\/option><\/select>$/,
  );
  assert.doesNotMatch(html, /id="preferred_Value"/);
  const bool = element(html, /<select [^>]*id="donotemail"[^>]*>/);
  assert.match(bool, /class="aspNetDisabled form-control boolean-dropdown " onchange="setIsDirty\(this.id\);" disabled="disabled" readonly="readonly">/);
  // The lookup name box is readonly="readonly"; the server leaves the containers unfocusable
  // (the app bundle adds their tabindex for read-only lookups and option sets).
  assert.match(html, /<div class="control" data-logical-name="parentcustomerid"><div><input [^>]*class="text form-control lookup form-control  readonly" readonly="readonly"/);
  assert.match(html, /<div class="control" data-logical-name="preferred"><div|<div class="control" data-logical-name="preferred"><select/);
  assert.doesNotMatch(html, /data-logical-name="[^"]*" tabindex/);
  // Read-only date pickers (crmentityformview-datetime.js): no input group, no placeholder,
  // a readonly="readonly" box and a hidden calendar button.
  assert.match(
    html,
    /<div class="datetimepicker" role="none" data-sim-date-target="birthdate" data-sim-date-only="true"><input type="text" data-date-format="[^"]+"[^>]*class="form-control input-text-box readonly" readonly="readonly"><span class="input-group-addon" tabindex="0" role="button" title="Choose a date" aria-label="Choose a date" style="display: none;">/,
  );
  // No default button: no keypress handler, and an empty actions container.
  assert.doesNotMatch(html, /WebForm_FireDefaultButton/);
  assert.match(html, /<\/div><div class="actions"><\/div><\/div>/);
});

test("field-level read-only option set in an edit form keeps every option, aria-disabled and its value field", async () => {
  const original = fields.find((field) => field.name === "preferred");
  original.readOnly = true;
  try {
    const html = await render(100000001);
    const picklist = element(html, /<select [^>]*id="preferred"[^>]*>.*?<\/select>/);
    assert.match(
      picklist,
      /class="readonly form-control picklist " onchange="setIsDirty\(this.id\);" disabled="disabled" aria-disabled="true"><option value="" label="Select" aria-label="Select"><\/option><option value="1">Email<\/option><option selected="selected" value="2">Phone<\/option>/,
    );
    assert.match(html, /<input type="hidden" name="[^"]*" id="preferred_Value" value="2">/);
    assert.doesNotMatch(html, /data-logical-name="preferred" tabindex/);
  } finally {
    delete original.readOnly;
  }
});
