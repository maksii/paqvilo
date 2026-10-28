import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser, fileScope } from './shared-browser.mjs';

const chrome = sharedBrowser();
// Tests that select staff or create records own their simulator; read-only tests share one.
const scope = fileScope();
let sharedApp;

// The custom page: a project canvas app whose OnStart reads the navigateTo parameters (Param("recordId"),
// Param("entityName")) and looks the record up in Dataverse; its screen's OnVisible sets a context variable.
const CUSTOM_PAGE = {
  'Src/App.pa.yaml': stringify({
    App: {
      Properties: {
        OnStart:
          '=Set(fxRecord, Param("recordId")); Set(fxEntity, Param("entityName")); Set(fxCount, CountRows(Items))',
        StartScreen: '=PageScreen',
      },
    },
    DataSources: { Items: { Type: 'Table', Parameters: { TableLogicalName: 'x_item' } } },
  }),
  'Src/PageScreen.pa.yaml': stringify({
    Screens: {
      PageScreen: {
        Properties: { OnVisible: '=UpdateContext({fxShown: true})' },
        Children: [
          {
            ItemLabel: {
              Control: 'Label@2.5.1',
              Properties: { Text: '="Item " & LookUp(Items, x_itemid = GUID(Param("recordId"))).x_name' },
            },
          },
        ],
      },
    },
  }),
};

// A dataset component: renders the formatted names of its dataset and exposes its context.
const grid = `ComponentFramework.registerControl('Invented.Grid', class {
  init(context, notify, state, container) { this.container = container; }
  updateView(context) { const set = context.parameters.records; window.gridContext = context;
    this.container.textContent = set.loading ? 'loading' : 'Rows: ' + set.sortedRecordIds.map(id => set.records[id].getFormattedValue('x_name')).join('|'); }
  destroy() {}
});`;

async function app(owner) {
  const initial = await modelDrivenFixture(owner, { modelDriven: { trustedExtensions: true }, defer: true });
  const dir = initial.solutionDir,
    write = async (name, content) => {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), content);
    };
  await write(
    'WebResources/summary.html',
    '<!doctype html><p id="message">Invented summary</p><script>document.getElementById("message").dataset.data = new URLSearchParams(location.search).get("data") || "";</script>',
  );
  await write(
    'WebResources/summary.html.data.xml',
    '<WebResource><WebResourceId>bbbbbbbb-0000-4000-8000-000000000001</WebResourceId><Name>x_/pages/summary.html</Name><WebResourceType>1</WebResourceType><FileName>WebResources/summary.html</FileName></WebResource>',
  );
  // The custom page is the app's own canvas app component (AppModuleComponent type 300); x_other_page is a canvas app the
  // canvas host holds that this app does not include.
  const appModule = path.join(dir, 'AppModules/x_example/AppModule.xml');
  await fs.writeFile(
    appModule,
    (await fs.readFile(appModule, 'utf8')).replace(
      '</AppModuleComponents>',
      '<AppModuleComponent type="300" schemaName="x_invented_page"/></AppModuleComponents>',
    ),
  );
  const siteMap = path.join(dir, 'AppModuleSiteMaps/x_example/AppModuleSiteMap.xml');
  await fs.writeFile(
    siteMap,
    (await fs.readFile(siteMap, 'utf8')).replace(
      '<SubArea Id="external"',
      '<SubArea Id="summary" Url="$webresource:x_/pages/summary.html"><Titles><Title LCID="1033" Title="Summary"/></Titles></SubArea><SubArea Id="custom" Url="/main.aspx?pagetype=custom&amp;name=x_invented_page"><Titles><Title LCID="1033" Title="Canvas page"/></Titles></SubArea><SubArea Id="other" Url="/main.aspx?pagetype=custom&amp;name=x_other_page"><Titles><Title LCID="1033" Title="Other page"/></Titles></SubArea><SubArea Id="external"',
    ),
  );
  await write(
    'Controls/x_Invented.Grid/ControlManifest.xml',
    '<manifest><control namespace="Invented" constructor="Grid" control-type="standard"><data-set name="records" display-name-key="Records"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
  );
  await write(
    'Controls/x_Invented.Grid/ControlManifest.xml.data.xml',
    '<CustomControl><Name>x_Invented.Grid</Name></CustomControl>',
  );
  await write('Controls/x_Invented.Grid/bundle.js', grid);
  const formFile = path.join(dir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    formFile,
    (await fs.readFile(formFile, 'utf8'))
      .replace(
        '<form><tabs>',
        '<form><header><rows><row><cell><control id="header_x_quantity" datafieldname="x_quantity"/></cell></row></rows></header><tabs>',
      )
      .replace(
        '</form>',
        '<controlDescriptions><controlDescription forControl="children"><customControl formFactor="0" name="x_Invented.Grid"><parameters><data-set name="records"><ViewId>{children-view}</ViewId><TargetEntityType>x_child</TargetEntityType></data-set></parameters></customControl></controlDescription></controlDescriptions></form>',
      ),
  );
  for (const app of ['x_invented_page', 'x_other_page'])
    for (const [name, content] of Object.entries(CUSTOM_PAGE)) {
      const file = path.join(initial.root, 'apps', app, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
  const sim = await initial.start({
    projectRoot: initial.root,
    canvas: { sources: ['apps/x_invented_page', 'apps/x_other_page'] },
  });
  return { sim, origin: sim.origin ?? sim.url };
}

async function fixture(t, { readOnly = false } = {}) {
  const { sim, origin } = await (readOnly ? (sharedApp ??= app(scope)) : app(t));
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, origin, errors, sim };
}

async function openRecord(page, origin) {
  await page.goto(
    origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && window.Xrm);
}

// Canvas apps run as a selected staff user, never SYSTEM: the tests select an administrator first.
async function selectStaff(page, sim) {
  const csrf = sim.state().csrf,
    request = page.context().request;
  const made = await request.post(sim.origin + '/_sim/api/dataverse/users', {
    headers: { 'x-sim-csrf': csrf },
    data: { fullname: 'Invented page staff', domainname: 'page-staff@example.test', roles: ['System Administrator'] },
  });
  assert.equal(made.status(), 201);
  assert.equal(
    (
      await request.post(sim.origin + '/_sim/api/dataverse/session', {
        headers: { 'x-sim-csrf': csrf },
        data: { userId: (await made.json()).systemuserid },
      })
    ).status(),
    200,
  );
}

test('SiteMap web resource pages open inline; a SiteMap custom page opens the headless canvas host', async (t) => {
  const { page, origin, errors, sim } = await fixture(t);
  sim.origin = origin;
  await selectStaff(page, sim);
  await page.goto(origin + '/main.aspx?appname=x_example');
  await page.getByRole('button', { name: 'Items', exact: true }).waitFor();
  // A SiteMap custom page whose canvas app this app does not include stays listed and disabled with the failed check.
  const other = page.getByRole('button', { name: 'Other page', exact: true });
  assert.equal(await other.isDisabled(), true);
  assert.equal(
    await other.getAttribute('title'),
    'Custom page x_other_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).',
  );
  await page.getByRole('button', { name: 'Canvas page', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'This custom page is not rendered locally.' }).waitFor();
  assert.match(page.url(), /pagetype=custom&name=x_invented_page/);
  // OnStart ran (no record parameters: Param is blank) and the start screen's OnVisible ran.
  const variables = JSON.parse(
    await page.getByRole('region', { name: 'Variables', exact: true }).locator('pre').textContent(),
  );
  assert.deepEqual([variables.fxCount, variables.fxRecord, variables.fxEntity], [3, undefined, undefined]);
  assert.deepEqual(
    JSON.parse(await page.getByRole('region', { name: 'Context variables', exact: true }).locator('pre').textContent()),
    { PageScreen: { fxShown: true } },
  );
  assert.equal(
    await page.getByRole('link', { name: 'Open the headless canvas host' }).getAttribute('href'),
    '/_apps/canvas/x_invented_page',
  );
  await page.getByRole('button', { name: 'Summary', exact: true }).click();
  const frame = page.frameLocator('iframe.webresource-page');
  await frame.locator('#message').waitFor();
  assert.equal(await frame.locator('#message').textContent(), 'Invented summary');
  assert.match(page.url(), /pagetype=webresource&webresourceName=x_%2Fpages%2Fsummary\.html/);
  assert.deepEqual(errors, []);
});

test('navigateTo opens web resources, records and custom pages; a missing custom page rejects with CustomPageNotFound', async (t) => {
  const { page, origin, errors, sim } = await fixture(t);
  sim.origin = origin;
  await selectStaff(page, sim);
  await openRecord(page, origin);
  await page.evaluate(() => {
    window.pageClosed = window.Xrm.Navigation.navigateTo(
      { pageType: 'webresource', webresourceName: 'x_/pages/summary.html', data: 'invented' },
      { target: 2, width: 500, title: 'Summary dialog' },
    ).then((result) => ({ result: result ?? null }));
  });
  const dialog = page.getByRole('dialog', { name: 'Summary dialog' });
  await dialog.waitFor();
  await page.frameLocator('dialog.page-dialog iframe').locator('#message[data-data="invented"]').waitFor();
  await dialog.getByRole('button', { name: 'Close' }).click();
  assert.deepEqual(await page.evaluate(() => window.pageClosed), { result: null });
  // navigateTo: an existing record closed in a dialog resolves with no value.
  await page.evaluate(() => {
    window.saved = window.Xrm.Navigation.navigateTo(
      { pageType: 'entityrecord', entityName: 'x_item', entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { target: 2, position: 2, title: 'Side record' },
    ).then((result) => ({ result: result ?? null }));
  });
  await page
    .frameLocator('dialog.page-dialog.side iframe')
    .getByRole('heading', { name: 'Silver', exact: true })
    .waitFor();
  await page.getByRole('dialog', { name: 'Side record' }).getByRole('button', { name: 'Close' }).first().click();
  assert.deepEqual(await page.evaluate(() => window.saved), { result: null });
  // A record opened in create mode resolves with savedEntityReference once it was saved.
  await page.evaluate(() => {
    window.created = window.Xrm.Navigation.navigateTo(
      { pageType: 'entityrecord', entityName: 'x_item' },
      { target: 2, title: 'New record' },
    );
  });
  const created = page.frameLocator('dialog.page-dialog iframe');
  await created.getByLabel('Name', { exact: true }).fill('Bronze');
  await created
    .getByRole('toolbar', { name: 'Commands', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await created.getByRole('heading', { name: 'Bronze', exact: true }).waitFor();
  await page.getByRole('dialog', { name: 'New record' }).getByRole('button', { name: 'Close' }).first().click();
  const saved = await page.evaluate(() => window.created);
  assert.deepEqual(
    saved.savedEntityReference.map((reference) => [reference.entityType, reference.name]),
    [['x_item', 'Bronze']],
  );
  assert.match(saved.savedEntityReference[0].id, /^\{[0-9a-f-]{36}\}$/);
  assert.deepEqual(
    await page.evaluate(() =>
      window.Xrm.Navigation.navigateTo({ pageType: 'custom', name: 'x_missing_page' }).then(
        () => 'opened',
        (error) => [error.code, error.message],
      ),
    ),
    [
      'CustomPageNotFound',
      'Custom page x_missing_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).',
    ],
  );
  // A canvas app the host holds is still not a page of this app unless the app includes it.
  assert.deepEqual(
    await page.evaluate(() =>
      window.Xrm.Navigation.navigateTo({ pageType: 'custom', name: 'x_other_page' }).then(
        () => 'opened',
        (error) => [error.code, error.message],
      ),
    ),
    ['CustomPageNotFound', 'Custom page x_other_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).'],
  );
  // Inline with record context: the page's formulas read recordId and entityName through Param.
  await page.evaluate(() =>
    window.Xrm.Navigation.navigateTo(
      {
        pageType: 'custom',
        name: 'x_invented_page',
        entityName: 'x_item',
        recordId: '{AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA}',
      },
      { target: 1 },
    ),
  );
  await page.getByRole('status').filter({ hasText: 'This custom page is not rendered locally.' }).waitFor();
  assert.match(
    page.url(),
    /pagetype=custom&name=x_invented_page&entityName=x_item&recordId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/,
  );
  const screen = JSON.parse(
    await page.getByRole('region', { name: 'Current screen', exact: true }).locator('pre').textContent(),
  );
  assert.deepEqual([screen.screen, screen.controls.ItemLabel.Text], ['PageScreen', 'Item Copper']);
  const variables = JSON.parse(
    await page.getByRole('region', { name: 'Variables', exact: true }).locator('pre').textContent(),
  );
  assert.deepEqual([variables.fxRecord, variables.fxEntity], ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x_item']);
  // The route of a missing page answers the same error in the shell.
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=custom&name=x_missing_page');
  await page
    .getByRole('status')
    .filter({ hasText: 'Custom page x_missing_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).' })
    .waitFor();
  assert.deepEqual(errors, []);
});

test('Xrm.App.sidePanes hosts pages beside the workspace and closes them', async (t) => {
  const { page, origin, errors } = await fixture(t, { readOnly: true });
  await openRecord(page, origin);
  await page.evaluate(async () => {
    const pane = await window.Xrm.App.sidePanes.createPane({ title: 'Invented pane', paneId: 'invented' });
    await pane.navigate({ pageType: 'entitylist', entityName: 'x_item' });
  });
  const pane = page.getByRole('region', { name: 'Invented pane' });
  await page.frameLocator('.side-pane iframe').getByText('Silver', { exact: true }).waitFor();
  assert.equal(await pane.isVisible(), true);
  assert.equal(await page.evaluate(() => window.Xrm.App.sidePanes.getAllPanes().getLength()), 1);
  // sidePanes.state: 0 collapsed, 1 expanded; the value read is the value set.
  // formContext.getControl: a header column is the control header_<column>; it is not rendered locally, so changes refuse by name.
  assert.deepEqual(
    await page.evaluate(() => {
      const control = window.Xrm.Page.getControl('header_x_quantity');
      let refused;
      try {
        control.setVisible(false);
      } catch (error) {
        refused = error.message;
      }
      return [
        control.getName(),
        control.getAttribute().getName(),
        window.Xrm.Page.getAttribute('x_quantity').controls.getLength(),
        /header control header_x_quantity/.test(refused),
      ];
    }),
    ['header_x_quantity', 'x_quantity', 2, true],
  );
  assert.deepEqual(
    await page.evaluate(() => {
      const panes = window.Xrm.App.sidePanes,
        before = panes.state;
      panes.state = 0;
      const collapsed = panes.state;
      panes.state = 1;
      return [before, collapsed, panes.state];
    }),
    [1, 0, 1],
  );
  await page.evaluate(() => window.Xrm.App.sidePanes.getPane('invented').close());
  assert.equal(await page.locator('.side-pane').count(), 0);
  assert.equal(await page.evaluate(() => window.Xrm.App.sidePanes.getSelectedPane()), undefined);
  assert.deepEqual(errors, []);
});

test('a closed side pane refuses navigation before changing its detached frame or a replacement pane', async (t) => {
  const { page, origin, errors } = await fixture(t, { readOnly: true });
  await openRecord(page, origin);
  const result = await page.evaluate(async () => {
    const panes = window.Xrm.App.sidePanes;
    const closed = await panes.createPane({ paneId: 'reused-id', title: 'Closed pane' });
    const frame = document.querySelector('.side-pane iframe');
    const before = frame.getAttribute('src');
    closed.close();
    const replacement = await panes.createPane({ paneId: 'reused-id', title: 'Replacement pane' });
    const outcome = closed.navigate({ pageType: 'entitylist', entityName: 'x_item' }).then(
      () => 'resolved',
      (error) => error.code,
    );
    // A stale browser load must not turn a disposed handle back into a live pane.
    frame.dispatchEvent(new Event('load'));
    return {
      outcome: await outcome,
      unchanged: frame.getAttribute('src') === before,
      replacementSelected: panes.getSelectedPane() === replacement,
      panes: panes.getAllPanes().getLength(),
    };
  });
  assert.deepEqual(result, { outcome: 'PaneClosed', unchanged: true, replacementSelected: true, panes: 1 });
  assert.deepEqual(errors, []);
});

test('closing a pane rejects in-flight navigation and releases stale frame load handlers', async (t) => {
  const { page, origin, errors } = await fixture(t, { readOnly: true });
  await openRecord(page, origin);
  const result = await page.evaluate(async () => {
    const panes = window.Xrm.App.sidePanes;
    const pane = await panes.createPane({ paneId: 'pending-pane' });
    const frame = document.querySelector('.side-pane iframe');
    const outcomes = [
      pane.navigate({ pageType: 'entitylist', entityName: 'x_item' }),
      pane.navigate({ pageType: 'entityrecord', entityName: 'x_item' }),
    ].map((pending) =>
      pending.then(
        () => 'resolved',
        (error) => error.code,
      ),
    );
    pane.close();
    frame.dispatchEvent(new Event('load'));
    const replacement = await panes.createPane({ paneId: 'pending-pane' });
    return {
      outcomes: await Promise.all(outcomes),
      replacementSelected: panes.getSelectedPane() === replacement,
      panes: panes.getAllPanes().getLength(),
    };
  });
  assert.deepEqual(result, { outcomes: ['PaneClosed', 'PaneClosed'], replacementSelected: true, panes: 1 });
  assert.deepEqual(errors, []);
});

test('side pane selection expands the group and clears badges unless retained', async (t) => {
  const { page, origin, errors } = await fixture(t, { readOnly: true });
  await openRecord(page, origin);
  assert.deepEqual(
    await page.evaluate(async () => {
      const panes = window.Xrm.App.sidePanes;
      const first = await panes.createPane({ paneId: 'first', title: 'First pane' });
      first.badge = 4;
      panes.state = 0;
      const second = await panes.createPane({
        paneId: 'second',
        title: 'Second pane',
        isSelected: false,
        keepBadgeOnSelect: true,
      });
      second.badge = 2;
      const background = [panes.getSelectedPane().paneId, panes.state, first.badge, second.badge];
      second.select();
      const selected = [panes.getSelectedPane().paneId, panes.state, second.badge];
      panes.state = 0;
      first.select();
      return { background, selected, restored: [panes.getSelectedPane().paneId, panes.state, first.badge] };
    }),
    { background: ['first', 0, 4, 2], selected: ['second', 1, 2], restored: ['first', 1, null] },
  );
  assert.equal(await page.getByRole('region', { name: 'First pane', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('region', { name: 'Second pane', exact: true }).isVisible(), false);
  // Creating a foreground pane also expands a previously collapsed group.
  await page.evaluate(async () => {
    window.Xrm.App.sidePanes.state = 0;
    await window.Xrm.App.sidePanes.createPane({ paneId: 'foreground', title: 'Foreground pane' });
  });
  assert.equal(await page.getByRole('region', { name: 'Foreground pane', exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
});

test('explicit source form selection refuses unavailable forms without substituting a default', async (t) => {
  const { page, origin, errors } = await fixture(t, { readOnly: true });
  const route =
    origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.goto(route + '&formid=not-imported');
  await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.mirageAppState));
  assert.equal(await page.locator('html').getAttribute('data-mirage-app-state'), 'error');
  assert.match(await page.locator('#notice').textContent(), /requested form.*unavailable/i);
  assert.equal(await page.locator('#record-form').count(), 0, 'no different source form is rendered');
  for (const suffix of ['&formid=%7BITEM-FORM%7D', '']) {
    await page.goto(route + suffix);
    await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && window.Xrm?.Page);
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Copper');
    assert.equal(await page.evaluate(() => window.Xrm.Page.ui.formSelector.getCurrentItem().getId()), '{item-form}');
  }
  const refusal = await page.evaluate(async () => {
    const pane = await window.Xrm.App.sidePanes.createPane({ paneId: 'source-form', title: 'Source form' });
    await pane.navigate({ pageType: 'entityrecord', entityName: 'x_item', formId: '{ITEM-FORM}' });
    const frame = document.querySelector('.side-pane[data-pane-id="source-form"] iframe');
    const before = frame.getAttribute('src');
    let code;
    try {
      await pane.navigate({ pageType: 'entityrecord', entityName: 'x_item', formId: 'not-imported' });
    } catch (error) {
      code = error.code;
    }
    return { code, unchanged: before === frame.getAttribute('src') };
  });
  assert.deepEqual(refusal, { code: 'FormUnavailable', unchanged: true });
  assert.deepEqual(errors, []);
});

test('a reused record pane follows current and newly supplied record context, source form and named tab', async (t) => {
  const { page, origin, errors } = await fixture(t, { readOnly: true });
  await openRecord(page, origin);
  await page.evaluate(async () => {
    const form = window.Xrm.Page,
      panes = window.Xrm.App.sidePanes;
    const pane = await panes.createPane({ paneId: 'record-context', title: 'Record context' });
    await pane.navigate({
      pageType: 'entityrecord',
      entityName: form.data.entity.getEntityName(),
      entityId: form.data.entity.getId(),
      formId: form.ui.formSelector.getCurrentItem().getId(),
      tabName: 'related',
    });
  });
  const frame = page.frameLocator('.side-pane[data-pane-id="record-context"] iframe');
  await frame.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  await frame.getByText('Rows: Copper child', { exact: true }).waitFor();
  await frame.locator('html[data-mirage-app-state="ready"]').waitFor();
  assert.equal(
    await frame.getByRole('tab', { name: 'Related items', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  assert.equal(
    await frame
      .getByRole('tab', { name: 'Related items', exact: true })
      .evaluate((node) => node === node.ownerDocument.activeElement),
    true,
  );
  await page.evaluate(async () => {
    const pane = window.Xrm.App.sidePanes.getPane('record-context');
    await pane.navigate({
      pageType: 'entityrecord',
      entityName: 'x_item',
      entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      formId: 'item-form',
      tabName: 'general',
      data: { x_name: 'Ignored existing-row default' },
    });
    pane.select();
  });
  await frame.getByRole('heading', { name: 'Silver', exact: true }).waitFor();
  assert.equal(await frame.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Silver');
  assert.equal(await frame.getByRole('tab', { name: 'General', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.side-pane[data-pane-id="record-context"]').count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'Copper', exact: true }).count(), 1);
  await page.evaluate(async () => {
    await window.Xrm.App.sidePanes.getPane('record-context').navigate({
      pageType: 'entityrecord',
      entityName: 'x_item',
      formId: 'item-form',
      tabName: 'general',
      data: { x_name: 'Invented unsaved default' },
    });
  });
  await frame.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
  assert.equal(
    await frame.getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    'Invented unsaved default',
  );
  await page.evaluate(async () => {
    await window.Xrm.App.sidePanes
      .getPane('record-context')
      .navigate({ pageType: 'entitylist', entityName: 'x_item', viewId: 'items-view', viewType: 'savedquery' });
  });
  await frame.locator('html[data-mirage-app-state="ready"]').waitFor();
  assert.deepEqual(
    await frame.locator('html').evaluate(() => {
      const context = window.Xrm.Utility.getPageContext().input;
      return [context.pageType, context.entityName, context.viewId, context.viewType];
    }),
    ['entitylist', 'x_item', 'items-view', 'savedquery'],
  );
  const before = await page.locator('.side-pane[data-pane-id="record-context"] iframe').getAttribute('src');
  const refused = await page.evaluate(async () => {
    try {
      await window.Xrm.App.sidePanes
        .getPane('record-context')
        .navigate({ pageType: 'entitylist', entityName: 'x_item', viewId: 'items-view', viewType: 'userquery' });
    } catch (error) {
      return error.code;
    }
  });
  assert.equal(refused, 'PersonalViewUnsupported');
  assert.equal(await page.locator('.side-pane[data-pane-id="record-context"] iframe').getAttribute('src'), before);
  assert.deepEqual(errors, []);
});

test('side panes respect hidden headers and visibility, and allow programmatic close without a close button', async (t) => {
  const { page, origin, errors } = await fixture(t, { readOnly: true });
  await openRecord(page, origin);
  await page.evaluate(async () => {
    const panes = window.Xrm.App.sidePanes;
    await panes.createPane({ paneId: 'retained', title: 'Retained pane', canClose: false });
    const hidden = await panes.createPane({ paneId: 'hidden', title: 'Hidden pane', hideHeader: true, hidden: true });
    hidden.title = 'Renamed pane';
  });
  const renamed = page.locator('.side-pane[data-pane-id="hidden"]');
  assert.equal(await renamed.isVisible(), false);
  await page.evaluate(() => {
    window.Xrm.App.sidePanes.getPane('hidden').hidden = false;
  });
  assert.equal(await renamed.isVisible(), true);
  assert.equal(await renamed.getAttribute('aria-label'), 'Renamed pane');
  assert.equal(await renamed.locator('iframe').getAttribute('title'), 'Renamed pane');
  assert.equal(await renamed.locator('.page-dialog-heading').isVisible(), false);
  assert.equal(await page.locator('.side-pane[data-pane-id="retained"] button').count(), 0);
  await page.evaluate(() => window.Xrm.App.sidePanes.getPane('hidden').close());
  assert.equal(await page.getByRole('region', { name: 'Retained pane', exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => window.Xrm.App.sidePanes.getSelectedPane().paneId), 'retained');
  await page.evaluate(() => window.Xrm.App.sidePanes.getPane('retained').close());
  assert.equal(await page.locator('#side-panes').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('generated side pane ids survive close and explicit ids, and a repeated close cannot remove another pane', async (t) => {
  const { page, origin, errors } = await fixture(t, { readOnly: true });
  await openRecord(page, origin);
  const result = await page.evaluate(async () => {
    const panes = window.Xrm.App.sidePanes;
    await panes.createPane({ paneId: 'pane-1' });
    const first = await panes.createPane();
    const second = await panes.createPane();
    first.close();
    const third = await panes.createPane();
    first.close();
    first.select();
    let duplicate;
    try {
      await panes.createPane({ paneId: second.paneId });
    } catch (error) {
      duplicate = error.message;
    }
    return {
      ids: panes
        .getAllPanes()
        .get()
        .map((pane) => pane.paneId),
      generated: [first.paneId, second.paneId, third.paneId],
      selected: panes.getSelectedPane().paneId,
      duplicate,
    };
  });
  assert.equal(new Set(['pane-1', ...result.generated]).size, 4);
  assert.deepEqual(result.ids, ['pane-1', result.generated[1], result.generated[2]]);
  assert.equal(result.selected, result.generated[2]);
  assert.match(result.duplicate, /already exists/);
  assert.deepEqual(errors, []);
});

test('a dataset component on a related subgrid receives the parent rows and the staff context', async (t) => {
  const { page, origin, errors } = await fixture(t, { readOnly: true });
  await openRecord(page, origin);
  await page.getByRole('tab', { name: 'Related items' }).click();
  await page.getByText('Rows: Copper child', { exact: true }).waitFor();
  const context = await page.evaluate(() => ({
    entity: window.gridContext.parameters.records.getTargetEntityType(),
    total: window.gridContext.parameters.records.paging.totalResultCount,
    roles: window.gridContext.userSettings.securityRoles.length,
    language: window.gridContext.userSettings.languageId,
    xrmRoles: window.Xrm.Utility.getGlobalContext().userSettings.securityRoles,
  }));
  assert.equal(context.entity, 'x_child');
  assert.equal(context.total, 1);
  assert.equal(context.language, 1033);
  assert.ok(context.roles > 0, 'the local administrator context carries its organization role ids');
  assert.equal(context.xrmRoles.length, context.roles);
  assert.deepEqual(errors, []);
});
