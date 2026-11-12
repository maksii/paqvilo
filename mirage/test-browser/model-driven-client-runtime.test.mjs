// @test-kind unproven: mixed model-driven form, lifecycle, navigation and rendered UI guarantees; individually reproduced assertions have protected parity regions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser, appOrigins, appsOrigin } from './shared-browser.mjs';

const chrome = sharedBrowser();

const script = `var InventedClient = {
  async load(executionContext) {
    await Promise.resolve(); window.clientLoads=(window.clientLoads||0)+1;
    var form=executionContext.getFormContext(); form.getControl('x_quantity').setLabel('Calculated quantity'); form.getControl('x_quantity').setVisible(true);
    form.ui.setFormNotification('Exported OnLoad completed','INFO','loaded');
  },
  async change(executionContext) {
    await Promise.resolve(); var form=executionContext.getFormContext();
    form.getAttribute('x_quantity').setValue(form.getAttribute('x_name').getValue().length);
  },
  save(executionContext) {
    var form=executionContext.getFormContext();
    if(form.getAttribute('x_name').getValue()==='BLOCK') { executionContext.getEventArgs().preventDefault(); form.ui.setFormNotification('Choose a different name','ERROR','validation'); }
    else form.ui.clearFormNotification('validation');
  },
  async mark(form) {
    var result=await Xrm.WebApi.retrieveRecord('x_item',form.data.entity.getId(),'?$select=x_quantity');
    form.getAttribute('x_name').setValue('Reviewed '+result.x_quantity); await form.data.save();
  },
  unsupported(form) { form.ui.nonexistentApi(); }
};`;

async function fixture(t, trusted = true) {
  const initial = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: trusted } });
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  let xml = await fs.readFile(formFile, 'utf8');
  xml = xml.replace('<control datafieldname="x_quantity"', '<control visible="false" datafieldname="x_quantity"');
  xml = xml.replace(
    '</form>',
    '<formLibraries><Library name="x_/client.js"/></formLibraries><events><event name="onload"><Handlers><Handler libraryName="x_/client.js" functionName="InventedClient.load" enabled="true" passExecutionContext="true"/></Handlers></event><event name="onchange" attribute="x_name"><Handlers><Handler libraryName="x_/client.js" functionName="InventedClient.change" enabled="true" passExecutionContext="true"/></Handlers></event><event name="onsave"><Handlers><Handler libraryName="x_/client.js" functionName="InventedClient.save" enabled="true" passExecutionContext="true"/></Handlers></event></events></form>',
  );
  await fs.writeFile(formFile, xml);
  await fs.mkdir(path.join(initial.solutionDir, 'WebResources'), { recursive: true });
  await fs.writeFile(path.join(initial.solutionDir, 'WebResources/client.js'), script);
  await fs.writeFile(
    path.join(initial.solutionDir, 'WebResources/client.js.data.xml'),
    '<WebResource><WebResourceId>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</WebResourceId><Name>x_/client.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/client.js</FileName></WebResource>',
  );
  await fs.mkdir(path.join(initial.solutionDir, 'AppActions/x_early'), { recursive: true });
  await fs.writeFile(
    path.join(initial.solutionDir, 'AppActions/x_early/AppAction.xml'),
    '<appaction uniquename="x_early"><buttonlabeltext default="Early reviewed"/><context>1</context><contextvalue>x_item</contextvalue><location>0</location><sequence>0.0000000000</sequence><onclickeventjavascriptfunctionname>InventedClient.mark</onclickeventjavascriptfunctionname><onclickeventjavascriptparameters>[{"type":5,"value":null}]</onclickeventjavascriptparameters><onclickeventjavascriptwebresourceid><webresourceid>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</webresourceid></onclickeventjavascriptwebresourceid><onclickeventtype>2</onclickeventtype><type>0</type></appaction>',
  );
  await fs.writeFile(
    path.join(initial.solutionDir, 'Entities/x_item/RibbonDiff.xml'),
    '<RibbonDiffXml><CustomActions><CustomAction><CommandUIDefinition><Button Id="x.Form.Mark" Command="x.Mark" LabelText="Mark reviewed"/></CommandUIDefinition></CustomAction><CustomAction><CommandUIDefinition><Button Id="x.Form.Unsupported" Command="x.Unsupported" LabelText="Unsupported API"/></CommandUIDefinition></CustomAction><CustomAction><CommandUIDefinition><Button Id="x.Form.Remote" Command="x.Remote" LabelText="Unsupported remote action"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="x.Mark"><EnableRules><EnableRule Id="x.Existing"/></EnableRules><Actions><JavaScriptFunction Library="$webresource:x_/client.js" FunctionName="InventedClient.mark"><CrmParameter Value="PrimaryControl"/></JavaScriptFunction></Actions></CommandDefinition><CommandDefinition Id="x.Unsupported"><Actions><JavaScriptFunction Library="$webresource:x_/client.js" FunctionName="InventedClient.unsupported"><CrmParameter Value="PrimaryControl"/></JavaScriptFunction></Actions></CommandDefinition><CommandDefinition Id="x.Remote"><Actions><Url Address="https://example.invalid"/></Actions></CommandDefinition></CommandDefinitions><RuleDefinitions><EnableRules><EnableRule Id="x.Existing"><FormStateRule State="Existing"/></EnableRule></EnableRules></RuleDefinitions></RibbonDiffXml>',
  );
  const sim = await initial.start();
  sim.origin = sim.origin ?? sim.url;
  const page = await chrome.page(t);
  const errors = [],
    external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!appOrigins(sim, sim.origin).includes(new URL(request.url()).origin)) external.push(request.url());
  });
  await page.goto(
    appsOrigin(sim, sim.origin) +
      '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  return { page, sim, errors, external };
}

/** Starts the fixture's simulator and opens the Copper record once the client runtime and Xrm are ready. */
async function openReadyRecord(t, initial) {
  const sim = await initial.start();
  sim.origin = sim.origin ?? sim.url;
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    appsOrigin(sim, sim.origin) +
      '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  return { sim, page, errors };
}

// Native command bars move trailing source actions into More as the workspace narrows.
async function formCommand(page, name) {
  const popup = page.getByRole('menu', { name: 'More commands', exact: true });
  if (await popup.isVisible()) await page.keyboard.press('Escape');
  const direct = page
    .getByRole('toolbar', { name: 'Commands', exact: true })
    .getByRole('button', { name, exact: true });
  if (await direct.isVisible()) return direct;
  await page.getByRole('button', { name: 'More commands', exact: true }).click();
  return page.getByRole('menuitem', { name, exact: true });
}

test('Solution form events and ribbon JS run locally through the staff API with save cancellation', async (t) => {
  const { page, sim, errors, external } = await fixture(t);
  await page.getByText('Exported OnLoad completed', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Calculated quantity', { exact: true }).inputValue(), '2');
  assert.equal(await page.evaluate(() => window.clientLoads), 1);
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('button', { name: 'Copper child', exact: true }).waitFor();
  assert.equal(
    await page.getByText('Exported OnLoad completed', { exact: true }).isVisible(),
    true,
    'form notifications persist across tab changes',
  );
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.getByLabel('Calculated quantity', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.clientLoads), 1, 'tab switches do not replay OnLoad');
  const notificationTop = await page
    .locator('#form-notifications')
    .evaluate((node) => node.getBoundingClientRect().top);
  const commandTop = await page
    .getByRole('toolbar', { name: 'Commands', exact: true })
    .evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(notificationTop < commandTop, 'source notifications sit above the command bar');
  await page.getByLabel('Name', { exact: true }).fill('BLOCK');
  await page.getByLabel('Calculated quantity', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name=x_quantity]').value === '5');
  await (await formCommand(page, 'Save')).click();
  await page.getByText('Choose a different name', { exact: true }).waitFor();
  const unchanged = await (
    await fetch(appsOrigin(sim, sim.origin) + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  ).json();
  assert.equal(unchanged.row.x_name, 'Copper');
  assert.equal(unchanged.row.x_quantity, 2);
  await page.getByLabel('Name', { exact: true }).fill('Silver local');
  await page.getByLabel('Calculated quantity', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name=x_quantity]').value === '12');
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('heading', { name: 'Silver local', exact: true }).waitFor();
  assert.equal(
    await page.getByText('Choose a different name', { exact: true }).count(),
    0,
    'clearing the notification removes its persisted banner',
  );
  await (await formCommand(page, 'Mark reviewed')).click();
  await page.getByRole('heading', { name: 'Reviewed 12', exact: true }).waitFor();
  assert.equal(await (await formCommand(page, 'Unsupported remote action')).isDisabled(), true);
  await (await formCommand(page, 'Unsupported API')).click();
  await page.getByRole('status').filter({ hasText: 'does not support formContext.ui.nonexistentApi' }).waitFor();
  // A handler may navigate. Completion of the disposed form must not overwrite
  // the newly selected record or retain executable form-context references.
  await page.evaluate(() => {
    window.priorControl = window.Xrm.Page.getControl('x_name');
    window.InventedClient.load = async () => {
      if (!window.didRedirect) {
        window.didRedirect = true;
        await window.Xrm.Navigation.openForm({
          entityName: 'x_child',
          entityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        });
      }
    };
  });
  await (await formCommand(page, 'Refresh')).click();
  await page.getByRole('heading', { name: 'Copper child', exact: true }).waitFor();
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Copper child');
  assert.equal(
    await page.getByText('Exported OnLoad completed', { exact: true }).count(),
    0,
    'navigation disposes the previous form notifications',
  );
  assert.match(
    await page.evaluate(() => {
      try {
        window.priorControl.setVisible(false);
        return 'unexpected';
      } catch (error) {
        return error.message;
      }
    }),
    /disposed/,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

test('retry recreates failed client initialization and clears its error after recovery', async (t) => {
  const { page, errors } = await fixture(t);
  await page.getByText('Exported OnLoad completed', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.InventedClient.load = async (executionContext) => {
      window.retryLoads = (window.retryLoads ?? 0) + 1;
      if (window.retryLoads === 1) throw new Error('Invented first-load failure');
      executionContext.getFormContext().ui.setFormNotification('Recovered form initialization', 'INFO', 'recovered');
    };
  });
  await (await formCommand(page, 'Refresh')).click();
  await page.getByRole('status').filter({ hasText: 'Invented first-load failure' }).waitFor();
  assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'false');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText('Recovered form initialization', { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  assert.equal(await page.evaluate(() => window.retryLoads), 2);
  assert.equal(await page.locator('#notice').isVisible(), false);
  assert.equal(await page.locator('#record-form').evaluate((node) => node.inert), false);
  await page.getByLabel('Name', { exact: true }).fill('Recovered editable record');
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('heading', { name: 'Recovered editable record', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('a source zero-sequence modern form command precedes standard actions and executes its imported handler', async (t) => {
  const { page, sim, errors } = await fixture(t);
  await page.getByText('Exported OnLoad completed', { exact: true }).waitFor();
  const labels = await page
    .getByRole('toolbar', { name: 'Commands', exact: true })
    .locator('button')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent.trim()));
  assert.ok(labels.indexOf('Early reviewed') > labels.indexOf('Open in new window'));
  assert.equal(labels.includes('Open in VSCode'), false);
  assert.ok(labels.indexOf('Early reviewed') < labels.indexOf('Save'));
  await (await formCommand(page, 'Early reviewed')).click();
  await page.getByRole('heading', { name: 'Reviewed 2', exact: true }).waitFor();
  const row = await (
    await fetch(appsOrigin(sim, sim.url) + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  ).json();
  assert.equal(row.row.x_name, 'Reviewed 2');
  assert.equal(row.row.x_quantity, 2);
  assert.deepEqual(errors, []);
});

test('a staff change in another tab revokes extension contexts while retaining the blocked draft', async (t) => {
  const { page, sim, errors } = await fixture(t);
  await page.getByText('Exported OnLoad completed', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.priorControl = window.Xrm.Page.getControl('x_name');
    window.priorWebApi = window.Xrm.WebApi;
  });
  await page.getByLabel('Name', { exact: true }).fill('Unsaved draft');
  const context = page.context();
  const made = await context.request.post(sim.origin + '/_sim/api/dataverse/users', {
    headers: { 'x-sim-csrf': sim.state().csrf },
    data: {
      fullname: 'Invented replacement staff',
      domainname: 'replacement@example.test',
      roles: ['System Administrator'],
    },
  });
  assert.equal(made.status(), 201);
  const staff = await made.json();
  const selected = await context.request.post(sim.origin + '/_sim/api/dataverse/session', {
    headers: { 'x-sim-csrf': sim.state().csrf },
    data: { userId: staff.systemuserid },
  });
  assert.equal(selected.status(), 200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('status').filter({ hasText: 'The staff session changed in another tab.' }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved draft');
  assert.equal(await page.getByLabel('Name', { exact: true }).isDisabled(), true);
  assert.match(
    await page.evaluate(() => {
      try {
        window.priorControl.setVisible(false);
        return 'unexpected';
      } catch (error) {
        return error.message;
      }
    }),
    /disposed/,
  );
  const webApiRequests = [];
  const countWebApiRequest = (request) => {
    if (request.url().startsWith(appsOrigin(sim, sim.origin) + '/_apps/api/')) webApiRequests.push(request.url());
  };
  page.on('request', countWebApiRequest);
  const revoked = await page.evaluate(() =>
    window.priorWebApi.createRecord('x_item', { x_name: 'stale' }).then(
      () => 'resolved',
      (error) => error.message,
    ),
  );
  page.off('request', countWebApiRequest);
  assert.match(revoked, /disposed/);
  assert.deepEqual(webApiRequests, [], 'a revoked context sends no Web API request');
  assert.deepEqual(errors, []);
});

test('Solution code stays inert by default while ordinary CRUD continues to work', async (t) => {
  const { page, sim, errors } = await fixture(t, false);
  assert.equal(await page.evaluate(() => typeof InventedClient), 'undefined');
  assert.equal(await (await formCommand(page, 'Mark reviewed')).isDisabled(), true);
  await page.getByLabel('Name', { exact: true }).fill('BLOCK');
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('heading', { name: 'BLOCK', exact: true }).waitFor();
  const result = await (
    await fetch(appsOrigin(sim, sim.origin) + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  ).json();
  assert.equal(result.row.x_name, 'BLOCK');
  assert.deepEqual(errors, []);
});

test('application form and view components select the authored surface before generic table defaults', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true });
  const appFile = path.join(initial.solutionDir, 'AppModules/x_example/AppModule.xml');
  await fs.writeFile(
    appFile,
    (await fs.readFile(appFile, 'utf8')).replace(
      '</AppModuleComponents>',
      '<AppModuleComponent type="60" id="{item-form}"/><AppModuleComponent type="26" id="{items-view}"/></AppModuleComponents>',
    ),
  );
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    path.join(path.dirname(formFile), '0-excluded.xml'),
    (await fs.readFile(formFile, 'utf8'))
      .replace('{item-form}', '{excluded-form}')
      .replace('description="Information"', 'description="Excluded form"')
      .replace('description="Name"', 'description="Excluded name"'),
  );
  const viewFile = path.join(initial.solutionDir, 'Entities/x_item/SavedQueries/items.xml');
  await fs.writeFile(
    path.join(path.dirname(viewFile), '0-excluded.xml'),
    (await fs.readFile(viewFile, 'utf8'))
      .replace('{items-view}', '{excluded-view}')
      .replace('Stocked items', 'Excluded view'),
  );
  const sim = await initial.start();
  const page = await chrome.page(t);
  await page.goto(appsOrigin(sim, sim.url) + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  assert.deepEqual(
    await page
      .getByRole('menuitemradio')
      .evaluateAll((nodes) => nodes.map((node) => node.querySelector('span:not(.picker-check)').textContent)),
    ['Stocked items'],
  );
  await page.keyboard.press('Escape');
  await page.locator('tbody').getByRole('button', { name: 'Copper', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Record form', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Excluded name', { exact: true }).count(), 0);
});

test('form deep links, picker changes, saves and Xrm openForm preserve the selected app-owned form', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true });
  const reviewId = 'b1168cab-0940-40f2-a83a-f79675751ade',
    excludedId = '1603bd23-cd05-4ca3-a16f-31503d42359a';
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml'),
    xml = await fs.readFile(formFile, 'utf8');
  await fs.writeFile(
    path.join(path.dirname(formFile), 'review.xml'),
    xml
      .replace('{item-form}', `{${reviewId}}`)
      .replace('description="Information"', 'description="Review form"')
      .replace('description="General"', 'description="Review details"'),
  );
  await fs.writeFile(
    path.join(path.dirname(formFile), 'excluded.xml'),
    xml.replace('{item-form}', `{${excludedId}}`).replace('description="Information"', 'description="Excluded form"'),
  );
  const appFile = path.join(initial.solutionDir, 'AppModules/x_example/AppModule.xml');
  await fs.writeFile(
    appFile,
    (await fs.readFile(appFile, 'utf8')).replace(
      '</AppModuleComponents>',
      `<AppModuleComponent type="60" id="{item-form}"/><AppModuleComponent type="60" id="{${reviewId}}"/></AppModuleComponents>`,
    ),
  );
  const sim = await initial.start();
  const page = await chrome.page(t),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const route =
    appsOrigin(sim, sim.url) +
    '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.goto(route + '&formid=' + encodeURIComponent(`{${reviewId.toUpperCase()}}`));
  await page.getByRole('tab', { name: 'Review details', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('formid'), reviewId);
  const formGeometry = await page.getByRole('button', { name: 'Record form', exact: true }).evaluate((node) => {
    const picker = node.getBoundingClientRect(),
      label = node.parentElement.querySelector('small').getBoundingClientRect();
    return { gap: picker.left - label.right, vertical: Math.abs(picker.top - label.top) };
  });
  assert.ok(formGeometry.gap >= 8 && formGeometry.gap <= 28, 'the form selector follows the entity label inline');
  assert.ok(formGeometry.vertical <= 8);
  await page.getByLabel('Name', { exact: true }).fill('Draft across forms');
  await page.getByRole('button', { name: 'Record form', exact: true }).click();
  assert.equal(await page.locator('.form-picker').evaluate((node) => node.getBoundingClientRect().width), 203);
  assert.equal(await page.locator('.form-picker [role=menuitemradio]').first().getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('menuitemradio', { name: 'Excluded form', exact: true }).count(), 0);
  await page.getByRole('menuitemradio', { name: 'Information', exact: true }).click();
  await page.getByRole('tab', { name: 'General', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Draft across forms');
  assert.equal(new URL(page.url()).searchParams.get('formid'), 'item-form');
  await page.getByRole('button', { name: 'Record form', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Review form', exact: true }).click();
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('formid'), reviewId);
  await page.reload();
  await page.getByRole('tab', { name: 'Review details', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Draft across forms');
  await page.goto(appsOrigin(sim, sim.url) + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.locator('tbody').getByRole('button', { name: 'Draft across forms', exact: true }).click();
  await page.getByRole('tab', { name: 'Review details', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Record form', exact: true }).innerText(),
    'Review form',
    'opening a row without formid remembers the selected eligible form for this app and table',
  );
  await page.goto(route + '&formid=' + excludedId);
  await page.getByRole('tab', { name: 'General', exact: true }).waitFor();
  assert.equal(
    new URL(page.url()).searchParams.get('formid'),
    'item-form',
    'excluded form IDs fall back to a form belonging to the app',
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  await page.evaluate(async (formId) => {
    await window.Xrm.Navigation.openForm({
      entityName: 'x_item',
      entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      formId,
    });
  }, reviewId);
  await page.getByRole('tab', { name: 'Review details', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('formid'), reviewId);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Record form', exact: true }).click();
  const mobile = await page.locator('.form-picker').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, document: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  assert.ok(mobile.left >= 12 && mobile.right <= mobile.viewport - 12);
  assert.equal(mobile.document, mobile.viewport);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
});

test('known excluded source forms fall back inside the app while genuinely missing source forms refuse', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true }),
    excludedId = '1603bd23-cd05-4ca3-a16f-31503d42359a';
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    path.join(path.dirname(formFile), 'excluded.xml'),
    (await fs.readFile(formFile, 'utf8'))
      .replace('{item-form}', `{${excludedId}}`)
      .replace('description="Information"', 'description="Excluded form"'),
  );
  const appFile = path.join(initial.solutionDir, 'AppModules/x_example/AppModule.xml');
  await fs.writeFile(
    appFile,
    (await fs.readFile(appFile, 'utf8')).replace(
      '</AppModuleComponents>',
      '<AppModuleComponent type="60" id="{item-form}"/></AppModuleComponents>',
    ),
  );
  const sim = await initial.start(),
    page = await chrome.page(t),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const route =
    appsOrigin(sim, sim.url) +
    '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ready = () =>
    page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && window.Xrm?.Page);
  // Each fresh route hydrates source metadata before deciding app eligibility.
  for (const requested of [`{${excludedId.toUpperCase()}}`, '{ITEM-FORM}', undefined]) {
    await page.goto(route + (requested === undefined ? '' : '&formid=' + encodeURIComponent(requested)));
    await ready();
    assert.equal(await page.getByRole('tab', { name: 'General', exact: true }).isVisible(), true);
    assert.equal(new URL(page.url()).searchParams.get('formid'), requested === undefined ? null : 'item-form');
    assert.equal(await page.evaluate(() => window.Xrm.Page.ui.formSelector.getCurrentItem().getId()), '{item-form}');
  }
  await page.evaluate(async (formId) => {
    const pane = await window.Xrm.App.sidePanes.createPane({ paneId: 'eligible-form', title: 'Eligible form' });
    await pane.navigate({
      pageType: 'entityrecord',
      entityName: 'x_item',
      entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      formId,
    });
  }, excludedId);
  const frame = page.frameLocator('.side-pane[data-pane-id="eligible-form"] iframe');
  await frame.locator('html[data-mirage-app-state="ready"]').waitFor();
  assert.equal(await frame.getByRole('tab', { name: 'General', exact: true }).isVisible(), true);
  assert.equal(
    await frame.locator('html').evaluate(() => new URL(location.href).searchParams.get('formid')),
    'item-form',
  );
  await page.goto(route + '&formid=missing-source-form');
  await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.mirageAppState));
  assert.equal(await page.locator('html').getAttribute('data-mirage-app-state'), 'error');
  assert.match(await page.locator('#notice').textContent(), /requested form.*unavailable/i);
  assert.equal(await page.locator('#record-form').count(), 0);
  assert.deepEqual(errors, []);
});

test('switching source forms clears stale explicit tab context before reload and preserves drafts through save', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true }),
    reviewId = 'b1168cab-0940-40f2-a83a-f79675751ade';
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    path.join(path.dirname(formFile), 'review.xml'),
    (await fs.readFile(formFile, 'utf8'))
      .replace('{item-form}', `{${reviewId}}`)
      .replace('description="Information"', 'description="Review form"')
      .replace('<tab name="general">', '<tab name="review-tab">')
      .replace('description="General"', 'description="Review details"'),
  );
  const appFile = path.join(initial.solutionDir, 'AppModules/x_example/AppModule.xml');
  await fs.writeFile(
    appFile,
    (await fs.readFile(appFile, 'utf8')).replace(
      '</AppModuleComponents>',
      `<AppModuleComponent type="60" id="{item-form}"/><AppModuleComponent type="60" id="{${reviewId}}"/></AppModuleComponents>`,
    ),
  );
  const sim = await initial.start(),
    page = await chrome.page(t),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const route =
    appsOrigin(sim, sim.url) +
    '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const openReview = async () => {
    await page.goto(route + `&formid=${reviewId}&tabname=review-tab`);
    await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && window.Xrm?.Page);
    assert.equal(
      await page.getByRole('tab', { name: 'Review details', exact: true }).getAttribute('aria-selected'),
      'true',
    );
  };
  const choose = async (name) => {
    await page.getByRole('button', { name: 'Record form', exact: true }).click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
  };
  await openReview();
  await choose('Review form');
  assert.equal(
    new URL(page.url()).searchParams.get('tabname'),
    'review-tab',
    'choosing the current form retains its explicit tab',
  );
  await choose('Information');
  await page.getByRole('tab', { name: 'General', exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.mirageAppState));
  assert.equal(await page.locator('html').getAttribute('data-mirage-app-state'), 'ready');
  assert.equal(await page.getByRole('tab', { name: 'General', exact: true }).isVisible(), true);
  assert.equal(new URL(page.url()).searchParams.has('tabname'), false);
  await openReview();
  await page.getByLabel('Name', { exact: true }).fill('Draft across form tabs');
  await choose('Information');
  await page.getByRole('tab', { name: 'General', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Draft across form tabs');
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && window.Xrm?.Page);
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Draft across form tabs');
  assert.equal(new URL(page.url()).searchParams.get('formid'), 'item-form');
  assert.equal(new URL(page.url()).searchParams.has('tabname'), false);
  assert.deepEqual(errors, []);
});

test('a persisted inactive two-state record disables its default UI while explicit client unlocks and SDK saves retain native behavior', async (t) => {
  // A record read is held later; release it before the fixture closes the page (t.after runs first in, first out).
  let releaseRead;
  const holdRead = new Promise((resolve) => {
    releaseRead = resolve;
  });
  t.after(() => releaseRead());
  const initial = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: true } });
  const entityFile = path.join(initial.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '</attributes>',
      '<attribute PhysicalName="statecode"><Name>statecode</Name><Type>state</Type><displaynames><displayname description="Status" languagecode="1033"/></displaynames><optionset Name="x_item_statecode"><OptionSetType>state</OptionSetType><states><state value="0" defaultstatus="1" invariantname="Active"><labels><label description="Active" languagecode="1033"/></labels></state><state value="1" defaultstatus="2" invariantname="Inactive"><labels><label description="Inactive" languagecode="1033"/></labels></state></states></optionset></attribute></attributes>',
    ),
  );
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '<Type>int</Type>',
      '<Type>int</Type><ValidForUpdateApi>0</ValidForUpdateApi>',
    ),
  );
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    formFile,
    (await fs.readFile(formFile, 'utf8'))
      .replace('<control datafieldname="x_name"', '<control disabled="true" datafieldname="x_name"')
      .replace(
        '<section name="children"><rows>',
        '<section name="children"><rows><row><cell><labels><label description="Status" languagecode="1033"/></labels><control datafieldname="statecode"/></cell></row>',
      ),
  );
  await fs.mkdir(path.join(initial.solutionDir, 'WebResources'), { recursive: true });
  await fs.writeFile(
    path.join(initial.solutionDir, 'WebResources/inactive.js'),
    'window.InactiveCommand={run:function(form){form.ui.setFormNotification("Inactive source command ran","INFO","inactive-command")}};',
  );
  await fs.writeFile(
    path.join(initial.solutionDir, 'WebResources/inactive.js.data.xml'),
    '<WebResource><WebResourceId>82af175a-50ad-4e9e-9557-65e5e2bc338c</WebResourceId><Name>x_/inactive.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/inactive.js</FileName></WebResource>',
  );
  await fs.mkdir(path.join(initial.solutionDir, 'AppActions/x_inactive'), { recursive: true });
  await fs.writeFile(
    path.join(initial.solutionDir, 'AppActions/x_inactive/AppAction.xml'),
    '<appaction uniquename="x_inactive"><buttonlabeltext default="Inactive action"/><context>1</context><contextvalue>x_item</contextvalue><location>0</location><sequence>0.0000000000</sequence><onclickeventjavascriptfunctionname>InactiveCommand.run</onclickeventjavascriptfunctionname><onclickeventjavascriptparameters>[{"type":5,"value":null}]</onclickeventjavascriptparameters><onclickeventjavascriptwebresourceid><webresourceid>82af175a-50ad-4e9e-9557-65e5e2bc338c</webresourceid></onclickeventjavascriptwebresourceid><onclickeventtype>2</onclickeventtype><type>0</type></appaction>',
  );
  await fs.rm(initial.stateFile, { force: true });
  const sim = await initial.start({
    initial: {
      version: 1,
      mappings: {
        x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' },
        x_child: { entitySet: 'x_children', idColumn: 'x_childid', nameColumn: 'x_name' },
      },
      tables: {
        x_item: [{ x_itemid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', x_name: 'Copper', x_quantity: 2, statecode: 1 }],
        x_child: [],
      },
    },
  });
  const page = await chrome.page(t),
    errors = [],
    writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/_apps/api/tables/x_item') && ['POST', 'PATCH'].includes(request.method()))
      writes.push(request.method());
  });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.goto(appsOrigin(sim, sim.url) + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=' + id);
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  await t.test('native inactive persisted records report form type four', async () => {
    const nativeFacts = readFileSync(
      new URL('../test/fixtures/model-driven-historical-native-facts.json', import.meta.url),
    );
    assert.equal(
      createHash('sha256').update(nativeFacts).digest('hex'),
      '9427b1304180444657c59cd0d1835a6b660122e2e9fca978b1943382adcbc412',
    );
    assert.equal(JSON.parse(nativeFacts).inactiveFormType, 4);
    assert.equal(await page.evaluate(() => window.Xrm.Page.ui.getFormType()), 4);
  });
  await page.getByRole('button', { name: 'Inactive action', exact: true }).click();
  await page.getByText('Inactive source command ran', { exact: true }).waitFor();
  const commandLabels = await page
    .getByRole('toolbar', { name: 'Commands', exact: true })
    .getByRole('button')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent.trim()));
  assert.ok(
    commandLabels.indexOf('Inactive action') < commandLabels.indexOf('New'),
    'source zero-sequence commands precede the first retained action after inactive Save removal',
  );
  assert.equal(
    await page.evaluate(() => window.Xrm.Page.getControl('x_name').getLabel()),
    'Name',
    'client labels retain authored text without required markers or lock glyphs',
  );
  await page.evaluate(() => window.Xrm.Page.getControl('x_name').setLabel('Updated title'));
  assert.equal(await page.evaluate(() => window.Xrm.Page.getControl('x_name').getLabel()), 'Updated title');
  assert.equal(
    await page.locator('label[for="field-x_name"] .required').count(),
    1,
    'label changes preserve the separate required marker',
  );
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_name').setRequiredLevel('none'));
  assert.equal(await page.locator('label[for="field-x_name"] .required').count(), 0);
  await page.evaluate(() => {
    window.Xrm.Page.getControl('x_name').setLabel('Name');
    window.Xrm.Page.getAttribute('x_name').setRequiredLevel('required');
  });
  assert.equal(await page.locator('label[for="field-x_name"] .required').count(), 1);
  assert.equal(await page.locator('#record-status').textContent(), 'Read-only This record’s status: Inactive');
  await page.evaluate(() =>
    window.Xrm.Page.ui.setFormNotification('Readonly source notification', 'INFO', 'readonly-note'),
  );
  assert.equal(
    await page.locator('#record-status').evaluate((node) => node.nextElementSibling.id),
    'form-notifications',
    'native read-only status precedes source notifications',
  );
  assert.equal(await page.getByLabel('Name', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Save & Close', exact: true }).count(), 0);
  assert.equal(
    await page.evaluate(() => {
      window.Xrm.Page.getControl('x_name').setDisabled(false);
      return window.Xrm.Page.getControl('x_name').getDisabled();
    }),
    false,
  );
  assert.equal(
    await page.evaluate(() => {
      window.Xrm.Page.getControl('x_quantity').setDisabled(false);
      return window.Xrm.Page.getControl('x_quantity').getDisabled();
    }),
    true,
    'a presentation override cannot enable a column denied by update metadata',
  );
  assert.match(
    await page.evaluate(() => {
      try {
        window.Xrm.Page.getAttribute('x_quantity').setValue(9);
        return 'unexpected';
      } catch (error) {
        return error.message;
      }
    }),
    /cannot be changed/,
  );
  await page.getByLabel('Name', { exact: true }).fill('Unlocked inactive draft');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  assert.equal(await page.locator('#record-status').count(), 1);
  assert.match(await page.locator('#record-status').textContent(), /Inactive$/);
  assert.equal(await page.getByText('Readonly source notification', { exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => window.Xrm.Page.getControl('statecode').getDisabled()), true);
  assert.equal(
    await page.evaluate(() => window.Xrm.Page.getControl('x_quantity').getDisabled()),
    true,
    'source denial remains accurately reported while its control is on another tab',
  );
  assert.equal(await page.evaluate(() => window.Xrm.Page.ui.getFormType()), 4);
  assert.deepEqual(writes, [], 'default inactive navigation and an unlocked draft do not save automatically');
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  assert.equal(
    await page.getByLabel('Name', { exact: true }).isEnabled(),
    true,
    'an explicit client unlock survives tab rendering',
  );
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Unlocked inactive draft');
  await page.evaluate(async () => {
    window.Xrm.Page.getAttribute('x_name').setValue('Inactive SDK edit');
    await window.Xrm.Page.data.save();
  });
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  assert.deepEqual(writes, ['PATCH'], 'an explicit SDK save persists the inactive draft once');
  const inactiveSaved = await (
    await page.request.get(appsOrigin(sim, sim.url) + '/_apps/api/tables/x_item/' + id)
  ).json();
  assert.equal(inactiveSaved.row.x_name, 'Inactive SDK edit');
  assert.equal(inactiveSaved.row.statecode, 1);
  assert.equal(await page.evaluate(() => window.Xrm.Page.ui.getFormType()), 4);
  assert.equal(
    await page.getByLabel('Name', { exact: true }).isDisabled(),
    true,
    'reload after save restores default inactive presentation',
  );
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  // A disabled presentation does not remove independent staff Web API rights.
  await page.evaluate(async (id) => window.Xrm.WebApi.updateRecord('x_item', id, { statecode: 0 }), id);
  assert.equal(
    await page.evaluate(() => window.Xrm.Page.ui.getFormType()),
    4,
    'the loaded form remains disabled until refreshed',
  );
  const recordRead = appsOrigin(sim, sim.url) + '/_apps/api/tables/x_item/' + id;
  await page.route(
    recordRead,
    async (route) => {
      await holdRead;
      await route.continue();
    },
    { times: 1 },
  );
  const readPending = page.waitForRequest(recordRead);
  await (await formCommand(page, 'Refresh')).click();
  await readPending;
  assert.equal(
    await page.getByLabel('Name', { exact: true }).isVisible(),
    true,
    'the old label stays visible while its form context is disposed',
  );
  assert.equal(await page.locator('#content').evaluate((node) => node.inert), true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.mirageAppState), 'loading');
  assert.match(
    await page.evaluate(() => {
      try {
        window.Xrm.Page.ui.getFormType();
        return 'unexpected';
      } catch (error) {
        return error.message;
      }
    }),
    /disposed/,
  );
  releaseRead();
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  assert.equal(await page.evaluate(() => window.Xrm.Page.ui.getFormType()), 2);
  assert.equal(
    await page.locator('#record-status').count(),
    0,
    'refreshing an activated record removes its old status strip',
  );
  assert.equal(
    await page.getByLabel('Name', { exact: true }).isDisabled(),
    true,
    'source-authored read-only presentation remains the default on an active form',
  );
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_name').setValue('Copper'));
  assert.equal(
    await page.getByLabel('Name', { exact: true }).isDisabled(),
    true,
    'SDK attribute writes do not implicitly unlock a source-disabled control',
  );
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.evaluate(() => window.Xrm.Page.getAttribute('statecode').setValue(1));
  assert.equal(
    await page.evaluate(() => window.Xrm.Page.ui.getFormType()),
    2,
    'draft state transitions stay editable until saved',
  );
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  assert.equal(await page.evaluate(() => window.Xrm.Page.ui.getFormType()), 4);
  const saved = await (await page.request.get(appsOrigin(sim, sim.url) + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(saved.row.statecode, 1);
  assert.equal(saved.row.x_name, 'Copper');
  assert.equal(await page.locator('#record-status').count(), 1);
  await page.goto(appsOrigin(sim, sim.url) + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  assert.equal(await page.locator('#record-status').count(), 0, 'the inactive record strip cannot leak onto a grid');
  assert.deepEqual(errors, []);
});

test('a header-only column set through the client API is saved with the record; dirty clears for persisted values', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: true } });
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  let xml = await fs.readFile(formFile, 'utf8');
  // x_quantity moves from the body to the form header (header controls are named header_<column>).
  xml = xml
    .replace(
      '<row><cell><labels><label description="Quantity" languagecode="1033"/></labels><control datafieldname="x_quantity"/></cell></row>',
      '',
    )
    .replace(
      '<form><tabs>',
      '<form><header><rows><row><cell><control id="header_x_quantity" datafieldname="x_quantity"/></cell></row></rows></header><tabs>',
    );
  await fs.writeFile(formFile, xml);
  const { sim, page, errors } = await openReadyRecord(t, initial);
  assert.equal(
    await page.evaluate(() => window.Xrm.Page.getControl('header_x_quantity')?.getName()),
    'header_x_quantity',
  );
  assert.equal(
    await page.evaluate(() => {
      window.Xrm.Page.getAttribute('x_quantity').setValue(42);
      return window.Xrm.Page.data.entity.getIsDirty();
    }),
    true,
  );
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page.getByText('Record saved locally.', { exact: true }).waitFor();
  const row = await (
    await fetch(appsOrigin(sim, sim.origin) + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  ).json();
  assert.equal(row.row.x_quantity, 42);
  assert.equal(row.row.x_name, 'Copper');
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  assert.equal(await page.evaluate(() => window.Xrm.Page.data.entity.getIsDirty()), false);
  assert.deepEqual(errors, []);
});

test('a save that cannot carry every changed column still runs Save & Close, then names the columns', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: true } });
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  // x_quantity is bound to a custom control the shell does not host: it stays a form attribute a client script can set,
  // but the save cannot carry it.
  await fs.writeFile(
    formFile,
    (await fs.readFile(formFile, 'utf8'))
      .replace(
        '<control datafieldname="x_quantity"/>',
        '<control datafieldname="x_quantity" uniqueid="{77777777-7777-4777-8777-7777777777c1}"/>',
      )
      .replace(
        '</form>',
        '<controlDescriptions><controlDescription forControl="{77777777-7777-4777-8777-7777777777c1}"><customControl formFactor="2" name="x_Invented.Phone"/></controlDescription></controlDescriptions></form>',
      ),
  );
  const { sim, page, errors } = await openReadyRecord(t, initial);
  await page.evaluate(() => {
    window.Xrm.Page.getAttribute('x_name').setValue('Copper two');
    window.Xrm.Page.getAttribute('x_quantity').setValue(42);
  });
  await page.getByRole('button', { name: 'Save & Close', exact: true }).first().click();
  // The normal path ran: the grid is shown again, and the notice names the column the save could not carry.
  await page
    .getByText('Record saved locally. These changed columns cannot be saved locally: x_quantity.', { exact: true })
    .waitFor();
  assert.doesNotMatch(page.url(), /pagetype=entityrecord/);
  const row = await (
    await fetch(appsOrigin(sim, sim.origin) + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  ).json();
  assert.deepEqual([row.row.x_name, row.row.x_quantity], ['Copper two', 2]);
  assert.deepEqual(errors, []);
});

// @test-kind observation: native model-driven main form observed 2026-11-12 on a developer environment (single console probe): a create-form save resolves and the captured context stays on the saved record (update form type, id and values, not dirty), load state after a save is 2, a refused OnSave rejects with the observed plain object, the form-registered OnLoad is not replayed, and saveandnew leaves the saved context readable while the open form is a new record.
test('a create-form context keeps answering after its save, a refused OnSave sends no PATCH, and saveandnew opens a new form', async (t) => {
  const { page, sim, errors } = await fixture(t);
  const writes = [];
  page.on('request', (request) => {
    if (
      request.url().startsWith(appsOrigin(sim, sim.origin) + '/_apps/api/tables/x_item') &&
      ['POST', 'PATCH'].includes(request.method())
    )
      writes.push(request.method());
  });
  await page.goto(appsOrigin(sim, sim.origin) + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item');
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  const created = await page.evaluate(() => {
    const context = window.Xrm.Page;
    window.createdContext = context;
    window.loadStates = [];
    context.data.addOnLoad((loadContext) => window.loadStates.push(loadContext.getEventArgs().getDataLoadState()));
    context.getAttribute('x_name').setValue('Created copper');
    return context.data.save().then(() => ({
      id: context.data.entity.getId(),
      formType: context.ui.getFormType(),
      value: context.getAttribute('x_name').getValue(),
      dirty: context.data.getIsDirty(),
      loadStates: window.loadStates.slice(),
      formLoads: window.clientLoads,
    }));
  });
  assert.match(created.id, /^\{[\da-f-]{36}\}$/);
  assert.equal(created.formType, 2);
  assert.equal(created.value, 'Created copper');
  assert.equal(created.dirty, false);
  assert.deepEqual(created.loadStates, [2]);
  assert.equal(created.formLoads, 1, 'the form-registered OnLoad is not replayed after a save');
  assert.deepEqual(writes, ['POST']);
  await page.getByLabel('Name', { exact: true }).fill('BLOCK');
  const refusal = await page.evaluate(() =>
    window.Xrm.Page.data.save().then(
      () => 'resolved',
      (error) => error,
    ),
  );
  assert.deepEqual(refusal, {
    errorCode: 2200000005,
    code: 2200000005,
    message: 'This form can’t be saved due to a custom setting.',
    title: 'Unable to save',
  });
  assert.deepEqual(writes, ['POST'], 'a refused OnSave sends no PATCH');
  assert.equal(await page.evaluate(() => window.Xrm.Page.data.getIsDirty()), true);
  // saveandnew saves the record, then the open form is a new record while the saved context keeps the record.
  await page.getByLabel('Name', { exact: true }).fill('Created copper two');
  assert.equal(
    await page.evaluate(() => window.Xrm.Page.data.entity.save('saveandnew')),
    undefined,
    'saveandnew returns no promise',
  );
  await page.waitForFunction(
    () => window.Xrm.Page.ui.getFormType() === 1 && document.documentElement.dataset.mirageAppState === 'ready',
  );
  const afterNew = await page.evaluate(() => ({
    fresh: window.Xrm.Page !== window.createdContext,
    newId: window.Xrm.Page.data.entity.getId(),
    oldId: window.createdContext.data.entity.getId(),
    oldType: window.createdContext.ui.getFormType(),
    oldValue: window.createdContext.getAttribute('x_name').getValue(),
  }));
  assert.deepEqual(afterNew, { fresh: true, newId: '', oldId: created.id, oldType: 2, oldValue: 'Created copper two' });
  assert.deepEqual(writes, ['POST', 'PATCH'], 'saveandnew saves the record once before the new form opens');
  assert.deepEqual(errors, []);
});

// @test-kind contract: a second data.save() started while the first is in flight rejects with the Saving in Progress object, and only the first save writes; a route gate holds the first write open so it is provably in flight when the second starts.
test('a second script save started while the first is in flight rejects and sends no write', async (t) => {
  const { page, sim, errors } = await fixture(t);
  const writes = [];
  page.on('request', (request) => {
    if (
      request.url().startsWith(appsOrigin(sim, sim.origin) + '/_apps/api/tables/x_item') &&
      ['POST', 'PATCH'].includes(request.method())
    )
      writes.push(request.method());
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    async (route) => {
      if (route.request().method() === 'PATCH') await gate;
      await route.continue();
    },
  );
  const firstWriteInFlight = page.waitForRequest(
    (request) => request.method() === 'PATCH' && request.url().includes('/_apps/api/tables/x_item/aaaaaaaa'),
  );
  await page.evaluate(() => {
    window.Xrm.Page.getAttribute('x_name').setValue('Copper gated');
    window.firstSave = window.Xrm.Page.data.save();
  });
  await firstWriteInFlight;
  const second = await page.evaluate(() =>
    window.Xrm.Page.data.save().then(
      () => 'resolved',
      (error) => error,
    ),
  );
  assert.deepEqual(second, {
    errorCode: 2200000003,
    code: 2200000003,
    message: 'Please wait while saving is completed',
    title: 'Saving in Progress',
  });
  release();
  const first = await page.evaluate(() => window.firstSave);
  assert.deepEqual(first, {
    savedEntityReference: {
      entityType: 'x_item',
      id: '{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}',
      name: 'Copper gated',
    },
  });
  assert.deepEqual(writes, ['PATCH'], 'only the first save sends a write');
  assert.deepEqual(errors, []);
});

// @test-kind observation: native model-driven main form observed 2026-11-12 on a developer environment (single console probe): data.refresh fires script-added OnLoad handlers with load state 3 and does not re-run the form-registered OnLoad.
test('data.refresh on an open record runs script-added OnLoad with load state 3 and keeps the captured context readable', async (t) => {
  const { page, errors } = await fixture(t);
  await page.waitForFunction(() => window.clientLoads === 1 && Boolean(window.Xrm?.Page));
  const outcome = await page.evaluate(async () => {
    const formContext = window.Xrm.Page;
    window.refreshLoads = [];
    formContext.data.addOnLoad((loadContext) =>
      window.refreshLoads.push(loadContext.getEventArgs().getDataLoadState()),
    );
    await formContext.data.refresh(false);
    return {
      loads: window.refreshLoads.slice(),
      formLoads: window.clientLoads,
      id: formContext.data.entity.getId(),
      name: formContext.getAttribute('x_name').getValue(),
    };
  });
  assert.deepEqual(outcome.loads, [3]);
  assert.equal(outcome.formLoads, 1, 'the form-registered OnLoad is not replayed by data.refresh');
  assert.match(outcome.id, /^\{[\da-f-]{36}\}$/);
  assert.equal(outcome.name, 'Copper');
  assert.deepEqual(errors, []);
});

// The form OnLoad registers a script OnLoad handler, and the handler changes section visibility, as scripts do.
const loopScript = `var LoopClient = {
  load(executionContext) {
    executionContext.getFormContext().data.addOnLoad(function (loadContext) {
      window.loopLoads = (window.loopLoads || 0) + 1;
      window.loopStates = (window.loopStates || []).concat([loadContext.getEventArgs().getDataLoadState()]);
      loadContext.getFormContext().ui.tabs.get('related').sections.get('children').setVisible(true);
    });
  }
};`;

/** The Copper form whose OnLoad registers the loop script's handler, opened once its Xrm context is ready. */
async function loopFixture(t) {
  const initial = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: true } });
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const xml = (await fs.readFile(formFile, 'utf8')).replace(
    '</form>',
    '<formLibraries><Library name="x_/loop.js"/></formLibraries><events><event name="onload"><Handlers><Handler libraryName="x_/loop.js" functionName="LoopClient.load" enabled="true" passExecutionContext="true"/></Handlers></event></events></form>',
  );
  await fs.writeFile(formFile, xml);
  await fs.mkdir(path.join(initial.solutionDir, 'WebResources'), { recursive: true });
  await fs.writeFile(path.join(initial.solutionDir, 'WebResources/loop.js'), loopScript);
  await fs.writeFile(
    path.join(initial.solutionDir, 'WebResources/loop.js.data.xml'),
    '<WebResource><WebResourceId>dddddddd-dddd-4ddd-8ddd-dddddddddddd</WebResourceId><Name>x_/loop.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/loop.js</FileName></WebResource>',
  );
  const sim = await initial.start();
  sim.origin = sim.origin ?? sim.url;
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    appsOrigin(sim, sim.origin) +
      '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  return { page, errors };
}

// @test-kind contract: a script OnLoad handler runs on open and on each data load only; tab, label and visibility re-renders from the page or a script do not replay it.
test('script-added OnLoad runs on open and data load only, not on tab or layout re-renders', async (t) => {
  const { page, errors } = await loopFixture(t);
  await page.waitForFunction(() => window.loopLoads >= 1 && Boolean(window.Xrm?.Page));
  const loadCount = () => page.evaluate(() => window.loopLoads);
  assert.equal(await loadCount(), 1, 'the script OnLoad runs once when the form opens');
  // Tabs are clicked in the page so that a re-render loop shows as a failed count, not as a stalled click.
  const clickTab = (id) => page.evaluate((id) => document.querySelector(`[data-id="tablist-${id}"]`).click(), id);
  await clickTab('related');
  await page.waitForFunction(() => document.querySelector('.form-section[data-id="children"]'));
  assert.equal(await loadCount(), 1, 'a tab change does not replay OnLoad');
  await page.evaluate(() =>
    window.Xrm.Page.ui.tabs.get('related').sections.get('children').setLabel('Renamed children'),
  );
  await page.waitForFunction(
    () => document.querySelector('.form-section[data-id="children"] h2')?.textContent === 'Renamed children',
  );
  assert.equal(await loadCount(), 1, 'a section label change does not replay OnLoad');
  await page.evaluate(() => window.Xrm.Page.ui.tabs.get('general').setVisible(false));
  await page.waitForFunction(() => !document.querySelector('[data-id="tablist-general"]'));
  await page.evaluate(() => window.Xrm.Page.ui.tabs.get('general').setVisible(true));
  await page.waitForFunction(() => Boolean(document.querySelector('[data-id="tablist-general"]')));
  assert.equal(await loadCount(), 1, 'a tab visibility change does not replay OnLoad');
  await clickTab('general');
  await page.waitForFunction(() => document.querySelector('.form-section[data-id="details"]'));
  assert.equal(await loadCount(), 1, 'the tab change back does not replay OnLoad');
  await page.evaluate(() => window.Xrm.Page.data.refresh(false));
  await page.waitForFunction(() => window.loopLoads >= 2);
  assert.equal(await loadCount(), 2, 'data.refresh runs the script OnLoad once more');
  assert.deepEqual(await page.evaluate(() => window.loopStates), [1, 3], 'the refresh load state is 3');
  assert.deepEqual(errors, []);
});

// @test-kind contract: a successful save clears the required-fields form notice, and a notice a script set under its own id stays.
test('a successful save clears the required-fields notice and keeps a script notice', async (t) => {
  const { page, errors } = await fixture(t);
  await page.waitForFunction(() => window.clientLoads === 1 && Boolean(window.Xrm?.Page));
  await page.evaluate(() => window.Xrm.Page.ui.setFormNotification('note', 'INFO', 'mine'));
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_name').setValue(null));
  await (await formCommand(page, 'Save')).click();
  const requiredNotice = page.locator('#form-notifications [data-form-notification="required-fields"]');
  await requiredNotice.waitFor();
  // A script write makes the field valid without an input event, so the save is what has to clear the notice.
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_name').setValue('Copper updated'));
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  assert.equal(await requiredNotice.count(), 0, 'the saved form drops the required-fields notice');
  assert.equal(
    await page.locator('#form-notifications [data-form-notification="mine"]').count(),
    1,
    'the script notice stays until the script clears it',
  );
  assert.deepEqual(errors, []);
});

test('a save without changes clears the required-fields notice', async (t) => {
  const { page, errors } = await fixture(t);
  await page.waitForFunction(() => window.clientLoads === 1 && Boolean(window.Xrm?.Page));
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_name').setValue(null));
  await (await formCommand(page, 'Save')).click();
  const requiredNotice = page.locator('#form-notifications [data-form-notification="required-fields"]');
  await requiredNotice.waitFor();
  // Restoring the loaded value leaves no attribute dirty, so the save takes the unchanged path.
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_name').setValue('Copper'));
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('status').filter({ hasText: 'No record changes to save.' }).waitFor();
  assert.equal(await requiredNotice.count(), 0, 'the unchanged save drops the required-fields notice');
  assert.deepEqual(errors, []);
});

/** The Copper form with a second section named details in the Related tab, next to the General tab's details section. */
async function sameNameFixture(t) {
  const initial = await modelDrivenFixture(t, { defer: true });
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const xml = (await fs.readFile(formFile, 'utf8')).replace(
    '<section name="children">',
    '<section name="details"><labels><label description="Related details" languagecode="1033"/></labels><rows></rows></section><section name="children">',
  );
  await fs.writeFile(formFile, xml);
  return openReadyRecord(t, initial);
}

// @test-kind contract: script section visibility applies to the section of its own tab, so a same-named section in another tab stays shown through a save.
test('a section hidden in one tab stays shown under the same name in another tab, through a save', async (t) => {
  const { page, errors } = await sameNameFixture(t);
  const clickTab = (id) => page.evaluate((id) => document.querySelector(`[data-id="tablist-${id}"]`).click(), id);
  const detailsHeadings = () => page.locator('.form-section[data-id="details"] h2').allTextContents();
  assert.deepEqual(await detailsHeadings(), ['Item details'], 'the General tab opens with its details section');
  await page.evaluate(() => window.Xrm.Page.ui.tabs.get('general').sections.get('details').setVisible(false));
  await page.waitForFunction(() => !document.querySelector('.form-section[data-id="details"]'));
  await clickTab('related');
  await page.waitForFunction(() => document.querySelector('.form-section[data-id="children"]'));
  assert.deepEqual(await detailsHeadings(), ['Related details'], 'the Related tab keeps its same-named section shown');
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').setValue(5));
  await page.evaluate(() => window.Xrm.Page.data.save());
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  // The save keeps the Related tab selected, so the General tab is opened to check its hidden section.
  await clickTab('general');
  await page.waitForFunction(
    () => document.querySelector('[data-id="tablist-general"]')?.getAttribute('aria-selected') === 'true',
  );
  assert.deepEqual(await detailsHeadings(), [], 'the save keeps the General section hidden');
  await clickTab('related');
  await page.waitForFunction(() => document.querySelector('.form-section[data-id="children"]'));
  assert.deepEqual(await detailsHeadings(), ['Related details'], 'the save keeps the Related section shown');
  assert.deepEqual(errors, []);
});

test('sections of two tabs without an id keep separate visibility under the same name', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true });
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const xml = (await fs.readFile(formFile, 'utf8'))
    .replace('<tab name="general">', '<tab>')
    .replace('<tab name="related">', '<tab>')
    .replace(
      '<section name="children">',
      '<section name="details"><labels><label description="Related details" languagecode="1033"/></labels><rows></rows></section><section name="children">',
    );
  await fs.writeFile(formFile, xml);
  const { page, errors } = await openReadyRecord(t, initial);
  const clickTab = (id) => page.evaluate((id) => document.querySelector(`[data-id="tablist-${id}"]`).click(), id);
  const detailsHeadings = () => page.locator('.form-section[data-id="details"] h2').allTextContents();
  assert.deepEqual(await detailsHeadings(), ['Item details'], 'the first tab opens with its details section');
  await page.evaluate(() => window.Xrm.Page.ui.tabs.get('tab-0').sections.get('details').setVisible(false));
  await page.waitForFunction(() => !document.querySelector('.form-section[data-id="details"]'));
  await clickTab('tab-1');
  await page.waitForFunction(() => document.querySelector('.form-section[data-id="children"]'));
  assert.deepEqual(await detailsHeadings(), ['Related details'], 'the second tab keeps its same-named section shown');
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').setValue(5));
  await page.evaluate(() => window.Xrm.Page.data.save());
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  // The save keeps the second tab selected, so the first tab is opened to check its hidden section.
  await clickTab('tab-0');
  await page.waitForFunction(
    () => document.querySelector('[data-id="tablist-tab-0"]')?.getAttribute('aria-selected') === 'true',
  );
  assert.deepEqual(await detailsHeadings(), [], 'the save keeps the first tab section hidden');
  await clickTab('tab-1');
  await page.waitForFunction(() => document.querySelector('.form-section[data-id="children"]'));
  assert.deepEqual(await detailsHeadings(), ['Related details'], 'the save keeps the second tab section shown');
  assert.deepEqual(errors, []);
});

// @test-kind unproven: the tab kept across a save and a refresh models the Unified Interface as described in its documentation; no recorded capture backs it.
test('the selected tab stays selected after a save and after data.refresh, and resets when another record opens', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true });
  const entityFile = path.join(initial.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '</attributes>',
      '<attribute PhysicalName="x_notes"><Name>x_notes</Name><LogicalName>x_notes</LogicalName><Type>nvarchar</Type><displaynames><displayname description="Notes" languagecode="1033"/></displaynames></attribute></attributes>',
    ),
  );
  // The Related tab gets a text column in its own section, so the second tab holds an editable field.
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    formFile,
    (await fs.readFile(formFile, 'utf8')).replace(
      '<section name="children">',
      '<section name="notes"><labels><label description="Related notes" languagecode="1033"/></labels><rows><row><cell><labels><label description="Notes" languagecode="1033"/></labels><control datafieldname="x_notes"/></cell></row></rows></section><section name="children">',
    ),
  );
  const { page, errors } = await openReadyRecord(t, initial);
  const selectedTab = () => page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-id');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByLabel('Notes', { exact: true }).fill('Copper note');
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  assert.equal(await selectedTab(), 'tablist-related', 'the save keeps the Related tab selected');
  await page.evaluate(() => window.Xrm.Page.data.refresh(false));
  assert.equal(await selectedTab(), 'tablist-related', 'data.refresh keeps the Related tab selected');
  await page.evaluate(() =>
    window.Xrm.Navigation.openForm({ entityName: 'x_item', entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
  );
  await page.getByRole('heading', { name: 'Silver', exact: true }).waitFor();
  assert.equal(await selectedTab(), 'tablist-general', 'another record opens on its first tab');
  // The URL names the first tab: a refresh keeps the tab the user selected, not the one the URL names.
  await page.evaluate(() =>
    window.Xrm.Navigation.navigateTo({
      pageType: 'entityrecord',
      entityName: 'x_item',
      entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tabName: 'general',
    }),
  );
  await page.getByRole('heading', { name: 'Silver', exact: true }).waitFor();
  assert.equal(await selectedTab(), 'tablist-general', 'a record opened with the first tab in the URL opens on it');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.evaluate(() => window.Xrm.Page.data.refresh(false));
  assert.equal(
    await selectedTab(),
    'tablist-related',
    'data.refresh keeps the selected tab although the URL names the first tab',
  );
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.evaluate(() => window.Xrm.Navigation.navigateTo({ pageType: 'entitylist', entityName: 'x_item' }));
  await page.waitForFunction(() => !document.querySelector('[data-id="tablist-related"]'));
  await page.evaluate(() =>
    window.Xrm.Navigation.openForm({ entityName: 'x_item', entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
  );
  await page.getByRole('heading', { name: 'Silver', exact: true }).waitFor();
  assert.equal(await selectedTab(), 'tablist-general', 'the same record reopened from the list opens on its first tab');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.evaluate(() => window.Xrm.Navigation.openForm({ entityName: 'x_item' }));
  await page.getByRole('tab', { name: 'Related items', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.evaluate(() => window.Xrm.Navigation.openForm({ entityName: 'x_item' }));
  assert.equal(await selectedTab(), 'tablist-general', 'a second new-record form opens on its first tab');
  assert.deepEqual(errors, []);
});

// @test-kind contract: a new-record lookup default takes its table from the link only when the field targets it and the catalogue has it, so a link naming another table falls back to the field's single target.
test('a new-record lookup default ignores a table link the field does not target', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  const copper = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  // The lookup's table is what scripts read back as entityType; the name shown is the link's name either way.
  const openNewChild = async (entity) => {
    const defaults = new URLSearchParams([
      ['x_parentid', copper],
      ['x_parentidtype', entity],
      ['x_parentidname', 'Copper'],
    ]);
    const query = new URLSearchParams({
      appname: 'x_example',
      pagetype: 'entityrecord',
      etn: 'x_child',
      extraqs: defaults.toString(),
    });
    await page.goto(`${origin}/main.aspx?${query}`);
    await page.waitForFunction(
      () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
    );
    const [reference] = await page.evaluate(() => window.Xrm.Page.getAttribute('x_parentid').getValue());
    return { shown: await page.getByLabel('Parent', { exact: true }).inputValue(), entityType: reference?.entityType };
  };
  assert.deepEqual(
    await openNewChild('x_child'),
    { shown: 'Copper', entityType: 'x_item' },
    'a table the field does not target falls back to its single target',
  );
  assert.deepEqual(
    await openNewChild('x_item'),
    { shown: 'Copper', entityType: 'x_item' },
    'a table the field targets is kept',
  );
});

test('a new-record lookup default without a type on a field with several targets shows its name and asks for the target table', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true });
  // A second relationship on x_parentid gives the lookup a second target, as a polymorphic lookup has.
  const relationshipsFile = path.join(initial.solutionDir, 'Other/Relationships.xml');
  await fs.writeFile(
    relationshipsFile,
    (await fs.readFile(relationshipsFile, 'utf8')).replace(
      '</EntityRelationships>',
      '<EntityRelationship Name="x_child_parent"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>x_child</ReferencingEntityName><ReferencedEntityName>x_child</ReferencedEntityName><ReferencingAttributeName>x_parentid</ReferencingAttributeName><ReferencedAttributeName>x_childid</ReferencedAttributeName></EntityRelationship></EntityRelationships>',
    ),
  );
  const sim = await initial.start();
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Only the id and the name are linked: no table name, so the field's several targets leave the entity unknown.
  const query = new URLSearchParams({
    appname: 'x_example',
    pagetype: 'entityrecord',
    etn: 'x_child',
    extraqs: new URLSearchParams([
      ['x_parentid', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['x_parentidname', 'Copper'],
    ]).toString(),
  });
  await page.goto(`${appsOrigin(sim, sim.origin ?? sim.url)}/main.aspx?${query}`);
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Copper', 'the URL name is shown');
  // With several targets and no table, the value cannot be read until the user chooses the target table.
  const read = await page.evaluate(() => {
    try {
      window.Xrm.Page.getAttribute('x_parentid').getValue();
      return 'read';
    } catch (error) {
      return error.message;
    }
  });
  assert.match(read, /Choose a target table/);
  assert.deepEqual(errors, []);
});

// The OnLoad script only changes the Copper record: a record opened later must not inherit the script's state.
const stateScript = `var StateClient = {
  load(executionContext) {
    window.stateLoads = (window.stateLoads || 0) + 1;
    window.loadStates = (window.loadStates || []).concat([executionContext.getEventArgs().getDataLoadState()]);
    var form = executionContext.getFormContext();
    if (form.data.entity.getId().indexOf('aaaaaaaa') < 0) return;
    form.getControl('x_quantity').setVisible(false);
    form.getControl('x_name').setDisabled(true);
    form.getControl('x_name').setLabel('Scripted name');
    form.getControl('x_name').setNotification('Name is under review', 'name-review');
    form.ui.tabs.get('extras').setVisible(false);
    form.ui.setFormNotification('Form scripted notice', 'WARNING', 'scripted-form');
  }
};`;

/** The Copper form with an extra tab and an OnLoad script that sets control, label, notification and tab state. */
async function stateFixture(t) {
  const initial = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: true } });
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const extraTab =
    '<tab name="extras"><labels><label description="Extras" languagecode="1033"/></labels><columns><column><sections><section name="extra_inputs"><labels><label description="Extra inputs" languagecode="1033"/></labels><rows></rows></section></sections></column></columns></tab>';
  let xml = (await fs.readFile(formFile, 'utf8')).replace('</tabs>', extraTab + '</tabs>');
  xml = xml.replace(
    '</form>',
    '<formLibraries><Library name="x_/state.js"/></formLibraries><events><event name="onload"><Handlers><Handler libraryName="x_/state.js" functionName="StateClient.load" enabled="true" passExecutionContext="true"/></Handlers></event></events></form>',
  );
  await fs.writeFile(formFile, xml);
  await fs.mkdir(path.join(initial.solutionDir, 'WebResources'), { recursive: true });
  await fs.writeFile(path.join(initial.solutionDir, 'WebResources/state.js'), stateScript);
  await fs.writeFile(
    path.join(initial.solutionDir, 'WebResources/state.js.data.xml'),
    '<WebResource><WebResourceId>bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb</WebResourceId><Name>x_/state.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/state.js</FileName></WebResource>',
  );
  const sim = await initial.start();
  sim.origin = sim.origin ?? sim.url;
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    appsOrigin(sim, sim.origin) +
      '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.waitForFunction(() => window.stateLoads === 1 && Boolean(window.Xrm?.Page));
  return { page, errors };
}

/** Asserts the script-set state in the DOM: the hidden and disabled controls, the label, notification, tab and form notice. */
async function assertScriptState(page, when, { expected }) {
  const quantity = page.locator('.field[data-id="x_quantity"]').first();
  assert.equal(await quantity.isVisible(), !expected, `${when}: the script hides Quantity`);
  const name = page.getByLabel(expected ? 'Scripted name' : 'Name', { exact: true });
  assert.equal(await name.isDisabled(), expected, `${when}: the script disables Name`);
  assert.equal(
    await name.evaluate((input) => input.validity.customError),
    expected,
    `${when}: the script's field notification stays set`,
  );
  assert.equal(
    await page.getByRole('tab', { name: 'Extras', exact: true }).count(),
    expected ? 0 : 1,
    `${when}: the script hides the Extras tab`,
  );
  assert.equal(
    await page.locator('#form-notifications p.warning').count(),
    expected ? 1 : 0,
    `${when}: the form notification stays shown`,
  );
}

// @test-kind contract: script-set control, tab, label and notification state is part of the open form and survives an in-place reload; the reload does not replay OnLoad.
test('script-set state stays in effect across a save and a data.refresh, and another record starts clean', async (t) => {
  const { page, errors } = await stateFixture(t);
  await assertScriptState(page, 'after OnLoad', { expected: true });
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').setValue(5));
  await page.evaluate(() => window.Xrm.Page.data.save());
  await assertScriptState(page, 'after save', { expected: true });
  assert.equal(await page.evaluate(() => window.stateLoads), 1, 'the form OnLoad is not replayed by save');
  await page.evaluate(() => window.Xrm.Page.data.refresh(false));
  await assertScriptState(page, 'after refresh', { expected: true });
  assert.equal(await page.evaluate(() => window.stateLoads), 1, 'the form OnLoad is not replayed by refresh');
  await page.evaluate(() =>
    window.Xrm.Navigation.openForm({ entityName: 'x_item', entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
  );
  await page.getByRole('heading', { name: 'Silver', exact: true }).waitFor();
  await assertScriptState(page, 'on another record', { expected: false });
  assert.deepEqual(errors, []);
});

/**
 * Holds the record reads that follow the first write on the path, in order. Each gate's `reached` resolves when its read
 * arrives and the read waits until the gate's `open` is called.
 */
async function holdRecordReadsAfterWrite(page, pathname, count) {
  const gates = Array.from({ length: count }, () => {
    const gate = {};
    gate.reached = new Promise((resolve) => {
      gate.arrive = resolve;
    });
    gate.released = new Promise((resolve) => {
      gate.open = resolve;
    });
    return gate;
  });
  let writes = 0,
    next = 0;
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      const method = route.request().method();
      if (method === 'PATCH') writes++;
      const gate = gates[next];
      if (method === 'GET' && writes > 0 && gate) {
        next++;
        gate.arrive();
        await gate.released;
      }
      await route.continue();
    },
  );
  return gates;
}

const copperPath = '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// @test-kind contract: a route load decides from its own target whether the open runtime is kept, so a navigation during a save's reload gets a fresh runtime.
test('a navigation to another record while a save reload is pending gets its own runtime and load state 1', async (t) => {
  const { page, errors } = await stateFixture(t);
  const [reload] = await holdRecordReadsAfterWrite(page, copperPath, 1);
  await page.evaluate(() => {
    window.Xrm.Page.getAttribute('x_quantity').setValue(5);
    window.firstContext = window.Xrm.Page;
    window.firstSave = window.Xrm.Page.data.save();
  });
  await reload.reached;
  const opened = page.evaluate(() =>
    window.Xrm.Navigation.openForm({ entityName: 'x_item', entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
  );
  await page.getByRole('heading', { name: 'Silver', exact: true }).waitFor();
  reload.open();
  await opened;
  await page.evaluate(() => window.firstSave.catch(() => {}));
  assert.equal(
    await page.evaluate(() => window.Xrm.Page !== window.firstContext),
    true,
    'the other record runs under a new form context',
  );
  assert.equal(
    await page.evaluate(() => window.Xrm.Page.data.entity.getId()),
    '{bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb}',
  );
  assert.deepEqual(await page.evaluate(() => window.loadStates), [1, 1], 'its form OnLoad ran with data-load state 1');
  assert.deepEqual(errors, []);
});

// @test-kind contract: two overlapping reloads each keep their own load state; the last operation's state reaches OnLoad and the runtime is kept once.
test('a save followed by data.refresh while the save reload is pending ends on one runtime with the refresh load state', async (t) => {
  const { page, errors } = await stateFixture(t);
  const [saveReload, refreshReload] = await holdRecordReadsAfterWrite(page, copperPath, 2);
  await page.evaluate(() => {
    window.Xrm.Page.getAttribute('x_quantity').setValue(6);
    window.firstContext = window.Xrm.Page;
    window.reloadStates = [];
    window.Xrm.Page.data.addOnLoad((loadContext) =>
      window.reloadStates.push(loadContext.getEventArgs().getDataLoadState()),
    );
    window.firstSave = window.Xrm.Page.data.save();
  });
  await saveReload.reached;
  await page.evaluate(() => {
    window.refreshed = window.Xrm.Page.data.refresh(false);
  });
  await refreshReload.reached;
  saveReload.open();
  await page.evaluate(() => window.firstSave.catch(() => {}));
  refreshReload.open();
  await page.evaluate(() => window.refreshed);
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.Xrm.Page === window.firstContext),
    true,
    'both reloads keep the open runtime',
  );
  assert.equal(
    await page.evaluate(() => window.Xrm.Page.data.entity.getId()),
    '{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}',
  );
  assert.deepEqual(await page.evaluate(() => window.reloadStates), [3], 'the refresh load state reaches OnLoad');
  assert.equal(await page.evaluate(() => window.stateLoads), 1, 'the form OnLoad is not replayed by either reload');
  assert.deepEqual(errors, []);
});
