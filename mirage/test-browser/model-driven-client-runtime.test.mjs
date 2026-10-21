import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';

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
  const initial = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: trusted } }); await initial.sim.close();
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  let xml = await fs.readFile(formFile, 'utf8');
  xml = xml.replace('<control datafieldname="x_quantity"', '<control visible="false" datafieldname="x_quantity"');
  xml = xml.replace('</form>', '<formLibraries><Library name="x_/client.js"/></formLibraries><events><event name="onload"><Handlers><Handler libraryName="x_/client.js" functionName="InventedClient.load" enabled="true" passExecutionContext="true"/></Handlers></event><event name="onchange" attribute="x_name"><Handlers><Handler libraryName="x_/client.js" functionName="InventedClient.change" enabled="true" passExecutionContext="true"/></Handlers></event><event name="onsave"><Handlers><Handler libraryName="x_/client.js" functionName="InventedClient.save" enabled="true" passExecutionContext="true"/></Handlers></event></events></form>');
  await fs.writeFile(formFile, xml);
  await fs.mkdir(path.join(initial.solutionDir, 'WebResources'), { recursive: true });
  await fs.writeFile(path.join(initial.solutionDir, 'WebResources/client.js'), script);
  await fs.writeFile(path.join(initial.solutionDir, 'WebResources/client.js.data.xml'), '<WebResource><WebResourceId>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</WebResourceId><Name>x_/client.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/client.js</FileName></WebResource>');
  await fs.mkdir(path.join(initial.solutionDir, 'AppActions/x_early'), { recursive: true });
  await fs.writeFile(path.join(initial.solutionDir, 'AppActions/x_early/AppAction.xml'), '<appaction uniquename="x_early"><buttonlabeltext default="Early reviewed"/><context>1</context><contextvalue>x_item</contextvalue><location>0</location><sequence>0.0000000000</sequence><onclickeventjavascriptfunctionname>InventedClient.mark</onclickeventjavascriptfunctionname><onclickeventjavascriptparameters>[{"type":5,"value":null}]</onclickeventjavascriptparameters><onclickeventjavascriptwebresourceid><webresourceid>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</webresourceid></onclickeventjavascriptwebresourceid><onclickeventtype>2</onclickeventtype><type>0</type></appaction>');
  await fs.writeFile(path.join(initial.solutionDir, 'Entities/x_item/RibbonDiff.xml'), '<RibbonDiffXml><CustomActions><CustomAction><CommandUIDefinition><Button Id="x.Form.Mark" Command="x.Mark" LabelText="Mark reviewed"/></CommandUIDefinition></CustomAction><CustomAction><CommandUIDefinition><Button Id="x.Form.Unsupported" Command="x.Unsupported" LabelText="Unsupported API"/></CommandUIDefinition></CustomAction><CustomAction><CommandUIDefinition><Button Id="x.Form.Remote" Command="x.Remote" LabelText="Unsupported remote action"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="x.Mark"><EnableRules><EnableRule Id="x.Existing"/></EnableRules><Actions><JavaScriptFunction Library="$webresource:x_/client.js" FunctionName="InventedClient.mark"><CrmParameter Value="PrimaryControl"/></JavaScriptFunction></Actions></CommandDefinition><CommandDefinition Id="x.Unsupported"><Actions><JavaScriptFunction Library="$webresource:x_/client.js" FunctionName="InventedClient.unsupported"><CrmParameter Value="PrimaryControl"/></JavaScriptFunction></Actions></CommandDefinition><CommandDefinition Id="x.Remote"><Actions><Url Address="https://example.invalid"/></Actions></CommandDefinition></CommandDefinitions><RuleDefinitions><EnableRules><EnableRule Id="x.Existing"><FormStateRule State="Existing"/></EnableRule></EnableRules></RuleDefinitions></RibbonDiffXml>');
  const sim = await initial.start(); sim.origin = sim.origin ?? sim.url; t.after(() => sim.close());
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (new URL(request.url()).origin !== sim.origin) external.push(request.url()); });
  await page.goto(sim.origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  return { page, sim, errors, external };
}

// Native command bars move trailing source actions into More as the workspace narrows.
async function formCommand(page, name) {
  const popup = page.getByRole('menu', { name: 'More commands', exact: true });
  if (await popup.isVisible()) await page.keyboard.press('Escape');
  const direct = page.getByRole('toolbar', { name: 'Commands', exact: true }).getByRole('button', { name, exact: true });
  if (await direct.isVisible()) return direct;
  await page.getByRole('button', { name: 'More commands', exact: true }).click();
  return page.getByRole('menuitem', { name, exact: true });
}

test('Solution form events and ribbon JS run locally through the staff API with save cancellation', async t => {
  const { page, sim, errors, external } = await fixture(t);
  await page.getByText('Exported OnLoad completed', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Calculated quantity', { exact: true }).inputValue(), '2');
  assert.equal(await page.evaluate(() => clientLoads), 1);
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('button', { name: 'Copper child', exact: true }).waitFor();
  assert.equal(await page.getByText('Exported OnLoad completed', { exact: true }).isVisible(), true, 'form notifications persist across tab changes');
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.getByLabel('Calculated quantity', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => clientLoads), 1, 'tab switches do not replay OnLoad');
  const notificationTop = await page.locator('#form-notifications').evaluate(node => node.getBoundingClientRect().top);
  const commandTop = await page.getByRole('toolbar', { name: 'Commands', exact: true }).evaluate(node => node.getBoundingClientRect().top);
  assert.ok(notificationTop < commandTop, 'source notifications sit above the command bar');
  await page.getByLabel('Name', { exact: true }).fill('BLOCK');
  await page.getByLabel('Calculated quantity', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name=x_quantity]').value === '5');
  await (await formCommand(page, 'Save')).click();
  await page.getByText('Choose a different name', { exact: true }).waitFor();
  const unchanged = await (await fetch(sim.origin + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).json();
  assert.equal(unchanged.row.x_name, 'Copper'); assert.equal(unchanged.row.x_quantity, 2);
  await page.getByLabel('Name', { exact: true }).fill('Silver local'); await page.getByLabel('Calculated quantity', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name=x_quantity]').value === '12');
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('heading', { name: 'Silver local', exact: true }).waitFor();
  assert.equal(await page.getByText('Choose a different name', { exact: true }).count(), 0, 'clearing the notification removes its persisted banner');
  await (await formCommand(page, 'Mark reviewed')).click();
  await page.getByRole('heading', { name: 'Reviewed 12', exact: true }).waitFor();
  assert.equal(await (await formCommand(page, 'Unsupported remote action')).isDisabled(), true);
  await (await formCommand(page, 'Unsupported API')).click();
  await page.getByRole('status').filter({ hasText: 'does not support formContext.ui.nonexistentApi' }).waitFor();
  // A handler may navigate. Completion of the disposed form must not overwrite
  // the newly selected record or retain executable form-context references.
  await page.evaluate(() => { window.priorControl = Xrm.Page.getControl('x_name'); InventedClient.load = async () => { if (!window.didRedirect) { window.didRedirect = true; await Xrm.Navigation.openForm({ entityName: 'x_child', entityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }); } }; });
  await (await formCommand(page, 'Refresh')).click();
  await page.getByRole('heading', { name: 'Copper child', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Copper child');
  assert.equal(await page.getByText('Exported OnLoad completed', { exact: true }).count(), 0, 'navigation disposes the previous form notifications');
  assert.match(await page.evaluate(() => { try { priorControl.setVisible(false); return 'unexpected'; } catch (error) { return error.message; } }), /disposed/);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('retry recreates failed client initialization and clears its error after recovery', async t => {
  const { page, errors } = await fixture(t);
  await page.getByText('Exported OnLoad completed', { exact: true }).waitFor();
  await page.evaluate(() => {
    InventedClient.load = async executionContext => {
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
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  assert.equal(await page.evaluate(() => retryLoads), 2);
  assert.equal(await page.locator('#notice').isVisible(), false);
  assert.equal(await page.locator('#record-form').evaluate(node => node.inert), false);
  await page.getByLabel('Name', { exact: true }).fill('Recovered editable record');
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('heading', { name: 'Recovered editable record', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('a source zero-sequence modern form command precedes standard actions and executes its imported handler', async t => {
  const { page, sim, errors } = await fixture(t);
  await page.getByText('Exported OnLoad completed', { exact: true }).waitFor();
  const labels = await page.getByRole('toolbar', { name: 'Commands', exact: true }).locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? node.textContent.trim()));
  assert.ok(labels.indexOf('Early reviewed') > labels.indexOf('Open in new window'));
  assert.equal(labels.includes('Open in VSCode'), false);
  assert.ok(labels.indexOf('Early reviewed') < labels.indexOf('Save'));
  await (await formCommand(page, 'Early reviewed')).click();
  await page.getByRole('heading', { name: 'Reviewed 2', exact: true }).waitFor();
  const row = await (await fetch(sim.url + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).json();
  assert.equal(row.row.x_name, 'Reviewed 2'); assert.equal(row.row.x_quantity, 2);
  assert.deepEqual(errors, []);
});

test('a staff change in another tab revokes extension contexts while retaining the blocked draft', async t => {
  const { page, sim, errors } = await fixture(t);
  await page.getByText('Exported OnLoad completed', { exact: true }).waitFor();
  await page.evaluate(() => { window.priorControl = Xrm.Page.getControl('x_name'); window.priorWebApi = Xrm.WebApi; });
  await page.getByLabel('Name', { exact: true }).fill('Unsaved draft');
  const context = page.context();
  const made = await context.request.post(sim.origin + '/_sim/api/dataverse/users', { headers: { 'x-sim-csrf': sim.state().csrf }, data: { fullname: 'Invented replacement staff', domainname: 'replacement@example.test', roles: ['System Administrator'] } });
  assert.equal(made.status(), 201); const staff = await made.json();
  const selected = await context.request.post(sim.origin + '/_sim/api/dataverse/session', { headers: { 'x-sim-csrf': sim.state().csrf }, data: { userId: staff.systemuserid } }); assert.equal(selected.status(), 200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('status').filter({ hasText: 'The staff session changed in another tab.' }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved draft');
  assert.equal(await page.getByLabel('Name', { exact: true }).isDisabled(), true);
  assert.match(await page.evaluate(() => { try { priorControl.setVisible(false); return 'unexpected'; } catch (error) { return error.message; } }), /disposed/);
  assert.match(await page.evaluate(() => { try { priorWebApi.createRecord('x_item', { x_name: 'stale' }); return 'unexpected'; } catch (error) { return error.message; } }), /disposed/);
  assert.deepEqual(errors, []);
});

test('Solution code stays inert by default while ordinary CRUD continues to work', async t => {
  const { page, sim, errors } = await fixture(t, false);
  assert.equal(await page.evaluate(() => typeof InventedClient), 'undefined');
  assert.equal(await (await formCommand(page, 'Mark reviewed')).isDisabled(), true);
  await page.getByLabel('Name', { exact: true }).fill('BLOCK');
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('heading', { name: 'BLOCK', exact: true }).waitFor();
  const result = await (await fetch(sim.origin + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).json(); assert.equal(result.row.x_name, 'BLOCK');
  assert.deepEqual(errors, []);
});

test('application form and view components select the authored surface before generic table defaults', async t => {
  const initial = await modelDrivenFixture(t); await initial.sim.close();
  const appFile = path.join(initial.solutionDir, 'AppModules/x_example/AppModule.xml');
  await fs.writeFile(appFile, (await fs.readFile(appFile, 'utf8')).replace('</AppModuleComponents>', '<AppModuleComponent type="60" id="{item-form}"/><AppModuleComponent type="26" id="{items-view}"/></AppModuleComponents>'));
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(path.join(path.dirname(formFile), '0-excluded.xml'), (await fs.readFile(formFile, 'utf8')).replace('{item-form}', '{excluded-form}').replace('description="Information"', 'description="Excluded form"').replace('description="Name"', 'description="Excluded name"'));
  const viewFile = path.join(initial.solutionDir, 'Entities/x_item/SavedQueries/items.xml');
  await fs.writeFile(path.join(path.dirname(viewFile), '0-excluded.xml'), (await fs.readFile(viewFile, 'utf8')).replace('{items-view}', '{excluded-view}').replace('Stocked items', 'Excluded view'));
  const sim = await initial.start(); t.after(() => sim.close());
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close()); const page = await browser.newPage();
  await page.goto((sim.origin ?? sim.url) + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  assert.deepEqual(await page.getByRole('menuitemradio').evaluateAll(nodes => nodes.map(node => node.querySelector('span:not(.picker-check)').textContent)), ['Stocked items']);
  await page.keyboard.press('Escape');
  await page.locator('tbody').getByRole('button', { name: 'Copper', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Record form', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Excluded name', { exact: true }).count(), 0);
});

test('form deep links, picker changes, saves and Xrm openForm preserve the selected app-owned form', async t => {
  const initial = await modelDrivenFixture(t); await initial.sim.close();
  const reviewId = 'b1168cab-0940-40f2-a83a-f79675751ade', excludedId = '1603bd23-cd05-4ca3-a16f-31503d42359a';
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml'), xml = await fs.readFile(formFile, 'utf8');
  await fs.writeFile(path.join(path.dirname(formFile), 'review.xml'), xml.replace('{item-form}', `{${reviewId}}`).replace('description="Information"', 'description="Review form"').replace('description="General"', 'description="Review details"'));
  await fs.writeFile(path.join(path.dirname(formFile), 'excluded.xml'), xml.replace('{item-form}', `{${excludedId}}`).replace('description="Information"', 'description="Excluded form"'));
  const appFile = path.join(initial.solutionDir, 'AppModules/x_example/AppModule.xml');
  await fs.writeFile(appFile, (await fs.readFile(appFile, 'utf8')).replace('</AppModuleComponents>', `<AppModuleComponent type="60" id="{item-form}"/><AppModuleComponent type="60" id="{${reviewId}}"/></AppModuleComponents>`));
  const sim = await initial.start(); t.after(() => sim.close());
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const route = sim.url + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.goto(route + '&formid=' + encodeURIComponent(`{${reviewId.toUpperCase()}}`));
  await page.getByRole('tab', { name: 'Review details', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('formid'), reviewId);
  const formGeometry = await page.getByRole('button', { name: 'Record form', exact: true }).evaluate(node => { const picker = node.getBoundingClientRect(), label = node.parentElement.querySelector('small').getBoundingClientRect(); return { gap: picker.left - label.right, vertical: Math.abs(picker.top - label.top) }; });
  assert.ok(formGeometry.gap >= 8 && formGeometry.gap <= 28, 'the form selector follows the entity label inline'); assert.ok(formGeometry.vertical <= 8);
  await page.getByLabel('Name', { exact: true }).fill('Draft across forms');
  await page.getByRole('button', { name: 'Record form', exact: true }).click();
  assert.equal(await page.locator('.form-picker').evaluate(node => node.getBoundingClientRect().width), 203);
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
  await page.reload(); await page.getByRole('tab', { name: 'Review details', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Draft across forms');
  await page.goto(sim.url + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.locator('tbody').getByRole('button', { name: 'Draft across forms', exact: true }).click();
  await page.getByRole('tab', { name: 'Review details', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Record form', exact: true }).innerText(), 'Review form', 'opening a row without formid remembers the selected eligible form for this app and table');
  await page.goto(route + '&formid=' + excludedId);
  await page.getByRole('tab', { name: 'General', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('formid'), 'item-form', 'excluded form IDs fall back to a form belonging to the app');
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  await page.evaluate(async formId => { await Xrm.Navigation.openForm({ entityName: 'x_item', entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', formId }); }, reviewId);
  await page.getByRole('tab', { name: 'Review details', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('formid'), reviewId);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Record form', exact: true }).click();
  const mobile = await page.locator('.form-picker').evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, document: document.documentElement.scrollWidth, viewport: innerWidth }; });
  assert.ok(mobile.left >= 12 && mobile.right <= mobile.viewport - 12); assert.equal(mobile.document, mobile.viewport); await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
});

test('a persisted inactive two-state record disables its default UI while explicit client unlocks and SDK saves retain native behavior', async t => {
  const initial = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } });
  await initial.sim.close();
  const entityFile = path.join(initial.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(entityFile, (await fs.readFile(entityFile, 'utf8')).replace('</attributes>', '<attribute PhysicalName="statecode"><Name>statecode</Name><Type>state</Type><displaynames><displayname description="Status" languagecode="1033"/></displaynames><optionset Name="x_item_statecode"><OptionSetType>state</OptionSetType><states><state value="0" defaultstatus="1" invariantname="Active"><labels><label description="Active" languagecode="1033"/></labels></state><state value="1" defaultstatus="2" invariantname="Inactive"><labels><label description="Inactive" languagecode="1033"/></labels></state></states></optionset></attribute></attributes>'));
  await fs.writeFile(entityFile, (await fs.readFile(entityFile, 'utf8')).replace('<Type>int</Type>', '<Type>int</Type><ValidForUpdateApi>0</ValidForUpdateApi>'));
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(formFile, (await fs.readFile(formFile, 'utf8')).replace('<control datafieldname="x_name"', '<control disabled="true" datafieldname="x_name"').replace('<section name="children"><rows>', '<section name="children"><rows><row><cell><labels><label description="Status" languagecode="1033"/></labels><control datafieldname="statecode"/></cell></row>'));
  await fs.mkdir(path.join(initial.solutionDir, 'WebResources'), { recursive: true });
  await fs.writeFile(path.join(initial.solutionDir, 'WebResources/inactive.js'), 'window.InactiveCommand={run:function(form){form.ui.setFormNotification("Inactive source command ran","INFO","inactive-command")}};');
  await fs.writeFile(path.join(initial.solutionDir, 'WebResources/inactive.js.data.xml'), '<WebResource><WebResourceId>82af175a-50ad-4e9e-9557-65e5e2bc338c</WebResourceId><Name>x_/inactive.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/inactive.js</FileName></WebResource>');
  await fs.mkdir(path.join(initial.solutionDir, 'AppActions/x_inactive'), { recursive: true });
  await fs.writeFile(path.join(initial.solutionDir, 'AppActions/x_inactive/AppAction.xml'), '<appaction uniquename="x_inactive"><buttonlabeltext default="Inactive action"/><context>1</context><contextvalue>x_item</contextvalue><location>0</location><sequence>0.0000000000</sequence><onclickeventjavascriptfunctionname>InactiveCommand.run</onclickeventjavascriptfunctionname><onclickeventjavascriptparameters>[{"type":5,"value":null}]</onclickeventjavascriptparameters><onclickeventjavascriptwebresourceid><webresourceid>82af175a-50ad-4e9e-9557-65e5e2bc338c</webresourceid></onclickeventjavascriptwebresourceid><onclickeventtype>2</onclickeventtype><type>0</type></appaction>');
  await fs.rm(initial.stateFile, { force: true });
  const sim = await initial.start({ initial: { version: 1,
    mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' }, x_child: { entitySet: 'x_children', idColumn: 'x_childid', nameColumn: 'x_name' } },
    tables: { x_item: [{ x_itemid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', x_name: 'Copper', x_quantity: 2, statecode: 1 }], x_child: [] },
  } }); t.after(() => sim.close());
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/_apps/api/tables/x_item') && ['POST', 'PATCH'].includes(request.method())) writes.push(request.method()); });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.goto(sim.url + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=' + id);
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  assert.equal(await page.evaluate(() => Xrm.Page.ui.getFormType()), 4);
  await page.getByRole('button', { name: 'Inactive action', exact: true }).click();
  await page.getByText('Inactive source command ran', { exact: true }).waitFor();
  const commandLabels = await page.getByRole('toolbar', { name: 'Commands', exact: true }).getByRole('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? node.textContent.trim()));
  assert.ok(commandLabels.indexOf('Inactive action') < commandLabels.indexOf('New'), 'source zero-sequence commands precede the first retained action after inactive Save removal');
  assert.equal(await page.evaluate(() => Xrm.Page.getControl('x_name').getLabel()), 'Name', 'client labels retain authored text without required markers or lock glyphs');
  await page.evaluate(() => Xrm.Page.getControl('x_name').setLabel('Updated title'));
  assert.equal(await page.evaluate(() => Xrm.Page.getControl('x_name').getLabel()), 'Updated title');
  assert.equal(await page.locator('label[for="field-x_name"] .required').count(), 1, 'label changes preserve the separate required marker');
  await page.evaluate(() => Xrm.Page.getAttribute('x_name').setRequiredLevel('none'));
  assert.equal(await page.locator('label[for="field-x_name"] .required').count(), 0);
  await page.evaluate(() => { Xrm.Page.getControl('x_name').setLabel('Name'); Xrm.Page.getAttribute('x_name').setRequiredLevel('required'); });
  assert.equal(await page.locator('label[for="field-x_name"] .required').count(), 1);
  assert.equal(await page.locator('#record-status').textContent(), 'Read-only This record’s status: Inactive');
  await page.evaluate(() => Xrm.Page.ui.setFormNotification('Readonly source notification', 'INFO', 'readonly-note'));
  assert.equal(await page.locator('#record-status').evaluate(node => node.nextElementSibling.id), 'form-notifications', 'native read-only status precedes source notifications');
  assert.equal(await page.getByLabel('Name', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Save & Close', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => { Xrm.Page.getControl('x_name').setDisabled(false); return Xrm.Page.getControl('x_name').getDisabled(); }), false);
  assert.equal(await page.evaluate(() => { Xrm.Page.getControl('x_quantity').setDisabled(false); return Xrm.Page.getControl('x_quantity').getDisabled(); }), true, 'a presentation override cannot enable a column denied by update metadata');
  assert.match(await page.evaluate(() => { try { Xrm.Page.getAttribute('x_quantity').setValue(9); return 'unexpected'; } catch (error) { return error.message; } }), /cannot be changed/);
  await page.getByLabel('Name', { exact: true }).fill('Unlocked inactive draft');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  assert.equal(await page.locator('#record-status').count(), 1); assert.match(await page.locator('#record-status').textContent(), /Inactive$/);
  assert.equal(await page.getByText('Readonly source notification', { exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => Xrm.Page.getControl('statecode').getDisabled()), true);
  assert.equal(await page.evaluate(() => Xrm.Page.getControl('x_quantity').getDisabled()), true, 'source denial remains accurately reported while its control is on another tab');
  assert.equal(await page.evaluate(() => Xrm.Page.ui.getFormType()), 4);
  assert.deepEqual(writes, [], 'default inactive navigation and an unlocked draft do not save automatically');
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  assert.equal(await page.getByLabel('Name', { exact: true }).isEnabled(), true, 'an explicit client unlock survives tab rendering');
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Unlocked inactive draft');
  await page.evaluate(async () => { Xrm.Page.getAttribute('x_name').setValue('Inactive SDK edit'); await Xrm.Page.data.save(); });
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  assert.deepEqual(writes, ['PATCH'], 'an explicit SDK save persists the inactive draft once');
  const inactiveSaved = await (await page.request.get(sim.url + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(inactiveSaved.row.x_name, 'Inactive SDK edit'); assert.equal(inactiveSaved.row.statecode, 1);
  assert.equal(await page.evaluate(() => Xrm.Page.ui.getFormType()), 4);
  assert.equal(await page.getByLabel('Name', { exact: true }).isDisabled(), true, 'reload after save restores default inactive presentation');
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  // A disabled presentation does not remove independent staff Web API rights.
  await page.evaluate(async id => Xrm.WebApi.updateRecord('x_item', id, { statecode: 0 }), id);
  assert.equal(await page.evaluate(() => Xrm.Page.ui.getFormType()), 4, 'the loaded form remains disabled until refreshed');
  let releaseRead;
  const holdRead = new Promise(resolve => { releaseRead = resolve; }), recordRead = sim.url + '/_apps/api/tables/x_item/' + id;
  t.after(() => releaseRead());
  await page.route(recordRead, async route => { await holdRead; await route.continue(); }, { times: 1 });
  const readPending = page.waitForRequest(recordRead);
  await (await formCommand(page, 'Refresh')).click();
  await readPending;
  assert.equal(await page.getByLabel('Name', { exact: true }).isVisible(), true, 'the old label stays visible while its form context is disposed');
  assert.equal(await page.locator('#content').evaluate(node => node.inert), true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.mirageAppState), 'loading');
  assert.match(await page.evaluate(() => { try { Xrm.Page.ui.getFormType(); return 'unexpected'; } catch (error) { return error.message; } }), /disposed/);
  releaseRead();
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  assert.equal(await page.evaluate(() => Xrm.Page.ui.getFormType()), 2);
  assert.equal(await page.locator('#record-status').count(), 0, 'refreshing an activated record removes its old status strip');
  assert.equal(await page.getByLabel('Name', { exact: true }).isDisabled(), true, 'source-authored read-only presentation remains the default on an active form');
  await page.evaluate(() => Xrm.Page.getAttribute('x_name').setValue('Copper'));
  assert.equal(await page.getByLabel('Name', { exact: true }).isDisabled(), true, 'SDK attribute writes do not implicitly unlock a source-disabled control');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.evaluate(() => Xrm.Page.getAttribute('statecode').setValue(1));
  assert.equal(await page.evaluate(() => Xrm.Page.ui.getFormType()), 2, 'draft state transitions stay editable until saved');
  await (await formCommand(page, 'Save')).click();
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  assert.equal(await page.evaluate(() => Xrm.Page.ui.getFormType()), 4);
  const saved = await (await page.request.get(sim.url + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(saved.row.statecode, 1); assert.equal(saved.row.x_name, 'Copper');
  assert.equal(await page.locator('#record-status').count(), 1);
  await page.goto(sim.url + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  assert.equal(await page.locator('#record-status').count(), 0, 'the inactive record strip cannot leak onto a grid');
  assert.deepEqual(errors, []);
});
