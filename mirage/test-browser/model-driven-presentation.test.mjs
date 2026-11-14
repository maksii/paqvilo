// @test-kind contract: presentation API changes render in the local form and survive tab re-rendering without editing exported sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';
const browser = sharedBrowser();
test('client tab, section and field labels render together and survive returning to the tab', async (t) => {
  const fixture = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } });
  const formFile = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const source = await fs.readFile(formFile, 'utf8');
  const page = await browser.page(t);
  await page.goto(
    fixture.sim.url +
      '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByLabel('Quantity', { exact: true }).waitFor();
  await page.evaluate(() => {
    const control = window.Xrm.Page.getControl('x_quantity');
    const section = control.getParent(),
      tab = section.getParent();
    control.setLabel('Invented quantity');
    section.setLabel('Invented section');
    tab.setLabel('Invented tab');
  });
  await page.getByRole('tab', { name: 'Invented tab', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Invented section', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Invented quantity', { exact: true }).inputValue(), '2');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('tab', { name: 'Invented tab', exact: true }).click();
  await page.getByRole('heading', { name: 'Invented section', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Invented quantity', { exact: true }).inputValue(), '2');
  assert.equal(await fs.readFile(formFile, 'utf8'), source);
});

test('phone-width list commands that do not fit move into a keyboard-reachable More commands menu', async (t) => {
  const fixture = await modelDrivenFixture(t);
  const page = await browser.page(t, { viewport: { width: 375, height: 812 } });
  await page.goto(fixture.origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Share', exact: true }).isVisible(), true);
  assert.equal(await page.locator('#commands').evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    true,
    'the page does not scroll horizontally',
  );
  assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'More commands', exact: true }).focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'More commands', exact: true });
  await menu.waitFor();
  assert.equal(await menu.getByRole('menuitem', { name: 'Refresh', exact: true }).count(), 1);
});
