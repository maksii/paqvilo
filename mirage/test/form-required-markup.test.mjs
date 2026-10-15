import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";

// Invented "ticket" insert form on a Bootstrap 5 site where every column is required.
test("required boxes: validator order and the required markers per box type", async () => {
  const fields = [
    { name: "title", label: "Title", dataverseType: "nvarchar", maxLength: 50, required: true },
    { name: "mail", label: "Mail", dataverseType: "nvarchar", format: "email", maxLength: 100, required: true },
    { name: "site", label: "Site", dataverseType: "nvarchar", format: "url", maxLength: 200, required: true },
    { name: "count", label: "Count", dataverseType: "int", minValue: 0, maxValue: 10, required: true },
    { name: "code", label: "Code", dataverseType: "nvarchar", maxLength: 20, required: true, readOnly: true },
  ];
  const store = { resolveMapping: () => ({ entitySet: "tickets", idColumn: "ticketid" }), get: async () => null, query: async () => ({ value: [] }) };
  const portal = { forms: [{ id: "form", name: "Ticket", mode: 100000000 }], records: [], website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
  const schemas = { form: { entity: "ticket", title: "Ticket", fields, layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: fields.map((field) => [{ name: field.name }]) }] }] }] } };
  const html = await renderComponent("entityform", "form", { user: { id: "current" }, request: { params: {} } }, { portal, store, schemas });
  const ids = (name) => { const start = html.indexOf(`id="${name}_label"`); const cell = html.slice(start, html.indexOf('<div class="control"', start)); return [...cell.matchAll(/<span id="([A-Za-z]+?)Validator/g)].map((match) => match[1]); };
  assert.deepEqual(ids("title"), ["RequiredField", "MaximumLength"]);
  assert.deepEqual(ids("mail"), ["EmailFormat", "RequiredField", "MaximumLength"]);
  assert.deepEqual(ids("count"), ["Integer", "Range", "RequiredField"]);
  assert.match(html, /id="title" class="text form-control " onchange="setIsDirty\(this\.id\);" aria-required="true" title="Title is a required field\." aria-label="Title"/);
  assert.match(html, /id="mail" class="text form-control " [^>]*onchange="setIsDirty\(this\.id\);" required="" title="Mail is a required field\." aria-label="Mail"/);
  assert.match(html, /id="site" class="text form-control " [^>]*onchange="setIsDirty\(this\.id\);validateUrlInput\(this,200\);" required="" onkeypress/);
  assert.match(html, /id="count" class="text integer form-control " onchange="setIsDirty\(this\.id\);" required="" aria-invalid="false">/);
  // A read-only required box keeps its required markers on Bootstrap 5.
  assert.match(html, /id="code" class="text form-control  readonly" onchange="setIsDirty\(this\.id\);" readonly="readonly" aria-required="true" title="Code is a required field\."/);
});

test("a money box shows the record currency's symbol only when it holds a value", async () => {
  const render = async (amount) => {
    const record = { ticketid: "t1", amount, transactioncurrencyid: { id: "c1", logical_name: "transactioncurrency" } };
    const store = { resolveMapping: () => ({ entitySet: "tickets", idColumn: "ticketid" }), get: async (entity) => (entity === "transactioncurrency" ? { currencysymbol: "€" } : record), query: async () => ({ value: [] }) };
    const portal = { forms: [{ id: "form", name: "Ticket", mode: 100000001 }], records: [], website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
    const schemas = { form: { entity: "ticket", title: "Ticket", fields: [{ name: "amount", label: "Amount", dataverseType: "money", precision: 2 }], layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: [[{ name: "amount" }]] }] }] }] } };
    return renderComponent("entityform", "form", { user: { id: "current" }, request: { params: { id: "t1" } } }, { portal, store, schemas });
  };
  assert.match(await render(199.99), /<div class="input-group"><span class="input-group-text">€<\/span><input [^>]*id="amount"/);
  assert.match(await render(null), /<div><input [^>]*id="amount"/);
});

test("ActionButtonPlacement 0 renders the action row above the form view", async () => {
  const settings = (placement) => JSON.stringify({ Type: "FormActionMetadata", ActionButtonPlacement: placement, ActionButtonAlignment: 0, Actions: [{ Type: "SubmitAction", ButtonLabel: [{ LCID: 1033, Value: "Save" }] }] });
  const render = async (placement) => {
    const store = { resolveMapping: () => ({ entitySet: "tickets", idColumn: "ticketid" }), get: async () => ({ ticketid: "t1", title: "A" }), query: async () => ({ value: [] }) };
    const portal = { forms: [{ id: "form", name: "Ticket", mode: 100000001, metadata: { adx_settings: settings(placement) } }], records: [], website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
    const schemas = { form: { entity: "ticket", title: "Ticket", fields: [{ name: "title", label: "Title", dataverseType: "nvarchar", maxLength: 50 }], layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: [[{ name: "title" }]] }] }] }] } };
    return renderComponent("entityform", "form", { user: { id: "current" }, request: { params: { id: "t1" } } }, { portal, store, schemas });
  };
  assert.match(await render(0), /<div id="EntityFormPanel"[^>]*><div class="row form-custom-actions">/);
  assert.match(await render(1), /<div id="EntityFormPanel"[^>]*><div id="EntityFormControl_form_EntityFormView"[^]*<div class="row form-custom-actions">/);
});

test("form options: tooltips from column descriptions, the platform-locked owner, unsupported cells and the submit class", async () => {
  const fields = [
    { name: "ownerid", label: "Owner", dataverseType: "owner", required: true, columnMetadata: { descriptionLabels: { 1033: "Owner Id" } }, targets: ["systemuser"] },
    { name: "big", label: "Big", dataverseType: "bigint" },
  ];
  const render = async (metadata) => {
    const store = { resolveMapping: () => ({ entitySet: "tickets", idColumn: "ticketid" }), get: async () => ({ ticketid: "t1", ownerid: { id: "u1", logical_name: "systemuser", name: "Someone" } }), query: async () => ({ value: [] }) };
    const portal = { forms: [{ id: "form", name: "Ticket", mode: 100000001, metadata: { adx_showownerfields: true, ...metadata } }], records: [], website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
    const schemas = { form: { entity: "ticket", title: "Ticket", fields, layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: fields.map((field) => [{ name: field.name }]) }] }] }] } };
    return renderComponent("entityform", "form", { user: { id: "current" }, request: { params: { id: "t1" } } }, { portal, store, schemas });
  };
  const on = await render({ adx_tooltipenabled: true, adx_showunsupportedfields: true, adx_submitbuttoncssclass: "btn btn-success custom" });
  assert.match(on, /<label id="ownerid_label" title="Owner Id" class="field-label">/);
  assert.match(on, /id="ownerid_name" title="Owner Id" class="text form-control lookup form-control " readonly="" aria-readonly="true" aria-labelledby="" aria-label="Owner is a required field\."/);
  assert.match(on, /type="hidden" id="ownerid" aria-required="true" aria-invalid="true" value="u1"/);
  assert.match(on, /class="clearfix cell unsupported-cell"><div class="info"><label for="big" class="field-label">Big<\/label><div class="validators"><\/div><\/div><div class="control" data-logical-name="big"><span id="big">Unsupported: DataFieldName=&quot;big&quot; Label=&quot;Big&quot;, AttributeType=&quot;BigInt&quot;, Format=&quot;&quot;<\/span>/);
  assert.match(on, /id="UpdateButton" class="submit-btn btn btn-success custom form-action-container-left"/);
  const off = await render({});
  assert.doesNotMatch(off, /title="Owner Id"|unsupported-cell/);
  assert.match(off, /<td colspan="1" rowspan="1" class="clearfix cell"><\/td>/);
  assert.match(off, /id="UpdateButton" class="submit-btn btn btn-primary form-action-container-left"/);
});

test("a form validation group scopes its validators and summary to its buttons; the summary header follows the form", async () => {
  const fields = [{ name: "title", label: "Title", dataverseType: "nvarchar", maxLength: 50, required: true }];
  const store = { resolveMapping: () => ({ entitySet: "tickets", idColumn: "ticketid" }), get: async () => null, query: async () => ({ value: [] }) };
  const portal = { forms: [{ id: "form", name: "Ticket", mode: 100000000, metadata: { adx_validationgroup: "tickets", adx_validationsummaryheadertext: JSON.stringify([{ LCID: 1033, Value: "Tickets have errors:" }]) } }], records: [], website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
  const schemas = { form: { entity: "ticket", title: "Ticket", fields, layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: [[{ name: "title" }]] }] }] }] } };
  const html = await renderComponent("entityform", "form", { user: { id: "current" }, request: { params: {} } }, { portal, store, schemas });
  assert.match(html, /Page_ClientValidate\(&#39;tickets&#39;\)/);
  assert.match(html, /getElementById\("RequiredFieldValidatortitle"\);if\(!v\)return;[^]*?v\.validationGroup="tickets";\n\}\)\(\);/);
  assert.match(html, /s\.displaymode="BulletList";s\.validationGroup="tickets";/);
  assert.match(html, /\\u003c\/span> Tickets have errors:\\u003c\/h2>";s\.displaymode/);
});
