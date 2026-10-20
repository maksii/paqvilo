import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';

test('navigation cancels a pending grid search and repeated dialogs release listeners', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.clock.install();
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const cdp = await page.context().newCDPSession(page); t.after(() => cdp.detach().catch(() => {}));
  const cancelListeners = async () => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#dialog")', objectGroup: 'dialog-audit' });
    try { return (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.filter(listener => listener.type === 'cancel').length; }
    finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'dialog-audit' }); }
  };
  const baseline = await cancelListeners();
  for (let index = 0; index < 15; index++) {
    await page.getByRole('button', { name: 'Edit columns' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  assert.equal(await cancelListeners(), baseline, 'closed dialog listeners must not accumulate');
  await page.getByRole('searchbox', { name: 'Filter by keyword' }).fill('unmatched stale search');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
  await page.clock.runFor(1000);
  assert.equal(await page.locator('#record-form').count(), 1, 'old search must not replace the opened record with a grid');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Unsaved');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
  assert.equal(await cancelListeners(), baseline);
  assert.equal(await page.locator('#record-form').count(), 1, 'Escape must keep the unsaved record');
});

test('model-driven shell supports solution navigation, editable grids and local record lifecycle', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1582, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const geometry = await page.evaluate(() => Object.fromEntries(['aside', '.commands', '#content', 'thead', 'tbody tr', '.grid-footer'].map(selector => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return [selector, { x, y, width, height }];
  })));
  assert.equal(geometry.aside.width, 200);
  assert.deepEqual(geometry['.commands'], { x: 207, y: 104, width: 1360, height: 46 });
  assert.equal(geometry['#content'].y, 155); assert.equal(geometry.thead.height, 42);
  assert.equal(geometry['tbody tr'].height, 43); assert.equal(geometry['.grid-footer'].y, 938);
  assert.equal(await page.locator('#navigation button svg').count() > 0, true);
  assert.equal(await page.getByRole('button', { name: 'Flow', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Advanced Find', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'external', exact: true }).isDisabled(), true);
  await page.getByRole('searchbox', { name: 'Filter by keyword' }).fill('Silver');
  await page.getByRole('button', { name: 'Silver', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('tbody')?.textContent.includes('Copper'));
  await page.getByRole('searchbox', { name: 'Filter by keyword' }).fill('');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit columns' }).click();
  await page.getByRole('checkbox', { name: 'Quantity', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('thead')?.textContent.includes('Quantity'));
  await page.getByRole('button', { name: 'Edit filters' }).click();
  await page.getByRole('button', { name: 'Add condition' }).click();
  await page.getByLabel('Filter 1 column').selectOption('x_quantity'); await page.getByLabel('Filter 1 operator').selectOption('ge'); await page.getByLabel('Filter 1 value').fill('5');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('Silver') && !document.querySelector('tbody')?.textContent.includes('Copper'));
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Bronze'); await page.getByLabel('Quantity', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Bronze', exact: true }).waitFor();
  assert.match(page.url(), /pagetype=entityrecord/); assert.match(page.url(), /id=/);
  await page.getByLabel('Quantity', { exact: true }).fill('9');
  await page.getByRole('button', { name: 'Save & Close', exact: true }).click();
  await page.getByRole('button', { name: 'Bronze', exact: true }).last().waitFor();
  await page.getByRole('button', { name: 'Bronze', exact: true }).last().click();
  assert.equal(await page.getByLabel('Quantity', { exact: true }).inputValue(), '9');
  await page.getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Copper', exact: true }).last().waitFor();
  assert.equal(await page.locator('tbody').getByRole('button', { name: 'Bronze', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('default management app edits portal customization and exposes working setup/admin links', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1582, height: 1000 } });
  await page.goto(origin + '/main.aspx'); await page.getByRole('button', { name: 'Invented portal', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Content Snippets', exact: true }).click();
  await page.locator('tbody').getByRole('button', { name: 'Welcome', exact: true }).click();
  await page.getByLabel('Value', { exact: true }).fill('Hello from management');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  const portal = await browser.newPage(); await portal.goto(origin + '/'); assert.match(await portal.locator('body').innerText(), /Hello from management/);
  await page.goto(origin + '/_sim/'); assert.equal(await page.getByRole('link', { name: 'Model-driven apps', exact: true }).getAttribute('href'), '/main.aspx');
});

test('exported related subgrid filters by the current record and binds related creates', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('button', { name: 'Copper child', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Silver child', exact: true }).count(), 0);
  await page.locator('[data-action=new-related]').click();
  await page.getByLabel('Name', { exact: true }).fill('New related child');
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const [createdResponse] = await Promise.all([page.waitForResponse(response => response.url().includes('/_apps/api/tables/x_child') && response.request().method() === 'POST'), page.getByRole('button', { name: 'Save', exact: true }).click()]);
  assert.equal(createdResponse.status(), 201, await createdResponse.text());
  await page.getByRole('heading', { name: 'New related child', exact: true }).waitFor();
  const response = await fetch(origin + '/_apps/api/tables/x_child'); const result = await response.json();
  const created = result.rows.find(row => row.x_name === 'New related child');
  const record = await (await fetch(origin + '/_apps/api/tables/x_child/' + created.x_childid)).json();
  assert.equal(record.row.x_parentid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select New related child', exact: true }).check();
  await page.locator('.related-grid').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.related-grid tbody')?.textContent.includes('New related child'));
  assert.equal((await fetch(origin + '/_apps/api/tables/x_child/' + created.x_childid)).status, 404);
});
