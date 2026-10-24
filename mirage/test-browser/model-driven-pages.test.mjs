import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser();


// The custom page: a project canvas app whose OnStart reads the navigateTo parameters (Param("recordId"),
// Param("entityName")) and looks the record up in Dataverse; its screen's OnVisible sets a context variable.
const CUSTOM_PAGE = {
  'Src/App.pa.yaml': stringify({ App: { Properties: { OnStart: '=Set(fxRecord, Param("recordId")); Set(fxEntity, Param("entityName")); Set(fxCount, CountRows(Items))', StartScreen: '=PageScreen' } },
    DataSources: { Items: { Type: 'Table', Parameters: { TableLogicalName: 'x_item' } } } }),
  'Src/PageScreen.pa.yaml': stringify({ Screens: { PageScreen: { Properties: { OnVisible: '=UpdateContext({fxShown: true})' }, Children: [
    { ItemLabel: { Control: 'Label@2.5.1', Properties: { Text: '="Item " & LookUp(Items, x_itemid = GUID(Param("recordId"))).x_name' } } }] } } }),
};

// A dataset component: renders the formatted names of its dataset and exposes its context.
const grid = `ComponentFramework.registerControl('Invented.Grid', class {
  init(context, notify, state, container) { this.container = container; }
  updateView(context) { const set = context.parameters.records; window.gridContext = context;
    this.container.textContent = set.loading ? 'loading' : 'Rows: ' + set.sortedRecordIds.map(id => set.records[id].getFormattedValue('x_name')).join('|'); }
  destroy() {}
});`;

async function fixture(t) {
  const initial = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } }); await initial.sim.close();
  const dir = initial.solutionDir, write = async (name, content) => { await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await fs.writeFile(path.join(dir, name), content); };
  await write('WebResources/summary.html', '<!doctype html><p id="message">Invented summary</p><script>document.getElementById("message").dataset.data = new URLSearchParams(location.search).get("data") || "";</script>');
  await write('WebResources/summary.html.data.xml', '<WebResource><WebResourceId>bbbbbbbb-0000-4000-8000-000000000001</WebResourceId><Name>x_/pages/summary.html</Name><WebResourceType>1</WebResourceType><FileName>WebResources/summary.html</FileName></WebResource>');
  // The custom page is the app's own canvas app component (AppModuleComponent type 300); x_other_page is a canvas app the
  // canvas host holds that this app does not include.
  const appModule = path.join(dir, 'AppModules/x_example/AppModule.xml');
  await fs.writeFile(appModule, (await fs.readFile(appModule, 'utf8')).replace('</AppModuleComponents>', '<AppModuleComponent type="300" schemaName="x_invented_page"/></AppModuleComponents>'));
  const siteMap = path.join(dir, 'AppModuleSiteMaps/x_example/AppModuleSiteMap.xml');
  await fs.writeFile(siteMap, (await fs.readFile(siteMap, 'utf8')).replace('<SubArea Id="external"', '<SubArea Id="summary" Url="$webresource:x_/pages/summary.html"><Titles><Title LCID="1033" Title="Summary"/></Titles></SubArea><SubArea Id="custom" Url="/main.aspx?pagetype=custom&amp;name=x_invented_page"><Titles><Title LCID="1033" Title="Canvas page"/></Titles></SubArea><SubArea Id="other" Url="/main.aspx?pagetype=custom&amp;name=x_other_page"><Titles><Title LCID="1033" Title="Other page"/></Titles></SubArea><SubArea Id="external"'));
  await write('Controls/x_Invented.Grid/ControlManifest.xml', '<manifest><control namespace="Invented" constructor="Grid" control-type="standard"><data-set name="records" display-name-key="Records"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>');
  await write('Controls/x_Invented.Grid/ControlManifest.xml.data.xml', '<CustomControl><Name>x_Invented.Grid</Name></CustomControl>');
  await write('Controls/x_Invented.Grid/bundle.js', grid);
  const formFile = path.join(dir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(formFile, (await fs.readFile(formFile, 'utf8')).replace('<form><tabs>', '<form><header><rows><row><cell><control id="header_x_quantity" datafieldname="x_quantity"/></cell></row></rows></header><tabs>').replace('</form>', '<controlDescriptions><controlDescription forControl="children"><customControl formFactor="0" name="x_Invented.Grid"><parameters><data-set name="records"><ViewId>{children-view}</ViewId><TargetEntityType>x_child</TargetEntityType></data-set></parameters></customControl></controlDescription></controlDescriptions></form>'));
  for (const app of ['x_invented_page', 'x_other_page']) for (const [name, content] of Object.entries(CUSTOM_PAGE)) { const file = path.join(initial.root, 'apps', app, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const sim = await initial.start({ projectRoot: initial.root, canvas: { sources: ['apps/x_invented_page', 'apps/x_other_page'] } }); const origin = sim.origin ?? sim.url; t.after(() => sim.close());
  const page = await chrome.page(t); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { page, origin, errors, sim };
}

async function openRecord(page, origin) {
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && window.Xrm);
}

// Canvas apps run as a selected staff user, never SYSTEM: the tests select an administrator first.
async function selectStaff(page, sim) {
  const csrf = sim.state().csrf, request = page.context().request;
  const made = await request.post(sim.origin + '/_sim/api/dataverse/users', { headers: { 'x-sim-csrf': csrf }, data: { fullname: 'Invented page staff', domainname: 'page-staff@example.test', roles: ['System Administrator'] } });
  assert.equal(made.status(), 201);
  assert.equal((await request.post(sim.origin + '/_sim/api/dataverse/session', { headers: { 'x-sim-csrf': csrf }, data: { userId: (await made.json()).systemuserid } })).status(), 200);
}

test('SiteMap web resource pages open inline; a SiteMap custom page opens the headless canvas host', async t => {
  const { page, origin, errors, sim } = await fixture(t);
  sim.origin = origin; await selectStaff(page, sim);
  await page.goto(origin + '/main.aspx?appname=x_example');
  await page.getByRole('button', { name: 'Items', exact: true }).waitFor();
  // A SiteMap custom page whose canvas app this app does not include stays listed and disabled with the failed check.
  const other = page.getByRole('button', { name: 'Other page', exact: true });
  assert.equal(await other.isDisabled(), true);
  assert.equal(await other.getAttribute('title'), 'Custom page x_other_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).');
  await page.getByRole('button', { name: 'Canvas page', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'This custom page is not rendered locally.' }).waitFor();
  assert.match(page.url(), /pagetype=custom&name=x_invented_page/);
  // OnStart ran (no record parameters: Param is blank) and the start screen's OnVisible ran.
  const variables = JSON.parse(await page.getByRole('region', { name: 'Variables', exact: true }).locator('pre').textContent());
  assert.deepEqual([variables.fxCount, variables.fxRecord, variables.fxEntity], [3, undefined, undefined]);
  assert.deepEqual(JSON.parse(await page.getByRole('region', { name: 'Context variables', exact: true }).locator('pre').textContent()), { PageScreen: { fxShown: true } });
  assert.equal(await page.getByRole('link', { name: 'Open the headless canvas host' }).getAttribute('href'), '/_apps/canvas/x_invented_page');
  await page.getByRole('button', { name: 'Summary', exact: true }).click();
  const frame = page.frameLocator('iframe.webresource-page');
  await frame.locator('#message').waitFor();
  assert.equal(await frame.locator('#message').textContent(), 'Invented summary');
  assert.match(page.url(), /pagetype=webresource&webresourceName=x_%2Fpages%2Fsummary\.html/);
  assert.deepEqual(errors, []);
});

test('navigateTo opens web resources, records and custom pages; a missing custom page rejects with CustomPageNotFound', async t => {
  const { page, origin, errors, sim } = await fixture(t);
  sim.origin = origin; await selectStaff(page, sim);
  await openRecord(page, origin);
  await page.evaluate(() => { window.pageClosed = window.Xrm.Navigation.navigateTo({ pageType: 'webresource', webresourceName: 'x_/pages/summary.html', data: 'invented' }, { target: 2, width: 500, title: 'Summary dialog' }).then(result => ({ result: result ?? null })); });
  const dialog = page.getByRole('dialog', { name: 'Summary dialog' });
  await dialog.waitFor();
  await page.frameLocator('dialog.page-dialog iframe').locator('#message[data-data="invented"]').waitFor();
  await dialog.getByRole('button', { name: 'Close' }).click();
  assert.deepEqual(await page.evaluate(() => window.pageClosed), { result: null });
  // navigateTo: an existing record closed in a dialog resolves with no value.
  await page.evaluate(() => { window.saved = window.Xrm.Navigation.navigateTo({ pageType: 'entityrecord', entityName: 'x_item', entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { target: 2, position: 2, title: 'Side record' }).then(result => ({ result: result ?? null })); });
  await page.frameLocator('dialog.page-dialog.side iframe').getByRole('heading', { name: 'Silver', exact: true }).waitFor();
  await page.getByRole('dialog', { name: 'Side record' }).getByRole('button', { name: 'Close' }).first().click();
  assert.deepEqual(await page.evaluate(() => window.saved), { result: null });
  // A record opened in create mode resolves with savedEntityReference once it was saved.
  await page.evaluate(() => { window.created = window.Xrm.Navigation.navigateTo({ pageType: 'entityrecord', entityName: 'x_item' }, { target: 2, title: 'New record' }); });
  const created = page.frameLocator('dialog.page-dialog iframe');
  await created.getByLabel('Name', { exact: true }).fill('Bronze');
  await created.getByRole('toolbar', { name: 'Commands', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
  await created.getByRole('heading', { name: 'Bronze', exact: true }).waitFor();
  await page.getByRole('dialog', { name: 'New record' }).getByRole('button', { name: 'Close' }).first().click();
  const saved = await page.evaluate(() => window.created);
  assert.deepEqual(saved.savedEntityReference.map(reference => [reference.entityType, reference.name]), [['x_item', 'Bronze']]);
  assert.match(saved.savedEntityReference[0].id, /^\{[0-9a-f-]{36}\}$/);
  assert.deepEqual(await page.evaluate(() => window.Xrm.Navigation.navigateTo({ pageType: 'custom', name: 'x_missing_page' }).then(() => 'opened', error => [error.code, error.message])),
    ['CustomPageNotFound', 'Custom page x_missing_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).']);
  // A canvas app the host holds is still not a page of this app unless the app includes it.
  assert.deepEqual(await page.evaluate(() => window.Xrm.Navigation.navigateTo({ pageType: 'custom', name: 'x_other_page' }).then(() => 'opened', error => [error.code, error.message])),
    ['CustomPageNotFound', 'Custom page x_other_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).']);
  // Inline with record context: the page's formulas read recordId and entityName through Param.
  await page.evaluate(() => window.Xrm.Navigation.navigateTo({ pageType: 'custom', name: 'x_invented_page', entityName: 'x_item', recordId: '{AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA}' }, { target: 1 }));
  await page.getByRole('status').filter({ hasText: 'This custom page is not rendered locally.' }).waitFor();
  assert.match(page.url(), /pagetype=custom&name=x_invented_page&entityName=x_item&recordId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
  const screen = JSON.parse(await page.getByRole('region', { name: 'Current screen', exact: true }).locator('pre').textContent());
  assert.deepEqual([screen.screen, screen.controls.ItemLabel.Text], ['PageScreen', 'Item Copper']);
  const variables = JSON.parse(await page.getByRole('region', { name: 'Variables', exact: true }).locator('pre').textContent());
  assert.deepEqual([variables.fxRecord, variables.fxEntity], ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x_item']);
  // The route of a missing page answers the same error in the shell.
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=custom&name=x_missing_page');
  await page.getByRole('status').filter({ hasText: 'Custom page x_missing_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).' }).waitFor();
  assert.deepEqual(errors, []);
});

test('Xrm.App.sidePanes hosts pages beside the workspace and closes them', async t => {
  const { page, origin, errors } = await fixture(t);
  await openRecord(page, origin);
  await page.evaluate(async () => { const pane = await window.Xrm.App.sidePanes.createPane({ title: 'Invented pane', paneId: 'invented' }); await pane.navigate({ pageType: 'entitylist', entityName: 'x_item' }); });
  const pane = page.getByRole('region', { name: 'Invented pane' });
  await page.frameLocator('.side-pane iframe').getByText('Silver', { exact: true }).waitFor();
  assert.equal(await pane.isVisible(), true);
  assert.equal(await page.evaluate(() => window.Xrm.App.sidePanes.getAllPanes().getLength()), 1);
  // sidePanes.state: 0 collapsed, 1 expanded; the value read is the value set.
  // formContext.getControl: a header column is the control header_<column>; it is not rendered locally, so changes refuse by name.
  assert.deepEqual(await page.evaluate(() => { const control = window.Xrm.Page.getControl('header_x_quantity'); let refused; try { control.setVisible(false); } catch (error) { refused = error.message; }
    return [control.getName(), control.getAttribute().getName(), window.Xrm.Page.getAttribute('x_quantity').controls.getLength(), /header control header_x_quantity/.test(refused)]; }), ['header_x_quantity', 'x_quantity', 2, true]);
  assert.deepEqual(await page.evaluate(() => { const panes = window.Xrm.App.sidePanes, before = panes.state; panes.state = 0; const collapsed = panes.state; panes.state = 1; return [before, collapsed, panes.state]; }), [1, 0, 1]);
  await page.evaluate(() => window.Xrm.App.sidePanes.getPane('invented').close());
  assert.equal(await page.locator('.side-pane').count(), 0);
  assert.equal(await page.evaluate(() => window.Xrm.App.sidePanes.getSelectedPane()), undefined);
  assert.deepEqual(errors, []);
});

test('a dataset component on a related subgrid receives the parent rows and the staff context', async t => {
  const { page, origin, errors } = await fixture(t);
  await openRecord(page, origin);
  await page.getByRole('tab', { name: 'Related items' }).click();
  await page.getByText('Rows: Copper child', { exact: true }).waitFor();
  const context = await page.evaluate(() => ({ entity: window.gridContext.parameters.records.getTargetEntityType(), total: window.gridContext.parameters.records.paging.totalResultCount,
    roles: window.gridContext.userSettings.securityRoles.length, language: window.gridContext.userSettings.languageId, xrmRoles: window.Xrm.Utility.getGlobalContext().userSettings.securityRoles }));
  assert.equal(context.entity, 'x_child'); assert.equal(context.total, 1); assert.equal(context.language, 1033);
  assert.ok(context.roles > 0, 'the local administrator context carries its organization role ids');
  assert.equal(context.xrmRoles.length, context.roles);
  assert.deepEqual(errors, []);
});
