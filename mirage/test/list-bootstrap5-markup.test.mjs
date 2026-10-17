import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";
import { gridRecord, buildLayout, actionLinks } from "../lib/native-services.mjs";
import { nativePageRegions } from "../lib/platform-manifest.mjs";

// Invented "widget" table and list on a Bootstrap 5 site (Site/BootstrapV5Enabled) and, for
// contrast, a Bootstrap 3 site. Views, fields and records are local fixtures.
const SITE = "5a000000-0000-4000-8000-000000000001";
const LIST = "5b000000-0000-4000-8000-000000000001";
const VIEW = "5c000000-0000-4000-8000-000000000001";
const CREATE_PAGE = "5d000000-0000-4000-8000-000000000001";
const fields = {
  widgetid: { name: "widgetid", dataverseType: "primarykey", label: "Widget" },
  name: { name: "name", dataverseType: "nvarchar", label: "Name", isPrimaryName: true },
  stamp: { name: "stamp", dataverseType: "datetime", label: "Stamp", format: "datetime", dateTimeBehavior: "UserLocal" },
  regions: { name: "regions", dataverseType: "multiselectpicklist", label: "Regions", options: [{ value: 1, label: "North" }, { value: 2, label: "South" }] },
  amount: { name: "amount", dataverseType: "decimal", label: "Amount", precision: 2 },
  statecode: { name: "statecode", dataverseType: "state", label: "Status", options: [{ value: 0, label: "Active" }] },
  statuscode: { name: "statuscode", dataverseType: "status", label: "Status Reason", options: [{ value: 1, label: "Active" }] },
};
const view = {
  id: VIEW,
  entity: "widget",
  name: "Active Widgets",
  fetchXml: `<fetch><entity name="widget"><attribute name="name"/><attribute name="stamp"/><attribute name="regions"/><attribute name="amount"/><order attribute="name"/></entity></fetch>`,
  fields: ["name", "stamp", "regions", "amount"].map((name) => ({ name, width: 100 })),
};
const metadata = { entities: { widget: { fields } }, views: [view] };
const settings = {
  ViewActions: [{ Type: "CrmEntityFormView-CreateAction", TargetType: 1, RedirectWebpageId: CREATE_PAGE, ButtonLabel: [{ LCID: 1033, Value: "New widget" }] }],
  ItemActions: [
    { Type: "CrmEntityFormView-DetailsAction", TargetType: 1, RedirectWebpageId: CREATE_PAGE, ButtonLabel: [{ LCID: 1033, Value: "View" }] },
    { Type: "CrmEntityFormView-DeleteAction", ButtonLabel: [{ LCID: 1033, Value: "Delete" }], Confirmation: [{ LCID: 1033, Value: "Delete this widget?" }] },
  ],
  CreateFormDialog: { Size: 1, CssClass: "widget-dialog", TitleCssClass: "widget-title" },
};
function portal(v5) {
  return {
    website: { id: SITE },
    websiteLanguages: [{ lcid: 1033, isDefault: true }],
    pages: [{ id: CREATE_PAGE, url: "/widgets/new/" }],
    settings: { "Site/BootstrapV5Enabled": v5 ? "true" : "false" },
    lists: [
      {
        id: LIST,
        name: "Widgets",
        entityName: "widget",
        metadata: { adx_entitylistid: LIST, adx_name: "Widgets", adx_entityname: "widget", adx_view: VIEW, adx_pagesize: 5, adx_searchenabled: true, adx_webpageforcreate: CREATE_PAGE, adx_createbuttonlabel: "New widget", adx_settings: JSON.stringify(settings) },
      },
    ],
  };
}
const store = { resolveMapping: () => ({ entitySet: "widgets", idColumn: "widgetid", nameColumn: "name" }) };
const render = (v5) =>
  renderComponent("entitylist", "Widgets", { user: { id: "current" }, request: { url: "http://localhost/widgets/" }, key: "Widgets" }, { portal: portal(v5), metadata, store, schemas: {}, args: { key: "Widgets" } });
const layouts = (html) => JSON.parse(Buffer.from(/data-view-layouts="([^"]*)"/.exec(html)[1], "base64").toString("utf8"));

test("a Bootstrap 5 list renders the platform grid attributes, messages and div dialogs", async () => {
  const { html } = await render(true);
  const grid = /<div class="entity-grid entitylist [^>]*>/.exec(html)[0];
  for (const attribute of ['data-id="', 'data-grid-class=""', `data-get-ai-insights-url="/_services/entity-grid-ai-summary.json/${SITE}"`, `data-update-url="/_services/entity-grid-update-entity/${SITE}"`, 'data-mobile-view-enabled="false"', 'data-enable-streaming="true"', 'data-nl-search-filter=""'])
    assert.ok(grid.includes(attribute), attribute);
  assert.match(html, /<div class="view-empty message">There are no records to display\.<\/div><div class="view-empty-maker message">/);
  assert.doesNotMatch(html, /<section|data-dismiss=|sr-only">Close/);
  assert.match(html, /<div aria-hidden="true" class="modal fade modal-form modal-form-insert widget-dialog" role="dialog" tabindex="-1"><div class="modal-dialog modal-lg">/);
  assert.match(html, /<h4 class="modal-title widget-title"><span class='fa fa-edit' aria-hidden='true'><\/span> Create<\/h4><button class="btn-close" data-bs-dismiss="modal" type="button">/);
  assert.match(html, new RegExp(`aria-labelledby="modalTitleID_${LIST}"><div class="modal-dialog "><div class="modal-content"><div class="modal-header"><h4 id="modalTitleID_${LIST}"`));
  assert.match(html, /<div class="modal-body">Delete this widget\?<\/div>/);
  assert.match(html, /modal-resolvecase/);
  // The list's create page is the InsertActionLink beside the configured create action.
  const configuration = layouts(html)[0].Configuration;
  assert.deepEqual([configuration.InsertActionLink.Enabled, configuration.InsertActionLink.Target, configuration.InsertActionLink.Tooltip, configuration.InsertActionLink.URL.Path], [true, 2, "Create", "/widgets/new/"]);
  assert.deepEqual(configuration.ViewActionLinks.map((action) => [action.Type, action.Tooltip]), [[3, "Create"]]);
  assert.deepEqual(configuration.ItemActionLinks.map((action) => action.Tooltip), ["View details", "Delete"]);
  assert.equal(configuration.Search.TooltipText, "To search on partial text, use the asterisk (*) wildcard character. ");
});

test("a Bootstrap 3 list keeps its section dialogs and striped grid", async () => {
  const { html } = await render(false);
  assert.match(html, /data-grid-class="table-striped"/);
  assert.match(html, /<section aria-hidden="true" aria-label="Create" class="modal fade modal-form modal-form-insert widget-dialog"/);
  assert.equal(layouts(html)[0].Configuration.InsertActionLink.Enabled, false);
});

test("grid records follow the service contract: no empty attributes, unformatted strings, culture dates, choices labels", () => {
  const layout = buildLayout({ view, entity: "widget", idColumn: "widgetid", primaryName: "name", metadata, configuration: {}, secure: { t: "query" } });
  const model = { entity: "widget", idColumn: "widgetid", primaryName: "name", view };
  const row = { widgetid: "5e000000-0000-4000-8000-000000000001", name: "Sprocket", stamp: "2026-03-04T10:30:00Z", regions: "1,2", amount: null, statecode: 0, statuscode: 1 };
  const context = { metadata, portal: { settings: { "DateTime/DateFormat": "yyyy-MM-dd" } }, timezoneOffset: -120, store: {}, config: { mode: "live" } };
  const record = gridRecord(row, model, layout, context);
  const byName = Object.fromEntries(record.Attributes.map((attribute) => [attribute.Name, attribute]));
  assert.equal(byName.amount, undefined);
  assert.deepEqual([byName.name.FormattedValue, byName.name.DisplayValue, byName.name.DateTimeBehavior], ["", "Sprocket", null]);
  assert.deepEqual([byName.widgetid.FormattedValue, byName.widgetid.DisplayValue], ["", row.widgetid]);
  assert.deepEqual([byName.stamp.FormattedValue, byName.stamp.DisplayValue, byName.stamp.DateTimeFormat, byName.stamp.DateTimeBehavior], ["3/4/2026 12:30 PM", "2026-03-04T10:30:00Z", "DateAndTime", { Value: "UserLocal", ExtensionData: {} }]);
  assert.deepEqual([byName.regions.FormattedValue, byName.regions.DisplayValue, byName.regions.Value], ["South", "North; South", [{ Value: 1, ExtensionData: {} }, { Value: 2, ExtensionData: {} }]]);
  assert.deepEqual([byName.statecode.FormattedValue, byName.statuscode.Value, record.StatusCode], ["Active", { Value: 1, ExtensionData: null }, 1]);
});

test("item action tooltips default to the platform's titles", () => {
  const actions = actionLinks(settings, { portal: portal(true), requestUrl: "http://localhost/", website: SITE });
  assert.deepEqual(actions.map((action) => [action.Type, action.Tooltip]), [[3, "Create"], [1, "View details"], [4, "Delete"]]);
});

test("a choice filter in Dropdown selection mode renders one select box", async () => {
  const definition = { entity: { name: "widget", filters: [{ "adx.id": "1", "adx.uiorder": "0", "adx.uiname": "Region", "adx.attribute": "regions", "adx.uiselectionmode": "Dropdown", type: "or", conditions: [{ "adx.id": "0", uiname: "North", attribute: "regions", operator: "eq", value: "1" }, { "adx.id": "1", uiname: "South", attribute: "regions", operator: "eq", value: "2" }] }] } };
  const site = portal(true);
  Object.assign(site.lists[0].metadata, { adx_filter_enabled: true, adx_filter_definition: JSON.stringify(definition) });
  const { html } = await renderComponent("entitylist", "Widgets", { user: { id: "current" }, request: { url: "http://localhost/widgets/" }, key: "Widgets" }, { portal: site, metadata, store, schemas: {}, args: { key: "Widgets" } });
  assert.match(html, /<label class="entitylist-filter-option-group-label h4" data-filter-id="1" for="dropdown_1">Region<\/label>[\s\S]*?<select class="form-control form-select" name="1" id="dropdown_1"><option value="" label=" "><\/option><option value="0" label="North">North<\/option><option value="1" label="South">South<\/option><\/select>/);
  assert.doesNotMatch(html, /type="checkbox" name="1"/);
});

test("without the create privilege the list keeps its create links disabled; a page control list uses the legacy grid markup", async () => {
  const rulesStore = (operations) => ({ ...store, state: { settings: { permissionMode: "enforce" } }, rules: (entity, operation) => (operations.includes(operation) ? [{ id: "rule" }] : []) });
  const renderWith = (operations, args = { key: "Widgets" }) =>
    renderComponent("entitylist", "Widgets", { user: { id: "current" }, request: { url: "http://localhost/widgets/" }, key: "Widgets" }, { portal: portal(true), metadata, store: rulesStore(operations), schemas: {}, args });
  const reader = layouts((await renderWith(["read"])).html)[0].Configuration;
  assert.equal(reader.InsertActionLink.Enabled, false);
  assert.ok(reader.ViewActionLinks.filter((link) => link.Type === 3).every((link) => link.Enabled === false));
  const editor = layouts((await renderWith(["read", "create"])).html)[0].Configuration;
  assert.equal(editor.InsertActionLink.Enabled, true);
  // A list bound to a legacy page: #EntityListControl > .entitylist > div > .entity-grid with the
  // grid messages and section dialogs, and no create page link (live page/bound-entitylist).
  const { html } = await renderWith(["read", "create"], { key: "Widgets", pp_page_control: true });
  assert.match(html, /^<div id="EntityListControl"><div class="entitylist"><div><div class="entity-grid entitylist" data-column-width-style="Percent" data-defer-loading="false" data-enable-actions="true" data-get-url="\/_services\/entity-grid-data\.json\/[^"]+" data-grid-class="" data-mobile-view-enabled="false" data-select-mode="None" data-selected-view="[^"]+" data-update-url="\/_services\/entity-grid-update-entity\/[^"]+" data-user-isauthenticated="true" data-user-parent-account-name="" data-view-layouts="[^"]+"><div class="view-grid"><\/div><div aria-label="There are no records to display\." aria-live="polite" class="view-empty message"/);
  assert.match(html, /<div class="view-pagination" data-current-page="1" data-pages="1" data-pagesize=""><\/div><section aria-hidden="true" aria-label="Create" class="modal fade modal-form modal-form-insert/);
  assert.doesNotMatch(html, /data-id="|data-get-ai-insights-url/);
  assert.equal(layouts(html)[0].Configuration.InsertActionLink.Enabled, false);
});

test("section grid dialogs follow their dialog settings: class, size, title, loading text, dismiss text and delete confirmation", async () => {
  const text = (value) => [{ LCID: 1033, Value: value }];
  const configured = {
    ...settings,
    CreateFormDialog: { Size: 0, CssClass: "widget-dialog", Title: text("Create widget"), LoadingMessage: text("Loading create widget..."), DismissButtonSrText: text("Close dialog") },
    DetailsFormDialog: { Size: 2, CssClass: "widget-dialog", Title: text("Widget"), LoadingMessage: text("Loading widget..."), DismissButtonSrText: text("Close dialog") },
    DeleteDialog: { Size: 0, CssClass: "widget-dialog", Title: text("Delete widget"), PrimaryButtonText: text("OK"), CloseButtonText: text("Close"), DismissButtonSrText: text("Close dialog") },
  };
  const base = portal(false);
  base.lists[0].metadata.adx_settings = JSON.stringify(configured);
  const { html } = await renderComponent("entitylist", "Widgets", { user: { id: "current" }, request: { url: "http://localhost/widgets/" }, key: "Widgets" }, { portal: base, metadata, store, schemas: {}, args: { key: "Widgets" } });
  assert.match(html, /<section aria-hidden="true" aria-label="Create" class="modal fade modal-form modal-form-insert widget-dialog" data-backdrop="static" role="dialog" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h1 class="modal-title" title="Create">Create widget<\/h1><button aria-label="Close" class="form-close" data-dismiss="modal" style="position: absolute; top: 3%;" tabindex="0" title="Close dialog" type="button"><span aria-hidden="true">×<\/span><span class="sr-only">Close dialog<\/span><\/button><\/div><div class="modal-body"><div class="form-loading">Loading create widget\.\.\.<\/div><iframe /);
  assert.match(html, /aria-label="Widget" class="modal fade modal-form modal-form-details widget-dialog" [^>]*><div class="modal-sm modal-dialog">/);
  assert.match(html, /aria-label="Delete widget" class="modal fade modal-delete widget-dialog" [^>]*>[^]*?<div class="modal-body">Delete this widget\?<\/div><div class="modal-footer"><button aria-label="OK" class="primary btn btn-primary" tabindex="0" title="OK" type="button">OK<\/button><button aria-label="Close" class="cancel btn btn-default" data-dismiss="modal" tabindex="0" title="Close" type="button">Close<\/button>/);
});

test("a map list without map credentials renders the empty legacy list control inside the server form", async () => {
  const base = portal(true);
  Object.assign(base.lists[0].metadata, { adx_map_enabled: true, adx_map_latitudefieldname: "amount", adx_map_longitudefieldname: "amount" });
  const { html } = await renderComponent("entitylist", "Widgets", { user: { id: "current" }, request: { url: "http://localhost/widgets/" }, key: "Widgets" }, { portal: base, metadata, store, schemas: {}, args: { key: "Widgets" } });
  assert.equal(html, `<!--pp-server-list--><div id="EntityListControl_${LIST.replace(/-/g, "")}"><div class="entitylist"></div></div>`);
  // The page wraps it in the WebForms form without event validation, as the platform's list control.
  const form = nativePageRegions({ content: html, action: "/" }).content;
  assert.match(form, /^<form method="post" action="\/" id="liquid_form">/);
  assert.doesNotMatch(form, /__EVENTVALIDATION/);
  // No validators or form controls: no WebUIValidation script (three AXD scripts, live map list).
  assert.equal(form.match(/\.axd\?/g).length, 3);
});

test("a list's own messages and its activate, deactivate and error dialogs come from its settings", async () => {
  const text = (value) => [{ LCID: 1033, Value: value }];
  const configured = portal(true);
  configured.lists[0].metadata.adx_settings = JSON.stringify({ ...settings, EmptyMessage: text("No widgets."), AccessDeniedMessage: text("No access to widgets."), ErrorMessage: text("Widgets failed."), LoadingMessage: text("Loading widgets..."), DeactivateDialog: { CssClass: "widget-dialog", Title: text("Deactivate widget"), DismissButtonSrText: text("Close dialog") }, ActivateDialog: { CssClass: "widget-dialog", Title: text("Activate widget") }, ErrorDialog: { CssClass: "widget-dialog", Title: text("Widget error"), Body: text("Widget error."), CloseButtonText: text("Close") } });
  const { html } = await renderComponent("entitylist", "Widgets", { user: { id: "current" }, request: { url: "http://localhost/widgets/" }, key: "Widgets" }, { portal: configured, metadata, store, schemas: {}, args: { key: "Widgets" } });
  assert.match(html, /<div class="view-empty message">No widgets\.<\/div>/);
  assert.match(html, /<div class="view-access-denied message">No access to widgets\.<\/div><div class="view-error message">Widgets failed\.<\/div><div class="view-loading message text-center">Loading widgets\.\.\.<\/div>/);
  assert.match(html, /class="modal fade modal-deactivate widget-dialog"[^]*?Deactivate widget[^]*?Close dialog/);
  assert.match(html, /class="modal fade modal-activate widget-dialog"[^]*?Activate widget/);
  assert.match(html, /class="modal fade modal-error widget-dialog"[^]*?<div class="modal-body">Widget error\.<\/div><div class="modal-footer"><button class="cancel btn btn-default btn btn-default" data-bs-dismiss="modal" type="button">Close<\/button>/);
});
