// Bootstrap 5 subgrid dialogs, notes control, attach-file control, entity references and the
// calendar/inactive-list page regions (invented "gadget"/"part" tables and loopback fixtures).
import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";
import { nativePageRegions, webFormsForm } from "../lib/platform-manifest.mjs";
import { DataStore } from "../lib/data.mjs";
import { model, parentId } from "./fixtures/subgrid.mjs";

const GADGET = "b0000000-0000-4000-8000-000000000001";
const PART = "d0000000-0000-4000-8000-000000000001";
const FORM = "f0000000-0000-4000-8000-000000000001";
const fields = [
  { name: "name", label: "Name", dataverseType: "nvarchar", maxLength: 100, required: true },
  { name: "partid", label: "Part", dataverseType: "lookup", lookupTargets: ["part"], required: true },
];
const layout = (cells) => [{ name: "main", label: "Main", columns: [{ width: "100%", sections: [{ name: "details", label: "Details", rows: cells }] }] }];
const store = ({ allowed = () => true } = {}) => ({
  resolveMapping: (entity) =>
    ({ part: { entitySet: "parts", idColumn: "partid", nameColumn: "name" } })[entity] ?? { entitySet: "gadgets", idColumn: "gadgetid", relationships: { gadget_part: { from: "partid", entity: "part", many: false } } },
  get: async (entity, id) => (entity === "part" && id === PART ? { partid: PART, name: "Cog" } : entity === "gadget" ? { gadgetid: GADGET, name: "Sprocket" } : null),
  query: async () => ({ value: [] }),
  allowed,
});
async function render({ mode = 100000001, params = { id: GADGET }, cells = [[{ name: "name" }]], metadata = {}, records = [], storeOverride } = {}) {
  const portal = {
    forms: [{ id: FORM, name: "Gadget", mode, metadata: { adx_entityformid: FORM, ...metadata } }],
    records,
    website: { id: "site" },
    websiteLanguages: [{ lcid: 1033, isDefault: true }],
    pages: [],
    settings: { "Site/BootstrapV5Enabled": "true" },
  };
  const schemas = { [FORM]: { entity: "gadget", title: "Gadget", fields, layout: layout(cells) } };
  return renderComponent("entityform", "Gadget", { user: { id: "current", contactId: "current" }, request: { params } }, { portal, store: storeOverride ?? store(), schemas });
}

test("Bootstrap 5 subgrid: dialog set, ErrorDialog settings, configured messages and the associate dialog", async () => {
  const { portal, schemas, state, settings } = model();
  settings.ViewActions.push({ Type: "CrmEntityFormView-AssociateAction", ViewId: "missing-view", ButtonLabel: [{ LCID: 1033, Value: "Add existing" }] });
  settings.EmptyMessage = [{ LCID: 1033, Value: "No children yet." }];
  settings.GridCssClass = "table-striped";
  settings.ErrorDialog = { Title: [{ LCID: 1033, Value: "Child error" }], CssClass: "child-dialog", DismissButtonSrText: [{ LCID: 1033, Value: "Close dialog" }], CloseButtonText: [{ LCID: 1033, Value: "Dismiss" }] };
  settings.LookupDialog = { Title: [{ LCID: 1033, Value: "Associate children" }], CssClass: "child-dialog", Size: 1, PrimaryButtonText: [{ LCID: 1033, Value: "OK" }], CloseButtonText: [{ LCID: 1033, Value: "Close" }], PrimaryButtonCssClass: "btn btn-primary", CloseButtonCssClass: "btn btn-default", DismissButtonSrText: [{ LCID: 1033, Value: "Close dialog" }], SelectRecordsTitle: [{ LCID: 1033, Value: "Select children" }], DefaultErrorMessage: [{ LCID: 1033, Value: "Could not associate." }], GridOptions: { EmptyMessage: [{ LCID: 1033, Value: "No candidates." }] } };
  portal.records[0].adx_subgrid_settings = JSON.stringify(settings);
  portal.settings = { "Site/BootstrapV5Enabled": "true" };
  const dataStore = await new DataStore({ state }).init();
  const html = await renderComponent("entityform", "Parent", { request: { url: "http://localhost/?id=" + parentId, params: { id: parentId } }, user: state.simulator.identity }, { portal, store: dataStore, schemas });
  const grid = html.slice(html.indexOf('<div id="Children" class="subgrid">'));
  // Only the form, delete and error dialogs; workflow, (de)activate and disassociate dialogs are absent.
  assert.doesNotMatch(grid, /modal-run-workflow|modal-deactivate|modal-activate|modal-disassociate/);
  assert.match(grid, /class="modal fade modal-form modal-form-insert"/);
  // The grid class appends the configured class as is; configured messages are plain text.
  assert.match(grid, /data-grid-class="table-striped table-striped"/);
  assert.match(grid, /<div aria-label="No children yet\." aria-live="polite" class="view-empty message" role="status" tabindex="-1">No children yet\.<\/div><div class="view-access-denied message" role="presentation" tabindex="0"><div class="alert alert-block alert-danger">/);
  // The details dialog keeps its raw title in the label and title attributes.
  assert.match(grid, /<section aria-hidden="true" aria-label="&lt;span class=&#39;fa fa-info-circle&#39; aria-hidden=&#39;true&#39;&gt;&lt;\/span&gt; View details" class="modal fade modal-form modal-form-details"/);
  // ErrorDialog: plain title, CssClass, dismiss text and close button text.
  assert.match(grid, /<section aria-hidden="true" aria-label="Child error" class="modal fade modal-error child-dialog"[^>]*><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h1 class="modal-title" title="Child error">Child error<\/h1><button aria-label="Close" class="form-close" data-bs-dismiss="modal" style="position: absolute; top: 3%;" tabindex="0" title="Close dialog" type="button"><span aria-hidden="true">×<\/span><span class="visually-hidden">Close dialog<\/span>/);
  assert.match(grid, /title="Close" type="button">Dismiss<\/button>/);
  // Associate dialog: CssClass on the wrapper and the candidate grid, CRLF JSON, default grid messages,
  // nested error dialog, titled selected-records card and extended footer buttons.
  const associate = grid.slice(grid.indexOf('<div class="entity-associate'));
  assert.match(associate, /^<div class="entity-associate associate-lookup child-dialog" data-url="\/_services\/entity-lookup-associate\/site" data-associate="\{&#13;&#10;  &quot;Target&quot;: \{&#13;&#10;    &quot;LogicalName&quot;: &quot;parent&quot;,|^<div class="entity-associate associate-lookup child-dialog" data-url="\/_services\/entity-lookup-associate\/site" data-associate="\{\r\n  &quot;Target&quot;: \{\r\n    &quot;LogicalName&quot;: &quot;parent&quot;,/);
  assert.match(associate, /<section aria-hidden="true" aria-label="Associate children" class="modal fade modal-associate"[^>]*><div class="modal-lg modal-dialog">/);
  assert.match(associate, /title="Close dialog" type="button"><span aria-hidden="true">×<\/span><span class="visually-hidden">Close dialog<\/span>/);
  assert.match(associate, /<div class="modal-error message" aria-hidden="true">Could not associate\.<\/div><div class="entity-grid associate-lookup child-dialog" data-column-width-style="Percent" data-defer-loading="true" data-enable-actions="false" data-get-url="\/_services\/entity-subgrid-data.json\/site" data-grid-class="" data-mobile-view-enabled="false" data-select-mode="Multiple" data-selected-view="[^"]*" data-user-isauthenticated="true" data-user-parent-account-name=""/);
  assert.match(associate, /<div class="alert alert-block alert-warning">There are no records to display\.<\/div>/);
  assert.match(associate, /<\/div><section aria-hidden="true" aria-label="&lt;span class=&#39;fa fa-exclamation-triangle&#39; aria-hidden=&#39;true&#39;&gt;&lt;\/span&gt; Error" class="modal fade modal-error"/);
  assert.match(associate, /<div class="content-panel card portal-card-default"><div class="card-header"><h2>Select children<\/h2><\/div><div class="selected-records card-body"><\/div><\/div>/);
  assert.match(associate, /<div class="modal-footer"><button aria-label="OK" class="primary btn btn-primary btn btn-primary" tabindex="0" title="OK" type="button">OK<\/button><button aria-label="Close" class="cancel btn btn-default btn btn-default" data-bs-dismiss="modal" tabindex="0" title="Close" type="button">Close<\/button><\/div>/);
  const [candidateLayout] = JSON.parse(Buffer.from(/data-view-layouts="([^"]*)"/.exec(associate)[1], "base64").toString("utf8"));
  assert.equal(candidateLayout.Columns[0].Name, "<span class='fa fa-check' aria-hidden='true'></span> <span class='visually-hidden'>Select</span>");
});

const notesRow = (settings) => ({ kind: "basicformmetadata", adx_entityform: FORM, adx_type: 100000005, adx_notes_settings: JSON.stringify(settings) });

test("Bootstrap 5 notes without Notes metadata are read-only with the platform's default messages and no dialogs", async () => {
  const html = await render({ cells: [[{ name: "name" }, { type: "notes", id: "notescontrol" }]] });
  const notes = html.slice(html.indexOf('<div id="notescontrol">'), html.indexOf("</div></div></td>", html.indexOf('<div id="notescontrol">')));
  assert.match(notes, /^<div id="notescontrol"><div class="col-lg-8 entity-notes" data-add-enabled="False" data-bs-target="/);
  assert.doesNotMatch(notes, /data-add-accept-types|modal-addnote|modal-editnote|modal-deletenote|addnote btn|class="col-md-3"|toolbar&#32;dropdown/);
  assert.match(notes, /data-orders="\[\{&quot;Attribute&quot;:&quot;createdon&quot;,&quot;Alias&quot;:null,&quot;Direction&quot;:null\}\]" data-pagesize="6"/);
  assert.match(notes, /<script id="notes-template" type="text\/x-handlebars-template">\{\{#each Records\}\}/);
  assert.match(notes, /<div class="label&#32;label-warning"><span class='fa fa-eye-slash' aria-hidden='true'><\/span> Private<\/div>/);
  assert.match(notes, /<div class="notes-empty message" role="presentation" tabindex="0"><div class="alert alert-block alert-warning">There are no notes to display\.<\/div><\/div><div class="notes-access-denied message" role="presentation" tabindex="0"><div class="alert alert-block alert-danger">You don't have permissions to view notes\.<\/div><\/div><div class="notes-error message" role="presentation" tabindex="0"><div class="alert alert-block alert-danger">Error completing request\. <span class="details"><\/span><\/div><\/div><div class="notes-loading message text-center" role="presentation" tabindex="0"><span class="fa fa-spinner fa-spin" aria-hidden="true"><\/span> Loading\.\.\.<\/div>/);
  assert.match(notes, /<div class="note-actions row"><div class="notes-pagination col-md-9" data-current-page="1" data-pages="1" data-pagesize="6"><\/div><\/div>/);
});

test("Bootstrap 5 notes with metadata: configured texts, template toolbar, six-note pages and every dialog", async () => {
  const settings = { CreateEnabled: true, EditEnabled: true, DeleteEnabled: true, PageSize: 10, ListTitle: "Gadget notes", AddNoteButtonLabel: "Add gadget note", NotePrivacyLabel: "Hidden", EmptyMessage: "No gadget notes.", ListOrders: [{ Attribute: "createdon", Direction: "Descending" }] };
  const html = await render({ cells: [[{ name: "name" }, { type: "notes", id: "notescontrol" }]], records: [notesRow(settings)] });
  const notes = html.slice(html.indexOf('<div id="notescontrol">'));
  assert.match(notes, /^<div id="notescontrol"><div class="col-lg-8 entity-notes" data-add-accept-types="\*" data-add-enabled="True" data-bs-target="[^"]*" data-delete-enabled="True" data-edit-enabled="True"/);
  assert.match(notes, /data-orders="\[\{&quot;Attribute&quot;:&quot;createdon&quot;,&quot;Alias&quot;:null,&quot;Direction&quot;:1\}\]" data-pagesize="6"/);
  assert.match(notes, /<div class="col-md-12 page-header mr-0"><h3>Gadget notes<\/h3><\/div><script id="notes-template"/);
  assert.match(notes, /<div class="label&#32;label-warning">Hidden<\/div>/);
  assert.match(notes, /\{\{#if DisplayToolbar\}\}<div class="toolbar&#32;dropdown&#32;float-end"/);
  assert.match(notes, /<div class="notes-empty message" role="presentation" tabindex="0">No gadget notes\.<\/div>/);
  assert.match(notes, /<div class="note-actions row"><div class="col-md-3"><a class="addnote btn btn-default" href="#" role="button">Add gadget note<\/a><\/div><div class="notes-pagination col-md-9" data-current-page="1" data-pages="1" data-pagesize="6">/);
  for (const dialog of ["modal-addnote", "modal-editnote", "modal-delete modal-deletenote"]) assert.match(notes, new RegExp(`class="modal fade ${dialog}"`));
  // The notes permission check gates the add/edit/delete flags.
  const denied = await render({ cells: [[{ name: "name" }, { type: "notes", id: "notescontrol" }]], records: [notesRow(settings)], storeOverride: store({ allowed: (entity) => entity !== "annotation" }) });
  assert.match(denied, /data-add-enabled="False" data-bs-target="[^"]*" data-delete-enabled="False" data-edit-enabled="False"/);
});

test("the attach-file control renders the platform upload control from the form's attach settings", async () => {
  const metadata = { adx_attachfile: true, adx_attachfileaccept: "application/pdf", adx_attachfileacceptextensions: ".pdf", adx_attachfileallowmultiple: true, adx_attachfilerequired: true, adx_attachfilemaxsize: 2048, adx_attachfilelabel: "Gadget PDFs", adx_attachfilesizeerrormessage: "Too big.", adx_attachfiletypeerrormessage: "PDF only." };
  const html = await render({ mode: 100000000, params: {}, metadata });
  const control = html.slice(html.indexOf('<span id="RequiredFieldValidatorAttachFile_HiddenField_AnnotationIds"'));
  assert.match(control, /^<span id="RequiredFieldValidatorAttachFile_HiddenField_AnnotationIds" style="display:none;"><\/span><div class="tr"><div class="file-cell cell"><div class="table-info required"><label for="AttachFile" id="NewAttachFileLabel">Gadget PDFs<\/label>You can upload a maximum of 5 files, each up to 2MB\. Supported files include pdf, \.pdf\.<\/div><div class="ContainerForFile"><div style="display:none;"><input type="file" multiple="multiple" name="[^"]*\$AttachFile" id="AttachFile" accept="application\/pdf,\.pdf" onchange="chooseAttachment\(\);" data-file-size-error-message="Too big\." data-file-type-error-message="PDF only\." aria-required="true"><\/div>/);
  for (const [suffix, value] of [["Location", "CrmDocument"], ["FormID", FORM], ["FormType", "basic"], ["MaxFile", "5"], ["MaxFileSizeInKB", "2097152"], ["SupportedFileType", ".pdf"], ["SupportedMimeType", "application/pdf"], ["SupportedType", "application/pdf,.pdf"]])
    assert.match(control, new RegExp(`<input type="hidden" name="[^"]*\\$AttachFile_HiddenField_${suffix}" id="AttachFile_HiddenField_${suffix}" value="${value.replace(/[.$]/g, "\\$&")}">`), suffix);
  assert.match(control, /<input type="hidden" name="[^"]*\$AttachFile_HiddenField_RegardingId" id="AttachFile_HiddenField_RegardingId"><input type="hidden" name="[^"]*\$AttachFile_HiddenField_MaxFile"/);
  assert.match(control, /<div class="buttonForFileUpload" aria-label="Gadget PDFs" aria-required="true"><button id="UploadButton" style="width: fit-content; gap: 6px; display:flex" type="button" class="btn btn-default btn-secondary" aria-required="true" onclick="selectAttachment\(\);"><div class="fa fa-arrow-up"><\/div> Upload<\/button>/);
  assert.match(control, /<input type="hidden" name="[^"]*\$AttachFile_HiddenField_AnnotationIds" id="AttachFile_HiddenField_AnnotationIds"><input type="hidden" name="[^"]*\$CdnUrl" id="CdnUrl" value="\/resource\/powerappsportal"><\/div><div class="file-info" id="newdivforfileinfo" tabindex="0"><\/div><\/div><\/div><div class="modal fade in errors" id="ModalToShowErrorForFileSize">/);
  assert.match(html, /"id":"RequiredFieldValidatorAttachFile_HiddenField_AnnotationIds"|RequiredFieldValidatorAttachFile_HiddenField_AnnotationIds.*controltovalidate/s);
  // A single optional image attachment.
  const single = await render({ mode: 100000000, params: {}, metadata: { adx_attachfile: true, adx_attachfileaccept: "image/*", adx_attachfilemaxsize: 1024 } });
  assert.match(single, /<div class="table-info"><label for="AttachFile" id="NewAttachFileLabel">Attach a File<\/label>You can upload a maximum of 1 file, up to 1MB\. Supported files include image\.<\/div>/);
  assert.match(single, /<input type="file" name="[^"]*\$AttachFile" id="AttachFile" accept="image\/\*," onchange="chooseAttachment\(\);"><\/div>/);
  assert.doesNotMatch(single, /RequiredFieldValidatorAttachFile/);
  // The WebForms form posts multipart and loads the upload control script after the form scripts.
  const form = webFormsForm({ content: `<div id="EntityFormControl_0123456789abcdef0123456789abcdef" data-pp-native-form>${single}</div>`, variant: "BootstrapV5" });
  assert.match(form, /^<form method="post" action="\/" onsubmit="javascript:return WebForm_OnSubmit\(\);" id="liquid_form" enctype="multipart\/form-data">/);
  assert.ok(form.indexOf("/xrm-adx/js/crmentityformview.js") < form.indexOf('<script src="/xrm-adx/js/fileuploadcontrol.js" type="text/javascript"></script>'));
  assert.doesNotMatch(webFormsForm({ content: '<div data-pp-native-form></div>' }), /enctype|fileuploadcontrol/);
});

test("Set Entity Reference fills the target lookup from the query parameter with the platform's labelling", async () => {
  const metadata = { adx_setentityreference: true, adx_referenceentitylogicalname: "part", adx_referencequerystringname: "partid", adx_referencequerystringisprimarykey: true, adx_referencetargetlookupattributelogicalname: "partid" };
  const html = await render({ mode: 100000000, params: { partid: PART }, cells: [[{ name: "name" }, { name: "partid" }]], metadata });
  assert.match(html, /<input name="[^"]*\$partid_name" type="text" value="Cog" id="partid_name" class="text form-control lookup form-control " readonly="" aria-readonly="true" aria-labelledby="" aria-label="Part is a required field\."><input name="[^"]*\$partid" type="hidden" id="partid" value="d0000000-0000-4000-8000-000000000001" aria-required="true" aria-invalid="true"><input name="[^"]*\$partid_entityname" type="hidden" id="partid_entityname">/);
  // Without the parameter the lookup stays empty with its usual labelling.
  const empty = await render({ mode: 100000000, params: {}, cells: [[{ name: "name" }, { name: "partid" }]], metadata });
  assert.match(empty, /id="partid_name" class="text form-control lookup form-control " readonly="" aria-readonly="true" aria-labelledby="partid_label" aria-label="Part"><input name="[^"]*\$partid" type="hidden" id="partid" aria-required="true">/);
});

test("a calendar list runs inside the WebForms form with its resources and no event validation", () => {
  const content = '<div id="EntityListControl_1b000000000040008000000000000001"><div class="entitylist" data-calendar-url="/EntityList/Calendar/site/list/view" data-view="calendar"><div class="view"></div></div></div>';
  const regions = nativePageRegions({ content, action: "/calendar/", formScripts: '<script src="/Areas/EntityList/js/entitylist-calendar.js" type="text/javascript"></script>' });
  assert.equal(regions.kind, "calendar-list");
  assert.match(regions.content, /^<form method="post" action="\/calendar\/" id="liquid_form">/);
  assert.ok(regions.content.indexOf("/js/jquery.blockUI.js") < regions.content.indexOf("/Areas/EntityList/js/entitylist-calendar.js"));
  assert.ok(regions.content.indexOf("entitylist-calendar.js") < regions.content.indexOf('data-calendar-url'));
  assert.doesNotMatch(regions.content, /__EVENTVALIDATION|crmentityformview\.js/);
  assert.match(regions.content, /__VIEWSTATEENCRYPTED" value="" \/>\n<\/div><\/form>$/);
});

test("an entity_list include of an absent (deactivated) list renders the platform's null-reference Liquid error", async () => {
  const portal = { lists: [], website: { id: "site" }, settings: {} };
  await assert.rejects(
    renderComponent("entitylist", "missing", { key: "missing", request: { params: {} } }, { portal, store: store(), schemas: {}, args: { key: "missing" } }),
    { message: "Object reference not set to an instance of an object." },
  );
});
