import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSolutionXml } from '../lib/solution-xml.mjs';
import { parseAppDefinitions, parseSiteMap } from '../lib/model-driven/solution.mjs';
import { appCatalogue, solutionApps } from '../lib/model-driven/catalogue.mjs';
import { createFormClientRuntime, pageRequest } from '../lib/model-driven/client-runtime.mjs';
import { inventoryRecord } from '../lib/solution-inventory.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';

const MIXED = '77777777-7777-4777-8777-777777777771', LISTS = '77777777-7777-4777-8777-777777777772', MISSING = '77777777-7777-4777-8777-777777777773';
const VIEW = '77777777-7777-4777-8777-777777777774', CHART = '77777777-7777-4777-8777-777777777775', APP = '77777777-7777-4777-8777-777777777776';
const GRID = '{E7A81278-8635-4D9E-8D4D-59480B391C5B}';
const cell = (label, control) => `<row><cell><labels><label description="${label}" languagecode="1033"/></labels>${control}</cell></row>`;
const dashboard = (id, name, rows) => `<Dashboard><FormId>{${id}}</FormId><LocalizedNames><LocalizedName description="${name}" languagecode="1033"/></LocalizedNames>
<FormXml><forms type="dashboard"><systemform><formid>{${id}}</formid><form><tabs><tab><columns><column><sections><section><rows>${rows}</rows></section></sections></column></columns></tab></tabs></form></systemform></forms></FormXml></Dashboard>`;
// Learn understand-dashboards-dashboard-components-formxml: lists and charts are sub-grid controls (TargetEntityType, ViewId, VisualizationId, ChartGridMode).
const CUSTOMIZATIONS = `<ImportExportXml><Dashboards>
${dashboard(MIXED, 'Invented board', cell('Open items', `<control id="grid1" classid="${GRID}"><parameters><TargetEntityType>x_item</TargetEntityType><ViewId>{${VIEW}}</ViewId><RecordsPerPage>4</RecordsPerPage><ChartGridMode>Grid</ChartGridMode></parameters></control>`)
  + cell('Item chart', `<control id="chart1" classid="${GRID}"><parameters><TargetEntityType>x_item</TargetEntityType><ViewId>{${VIEW}}</ViewId><VisualizationId>{${CHART}}</VisualizationId><ChartGridMode>Chart</ChartGridMode></parameters></control>`)
  + cell('Banner', '<control id="WebResource_banner" classid="{9FDF5F91-88B1-47f4-AD53-C11EFC01A01D}"><parameters><Url>x_/banner.html</Url></parameters></control>'))}
${dashboard(LISTS, 'Invented lists', cell('All items', `<control id="grid2" classid="${GRID}"><parameters><TargetEntityType>x_item</TargetEntityType><ViewId>{${VIEW}}</ViewId></parameters></control>`))}
</Dashboards></ImportExportXml>`;
const SITEMAP = `<SiteMap><Area Id="main"><Group Id="pages"><SubArea Id="items" Entity="x_item"/>
<SubArea Id="board" DefaultDashboard="{${MIXED}}"/><SubArea Id="lists" Url="/main.aspx?pagetype=dashboard&amp;id=${LISTS}"/><SubArea Id="gone" DefaultDashboard="{${MISSING}}"/></Group></Area></SiteMap>`;

function sources() {
  const facts = parseAppDefinitions(parseSolutionXml(CUSTOMIZATIONS));
  const scan = { layers: [{ documents: [
    { file: 'Other/Customizations.xml', facts },
    { file: 'AppModules/x_app.xml', facts: { apps: [{ id: APP, uniqueName: 'x_app', name: 'Invented app', components: [], navigation: parseSiteMap(SITEMAP) }] } },
  ] }] };
  return { facts, apps: solutionApps(scan) };
}

test('Solution dashboards parse into lists the shell hosts and named components it does not render', () => {
  const { facts } = sources();
  const [mixed, lists] = facts.dashboards;
  assert.deepEqual([mixed.id, mixed.name, lists.name], [MIXED, 'Invented board', 'Invented lists']);
  assert.deepEqual(mixed.components.map(component => [component.kind, component.name, component.supported ?? true]),
    [['grid', 'Open items', true], ['chart', 'Item chart', false], ['web resource', 'Banner', false]]);
  assert.deepEqual([mixed.components[0].entity, mixed.components[0].view, mixed.components[0].pageSize], ['x_item', VIEW, 4]);
});

test('the catalogue opens SiteMap dashboards from the sources and reports a list whose view is not imported', () => {
  const { apps } = sources();
  const view = { id: VIEW, entity: 'x_item', name: 'Open items', queryType: 0, isDefault: true, fields: [{ name: 'x_name', width: 200 }] };
  const catalogue = appCatalogue({ metadata: { modelDrivenApps: apps, entities: {}, views: [view] }, mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } } });
  const items = Object.fromEntries(catalogue.apps[0].navigation[0].groups[0].items.map(item => [item.id, item]));
  assert.deepEqual([items.board.supported, items.board.dashboard, items.lists.supported, items.lists.dashboard], [true, MIXED, true, LISTS]);
  assert.deepEqual([items.gone.supported, items.gone.reason], [false, 'The dashboard definition is not in the sources (MD_NAV_DASHBOARD).']);
  assert.equal(catalogue.capabilities.dashboards, true);
  assert.equal(catalogue.apps[0].dashboards.find(entry => entry.id === LISTS).components[0].supported, true);
  const noView = appCatalogue({ metadata: { modelDrivenApps: apps, entities: {} }, mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } } });
  const list = noView.apps[0].dashboards.find(entry => entry.id === LISTS).components[0];
  assert.deepEqual([list.supported, list.reason], [false, 'The list view is not imported for its table.']);
});

test('navigateTo opens a dashboard by id or the default one, and rejects a dashboard the sources do not hold', async () => {
  const dashboards = [{ id: LISTS, name: 'Invented lists', components: [] }, { id: MIXED, name: 'Invented board', components: [] }];
  assert.deepEqual(pageRequest({ pageType: 'dashboard', dashboardId: `{${MIXED.toUpperCase()}}` }, { target: 2 }, {}, dashboards), [{ pageType: 'dashboard', dashboardId: MIXED }, { target: 2, position: 1 }]);
  assert.deepEqual(pageRequest({ pageType: 'dashboard' }, {}, {}, dashboards)[0], { pageType: 'dashboard', dashboardId: LISTS });
  assert.throws(() => pageRequest({ pageType: 'dashboard', dashboardId: MISSING }, {}, {}, dashboards), error => error.code === 'DashboardPageUnsupported');
  const table = { entity: 'x_item', idColumn: 'x_itemid', nameColumn: 'x_name', entitySet: 'x_items', fields: { x_name: { name: 'x_name', type: 'text' } } };
  const opened = [];
  const { Xrm } = createFormClientRuntime({ table, tables: { x_item: table }, dashboards, form: { clientEvents: [], attributes: ['x_name'] }, record: {}, read: () => null, write() {}, isDirty: () => false,
    controlNames: name => name ? [name] : ['x_name'], controlField: name => name, controlState() {}, notification() {}, request: async () => ({}),
    openPage: async (input, options) => { opened.push([input, options]); } });
  await Xrm.Navigation.navigateTo({ pageType: 'dashboard', dashboardId: MIXED });
  assert.deepEqual(opened[0][0], { pageType: 'dashboard', dashboardId: MIXED });
  await Xrm.Navigation.navigateTo({ pageType: 'custom', name: 'x_invented_page' });
  assert.deepEqual(opened[1][0], { pageType: 'custom', name: 'x_invented_page' });
});

test('a SiteMap dashboard is a requirement row: satisfied when hosted, unsupported naming unrendered components or a missing definition', () => {
  const { apps } = sources();
  const inventory = [inventoryRecord({ component: 'dashboard', id: MIXED, name: 'Invented board', layer: 0 }), inventoryRecord({ component: 'dashboard', id: LISTS, name: 'Invented lists', layer: 0 })];
  const view = { id: VIEW, entity: 'x_item', name: 'Open items', queryType: 0 };
  const rows = Object.fromEntries(buildSourceGraph({ scan: { inventory }, metadata: { modelDrivenApps: apps, entities: { x_item: {} }, views: [view] } }).requirements().map(row => [row.id, row]));
  assert.deepEqual([rows['model-driven:dashboard/x_app/lists'].status, rows['model-driven:dashboard/x_app/lists'].level], ['satisfied', 'behaviour']);
  const board = rows['model-driven:dashboard/x_app/board'];
  assert.deepEqual([board.status, board.reason, board.components], ['unsupported', 'MD_DASHBOARD_COMPONENT_UNSUPPORTED', ['chart Item chart', 'web resource Banner']]);
  assert.deepEqual([rows['model-driven:dashboard/x_app/gone'].status, rows['model-driven:dashboard/x_app/gone'].reason], ['unsupported', 'MD_NAV_DASHBOARD']);
  // The inventory rows tell the same story: the hosted dashboard has none, the partial one names the component gap.
  assert.equal(rows['dashboard:invented lists'], undefined);
  assert.deepEqual([rows['dashboard:invented board'].status, rows['dashboard:invented board'].reason], ['unsupported', 'MD_DASHBOARD_COMPONENT_UNSUPPORTED']);
});

test('a dashboard list over an unimported view is unsupported in the requirement row and listed on the page (one verdict)', () => {
  const { apps } = sources();
  const metadata = { modelDrivenApps: apps, entities: { x_item: {} }, views: [] };
  const row = buildSourceGraph({ metadata }).requirements().find(entry => entry.id === 'model-driven:dashboard/x_app/lists');
  assert.deepEqual([row.status, row.reason, row.components], ['unsupported', 'MD_DASHBOARD_COMPONENT_UNSUPPORTED', ['grid All items']]);
  const page = appCatalogue({ metadata, mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } } }).apps[0].dashboards.find(entry => entry.id === LISTS);
  assert.deepEqual(page.components.filter(component => component.supported === false).map(component => [component.name, component.reason]), [['All items', 'The list view is not imported for its table.']]);
});
