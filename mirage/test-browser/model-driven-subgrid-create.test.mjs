// @test-kind contract: a subgrid New command must open the create form with the parent lookup bound to the parent record, so the saved child points at it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser();
const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('subgrid New opens the parent lookup with the parent name and saves a child that points at the parent', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.goto(`${origin}/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=${parentId}`);
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('button', { name: 'Copper child', exact: true }).waitFor();
  await page.locator('[data-action=new-related]').click();
  await page.getByLabel('Name', { exact: true }).fill('Subgrid bound child');
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Copper');
  const [createdResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/_apps/api/tables/x_child') && response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  assert.equal(createdResponse.status(), 201, await createdResponse.text());
  await page.getByRole('heading', { name: 'Subgrid bound child', exact: true }).waitFor();
  const result = await (await fetch(origin + '/_apps/api/tables/x_child')).json();
  const created = result.rows.find((row) => row.x_name === 'Subgrid bound child');
  const record = await (await fetch(origin + '/_apps/api/tables/x_child/' + created.x_childid)).json();
  assert.equal(record.row.x_parentid, parentId);
  await page.goto(`${origin}/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=${parentId}`);
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('button', { name: 'Subgrid bound child', exact: true }).waitFor();
});

test('disabled local-only commands state the local limit in the present tense', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.goto(`${origin}/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=${parentId}`);
  await page.getByRole('button', { name: 'Deactivate', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Deactivate', exact: true }).getAttribute('title'),
    'Record activation commands are not available in the local host.',
  );
  await page.goto(`${origin}/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item`);
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Show Chart', exact: true }).getAttribute('title'),
    'Charts are not available in the local host.',
  );
});
