import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";
import { gridRecord, buildLayout, actionLinks } from "../lib/native-services.mjs";

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
  assert.match(html, /<section aria-hidden="true" aria-label="Create" class="modal fade modal-form modal-form-insert"/);
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
  assert.match(html, /<label class="entitylist-filter-option-group-label h4" data-filter-id="1" for="dropdown_1">Region<\/label>[\s\S]*?<select class="form-control" name="1" id="dropdown_1"><option value="" label=" "><\/option><option value="0" label="North">North<\/option><option value="1" label="South">South<\/option><\/select>/);
  assert.doesNotMatch(html, /type="checkbox" name="1"/);
});
