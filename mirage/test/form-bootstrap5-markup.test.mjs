import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent, bootstrapMarkup } from "../lib/platform.mjs";

// Invented "gadget" table rendered by a Bootstrap 5 site (Site/BootstrapV5Enabled) and, for
// contrast, a Bootstrap 3 site. Records, schema and store are local fixtures.
const ID = "b0000000-0000-4000-8000-000000000001";
const CURRENCY = "c0000000-0000-4000-8000-000000000001";
const record = {
  gadgetid: ID,
  name: "Sprocket",
  homepage: "https://example.invalid/sprocket",
  symbol: "SPR",
  summary: "Line one",
  duration: 90,
  language: 1033,
  ratio: 1.5,
  price: 12.5,
  transactioncurrencyid: { id: CURRENCY, logical_name: "transactioncurrency", name: "Euro" },
  flag: true,
  statecode: 0,
  ownerid: null,
  vendorid: { id: "a0000000-0000-4000-8000-000000000001", logical_name: "vendor", name: "Acme" },
  frozen: "Fixed",
};
const fields = [
  { name: "name", label: "Name", dataverseType: "nvarchar", maxLength: 100, required: true },
  { name: "homepage", label: "Homepage", dataverseType: "nvarchar", format: "url", maxLength: 200 },
  { name: "symbol", label: "Symbol", dataverseType: "nvarchar", format: "tickersymbol", maxLength: 10 },
  { name: "summary", label: "Summary", dataverseType: "nvarchar", format: "textarea", maxLength: 500, rowspan: 1 },
  { name: "duration", label: "Duration", dataverseType: "int", format: "duration" },
  { name: "language", label: "Language", dataverseType: "int", format: "language" },
  { name: "ratio", label: "Ratio", dataverseType: "float", precision: 3 },
  { name: "price", label: "Price", dataverseType: "money", precision: 2 },
  { name: "huge", label: "Huge", dataverseType: "bigint" },
  { name: "flag", label: "Flag", dataverseType: "boolean", controlClassId: "{67FAC785-CD58-4F9F-ABB3-4B7DDC6ED5ED}" },
  { name: "vendorid", label: "Vendor", dataverseType: "lookup", lookupTargets: ["vendor"] },
  { name: "statecode", label: "Status", dataverseType: "state", required: true, readOnly: true, options: [{ value: 0, label: "Active" }] },
  { name: "frozen", label: "Frozen", dataverseType: "nvarchar", maxLength: 50, validForUpdate: false },
  { name: "secret", label: "Secret", dataverseType: "nvarchar", maxLength: 50 },
  { name: "attachment", label: "Attachment", dataverseType: "file" },
  { name: "photo", label: "Photo", dataverseType: "image" },
];
const cell = (field, extra = {}) => ({ name: field, label: fields.find((candidate) => candidate.name === field)?.label, ...extra });
const layout = [
  {
    name: "main",
    showLabel: true,
    label: "Main",
    columns: [
      {
        width: "100%",
        sections: [
          {
            name: "details",
            label: "Details",
            showLabel: true,
            rows: [
              ["name", "homepage"].map((name) => cell(name)),
              ["symbol", "summary"].map((name) => cell(name)),
              ["duration", "language"].map((name) => cell(name)),
              ["ratio", "price"].map((name) => cell(name)),
              [cell("huge"), cell("flag")],
              [cell("vendorid"), cell("statecode")],
              [cell("frozen"), cell("secret", { hidden: true })],
              [cell("attachment"), cell("photo")],
              [{ type: "webresource", id: "WebResource_logo", url: "acme_logo.svg", label: "Logo", showLabel: true }],
            ],
          },
          { name: "hidden", hidden: true, rows: [] },
          { name: "again", label: "Again", showLabel: true, rows: [[cell("summary", { label: "Summary again" })], [cell("name", { label: "Name again" })]] },
        ],
      },
    ],
  },
];
const vendorRows = [{ vendorid: "a0000000-0000-4000-8000-000000000001", name: "Acme" }];
function store() {
  return {
    resolveMapping: (entity) =>
      ({
        vendor: { entitySet: "vendors", idColumn: "vendorid", nameColumn: "name" },
        transactioncurrency: { entitySet: "transactioncurrencies", idColumn: "transactioncurrencyid" },
      })[entity] ?? { entitySet: "gadgets", idColumn: "gadgetid", relationships: { gadget_vendor: { from: "vendorid", entity: "vendor", many: false } } },
    get: async (entity) => (entity === "transactioncurrency" ? { transactioncurrencyid: CURRENCY, currencysymbol: "€" } : record),
    query: async () => ({ value: vendorRows }),
  };
}
async function render({ mode = 100000001, v5 = true, params = { id: ID }, nativePostbackState, storeOverride, schema } = {}) {
  const portal = {
    forms: [{ id: "f0000000-0000-4000-8000-000000000001", name: "Gadget", mode }],
    records: [],
    website: { id: "site" },
    websiteLanguages: [{ lcid: 1033, isDefault: true }],
    pages: [],
    settings: { "Site/BootstrapV5Enabled": v5 ? "true" : "false" },
  };
  const schemas = { "f0000000-0000-4000-8000-000000000001": { entity: "gadget", title: "Gadget", fields, layout, ...schema } };
  return renderComponent("entityform", "Gadget", { user: { id: "current" }, request: { params } }, { portal, store: storeOverride ?? store(), schemas, nativePostbackState });
}
const element = (html, pattern) => {
  const match = html.match(pattern);
  assert.ok(match, `missing ${pattern}`);
  return match[0];
};

test("bootstrapMarkup follows Site/BootstrapV5Enabled", () => {
  assert.equal(bootstrapMarkup({ "Site/BootstrapV5Enabled": "True" }).srOnly, "visually-hidden");
  assert.equal(bootstrapMarkup({}).srOnly, "sr-only");
});

test("Bootstrap 5 lookup: buttons without input-group-btn, Bootstrap 5 dialog attributes and the nested error dialog", async () => {
  const html = await render();
  const group = element(html, /<div class="input-group"><input name="[^"]*\$vendorid_name"[\s\S]*?<\/button><\/div>/);
  assert.doesNotMatch(group, /input-group-btn|sr-only|data-toggle=/);
  assert.match(group, /data-bs-toggle="tooltip"/);
  assert.match(group, /<span class="visually-hidden">Launch lookup modal<\/span>/);
  const modal = element(html, /<div id="vendorid_lookupmodal"[\s\S]*?Remove value<\/button>/);
  assert.match(modal, /<section aria-hidden="true" class="modal fade modal-lookup" data-bs-backdrop="static"/);
  assert.match(modal, /<h1 aria-label="Lookup records Dialog" class="modal-title" title="Lookup records">/);
  assert.match(modal, /data-mobile-view-enabled="false" data-select-mode="Single"/);
  assert.match(modal, /data-user-parent-account-name=""/);
  assert.doesNotMatch(modal, /SearchCountText|style="display:none"/);
  assert.match(modal, /Error completing request\.<span class="details"><\/span><span class="details"><\/span>/);
  assert.match(modal, /<section aria-hidden="true" aria-label="&lt;span class=&#39;fa fa-exclamation-triangle&#39; aria-hidden=&#39;true&#39;&gt;&lt;\/span&gt; Error" class="modal fade modal-error" data-bs-backdrop="static"/);
  assert.match(modal, /<button class="btn btn-default float-end remove-value"/);
  assert.match(modal, /data-bs-dismiss="modal"/);
});

test("Bootstrap 3 keeps the input-group-btn lookup and Bootstrap 3 dialog", async () => {
  const html = await render({ v5: false });
  assert.match(html, /<div class="input-group" role="none">[\s\S]*?<div class="input-group-btn"><button/);
  assert.match(html, /<section aria-hidden="true" aria-label="Lookup records Dialog" class="modal fade modal-lookup" data-backdrop="static"/);
  assert.match(html, /<div class="info required"><label for="name"/);
  assert.doesNotMatch(html, /data-bs-|visually-hidden|table-info/);
});

test("Bootstrap 5 form cells: table-info, repeated and hidden cells, hidden sections and Int64 columns", async () => {
  const html = await render();
  assert.match(html, /<div class="table-info required"><label for="name" id="name_label"/);
  // Columns placed twice render once, listed in the order they first appear.
  assert.match(html, /<div class="alert alert-danger alert-block">name, summary field is present multiple times on this form\. Only first field will be rendered in the UI<\/div>/);
  assert.equal(html.match(/id="summary_label"/g).length, 1);
  assert.doesNotMatch(html, /Summary again|Name again/);
  // A cell hidden in the form XML renders nothing; a hidden section an empty fieldset.
  assert.doesNotMatch(html, /id="secret"/);
  assert.match(html, /<\/fieldset><fieldset><\/fieldset><fieldset aria-label="Again">/);
  // Int64 columns render as empty cells.
  assert.match(html, /<td colspan="1" rowspan="1" class="clearfix cell"><\/td><td colspan="1" rowspan="1" class="clearfix cell boolean-radio-cell">/);
  // Web resource cells frame /_webresource/{name}.
  assert.match(html, /<td colspan="1" rowspan="1" class="clearfix cell web-resource-cell"><div class="table-info"><label for="WebResource_logo" class="field-label">Logo<\/label><\/div><div class="control"><iframe id="WebResource_logo" src="\/_webresource\/acme_logo.svg" width="100%" height="100%" frameborder="0" scrolling="auto"><\/iframe>/);
});

test("Bootstrap 5 string formats, option lists and numbers follow the platform markup", async () => {
  const html = await render();
  const url = element(html, /<input [^>]*id="homepage"[^>]*>/);
  assert.match(url, / type="url"/);
  assert.match(url, / ondblclick="launchUrl\(this.value\);" onchange="setIsDirty\(this.id\);validateUrlInput\(this,200\);"/);
  assert.match(url, / style="text-decoration:underline;"/);
  const symbol = element(html, /<input [^>]*id="symbol"[^>]*>/);
  assert.match(symbol, / type="url"[^>]* class="tickersymbol text form-control "[^>]* ondblclick="launchTickerSymbolUrl\(this.value\);" onchange="setIsDirty\(this.id\);uppercaseTickerSymbol\(this\);"/);
  // Text area format: a four-line memo box for a one-row cell.
  assert.match(element(html, /<textarea [^>]*id="summary"[^>]*>/), / rows="4" cols="20" maxlength="500"/);
  const duration = element(html, /<select [^>]*id="duration"[\s\S]*?<\/select>/);
  assert.match(duration, /^<select name="[^"]*\$duration" id="duration" class="integer form-control "/);
  assert.match(duration, /<option value="" label=" "><\/option><option value="1">1 minute<\/option>/);
  assert.match(duration, /<option selected="selected" value="90">1.5 hours<\/option>/);
  assert.match(duration, /<option value="4320">3 days<\/option><\/select>$/);
  assert.match(element(html, /<select [^>]*id="language"[\s\S]*?<\/select>/), /<option selected="selected" value="1033">English \(United States\)<\/option>/);
  assert.match(element(html, /<input [^>]*id="ratio"[^>]*>/), / value="1.500"[^>]* data-numberdecimalseparator="\."/);
  assert.match(html, /<div class="input-group"><span class="input-group-text">€<\/span><input name="[^"]*\$price" type="text" value="12.50"/);
});

test("empty values omit the value attribute; Bootstrap 5 dropdown lookups and option sets", async () => {
  const html = await render({ mode: 100000000, params: {} });
  assert.match(html, /<input name="[^"]*\$name" type="text" maxlength="100" id="name"/);
  assert.match(html, /<input name="[^"]*\$vendorid" type="hidden" id="vendorid">/);
  // Without a currency the money box has a plain wrapper.
  assert.match(html, /<div><input name="[^"]*\$price" type="text" id="price"/);
  // Insert forms show the file and image notices and the hidden state inputs.
  assert.match(html, /<div><div>This record hasn&#39;t been created yet\. To enable file upload, create this record\.<\/div><\/div><input type="hidden" name="[^"]*\$attachmenthidden_filename" id="attachmenthidden_filename">/);
  assert.match(html, /<div><div>This record hasn&#39;t been created yet\. To enable image upload, create this record<\/div><\/div><input type="hidden" name="[^"]*\$photohidden" id="photohidden">/);
  assert.match(html, /<span id="statecode" class="state "><\/span><input name="[^"]*\$statecode_EntityState" type="hidden" id="statecode_EntityState">/);
  // An editable form carries the off-screen honeypot box.
  assert.match(html, /<div class="frm-g-[0-9a-f]{8}" style="position:absolute;left:-9999px;top:-9999px;opacity:0;height:0;overflow:hidden;" aria-hidden="true"><label for="frm_pref_[0-9a-f]{8}">Leave this field blank<\/label><input name="[^"]*\$frm_pref_[0-9a-f]{8}" type="text" id="frm_pref_[0-9a-f]{8}" tabindex="-1" autocomplete="off"><\/div><\/div><div class="actions">/);
});

test("Bootstrap 5 read-only rendering: no column validity read-only, kept required attributes and ASP.NET disabled wrappers", async () => {
  const html = await render({ mode: 100000002 });
  assert.doesNotMatch(html, /frm-g-/);
  // validForUpdate applies to edit mode only.
  assert.match(element(html, /<input [^>]*id="frozen"[^>]*>/), / class="text form-control "[^>]* readonly="readonly"/);
  assert.match(element(html, /<input [^>]*id="name"[^>]*>/), / aria-required="true" title="Name is a required field\." aria-label="Name"/);
  assert.match(html, /<div class="table-info required"><label id="statecode_label"/);
  assert.match(html, /<span id="flag" class="aspNetDisabled boolean-radio " onchange="setIsDirty\(this.id\);" disabled="disabled" readonly="readonly"><span class="aspNetDisabled"><input id="flag_0"/);
  assert.match(html, /<span class='visually-hidden'>Flag <\/span>/);
});

test("edit mode keeps column validity read-only and the edit file control", async () => {
  const html = await render();
  assert.match(element(html, /<input [^>]*id="frozen"[^>]*>/), / class="text form-control  readonly"/);
  assert.match(html, /<button id="photo_input_image" type="button" class="btn btn-default btn-for-image-input btn-for-inputofimage" onclick="chooseImage\(this, 'photo'\);">Choose File<\/button>/);
  assert.match(html, /<input type="hidden" name="[^"]*\$photohidden_record_id" id="photohidden_record_id" value="b0000000-0000-4000-8000-000000000001">/);
});

test("Bootstrap 5 success panel carries the platform close button", async () => {
  const html = await render({ nativePostbackState: { kind: "entityform", formId: "f0000000-0000-4000-8000-000000000001", outcome: { type: "message", message: "Saved.", hideForm: false } } });
  assert.match(html, /<div id="MessagePanel" class="message alert success alert alert-success" role="alert"><input type="submit" name="ctl00\$ContentContainer\$EntityFormControl_f0000000000040008000000000000001\$btnCloseMessage" value="x" onclick="javascript:WebForm_DoPostBackWithOptions\(new WebForm_PostBackOptions\(&quot;ctl00\$ContentContainer\$EntityFormControl_f0000000000040008000000000000001\$btnCloseMessage&quot;, &quot;&quot;, true, &quot;&quot;, &quot;&quot;, false, false\)\)" id="btnCloseMessage" class="btn-close" data-bs-dismiss="alert" aria-label="close" style="border-style: none"><span id="MessageLabel">Saved\.<\/span><\/div>/);
});

test("a lookup without a form-selected view uses the target's exported default lookup view", async () => {
  const { lookupModel } = await import("../lib/native-services.mjs");
  const portal = { forms: [{ id: "form", name: "Gadget" }] };
  const schemas = { form: { entity: "gadget", fields: [{ name: "vendorid", type: "lookup", lookupTargets: ["vendor", "maker"] }] } };
  const metadata = {
    views: [
      { id: "vendor-public", entity: "vendor", name: "Active vendors", queryType: 0, isDefault: true, fetchXml: "<fetch/>", fields: [] },
      { id: "vendor-lookup", entity: "vendor", name: "Vendor Lookup View", queryType: 64, isDefault: true, fetchXml: '<fetch><entity name="vendor"/></fetch>', fields: [{ name: "name", width: 200 }] },
    ],
  };
  const model = lookupModel({ portal, schemas, metadata, store: store(), kind: "entityform", formId: "form", field: "vendorid" });
  assert.deepEqual(model.views.map((view) => [view.id, view.name, Boolean(view.synthesized)]), [
    ["vendor-lookup", "Vendor Lookup View", false],
    ["lookup-maker", "maker lookup", true],
  ]);
});

const FORM = "f0000000-0000-4000-8000-000000000001";
const INSERT = 100000000;

test("an insert form without a Create permission renders the denial inside the native form control", async () => {
  const html = await render({ mode: INSERT, params: {}, storeOverride: { ...store(), rules: () => [] } });
  assert.match(html, /^<script type="text\/javascript">function entityFormClientValidate\(\)/);
  assert.match(html, /<!--pp-native-form--><div id="EntityFormControl_f0000000000040008000000000000001"><div id="EntityFormPanel" class="crmEntityFormView" data-form-name="Gadget"/);
  assert.match(html, /<span class='fa fa-lock' aria-hidden='true'><\/span>You don't have the appropriate permissions\.<\/div><\/div><\/div><\/div><\/div><div class="actions"><\/div>/);
  assert.doesNotMatch(html, /id="name"/);
  const allowed = await render({ mode: INSERT, params: {}, storeOverride: { ...store(), rules: () => [{ scope: "global" }] } });
  assert.match(allowed, /id="name"/);
});

test("a failed save re-renders posted values in the Bootstrap 5 error panel; an unchanged lookup keeps its name", async () => {
  const html = await render({ nativePostbackState: { kind: "entityform", formId: FORM, values: { name: "Posted", vendorid: "A0000000-0000-4000-8000-000000000001" }, outcome: { type: "error", message: "Rejected <now>" } } });
  assert.match(html, /<div id="MessagePanel" class="message alert alert-danger" role="alert"><input type="submit" [^>]*id="btnCloseMessage"[^>]*><span id="MessageLabel" aria-live="polite" aria-atomic="true"><p class="text-danger"><span class="fa fa-exclamation-triangle" aria-hidden="true"><\/span> Rejected &lt;now&gt;<\/p><\/span><\/div><div id="EntityFormPanel"/);
  assert.match(element(html, /<input [^>]*id="name"[^>]*>/), / value="Posted"/);
  assert.match(html, /Acme/);
});

test("a re-rendered insert form doubles its entity-form class and drops the blank option's Select label", async () => {
  const postback = { kind: "entityform", formId: FORM, values: { name: "Posted" }, validationErrors: [{ field: "name", message: "Name is required." }] };
  const tier = { fields: [{ name: "tier", label: "Tier", dataverseType: "picklist", options: [{ value: 1, label: "Gold" }] }], layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: [[cell("tier", { label: "Tier" })]] }] }] }] };
  const html = await render({ mode: INSERT, params: {}, nativePostbackState: postback, schema: tier });
  assert.match(html, /_EntityFormView" class="entity-form entity-form">/);
  assert.match(html, /<option selected="selected" value=""><\/option><option value="1">Gold/);
  const fresh = await render({ mode: INSERT, params: {}, schema: tier });
  assert.match(fresh, /_EntityFormView" class="entity-form">/);
  assert.match(fresh, /value="" label="Select" aria-label="Select"/);
});

test("a success message that hides the form renders the message only", async () => {
  const html = await render({ mode: INSERT, params: {}, nativePostbackState: { kind: "entityform", formId: FORM, outcome: { type: "message", message: "Thanks." } } });
  assert.match(html, /<span id="MessageLabel">Thanks\.<\/span><\/div>/);
  assert.doesNotMatch(html, /id="EntityFormPanel"/);
});

test("Bootstrap 5 basic form without its record keeps the WebForms marker and the closable danger panel", async () => {
  const html = await render({ params: {} });
  assert.match(html, /<!--pp-native-form--><div id="EntityFormControl_[0-9a-f]+"><div id="MessagePanel" class="message alert error alert alert-danger"><input type="submit" name="[^"]*btnCloseMessage" value="x" id="btnCloseMessage" class="btn-close" data-bs-dismiss="alert" aria-label="close" type="button" style="border-style: none"><span id="MessageLabel">/);
});
