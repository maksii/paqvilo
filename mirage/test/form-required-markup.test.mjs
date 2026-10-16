import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent, captchaRefreshDelta } from "../lib/platform.mjs";

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
  const above = await render(0);
  assert.match(above, /<div id="EntityFormPanel"[^>]*><div class="row form-custom-actions">/);
  assert.match(above, /<\/div><div class="actions"><\/div><\/div>/);
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

test("a captcha shown to the visitor marks the form; signed-in visitors see it only when the form says so", async () => {
  const fields = [{ name: "title", label: "Title", dataverseType: "nvarchar", maxLength: 50 }];
  const render = async (metadata, user) => {
    const store = { resolveMapping: () => ({ entitySet: "tickets", idColumn: "ticketid" }), get: async () => null, query: async () => ({ value: [] }) };
    const portal = { forms: [{ id: "form", name: "Ticket", mode: 100000000, metadata }], records: [], website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
    const schemas = { form: { entity: "ticket", title: "Ticket", fields, layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: [[{ name: "title" }]] }] }] }] } };
    return renderComponent("entityform", "form", { user, request: { params: {}, url: "http://localhost/support/tickets/" } }, { portal, store, schemas });
  };
  const shown = await render({ adx_captcharequired: true }, null);
  assert.match(shown, /<!--pp-native-form--><!--pp-captcha-->/);
  // The RadCaptcha control follows the honeypot box; its resources are relative to the application root.
  const unique = "ctl00$ContentContainer$EntityFormControl_form$EntityFormControl_form_EntityFormView$captcha";
  const client = unique.replace(/\$/g, "_");
  assert.ok(shown.includes(`autocomplete="off"></div><div class="tr"><div class="captcha-cell"><div id="${client}" class="RadCaptcha&#32;RadCaptcha_Default">`));
  assert.match(shown, /<img id="[^"]+_captcha_CaptchaImageUP" alt="This&#32;is&#32;a&#32;CAPTCHA&#32;image,[^"]+" src="\.\.\/\.\.\/Telerik\.Web\.UI\.WebResource\.axd\?type=rca&amp;isc=cust&amp;guid=[0-9a-f-]{36}"/);
  assert.ok(shown.includes(`href="javascript:__doPostBack(&#39;${unique}$CaptchaLinkButton&#39;,&#39;&#39;)"`));
  assert.ok(shown.includes(`<input name="${unique}$CaptchaTextBox" type="text" maxlength="7" id="${client}_CaptchaTextBox">`));
  // Its validator joins the page validators and names the captcha in the summary.
  assert.ok(shown.includes(`document.getElementById("${client}_ctl00")]`));
  assert.match(shown, /v\.errormessage="\\u003ca href='#captcha'[^"]*Captcha is incorrect, please re-enter captcha\.\\u003c\/a>";\nv\.display="None";/);
  // The refresh postback answers the update panel delta with a new challenge and the announcement.
  const delta = captchaRefreshDelta(unique, "/support/tickets/");
  const segments = [];
  for (let at = 0; at < delta.length;) {
    const [length, type, id] = delta.slice(at).split("|", 3);
    const contentAt = at + length.length + type.length + id.length + 3;
    segments.push([type, id, delta.substr(contentAt, Number(length))]);
    at = contentAt + Number(length) + 1;
  }
  assert.deepEqual(segments.map(([type]) => type), ["#", "updatePanel", "hiddenField", "hiddenField", "asyncPostBackControlIDs", "postBackControlIDs", "updatePanelIDs", "childUpdatePanelIDs", "panelsToRefreshIDs", "asyncPostBackTimeout", "formAction", "scriptStartupBlock"]);
  assert.equal(segments[1][1], `${client}_ctl01`);
  assert.match(segments[1][2], /src="\.\.\/\.\.\/Telerik\.Web\.UI\.WebResource\.axd\?type=rca&amp;isc=cust&amp;guid=[0-9a-f-]{36}" style="height:50px;width:180px;display:block;" \/>/);
  assert.equal(segments[8][2], `${unique}$ctl01,`);
  assert.match(segments[11][2], /The new image is ready/);
  assert.doesNotMatch(await render({ adx_captcharequired: true }, { id: "current" }), /pp-captcha/);
  assert.match(await render({ adx_captcharequired: true, adx_showcaptchaforauthenticatedusers: true }, { id: "current" }), /<!--pp-captcha-->/);
  assert.doesNotMatch(await render({}, null), /pp-captcha/);
});

// Invented read-only and postback renders of a ticket form (live reader, save and error pages).
const ticketForm = async ({ mode = 100000001, metadata = {}, rows = [], fields, record, nativePostbackState, user = { id: "current" }, solution } ) => {
  const store = {
    resolveMapping: (entity) => (entity === "team" ? { entitySet: "teams", idColumn: "teamid", nameColumn: "name" } : { entitySet: "tickets", idColumn: "ticketid" }),
    get: async (entity) => (entity === "team" ? { teamid: "t1", name: "Team One" } : record),
    query: async () => ({ value: [{ teamid: "t1", name: "Team One" }, { teamid: "t2", name: "Team Two" }] }),
  };
  const portal = { forms: [{ id: "form", name: "Ticket", mode, metadata }], records: rows.map((row) => ({ kind: "basicformmetadata", adx_entityform: "form", adx_type: 100000000, ...row })), website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
  const schemas = { form: { entity: "ticket", title: "Ticket", fields, layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: fields.map((field) => [{ name: field.name }]) }] }] }] } };
  return renderComponent("entityform", "form", { user, request: { params: { id: "r1" } } }, { portal, store, schemas, nativePostbackState, ...(solution ? { metadata: solution } : {}) });
};

test("a read-only form disables its radio lists, keeps required markers on memo boxes and lists only the current dropdown record", async () => {
  const fields = [
    { name: "colour", label: "Colour", dataverseType: "picklist", options: [{ value: 1, label: "Red" }, { value: 2, label: "Blue" }] },
    { name: "notes", label: "Notes", dataverseType: "memo", maxLength: 100, required: true },
    { name: "teamid", label: "Team", dataverseType: "lookup", type: "lookup", targets: ["team"] },
  ];
  const html = await ticketForm({ mode: 100000002, fields, record: { ticketid: "r1", colour: 2, notes: "x", teamid: { id: "t1", logical_name: "team", name: "Team One" } }, rows: [{ adx_attributelogicalname: "colour", adx_controlstyle: 100000000 }, { adx_attributelogicalname: "teamid", adx_controlstyle: 756150000 }] });
  assert.match(html, /<span id="colour" disabled="disabled" class="aspNetDisabled picklist vertical " role="presentation" onchange="setIsDirty\(this\.id\);" readonly="readonly"><span class="aspNetDisabled"><input id="colour_0" type="radio" name="[^"]*" value="1" disabled="disabled"><label for="colour_0">/);
  assert.match(html, /<\/label><\/span><br><span class="aspNetDisabled"><input id="colour_1" type="radio" name="[^"]*" value="2" checked="checked" disabled="disabled">/);
  assert.match(html, /id="notes" class="textarea form-control " onchange="setIsDirty\(this\.id\);" aria-required="true" title="Notes is a required field\." aria-label="Notes" readonly="readonly"/);
  assert.match(html, /<select name="[^"]*" id="teamid" disabled="disabled" class="aspNetDisabled lookup form-control readonly" onchange="setIsDirty\(this\.id\);" aria-disabled="true" readonly="readonly"><option selected="selected" value="t1" class="dropdown-item">Team One<\/option><\/select>/);
  assert.match(html, /id="teamid_Value" value="t1"><input type="hidden" name="[^"]*" id="teamid_SelectedIndex" value="0">/);
});

test("postback renders: posted check boxes, blank option labels, failed validators, the server summary and the doubled view class", async () => {
  const fields = [
    { name: "flag", label: "Flag", dataverseType: "bit" },
    { name: "duration", label: "Duration", dataverseType: "int", format: "duration" },
    { name: "count", label: "Count", dataverseType: "int", minValue: 0, maxValue: 10 },
  ];
  const state = (extra) => ({ kind: "entityform", formId: "form", outcome: { type: "none" }, ...extra });
  const saved = await ticketForm({ fields, record: { ticketid: "r1", duration: 5, count: 1 }, nativePostbackState: state({ values: { flag: "on" } }) });
  assert.match(saved, /id="flag" type="checkbox"[^>]*checked="checked"/);
  assert.match(saved, /id="duration"[^>]*><option value="" label=" "><\/option>/);
  assert.match(saved, /class="entity-form entity-form"/);
  const blank = await ticketForm({ fields, record: { ticketid: "r1", count: 1 }, nativePostbackState: state({}) });
  assert.match(blank, /id="duration"[^>]*><option selected="selected" value="" label=" "><\/option>/);
  const invalid = await ticketForm({ fields, record: { ticketid: "r1", count: 99 }, metadata: { adx_validationsummarylinksenabled: true }, nativePostbackState: state({ validationErrors: [{ field: "count", code: "FormFieldOutOfRange", message: "Count is out of range." }, { field: "captcha", code: "CaptchaInvalid", message: "Captcha is incorrect." }] }) });
  assert.match(invalid, /<span id="RangeValidatorcount">\*<\/span>/);
  assert.match(invalid, /v\.isvalid="False";/);
  assert.match(invalid, /role="alert"><h2 class='validation-header'>/);
  assert.match(invalid, /<li><a href='#count_label' onclick='javascript:scrollToAndFocus\("count_label","count"\);return false;' referenceControlId=count>Count is out of range\. <\/a><\/li>/);
  assert.match(invalid, /<li><a href='#captcha' onclick='javascript:scrollToAndFocusCapatch\(\);return false;'>Captcha is incorrect\.<\/a><\/li>/);
  // A form that sets an entity reference rebuilds its controls: single class, blank choice unlabelled beside a value.
  const reference = await ticketForm({ fields, record: { ticketid: "r1", duration: 5 }, metadata: { adx_setentityreference: true }, nativePostbackState: state({}) });
  assert.doesNotMatch(reference, /entity-form entity-form/);
  assert.match(reference, /id="duration"[^>]*><option value=""><\/option>/);
});

test("the success panel's close button validates only without a form validation group", async () => {
  const fields = [{ name: "title", label: "Title", dataverseType: "nvarchar", maxLength: 50 }];
  const outcome = { type: "message", message: "Saved.", hideForm: false };
  const plain = await ticketForm({ fields, record: { ticketid: "r1" }, nativePostbackState: { kind: "entityform", formId: "form", outcome } });
  assert.match(plain, /value="x" onclick="javascript:WebForm_DoPostBackWithOptions/);
  const grouped = await ticketForm({ fields, record: { ticketid: "r1" }, metadata: { adx_validationgroup: "tickets" }, nativePostbackState: { kind: "entityform", formId: "form", outcome } });
  assert.match(grouped, /value="x" id="btnCloseMessage"/);
});

test("the server form's __VIEWSTATE carries the visitor's anti-forgery key", async () => {
  const { injectRuntime, viewStateWithKey } = await import("../lib/platform.mjs");
  const { nativeViewStateKey, decodeNativeViewState, encodeNativeViewState } = await import("../lib/native-postback.mjs");
  const html = injectRuntime('<html><body><form id="liquid_form"><input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEopaque" /></form></body></html>', "token-1", "r1");
  const value = /id="__VIEWSTATE" value="([^"]*)"/.exec(html)[1];
  assert.equal(nativeViewStateKey(value), "token-1");
  const carried = viewStateWithKey(encodeNativeViewState({ form: "f", autoStep: 1, values: { name: "x" } }), "token-1");
  assert.equal(nativeViewStateKey(carried), "token-1");
  assert.deepEqual(decodeNativeViewState(carried), { form: "f", autoStep: 1, values: { name: "x" } });
});

test("required number, date, choice and yes/no controls carry the platform's markers; lookups focus their name box", async () => {
  const fields = [
    { name: "amount", label: "Amount", dataverseType: "decimal", required: true },
    { name: "due", label: "Due", dataverseType: "datetime", format: "dateandtime", required: true },
    { name: "minutes", label: "Minutes", dataverseType: "int", format: "duration", required: true },
    { name: "colour", label: "Colour", dataverseType: "picklist", options: [{ value: 1, label: "Red" }], required: true },
    { name: "agree", label: "Agree", dataverseType: "bit", required: true },
    { name: "teamid", label: "Team", dataverseType: "lookup", type: "lookup", targets: ["team"], required: true },
  ];
  const html = await ticketForm({ mode: 100000000, fields, record: null, metadata: { adx_validationsummarylinksenabled: true } });
  assert.match(html, /id="amount" class="text decimal form-control " onchange="setIsDirty\(this\.id\);" required="" aria-invalid="true">/);
  assert.match(html, /data-attribute="due" data-behavior="[^"]*" required="" aria-invalid="true" onfocus="validateRequiredField\(this\.id\);">/);
  assert.match(html, /<span id="DateFormatValidatordue"[^>]*>\*<\/span><span id="RequiredFieldValidatordue"/);
  assert.match(html, /id="minutes" class="integer form-control " onchange="setIsDirty\(this\.id\);" required="">/);
  assert.match(html, /id="colour" class="form-control form-select picklist " onchange="setIsDirty\(this\.id\);" required="" aria-required="true" aria-invalid="false" title="Please select an item in this list">/);
  assert.match(html, /<span id="RequiredFieldValidatoragree" style="display:none;">/);
  assert.match(html, /scrollToAndFocus\(\\"teamid_label\\",\\"teamid_name\\"\)/);
});

test("an existing record's empty field shows its prepopulated value; a stored value wins", async () => {
  const fields = [{ name: "note", label: "Note", dataverseType: "nvarchar", maxLength: 50 }, { name: "code", label: "Code", dataverseType: "nvarchar", maxLength: 50 }];
  const rows = [{ adx_attributelogicalname: "note", adx_prepopulatetype: 100000000, adx_prepopulatevalue: "prefilled" }, { adx_attributelogicalname: "code", adx_prepopulatetype: 100000000, adx_prepopulatevalue: "prefilled" }];
  const html = await ticketForm({ fields, rows, record: { ticketid: "r1", code: "stored" } });
  assert.match(html, /value="prefilled"[^>]*id="note"|id="note"[^>]*value="prefilled"/);
  assert.match(html, /value="stored"[^>]*id="code"/);
});

test("a hosted multi-select names the column by its display name, not the form cell label", async () => {
  const fields = [{ name: "tags", label: "Tags", dataverseType: "multiselectpicklist", options: [{ value: 1, label: "One" }] }];
  const html = await ticketForm({ fields, record: { ticketid: "r1" }, solution: { entities: { ticket: { fields: { tags: { label: "Ticket tags column" } } } } } });
  assert.match(html, /&quot;value_DisplayName&quot;:&quot;Ticket tags column&quot;/);
});

test("a subgrid without a relationship lists its view with no parent reference and an empty hidden heading", async () => {
  const store = {
    resolveMapping: (entity) => (entity === "card" ? { entitySet: "cards", idColumn: "cardid", nameColumn: "title" } : { entitySet: "tickets", idColumn: "ticketid" }),
    get: async () => ({ ticketid: "r1" }),
    query: async () => ({ value: [] }),
    fetchXml: async () => { throw new Error("rows load through the grid service"); },
  };
  const portal = { forms: [{ id: "form", name: "Ticket", mode: 100000001, metadata: {} }], records: [], website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
  const cards = { type: "subgrid", id: "Cards", entity: "card", viewId: "v1", relationship: "", showLabel: false, rowspan: 6, label: "Assistant", fields: [{ name: "title", label: "Title" }], fetchXml: '<fetch><entity name="card"><attribute name="title"/></entity></fetch>' };
  const schemas = { form: { entity: "ticket", title: "Ticket", fields: [{ name: "title", label: "Title", dataverseType: "nvarchar", maxLength: 50 }], layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: [[{ name: "title" }], [cards]] }] }] }] } };
  const html = await renderComponent("entityform", "form", { user: { id: "current" }, request: { params: { id: "r1" } } }, { portal, store, schemas });
  assert.match(html, /class="clearfix cell subgrid-cell"><h3 class="table-info form-subgrid-heading"><\/h3><div class="control"><div id="Cards" class="subgrid"><div class="entity-grid subgrid"/);
  const grid = /<div class="entity-grid subgrid"[^>]*>/.exec(html)[0];
  assert.doesNotMatch(grid, /data-ref-entity|data-ref-id|data-ref-rel/);
});
