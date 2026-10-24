import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser();

test('native shell selectors filter, navigate, dismiss and preserve keyboard focus', async (t) => {
  const fixture = await modelDrivenFixture(t);
  await fixture.sim.close();
  const appRoot = path.join(fixture.solutionDir, 'AppModules/x_review');
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(
    path.join(appRoot, 'AppModule.xml'),
    '<AppModule><UniqueName>x_review</UniqueName><AppModuleId>{88888888-8888-4888-8888-888888888888}</AppModuleId><LocalizedNames><LocalizedName description="Review workspace" languagecode="1033"/></LocalizedNames><Descriptions><Description description="Review invented records" languagecode="1033"/></Descriptions><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>',
  );
  await fs.writeFile(
    path.join(fixture.solutionDir, 'Entities/x_item/SavedQueries/empty.xml'),
    '<savedquery><savedqueryid>{empty-view}</savedqueryid><querytype>0</querytype><LocalizedNames><LocalizedName description="Empty items" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="x_item"><attribute name="x_name"/><attribute name="x_quantity"/><filter><condition attribute="x_quantity" operator="eq" value="0"/></filter></entity></fetch></fetchxml><layoutxml><grid><row><cell name="x_name" width="200"/><cell name="x_quantity" width="100"/></row></grid></layoutxml></savedquery>',
  );
  const formFile = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    formFile,
    (await fs.readFile(formFile, 'utf8')).replace(
      '</rows>',
      '<row><cell visible="false"><labels><label description="Hidden quantity" languagecode="1033"/></labels><control datafieldname="x_quantity"/></cell></row></rows>',
    ),
  );
  const sim = await fixture.start();
  t.after(() => sim.close());
  const page = await chrome.page(t, { viewport: { width: 1582, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto((sim.origin ?? sim.url) + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const apps = page.getByRole('button', { name: 'Application', exact: true });
  await apps.click();
  const modal = page.getByRole('dialog', { name: 'Apps', exact: true });
  await modal.waitFor();
  assert.equal(await modal.evaluate((node) => Math.round(node.getBoundingClientRect().width)), 1424);
  assert.equal(await modal.evaluate((node) => Math.round(node.getBoundingClientRect().height)), 900);
  const card = modal.getByRole('button', { name: 'Review workspace', exact: true });
  assert.deepEqual(
    await card.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return [rect.width, rect.height];
    }),
    [218, 238],
  );
  await page.getByRole('searchbox', { name: 'Search my apps' }).fill('no matching app');
  await modal.getByRole('status').filter({ hasText: 'No apps found' }).waitFor();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await apps.getAttribute('aria-expanded'), 'false');
  assert.equal(await apps.evaluate((node) => document.activeElement === node), true);
  await apps.click();
  await page.getByRole('searchbox', { name: 'Search my apps' }).fill('Review');
  let releaseMetadata, metadataRequested;
  const metadataGate = new Promise((resolve) => {
    releaseMetadata = resolve;
  });
  const pendingMetadata = new Promise((resolve) => {
    metadataRequested = resolve;
  });
  t.after(() => releaseMetadata());
  await page.route('**/_apps/api/metadata/x_item', async (route) => {
    metadataRequested();
    await metadataGate;
    await route.continue();
  });
  await card.click();
  await page.waitForURL(/appname=x_review/);
  await pendingMetadata;
  assert.equal(
    await page.getByRole('button', { name: 'Copper', exact: true }).count(),
    0,
    'Previous route data is retired before metadata loads.',
  );
  assert.equal(
    await page.getByRole('button', { name: 'View', exact: true }).count(),
    0,
    'Previous route commands cannot receive keyboard focus.',
  );
  const refreshedMetadata = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/_apps/api/metadata/x_item',
  );
  releaseMetadata();
  await (await refreshedMetadata).finished();
  await page.unroute('**/_apps/api/metadata/x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const views = page.getByRole('button', { name: 'View', exact: true });
  await views.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('dialog', { name: 'View Options', exact: true });
  assert.equal(await menu.evaluate((node) => node.getBoundingClientRect().width), 312);
  await menu.getByRole('searchbox', { name: 'Search views' }).fill('Empty');
  assert.equal(await menu.getByRole('menuitemradio').count(), 1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Empty', exact: true }).waitFor();
  assert.match(page.url(), /viewid=empty-view/);
  assert.equal(await page.getByRole('button', { name: 'Copper', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  assert.equal(
    await page.getByLabel('Hidden quantity', { exact: true }).isHidden(),
    true,
    'hidden exported controls must remain outside layout despite the field grid styling',
  );
  assert.equal(await page.getByLabel('Hidden quantity', { exact: true }).boundingBox(), null);
  await page.getByRole('tab', { name: 'General', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('tab', { name: 'Related items', exact: true, selected: true }).waitFor();
  assert.equal(
    await page
      .getByRole('tab', { name: 'Related items', exact: true })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  assert.equal(await page.getByRole('tabpanel').getAttribute('aria-labelledby'), 'record-tab-1');
  await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  assert.equal(await page.locator('aside').evaluate((node) => node.getBoundingClientRect().width), 43);
  const activeNavigation = page.locator('#navigation button[aria-current="page"]');
  assert.equal(await activeNavigation.isVisible(), true);
  assert.equal(await activeNavigation.locator('svg').isVisible(), true);
  await page.getByLabel('Recent', { exact: true }).click();
  assert.equal(await page.locator('details[open] .navigation-history').isVisible(), true);
  await activeNavigation.click();
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('column menu applies sorting, reordering, widths and column-specific filters', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t, { viewport: { width: 1582, height: 1000 } });
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  // Keep the old Copper row visible while a filtered refresh is in flight.
  // Waiting for that row alone cannot prove the new grid was applied.
  await page.route('**/_apps/api/tables/x_item?*', async (route) => {
    const query = JSON.parse(new URL(route.request().url()).searchParams.get('query') ?? '{}');
    if (query.filters?.some((filter) => filter.value === 'Copper'))
      await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  const gridChange = async (action) => {
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' && new URL(response.url()).pathname === '/_apps/api/tables/x_item',
    );
    await action();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready');
  };
  await page.getByRole('button', { name: 'Edit columns', exact: true }).click();
  const columns = page.getByRole('dialog', { name: /^Edit columns:/ });
  assert.deepEqual(
    await columns.evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return [x, y, width, height];
    }),
    [1112, 0, 470, 1000],
  );
  assert.equal(await columns.getByRole('button', { name: 'Apply', exact: true }).isDisabled(), true);
  assert.equal(await columns.getByRole('button', { name: 'Reset to default', exact: true }).isDisabled(), true);
  await columns.getByRole('button', { name: 'Quantity column options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
  assert.equal(await columns.getByRole('button', { name: 'Reset to default', exact: true }).isDisabled(), false);
  await columns.getByRole('button', { name: 'Add columns', exact: true }).click();
  const addColumns = page.getByRole('dialog', { name: 'Add columns', exact: true });
  assert.equal(await addColumns.evaluate((node) => node.getBoundingClientRect().width), 340);
  assert.equal(await addColumns.locator('.add-column-search>.icon-search').count(), 1);
  await addColumns.getByRole('searchbox', { name: 'Search columns' }).fill('Quantity');
  await addColumns.getByRole('button', { name: 'Quantity', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await columns.isVisible(), true, 'Escape closes the child column browser first');
  assert.equal(
    await columns
      .getByRole('button', { name: 'Add columns', exact: true })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  assert.equal(
    await columns.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
    true,
    're-adding the same last column restores the original draft',
  );
  await columns.getByRole('button', { name: 'Cancel', exact: true }).click();
  const nameHeader = page.locator('thead').getByRole('button', { name: /^Name/ });
  await nameHeader.click();
  const menu = page.getByRole('menu', { name: 'Name column options', exact: true });
  assert.equal(await menu.evaluate((node) => node.getBoundingClientRect().width), 180);
  assert.equal(await menu.getByRole('menuitem', { name: 'Group by', exact: true }).isDisabled(), true);
  await gridChange(() => menu.getByRole('menuitemradio', { name: 'Z to A', exact: true }).click());
  await page.waitForFunction(() => document.querySelector('tbody tr button')?.textContent === 'Silver');
  assert.equal(await nameHeader.locator('..').getAttribute('aria-sort'), 'descending');
  await nameHeader.click();
  await menu.getByRole('menuitem', { name: 'Column width', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Width (pixels)' }).fill('320');
  await gridChange(() => page.getByRole('button', { name: 'Apply', exact: true }).click());
  await nameHeader.waitFor();
  assert.equal(
    await page
      .locator('colgroup col')
      .nth(1)
      .evaluate((node) => node.style.width),
    '320px',
  );
  await nameHeader.click();
  await gridChange(() => menu.getByRole('menuitem', { name: 'Move right', exact: true }).click());
  await page.waitForFunction(() => document.querySelector('thead th:nth-child(2)')?.textContent.includes('Quantity'));
  await nameHeader.click();
  assert.equal(await menu.getByRole('menuitem', { name: 'Move right', exact: true }).isDisabled(), true);
  await menu.getByRole('menuitem', { name: 'Filter by', exact: true }).click();
  assert.deepEqual(
    await page.getByRole('dialog', { name: /^Edit filters:/ }).evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return [x, y, width, height];
    }),
    [606, 0, 976, 1000],
  );
  assert.equal(await page.getByRole('button', { name: 'Filter 1 column', exact: true }).textContent(), 'Name');
  await page.getByLabel('Filter 1 value').fill('Copper');
  await gridChange(() => page.getByRole('button', { name: 'Apply', exact: true }).click());
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Silver', exact: true }).count(), 0);
});

test('filter drawer uses typed scalar values, literal contains, null conditions and isolated drafts', async (t) => {
  const fixture = await modelDrivenFixture(t);
  await fixture.sim.close();
  const entityFile = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  const labels = (label) => `<displaynames><displayname description="${label}" languagecode="1033"/></displaynames>`;
  const option = (value, label) =>
    `<option value="${value}"><labels><label description="${label}" languagecode="1033"/></labels></option>`;
  const attributes = `<attribute PhysicalName="x_available"><Name>x_available</Name><Type>bit</Type>${labels('Available')}<optionset Name="x_available"><options>${option(0, 'Unavailable')}${option(1, 'Available')}</options></optionset></attribute><attribute PhysicalName="x_stage"><Name>x_stage</Name><Type>picklist</Type>${labels('Stage')}<optionset Name="x_stage"><options>${option(3, 'Routine')}${option(7, 'Urgent')}</options></optionset></attribute><attribute PhysicalName="x_due"><Name>x_due</Name><Type>datetime</Type><Format>dateonly</Format><DateTimeBehavior>DateOnly</DateTimeBehavior>${labels('Due date')}</attribute>`;
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace('</attributes>', attributes + '</attributes>'),
  );
  const sim = await fixture.start();
  t.after(() => sim.close());
  const origin = sim.origin ?? sim.url;
  for (const [x_name, x_available, x_stage, x_quantity] of [
    ['Literal %_[box]', false, 3, 3],
    ['Ready for review', true, 7, 6],
  ]) {
    const response = await fetch(origin + '/_apps/api/tables/x_item', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf },
      body: JSON.stringify({ x_name, x_available, x_stage, x_quantity, x_due: '2026-04-12' }),
    });
    assert.equal(response.status, 201, await response.clone().text());
  }
  const page = await chrome.page(t, { viewport: { width: 1582, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const drawer = page.getByRole('dialog', { name: /^Edit filters:/ });
  const field = async (name) => {
    await drawer.getByRole('button', { name: 'Filter 1 column', exact: true }).click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
  };
  const operator = async (name) => {
    await drawer.getByRole('button', { name: 'Filter 1 operator', exact: true }).click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
  };
  const apply = async (expected) => {
    const request = page.waitForRequest(
      (request) => request.method() === 'GET' && new URL(request.url()).pathname === '/_apps/api/tables/x_item',
    );
    await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
    assert.deepEqual(JSON.parse(new URL((await request).url()).searchParams.get('query')).filters[0], expected);
    await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready');
  };
  await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
  await drawer.getByRole('button', { name: 'Add condition' }).click();
  await operator('Contains');
  await drawer.getByLabel('Filter 1 value').fill('%_[box]');
  await apply({ field: 'x_name', operator: 'contains', value: '%_[box]' });
  assert.equal(await page.locator('tbody tr').count(), 1);
  await page.getByRole('button', { name: 'Literal %_[box]', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
  assert.equal(await drawer.getByLabel('Filter 1 value').inputValue(), '%_[box]');
  await field('Quantity');
  assert.equal(await drawer.getByRole('spinbutton', { name: 'Filter 1 value' }).count(), 1);
  await operator('Greater than');
  await drawer.getByLabel('Filter 1 value').fill('4');
  await apply({ field: 'x_quantity', operator: 'gt', value: 4 });
  assert.equal(await page.getByRole('button', { name: 'Copper', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Silver', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
  await field('Available');
  assert.equal(await drawer.getByRole('button', { name: 'Filter 1 operator' }).textContent(), 'Equals');
  await drawer.getByRole('combobox', { name: 'Filter 1 value' }).click();
  await page.getByRole('option', { name: 'Unavailable', exact: true }).click();
  await apply({ field: 'x_available', operator: 'eq', value: 0 });
  await page.getByRole('button', { name: 'Literal %_[box]', exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 1);
  await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
  assert.equal(await drawer.getByRole('combobox', { name: 'Filter 1 value' }).inputValue(), 'Unavailable');
  await field('Stage');
  const choice = drawer.getByRole('combobox', { name: 'Filter 1 value' });
  await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await drawer.isVisible(), true, 'an empty choice cannot silently become a raw empty-string query');
  await choice.click();
  await page.getByRole('option', { name: 'Urgent', exact: true }).click();
  await apply({ field: 'x_stage', operator: 'eq', value: 7 });
  await page.getByRole('button', { name: 'Ready for review', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
  await operator('Does not contain data');
  assert.equal(await drawer.getByRole('combobox', { name: 'Filter 1 value' }).isDisabled(), true);
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
  assert.equal(await drawer.getByRole('button', { name: 'Filter 1 operator' }).textContent(), 'Equals');
  assert.equal(await drawer.getByRole('combobox', { name: 'Filter 1 value' }).inputValue(), 'Urgent');
  await field('Due date');
  const date = drawer.getByRole('combobox', { name: 'Filter 1 value', exact: true });
  await date.fill('incomplete');
  await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await drawer.isVisible(), true);
  assert.equal(await date.evaluate((node) => node.checkValidity()), false);
  await date.fill('4/12/2026');
  await date.press('Tab');
  assert.equal(await date.evaluate((node) => node.checkValidity()), true);
  await field('Stage');
  await drawer.getByRole('combobox', { name: 'Filter 1 value' }).click();
  assert.equal(await page.getByRole('listbox').isVisible(), true);
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.getByRole('listbox').count(), 0, 'closing the drawer disposes the active value popup');
  assert.deepEqual(errors, []);
});

test('new required owner controls default to the active organization staff principal', async (t) => {
  const initial = await modelDrivenFixture(t);
  await initial.sim.close();
  const entityFile = path.join(initial.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8'))
      .replace('<PrimaryIdAttribute>', '<OwnershipTypeMask>UserOwned</OwnershipTypeMask><PrimaryIdAttribute>')
      .replace(
        '</attributes>',
        '<attribute PhysicalName="OwnerId"><Name>ownerid</Name><LogicalName>ownerid</LogicalName><Type>owner</Type><RequiredLevel>systemrequired</RequiredLevel><displaynames><displayname description="Owner" languagecode="1033"/></displaynames></attribute></attributes>',
      ),
  );
  const formFile = path.join(initial.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    formFile,
    (await fs.readFile(formFile, 'utf8')).replace(
      '<control id="unimplemented"/>',
      '<control datafieldname="ownerid"/>',
    ),
  );
  const userRoot = path.join(initial.solutionDir, 'Entities/systemuser');
  await fs.mkdir(userRoot, { recursive: true });
  await fs.writeFile(
    path.join(userRoot, 'Entity.xml'),
    '<Entity><Name>systemuser</Name><EntityInfo><entity Name="systemuser"><EntitySetName>systemusers</EntitySetName><PrimaryIdAttribute>systemuserid</PrimaryIdAttribute><PrimaryNameAttribute>fullname</PrimaryNameAttribute><attributes><attribute PhysicalName="systemuserid"><Name>systemuserid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="fullname"><Name>fullname</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
  );
  const sim = await initial.start();
  t.after(() => sim.close());
  const origin = sim.origin ?? sim.url;
  const page = await chrome.page(t);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item');
  await page.getByLabel('Owner', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Owner', { exact: true }).inputValue(), 'Local administrator');
  await page.getByLabel('Name', { exact: true }).fill('Owned by local administrator');
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/_apps/api/tables/x_item',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const created = await createResponse;
  assert.equal(created.status(), 201, await created.text());
  await page.getByRole('heading', { name: 'Owned by local administrator', exact: true }).waitFor();
  const response = await fetch(origin + '/_sim/api/dataverse/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf },
    body: JSON.stringify({
      fullname: 'Invented record owner',
      domainname: 'owner@example.test',
      roles: ['System Administrator'],
    }),
  });
  assert.equal(response.status, 201);
  const user = await response.json();
  await page.getByRole('button', { name: 'Staff profile', exact: true }).click();
  await page.getByLabel('Organization staff', { exact: true }).selectOption(user.systemuserid);
  let releaseIdentity, identityRequested, releaseOldSession, oldSessionRequested;
  const identityGate = new Promise((resolve) => {
    releaseIdentity = resolve;
  });
  const pendingIdentity = new Promise((resolve) => {
    identityRequested = resolve;
  });
  const oldSessionGate = new Promise((resolve) => {
    releaseOldSession = resolve;
  });
  const pendingOldSession = new Promise((resolve) => {
    oldSessionRequested = resolve;
  });
  let holdOldSession = true;
  t.after(() => releaseIdentity());
  t.after(() => releaseOldSession());
  await page.route('**/_sim/api/dataverse/session', async (route) => {
    if (route.request().method() === 'GET' && holdOldSession) {
      holdOldSession = false;
      const response = await route.fetch();
      oldSessionRequested();
      await oldSessionGate;
      return route.fulfill({ response });
    }
    if (route.request().method() === 'POST') {
      identityRequested();
      await identityGate;
    }
    await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pendingOldSession;
  await page.getByRole('button', { name: 'Use identity', exact: true }).click();
  await pendingIdentity;
  assert.equal(
    await page.getByRole('button', { name: 'New', exact: true }).count(),
    0,
    'The old principal cannot start a new record during identity change.',
  );
  assert.equal(
    await page.getByLabel('Owner', { exact: true }).count(),
    0,
    'The previous form is retired after accepting the dirty guard.',
  );
  releaseIdentity();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Owner', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Owner', { exact: true }).inputValue(), 'Invented record owner');
  const staleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === '/_sim/api/dataverse/session',
  );
  releaseOldSession();
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.match(
    await page.getByRole('button', { name: 'Staff profile', exact: true }).getAttribute('title'),
    /^Invented record owner/,
    'A staff-session read started before switching cannot restore the old identity.',
  );
  await page.getByLabel('Name', { exact: true }).fill('Owned by selected staff');
  const submitted = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/_apps/api/tables/x_item',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await submitted).postDataJSON().ownerid.id, user.systemuserid);
  await page.getByRole('heading', { name: 'Owned by selected staff', exact: true }).waitFor();
});

test('subgrid exported view picker preserves its named parent relationship across view and search changes', async (t) => {
  const fixture = await modelDrivenFixture(t);
  await fixture.sim.close();
  const formFile = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    formFile,
    (await fs.readFile(formFile, 'utf8')).replace(
      '<RecordsPerPage>10</RecordsPerPage>',
      '<RecordsPerPage>1</RecordsPerPage><EnableQuickFind>true</EnableQuickFind><EnableViewPicker>true</EnableViewPicker><ViewIds>{children-view},{reviewed-view}</ViewIds><RelationshipName>x_item_children</RelationshipName>',
    ),
  );
  const childFile = path.join(fixture.solutionDir, 'Entities/x_child/Entity.xml');
  await fs.writeFile(
    childFile,
    (await fs.readFile(childFile, 'utf8')).replace(
      '</attributes>',
      '<attribute PhysicalName="x_otherparentid"><Name>x_otherparentid</Name><Type>lookup</Type></attribute></attributes>',
    ),
  );
  const relationshipFile = path.join(fixture.solutionDir, 'Other/Relationships.xml');
  await fs.writeFile(
    relationshipFile,
    (await fs.readFile(relationshipFile, 'utf8')).replace(
      '</EntityRelationships>',
      '<EntityRelationship Name="x_item_otherchildren"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>x_child</ReferencingEntityName><ReferencedEntityName>x_item</ReferencedEntityName><ReferencingAttributeName>x_otherparentid</ReferencingAttributeName><ReferencedAttributeName>x_itemid</ReferencedAttributeName></EntityRelationship></EntityRelationships>',
    ),
  );
  const baseView = await fs.readFile(
    path.join(fixture.solutionDir, 'Entities/x_child/SavedQueries/children.xml'),
    'utf8',
  );
  await fs.writeFile(
    path.join(fixture.solutionDir, 'Entities/x_child/SavedQueries/reviewed.xml'),
    baseView
      .replace('{children-view}', '{reviewed-view}')
      .replace('<isdefault>1</isdefault>', '<isdefault>0</isdefault>')
      .replace('description="Children"', 'description="Reviewed children"')
      .replace(
        '</entity>',
        '<filter><condition attribute="x_name" operator="begins-with" value="Reviewed"/></filter></entity>',
      ),
  );
  await fs.writeFile(
    path.join(fixture.solutionDir, 'Entities/x_child/SavedQueries/excluded.xml'),
    baseView
      .replace('{children-view}', '{excluded-view}')
      .replace('<isdefault>1</isdefault>', '<isdefault>0</isdefault>')
      .replace('description="Children"', 'description="Excluded children"'),
  );
  const sim = await fixture.start();
  t.after(() => sim.close());
  const origin = sim.origin ?? sim.url,
    parent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    otherParent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  for (const [x_name, x_parentid, x_otherparentid] of [
    ['Reviewed own child', parent, otherParent],
    ['Reviewed foreign child', otherParent, parent],
  ]) {
    const response = await fetch(origin + '/_apps/api/tables/x_child', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf },
      body: JSON.stringify({ x_name, x_parentid, x_otherparentid }),
    });
    assert.equal(response.status, 201, await response.clone().text());
  }
  const page = await chrome.page(t);
  page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=' + parent);
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  const grid = page.locator('.related-grid'),
    picker = grid.getByRole('button', { name: 'View for Related children', exact: true });
  await grid.getByRole('button', { name: 'Copper child', exact: true }).waitFor();
  const toolbarGap = await grid.evaluate(
    (node) =>
      node.querySelector('[data-action=new-related]').getBoundingClientRect().left -
      node.querySelector('.subgrid-view-picker').getBoundingClientRect().right,
  );
  assert.ok(toolbarGap > 150, 'subgrid commands align at the right side rather than crowding the view selector');
  await grid.getByRole('button', { name: 'Next related records', exact: false }).click();
  await grid.getByRole('button', { name: 'Reviewed own child', exact: true }).waitFor();
  await picker.click();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Excluded children', exact: true }).count(), 0);
  const request = page.waitForRequest(
    (request) => request.method() === 'GET' && new URL(request.url()).pathname === '/_apps/api/tables/x_child',
  );
  await page.getByRole('menuitemradio', { name: 'Reviewed children', exact: true }).click();
  const query = JSON.parse(new URL((await request).url()).searchParams.get('query'));
  assert.equal(query.view, 'reviewed-view');
  assert.equal(query.page, 1);
  assert.deepEqual(query.filters, [{ field: 'x_parentid', operator: 'eq', value: parent }]);
  await page.waitForFunction(() => document.querySelector('.related-results')?.getAttribute('aria-busy') === 'false');
  assert.equal(await grid.getByRole('button', { name: 'Reviewed foreign child', exact: true }).count(), 0);
  assert.equal(await grid.getByRole('button', { name: 'Copper child', exact: true }).count(), 0);
  await grid.getByRole('button', { name: 'Reviewed own child', exact: true }).waitFor();
  await picker.click();
  assert.equal(
    await page.getByRole('menuitemradio', { name: 'Reviewed children', exact: true }).getAttribute('aria-checked'),
    'true',
  );
  await page.keyboard.press('Escape');
  await grid
    .getByRole('searchbox', { name: 'Filter Related children by keyword', exact: true })
    .fill('no matching child');
  await grid.getByText('No related records.', { exact: true }).waitFor();
  await grid.getByRole('searchbox', { name: 'Filter Related children by keyword', exact: true }).fill('Reviewed');
  await grid.getByRole('button', { name: 'Reviewed own child', exact: true }).waitFor();
  await grid.locator('[data-action=new-related]').click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), parent);
});

test('populated grids preserve source widths, numeric alignment, compact rows and typed owner navigation', async (t) => {
  const fixture = await modelDrivenFixture(t);
  await fixture.sim.close();
  const entityFile = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8'))
      .replace('<PrimaryIdAttribute>', '<OwnershipTypeMask>UserOwned</OwnershipTypeMask><PrimaryIdAttribute>')
      .replace(
        '</attributes>',
        '<attribute PhysicalName="OwnerId"><Name>ownerid</Name><Type>owner</Type><displaynames><displayname description="Owner" languagecode="1033"/></displaynames></attribute></attributes>',
      ),
  );
  const userRoot = path.join(fixture.solutionDir, 'Entities/systemuser');
  await fs.mkdir(userRoot, { recursive: true });
  await fs.writeFile(
    path.join(userRoot, 'Entity.xml'),
    '<Entity><Name>systemuser</Name><EntityInfo><entity Name="systemuser"><EntitySetName>systemusers</EntitySetName><PrimaryIdAttribute>systemuserid</PrimaryIdAttribute><PrimaryNameAttribute>fullname</PrimaryNameAttribute><attributes><attribute PhysicalName="systemuserid"><Name>systemuserid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="fullname"><Name>fullname</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
  );
  const viewFile = path.join(fixture.solutionDir, 'Entities/x_item/SavedQueries/items.xml');
  await fs.writeFile(
    viewFile,
    (await fs.readFile(viewFile, 'utf8')).replace(
      '<row><cell name="x_name" width="200"/><cell name="x_quantity" width="100"/></row>',
      '<row><cell name="x_quantity" width="700"/><cell name="x_name" width="700"/><cell name="ownerid" width="250"/></row>',
    ),
  );
  const sim = await fixture.start();
  t.after(() => sim.close());
  const origin = sim.origin ?? sim.url;
  const session = await (await fetch(origin + '/_sim/api/dataverse/session')).json(),
    userId = session.current.principalId ?? session.current.id,
    userName = session.current.name;
  const ownerRecord = await (await fetch(origin + '/_apps/api/tables/systemuser/' + userId)).json(),
    ownerName = ownerRecord.row.fullname;
  const createdResponse = await fetch(origin + '/_apps/api/tables/x_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf },
    body: JSON.stringify({
      x_name: 'Owned wide row',
      x_quantity: 4,
      ownerid: { id: userId, entity: 'systemuser', name: userName },
    }),
  });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const page = await chrome.page(t, { viewport: { width: 1100, height: 800 } });
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  const row = page
    .locator('.grid-scroll tbody tr')
    .filter({ has: page.getByRole('button', { name: 'Owned wide row', exact: true }) });
  await row.waitFor();
  const geometry = await page.locator('.grid-scroll').evaluate((node) => ({
    viewport: node.clientWidth,
    scroll: node.scrollWidth,
    table: node.querySelector('table').getBoundingClientRect().width,
    document: document.documentElement.scrollWidth,
    window: innerWidth,
  }));
  assert.ok(geometry.scroll > geometry.viewport, 'wide exported columns scroll inside the grid');
  assert.ok(geometry.table >= 1698, 'the exported column widths are not squeezed into percentages');
  assert.equal(geometry.document, geometry.window);
  assert.equal(await row.evaluate((node) => node.getBoundingClientRect().height), 42);
  assert.equal(
    await row
      .locator('td')
      .nth(1)
      .evaluate((node) => getComputedStyle(node).textAlign),
    'right',
  );
  assert.equal(
    await row.locator('td').nth(1).getByRole('button').count(),
    0,
    'moving a numeric column first does not fabricate a record link',
  );
  await row.locator('td').nth(1).dblclick();
  await page.getByRole('heading', { name: 'Owned wide row', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await row.waitFor();
  const owner = row.getByRole('button', { name: ownerName, exact: true });
  assert.equal(await owner.isEnabled(), true);
  assert.equal(
    await owner.locator('.grid-persona').textContent(),
    ownerName
      .split(/\s+/)
      .map((word) => word[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );
  await owner.click();
  await page.waitForURL(/etn=systemuser/);
  await page.getByRole('heading', { name: ownerName, exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('id'), userId);
  await page.route('**/_apps/api/tables/x_item?*', async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    for (const row of body.rows ?? [])
      if (row.x_name === 'Owned wide row') row.ownerid = { id: userId, entity: 'x_unimported', name: ownerName };
    await route.fulfill({ response, json: body });
  });
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await row.waitFor();
  assert.equal(await owner.isDisabled(), true);
  assert.match(await owner.getAttribute('title'), /target is not available/);
});

test('a view without its primary-name column opens the selected record by double-clicking a data cell', async (t) => {
  const fixture = await modelDrivenFixture(t);
  await fixture.sim.close();
  const view = path.join(fixture.solutionDir, 'Entities/x_item/SavedQueries/items.xml');
  await fs.writeFile(view, (await fs.readFile(view, 'utf8')).replace('<cell name="x_name" width="200"/>', ''));
  const sim = await fixture.start();
  t.after(() => sim.close());
  const page = await chrome.page(t);
  await page.goto(sim.url + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  const row = page
    .locator('tbody tr')
    .filter({ has: page.getByRole('checkbox', { name: 'Select Copper', exact: true }) });
  await row.waitFor();
  assert.equal(await row.getByRole('button').count(), 0);
  await row.locator('td').nth(1).dblclick();
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('id'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('authored app areas isolate their groups and 137 records paginate through scoped server queries', async (t) => {
  const fixture = await modelDrivenFixture(t);
  await fixture.sim.close();
  const itemId = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const initial = structuredClone(fixture.sim.store.state);
  initial.tables.x_item = Array.from({ length: 137 }, (_, index) => ({
    x_itemid: itemId(index + 1),
    x_name: `Item ${String(index + 1).padStart(3, '0')}`,
    x_quantity: index + 1,
    statecode: index === 136 ? 1 : 0,
    statuscode: index === 136 ? 2 : 1,
  }));
  initial.tables.x_child = Array.from({ length: 35 }, (_, index) => ({
    x_childid: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    x_name: `Check ${String(index + 1).padStart(3, '0')}`,
    x_parentid: itemId(1),
  }));
  await fs.writeFile(fixture.stateFile, JSON.stringify(initial));
  const sitemap =
    '<AppModuleSiteMap><AppModuleUniqueName>x_example</AppModuleUniqueName><SiteMap><Area Id="delivery"><Titles><Title LCID="1033" Title="Delivery"/></Titles><Group Id="work"><Titles><Title LCID="1033" Title="Planning"/></Titles><SubArea Id="items" Entity="x_item"><Titles><Title LCID="1033" Title="Work items"/></Titles></SubArea></Group></Area><Area Id="quality"><Titles><Title LCID="1033" Title="Quality"/></Titles><Group Id="approval"><Titles><Title LCID="1033" Title="Approvals"/></Titles><SubArea Id="checks" Entity="x_child"><Titles><Title LCID="1033" Title="Review checks"/></Titles></SubArea></Group><Group Id="catalog"><Titles><Title LCID="1033" Title="Catalogue"/></Titles><SubArea Id="archive" Entity="x_item"><Titles><Title LCID="1033" Title="Work archive"/></Titles></SubArea></Group></Area></SiteMap></AppModuleSiteMap>';
  await fs.writeFile(
    path.join(fixture.solutionDir, 'AppModuleSiteMaps/x_example/AppModuleSiteMap.xml'),
    sitemap.replace(
      '<SubArea Id="items"',
      '<SubArea Id="upper" Url="/main.aspx?appid=77777777-7777-4777-8777-777777777777&amp;pagetype=entitylist&amp;etn=x_item&amp;viewid={upper-view}&amp;viewType=1039"><Titles><Title LCID="1033" Title="Upper work"/></Titles></SubArea><SubArea Id="archived" Url="/main.aspx?pagetype=entitylist&amp;etn=x_item&amp;viewid={archived-view}"><Titles><Title LCID="1033" Title="Archived work"/></Titles></SubArea><SubArea Id="items"',
    ),
  );
  const viewFile = path.join(fixture.solutionDir, 'Entities/x_item/SavedQueries/items.xml');
  await fs.writeFile(
    path.join(path.dirname(viewFile), 'upper.xml'),
    (await fs.readFile(viewFile, 'utf8'))
      .replace('{items-view}', '{upper-view}')
      .replace('<isdefault>1</isdefault>', '<isdefault>0</isdefault>')
      .replace('Stocked items', 'Upper items')
      .replace('value="1"', 'value="80"'),
  );
  await fs.writeFile(
    path.join(path.dirname(viewFile), 'archived.xml'),
    (await fs.readFile(viewFile, 'utf8'))
      .replace('{items-view}', '{archived-view}')
      .replace('<isdefault>1</isdefault>', '<isdefault>0</isdefault>')
      .replace('Stocked items', 'Archived items')
      .replace('attribute="x_quantity" operator="ge"', 'attribute="statecode" operator="eq"'),
  );
  const entityFile = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '</Entity>',
      '<CustomControlDefaultConfigs><CustomControlDefaultConfig><ControlDescriptionXML><controlDescriptions><controlDescription><customControl name="Microsoft.PowerApps.PowerAppsOneGrid" formFactor="0"><parameters><EnablePagination static="true" type="Enum">yes</EnablePagination></parameters></customControl></controlDescription></controlDescriptions></ControlDescriptionXML></CustomControlDefaultConfig></CustomControlDefaultConfigs></Entity>',
    ),
  );
  const sim = await fixture.start({ initial });
  t.after(() => sim.close());
  const origin = sim.origin ?? sim.url;
  const page = await chrome.page(t, { viewport: { width: 1582, height: 1000 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const change = async (action, entity, expectedPage, expectedCount, expectedTotal) => {
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' && new URL(response.url()).pathname === '/_apps/api/tables/' + entity,
    );
    await action();
    const received = await response;
    assert.equal(received.status(), 200);
    const result = await received.json(),
      query = JSON.parse(new URL(received.url()).searchParams.get('query'));
    assert.equal(query.page, expectedPage);
    assert.equal(query.pageSize, 50);
    assert.equal(result.rows.length, expectedCount);
    assert.equal(result.total, expectedTotal);
    await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready');
    assert.equal(await page.locator('.grid-scroll tbody tr').count(), expectedCount);
    return query;
  };
  await change(
    () => page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item'),
    'x_item',
    1,
    50,
    137,
  );
  assert.equal(await page.getByRole('button', { name: 'Change area', exact: true }).textContent(), 'Delivery');
  assert.equal(await page.locator('#navigation').getByText('Approvals', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Show As', exact: true }).isDisabled(), true);
  assert.match(
    await page.getByRole('button', { name: 'Show As', exact: true }).getAttribute('title'),
    /visualization modes/,
  );
  assert.equal(await page.getByRole('button', { name: 'Last page', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Item 001', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Item 051', exact: true }).count(), 0);
  await change(() => page.getByRole('button', { name: 'Next page', exact: true }).click(), 'x_item', 2, 50, 137);
  await page.getByRole('button', { name: 'Item 051', exact: true }).waitFor();
  await change(() => page.getByRole('button', { name: 'Next page', exact: true }).click(), 'x_item', 3, 37, 137);
  await page.getByRole('button', { name: 'Item 137', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Next page', exact: true }).isDisabled(), true);
  await change(() => page.getByRole('button', { name: 'Previous page', exact: true }).click(), 'x_item', 2, 50, 137);
  await change(
    () => page.getByRole('searchbox', { name: 'Filter by keyword', exact: true }).fill('Item 001'),
    'x_item',
    1,
    1,
    1,
  );
  await page.getByRole('button', { name: 'Item 001', exact: true }).waitFor();
  await change(
    () => page.getByRole('searchbox', { name: 'Filter by keyword', exact: true }).fill(''),
    'x_item',
    1,
    50,
    137,
  );
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await change(
    () => page.getByRole('menuitemradio', { name: 'Upper items', exact: true }).click(),
    'x_item',
    1,
    50,
    58,
  );
  assert.equal(await page.getByRole('button', { name: 'Upper work', exact: true }).getAttribute('aria-current'), null);
  assert.equal(
    await page.getByRole('button', { name: 'Work items', exact: true }).getAttribute('aria-current'),
    'page',
    'changing the selected view retains the activated sitemap page',
  );
  await change(() => page.getByRole('button', { name: 'Next page', exact: true }).click(), 'x_item', 2, 8, 58);
  assert.equal(await page.getByRole('button', { name: 'Item 001', exact: true }).count(), 0);
  assert.equal(await page.locator('.grid-footer').getByText('Rows: 51 - 58 of 58', { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('combobox', { name: 'Rows per page', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Item 130', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).waitFor();
  await change(() => page.getByRole('button', { name: 'Back', exact: true }).click(), 'x_item', 2, 8, 58);
  assert.equal(new URL(page.url()).searchParams.get('viewid'), 'upper-view');
  await change(() => page.getByRole('button', { name: 'Load first page', exact: true }).click(), 'x_item', 1, 50, 58);
  await change(
    () => page.getByRole('searchbox', { name: 'Filter by keyword', exact: true }).fill('Item 080'),
    'x_item',
    1,
    1,
    1,
  );
  assert.equal(await page.getByRole('button', { name: 'View', exact: true }).textContent(), 'Upper items*');
  await page.getByRole('button', { name: 'Item 080', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).waitFor();
  await change(() => page.getByRole('button', { name: 'Back', exact: true }).click(), 'x_item', 1, 1, 1);
  assert.equal(await page.getByRole('searchbox', { name: 'Filter by keyword', exact: true }).inputValue(), 'Item 080');
  await change(() => page.getByRole('button', { name: 'Archived work', exact: true }).click(), 'x_item', 1, 1, 1);
  await page.getByRole('button', { name: 'Item 137', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'View', exact: true }).textContent(), 'Archived items');
  assert.equal(
    await page.getByRole('button', { name: 'Archived work', exact: true }).getAttribute('aria-current'),
    'page',
  );
  await change(() => page.getByRole('button', { name: 'Upper work', exact: true }).click(), 'x_item', 1, 50, 58);
  await page.getByRole('button', { name: 'Change area', exact: true }).click();
  const areaMenu = page.locator('.area-picker');
  assert.ok(
    await areaMenu.evaluate(
      (node) =>
        node.getBoundingClientRect().bottom <= document.querySelector('.area-chooser').getBoundingClientRect().top,
    ),
  );
  await change(() => page.getByRole('menuitemradio', { name: 'Quality', exact: true }).click(), 'x_child', 1, 35, 35);
  assert.equal(new URL(page.url()).searchParams.get('etn'), 'x_child');
  assert.equal(await page.locator('#navigation').getByText('Planning', { exact: true }).count(), 0);
  assert.equal(await page.locator('#navigation').getByText('Approvals', { exact: true }).isVisible(), true);
  assert.equal(
    await page.getByRole('button', { name: 'Review checks', exact: true }).getAttribute('aria-current'),
    'page',
  );
  await change(() => page.getByRole('button', { name: 'Work archive', exact: true }).click(), 'x_item', 1, 50, 137);
  assert.equal(await page.getByRole('button', { name: 'Change area', exact: true }).textContent(), 'Quality');
  assert.equal(
    await page.getByRole('button', { name: 'Work items', exact: true }).count(),
    0,
    'duplicate table destinations stay in their authored area',
  );
  await change(() => page.goBack(), 'x_child', 1, 35, 35);
  await page.evaluate(() => localStorage.removeItem('mirage.apps.area.x_example'));
  await change(
    () => page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_child'),
    'x_child',
    1,
    35,
    35,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Change area', exact: true }).textContent(),
    'Quality',
    'a direct table route activates its containing area',
  );
  await change(
    () => page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item&viewid={UPPER-VIEW}'),
    'x_item',
    1,
    50,
    58,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Upper work', exact: true }).getAttribute('aria-current'),
    'page',
  );
  assert.equal(await page.getByRole('button', { name: 'Change area', exact: true }).textContent(), 'Delivery');
  await change(() => page.getByRole('button', { name: 'Work items', exact: true }).click(), 'x_item', 1, 50, 137);
  assert.equal(await page.getByRole('button', { name: 'Change area', exact: true }).textContent(), 'Delivery');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#sidebar').isVisible(), false);
  await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Change area', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(
    await page.locator('.area-picker').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    }),
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1582, height: 1000 });
  await change(() => page.goto(origin + '/main.aspx?appname=x_example'), 'x_item', 1, 50, 58);
  await page.getByRole('button', { name: 'Item 080', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Upper work', exact: true }).getAttribute('aria-current'),
    'page',
  );
  await page.getByRole('button', { name: 'Item 080', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Draft kept in its module');
  await page.getByRole('button', { name: 'Change area', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Quality', exact: true }).click();
  const unsaved = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Change area', exact: true }).textContent(), 'Delivery');
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Draft kept in its module');
  await page.getByRole('button', { name: 'Change area', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Quality', exact: true }).click();
  await change(
    () => unsaved.getByRole('button', { name: 'Discard changes', exact: true }).click(),
    'x_child',
    1,
    35,
    35,
  );
  assert.deepEqual(errors, []);
});

test('source infinite grid fetches additional server chunks and rejects stale chunks after keyword reset', async (t) => {
  const fixture = await modelDrivenFixture(t);
  await fixture.sim.close();
  const initial = structuredClone(fixture.sim.store.state);
  initial.tables.x_item = Array.from({ length: 137 }, (_, index) => ({
    x_itemid: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    x_name: `Item ${String(index + 1).padStart(3, '0')}`,
    x_quantity: index + 1,
  }));
  await fs.writeFile(fixture.stateFile, JSON.stringify(initial));
  const entityFile = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '</Entity>',
      '<CustomControlDefaultConfigs><CustomControlDefaultConfig><ControlDescriptionXML><controlDescriptions><controlDescription><customControl name="Microsoft.PowerApps.PowerAppsOneGrid" formFactor="0"><parameters><EnablePagination static="true" type="Enum">no</EnablePagination></parameters></customControl></controlDescription></controlDescriptions></ControlDescriptionXML></CustomControlDefaultConfig></CustomControlDefaultConfigs></Entity>',
    ),
  );
  const sim = await fixture.start();
  t.after(() => sim.close());
  const page = await chrome.page(t);
  await page.goto(sim.url + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  const scroll = page.locator('.grid-scroll');
  await page.getByRole('button', { name: 'Item 001', exact: true }).waitFor();
  assert.equal(await scroll.getAttribute('data-paging'), 'infinite');
  assert.equal(await page.getByRole('button', { name: 'Next page', exact: true }).count(), 0);
  assert.equal(await page.getByRole('combobox', { name: 'Rows per page', exact: true }).count(), 0);
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/_apps/api/tables/x_item' &&
      JSON.parse(new URL(response.url()).searchParams.get('query')).page === 2,
  );
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const next = await response;
  assert.equal((await next.json()).rows.length, 50);
  await page.waitForFunction(() => document.querySelectorAll('.grid-scroll tbody tr').length === 100);
  await page.locator('tbody tr').first().getByRole('checkbox').check();
  const third = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/_apps/api/tables/x_item' &&
      JSON.parse(new URL(response.url()).searchParams.get('query')).page === 3,
  );
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  assert.equal((await (await third).json()).rows.length, 37);
  await page.waitForFunction(() => document.querySelectorAll('.grid-scroll tbody tr').length === 137);
  assert.equal(await page.getByRole('checkbox', { name: 'Select Item 001', exact: true }).isChecked(), true);
  await page.getByRole('searchbox', { name: 'Filter by keyword', exact: true }).fill('Item 137');
  await page.waitForFunction(() => document.querySelectorAll('.grid-scroll tbody tr').length === 1);
  assert.equal(await page.getByRole('button', { name: 'Item 137', exact: true }).count(), 1);
  await page.getByRole('searchbox', { name: 'Filter by keyword', exact: true }).fill('');
  await page.getByRole('button', { name: 'Item 001', exact: true }).waitFor();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  await page.route('**/_apps/api/tables/x_item?*', async (route) => {
    const value = JSON.parse(new URL(route.request().url()).searchParams.get('query'));
    if (value.page === 2) {
      const response = await route.fetch();
      await pending;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const requested = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/_apps/api/tables/x_item' &&
      JSON.parse(new URL(request.url()).searchParams.get('query')).page === 2,
  );
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await requested;
  await page.getByRole('searchbox', { name: 'Filter by keyword', exact: true }).fill('Item 137');
  await page.waitForFunction(() => document.querySelectorAll('.grid-scroll tbody tr').length === 1);
  release();
  await page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/_apps/api/tables/x_item' &&
      JSON.parse(new URL(response.url()).searchParams.get('query')).page === 2,
  );
  assert.equal(await page.locator('.grid-scroll tbody tr').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Item 137', exact: true }).count(), 1);
});

test('compact form command overflow retains Share and executes supported Save through More', async (t) => {
  const fixture = await modelDrivenFixture(t);
  const page = await chrome.page(t, { viewport: { width: 390, height: 844 } });
  await page.goto(
    fixture.origin +
      '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByLabel('Name', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Share', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'More commands', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isVisible(), false);
  assert.equal(await page.locator('#commands').evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  const longTitle = 'Copper saved from overflow with a title that wraps across several narrow lines';
  await page.getByLabel('Name', { exact: true }).fill(longTitle);
  await page.getByRole('button', { name: 'More commands', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: 'Deactivate', exact: true }).isDisabled(), true);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname.endsWith('/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  );
  await page.getByRole('menuitem', { name: 'Save', exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.getByRole('heading', { name: longTitle, exact: true }).waitFor();
  assert.ok(
    await page
      .locator('.record-header')
      .evaluate((node) => node.getBoundingClientRect().bottom <= node.nextElementSibling.getBoundingClientRect().top),
  );
  assert.ok(
    await page
      .locator('.record-subtitle')
      .evaluate(
        (node) =>
          node.getBoundingClientRect().top >= document.querySelector('.record-title').getBoundingClientRect().bottom,
      ),
  );
  await page.setViewportSize({ width: 2172, height: 1000 });
  await page.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'More commands', exact: true }).click();
  await page.getByRole('dialog', { name: 'Record commands', exact: true }).waitFor();
});
