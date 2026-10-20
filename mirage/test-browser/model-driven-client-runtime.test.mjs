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
  await fs.writeFile(path.join(initial.solutionDir, 'WebResources/client.js.data.xml'), '<WebResource><Name>x_/client.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/client.js</FileName></WebResource>');
  await fs.writeFile(path.join(initial.solutionDir, 'Entities/x_item/RibbonDiff.xml'), '<RibbonDiffXml><CustomActions><CustomAction><CommandUIDefinition><Button Id="x.Form.Mark" Command="x.Mark" LabelText="Mark reviewed"/></CommandUIDefinition></CustomAction><CustomAction><CommandUIDefinition><Button Id="x.Form.Unsupported" Command="x.Unsupported" LabelText="Unsupported API"/></CommandUIDefinition></CustomAction><CustomAction><CommandUIDefinition><Button Id="x.Form.Remote" Command="x.Remote" LabelText="Unsupported remote action"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="x.Mark"><EnableRules><EnableRule Id="x.Existing"/></EnableRules><Actions><JavaScriptFunction Library="$webresource:x_/client.js" FunctionName="InventedClient.mark"><CrmParameter Value="PrimaryControl"/></JavaScriptFunction></Actions></CommandDefinition><CommandDefinition Id="x.Unsupported"><Actions><JavaScriptFunction Library="$webresource:x_/client.js" FunctionName="InventedClient.unsupported"><CrmParameter Value="PrimaryControl"/></JavaScriptFunction></Actions></CommandDefinition><CommandDefinition Id="x.Remote"><Actions><Url Address="https://example.invalid"/></Actions></CommandDefinition></CommandDefinitions><RuleDefinitions><EnableRules><EnableRule Id="x.Existing"><FormStateRule State="Existing"/></EnableRule></EnableRules></RuleDefinitions></RibbonDiffXml>');
  const sim = await initial.start(); sim.origin = sim.origin ?? sim.url; t.after(() => sim.close());
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (new URL(request.url()).origin !== sim.origin) external.push(request.url()); });
  await page.goto(sim.origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  return { page, sim, errors, external };
}

test('Solution form events and ribbon JS run locally through the staff API with save cancellation', async t => {
  const { page, sim, errors, external } = await fixture(t);
  await page.getByText('Exported OnLoad completed', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Calculated quantity', { exact: true }).inputValue(), '2');
  assert.equal(await page.evaluate(() => clientLoads), 1);
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('button', { name: 'Copper child', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.getByLabel('Calculated quantity', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => clientLoads), 1, 'tab switches do not replay OnLoad');
  await page.getByLabel('Name', { exact: true }).fill('BLOCK');
  await page.getByLabel('Calculated quantity', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name=x_quantity]').value === '5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Choose a different name', { exact: true }).waitFor();
  const unchanged = await (await fetch(sim.origin + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).json();
  assert.equal(unchanged.row.x_name, 'Copper'); assert.equal(unchanged.row.x_quantity, 2);
  await page.getByLabel('Name', { exact: true }).fill('Silver local'); await page.getByLabel('Calculated quantity', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name=x_quantity]').value === '12');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Silver local', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.getByRole('heading', { name: 'Reviewed 12', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Unsupported remote action', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Unsupported API', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'does not support formContext.ui.nonexistentApi' }).waitFor();
  // A handler may navigate. Completion of the disposed form must not overwrite
  // the newly selected record or retain executable form-context references.
  await page.evaluate(() => { window.priorControl = Xrm.Page.getControl('x_name'); InventedClient.load = async () => { if (!window.didRedirect) { window.didRedirect = true; await Xrm.Navigation.openForm({ entityName: 'x_child', entityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }); } }; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('heading', { name: 'Copper child', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Copper child');
  assert.match(await page.evaluate(() => { try { priorControl.setVisible(false); return 'unexpected'; } catch (error) { return error.message; } }), /disposed/);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
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
  assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).isDisabled(), true);
  await page.getByLabel('Name', { exact: true }).fill('BLOCK');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
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
  assert.deepEqual(await page.getByRole('combobox', { name: 'View', exact: true }).locator('option').allTextContents(), ['Stocked items']);
  await page.locator('tbody').getByRole('button', { name: 'Copper', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Record form', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Excluded name', { exact: true }).count(), 0);
});
