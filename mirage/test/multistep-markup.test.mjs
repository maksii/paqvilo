import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";
import { createWebFormSessions, webFormSession } from "../lib/form-service.mjs";

// Invented "survey" multistep form on a Bootstrap 5 site: one insert step with a metadata
// description and a required radio choice, then a second step.
const portal = {
  website: { id: "site" },
  forms: [],
  lists: [],
  pages: [],
  settings: { "Site/BootstrapV5Enabled": "true" },
  websiteLanguages: [{ lcid: 1033, isDefault: true }],
  advancedForms: [{ id: "survey", name: "Survey Wizard", metadata: { adx_progressindicatorenabled: true, adx_progressindicatorprependstepnum: true } }],
  records: [
    { kind: "advancedformmetadata", adx_webformstep: "one", adx_type: 100000000, adx_attributelogicalname: "note", adx_adddescription: true, adx_description: '[{"LCID":1033,"Value":"Shown below"}]', adx_descriptionposition: 100000001 },
    { kind: "advancedformmetadata", adx_webformstep: "one", adx_type: 100000000, adx_attributelogicalname: "colour", adx_controlstyle: 100000001, adx_fieldisrequired: true },
  ],
};
const step = (stepId, extra) => ({
  stepId,
  entity: "answer",
  mode: 100000000,
  formName: "Answer Compact",
  metadata: { adx_entitypermissionsenabled: true },
  fields: [
    { name: "note", label: "Note", dataverseType: "nvarchar", maxLength: 50 },
    { name: "colour", label: "Colour", dataverseType: "picklist", options: [{ value: 1, label: "Red" }, { value: 2, label: "Blue" }] },
  ],
  layout: [{ name: "tab", columns: [{ sections: [{ name: "s", rows: [[{ name: "note" }], [{ name: "colour" }]] }] }] }],
  ...extra,
});
const schemas = { survey: { initialStepId: "one", steps: [step("one", { nextStepId: "two", title: "One" }), step("two", { title: "Two" })] } };
const store = { resolveMapping: () => ({ entitySet: "answers", idColumn: "answerid" }), get: async () => null, query: async () => ({ value: [] }) };

test("multistep step markup follows the platform control (row wrapper, form name, layout, honeypot, buttons)", async () => {
  const webFormSessions = createWebFormSessions();
  const html = await renderComponent("webform", "Survey Wizard", { request: { params: {} } }, { portal, store, schemas, renderLiquid: async (s) => s, webFormSessions, webFormOwner: () => "visitor:a" });
  assert.match(html, /<div id="WebFormControl_survey"[^>]*>(<script[^>]*>[^<]*<\/script>)*<div class="row"><div id="WebFormControl_survey_ProgressIndicator"><ol class="progress list-group top">/);
  const panel = html.match(/<div id="WebFormPanel"[^>]*>/)[0];
  // role and aria-label are added by the client script, not the server.
  assert.equal(panel, `<div id="WebFormPanel" class="crmEntityFormView" data-form-name="Survey Wizard" onkeypress="javascript:return WebForm_FireDefaultButton(event, 'NextButton')">`);
  assert.match(html, /&quot;EnableEntityPermissions&quot;:false/);
  assert.match(html, /<div class="frm-g-[0-9a-f]{8}" [^>]*aria-hidden="true"><label for="frm_pref_/);
  assert.match(html, /<div class="actions"><div class="col-md-6 clearfix"><div role="group" class="btn-group entity-action-button"><input type="button" [^>]*id="NextButton" class="btn btn-primary button next submit-btn" nonactionlinkbutton="true"><\/div><\/div><\/div><\/div>/);
  assert.match(html, /id="note" class="text form-control "[^>]* aria-roledescription="Shown below"/);
  assert.match(html, /<span id="colour" class="picklist horizontal " role="presentation" onchange="setIsDirty\(this.id\);" data-required="true" aria-invalid="false" title="Please select an item in this list">/);
});

test("a data reset forgets multistep sessions", () => {
  const sessions = createWebFormSessions();
  const session = sessions.create("survey", "contact:x");
  session.current = "two";
  assert.equal(webFormSession({ webformId: "survey", owner: "contact:x", sessions }), session);
  sessions.clear();
  assert.equal(webFormSession({ webformId: "survey", owner: "contact:x", sessions }), null);
});

test("a step without its source record redirects to msg=source-invalid and then shows the not-found message alone", async () => {
  const editSchemas = { survey: { initialStepId: "one", steps: [step("one", { mode: 100000001, title: "One", js: "window.stepScript=1;" })] } };
  const options = { portal, store, schemas: editSchemas, renderLiquid: async (s) => s, webFormSessions: createWebFormSessions(), webFormOwner: () => "visitor:b" };
  const first = await renderComponent("webform", "Survey Wizard", { request: { url: "http://localhost/survey/", params: {} } }, options);
  assert.equal(first, '<script>location.replace("/survey/?msg=source-invalid&stepid=one");</script>');
  const html = await renderComponent("webform", "Survey Wizard", { request: { url: "http://localhost/survey/?msg=source-invalid&stepid=one", params: { msg: "source-invalid", stepid: "one" } } }, options);
  assert.equal(html, '<div id="WebFormControl_survey" data-pp-native-form><div id="MessagePanel" class="message error alert alert-danger" role="alert"><span id="MessageLabel">The record you are looking for couldn&#39;t be found.</span></div></div>');
});

test("Bootstrap 5 marks a completed step with the platform's check icon and Previous as a non-action-link button", async () => {
  const webFormSessions = createWebFormSessions();
  const session = webFormSessions.create("survey", "visitor:c");
  session.history.push({ stepId: "one", recordId: null, entity: null });
  session.current = "two";
  const html = await renderComponent("webform", "Survey Wizard", { request: { params: {} } }, { portal, store, schemas, renderLiquid: async (s) => s, webFormSessions, webFormOwner: () => "visitor:c" });
  assert.match(html, /<li class="list-group-item text-muted list-group-item-success"><span class="number">1<\/span>One<span class="fa-solid fa-check" role="img" aria-label="Completed"><\/span><\/li><li class="list-group-item active"><span class="number">2<\/span>Two<\/li>/);
  assert.match(html, /id="PreviousButton" class="btn btn-default button previous previous-btn" nonactionlinkbutton="true">/);
});

test("Bootstrap 5 side indicators: left progress bar and right title list with the platform column classes", async () => {
  const render = (metadata) => renderComponent("webform", "Survey Wizard", { request: { params: {} } }, {
    portal: { ...portal, advancedForms: [{ id: "survey", name: "Survey Wizard", metadata: { adx_progressindicatorenabled: true, adx_progressindicatorprependstepnum: true, ...metadata } }] },
    store, schemas, renderLiquid: async (s) => s, webFormSessions: createWebFormSessions(), webFormOwner: () => "visitor:d",
  });
  const left = await render({ adx_progressindicatortype: 756150002, adx_progressindicatorposition: 756150002 });
  assert.match(left, /<div id="WebFormControl_survey_ProgressIndicator" class=" col-md-3 col-lg-2 progress left col-md-3 col-lg-2 progress left"><span>0%<\/span><div aria-valuenow="0" aria-valuemax="100" aria-label="progressbar" class="bar progress-bar zero" aria-valuetext="0%" tabindex="0" style="width: 0%;" aria-valuemin="0" role="progressbar"><span aria-hidden="true">0%<\/span><\/div><\/div><div id="WebFormPanel" class="crmEntityFormView right col-lg-10 order-1"/);
  const right = await render({ adx_progressindicatortype: 756150000, adx_progressindicatorposition: 756150003 });
  assert.match(right, /<div id="WebFormControl_survey_ProgressIndicator" class=" col-md-3 col-lg-2 div-right order-lg-1 col-md-3 col-lg-2 div-right order-lg-1"><ol class="progress list-group right">/);
  assert.match(right, /<div id="WebFormPanel" class="crmEntityFormView left col-lg-10"/);
});
