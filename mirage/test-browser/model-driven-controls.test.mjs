import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';

test('model-driven choice fields preserve typed values, required validation, keyboard selection and disabled state', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx');
  await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs');
    document.body.replaceChildren(); const form = document.createElement('form'); document.body.append(form);
    window.changes = []; window.fields = {};
    for (const [field, value] of [
      [{ name: 'x_kind', label: 'Kind', type: 'number', required: true, options: [{ value: 3, label: 'Bronze' }, { value: 7, label: 'Gold' }] }, null],
      [{ name: 'x_enabled', label: 'Enabled', type: 'boolean', options: [{ value: 1, label: 'Available' }, { value: 0, label: 'Unavailable' }] }, false],
      [{ name: 'x_tags', label: 'Tags', type: 'text', dataverseType: 'multiselectpicklist', options: [{ value: 2, label: 'Red' }, { value: 5, label: 'Blue' }] }, '2,5'],
    ]) { const control = renderControl(field, value); fields[field.name] = control; form.append(control.element); }
    form.addEventListener('change', event => changes.push(event.target.name));
  });
  assert.equal(await page.locator('form').evaluate(form => form.checkValidity()), false);
  const kind = page.getByRole('combobox', { name: 'Kind', exact: true });
  await kind.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await kind.inputValue(), 'Gold');
  assert.equal(await page.evaluate(() => fields.x_kind.read()), 7);
  assert.equal(await page.locator('form').evaluate(form => form.checkValidity()), true);
  assert.equal(await page.getByRole('combobox', { name: 'Enabled', exact: true }).inputValue(), 'Unavailable');
  assert.equal(await page.evaluate(() => fields.x_enabled.read()), false);
  await page.getByRole('combobox', { name: 'Enabled', exact: true }).click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['Unavailable', 'Available'], 'native Boolean choices order false first even when the export serializes TrueOption first');
  await page.keyboard.press('Escape');
  const tags = page.getByRole('combobox', { name: 'Tags', exact: true });
  assert.equal(await tags.inputValue(), 'Red; Blue');
  await tags.click(); await page.getByRole('option', { name: 'Red', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => fields.x_tags.read()), [5]);
  await page.keyboard.press('Escape');
  assert.equal(await tags.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(await page.evaluate(() => changes), ['x_kind', 'x_tags']);
  await page.evaluate(() => { fields.x_tags.setValue('2'); fields.x_tags.setDisabled(true); });
  assert.equal(await tags.inputValue(), 'Red'); assert.equal(await tags.isDisabled(), true);
  await page.evaluate(() => fields.x_tags.setDisabled(false));
  await tags.click(); await tags.fill('Blue');
  assert.equal(await page.getByRole('option', { name: 'Red', exact: true }).count(), 0);
  await page.getByRole('option', { name: 'Select all', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => fields.x_tags.read()), [2, 5]);
  await page.keyboard.press('Escape');
});

test('advanced lookup uses staged Done, preserves a cancelled value, queries exported views and saves a typed reference', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await page.goto(`${origin}/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=${id}`);
  await page.getByLabel('Parent', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Choose .* for Parent$/ });
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).waitFor();
  const footerGap = await dialog.evaluate(node => node.getBoundingClientRect().bottom - node.querySelector('.dialog-actions .primary').getBoundingClientRect().bottom);
  assert.ok(footerGap >= 35 && footerGap <= 38, `Lookup footer must follow the modal bottom; gap was ${footerGap}px.`);
  assert.equal(await dialog.getByRole('button', { name: 'Done', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: 'Lookup view', exact: true }).textContent(), 'Stocked items (default)');
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  assert.equal(await dialog.isVisible(), true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Copper');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Silver');
  const submitted = page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes('/_apps/api/tables/x_child/'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.deepEqual((await submitted).postDataJSON().x_parentid, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', entity: 'x_item', name: 'Silver' });
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
});

test('inline lookup applies its exported lookup view and keeps lookup-only views outside the application view picker', async t => {
  const fixture = await modelDrivenFixture(t); await fixture.sim.close();
  const file = path.join(fixture.solutionDir, 'Entities/x_item/SavedQueries/items.xml');
  const lookupView = (await fs.readFile(file, 'utf8')).replace('{items-view}', '{qualified-lookup}').replace('<querytype>0</querytype>', '<querytype>64</querytype>').replace('Stocked items', 'Qualified lookup').replace('value="1"', 'value="8"');
  await fs.writeFile(path.join(path.dirname(file), 'lookup.xml'), lookupView);
  const sim = await fixture.start(); t.after(() => sim.close()); const origin = sim.origin ?? sim.url;
  const catalogue = await (await fetch(origin + '/_apps/api')).json();
  assert.equal(catalogue.tables.x_item.lookupViews[0].id, 'qualified-lookup');
  assert.equal(catalogue.tables.x_item.views.some(view => view.id === 'qualified-lookup'), false);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('option', { name: 'Silver', exact: true }).waitFor();
  assert.equal(await page.getByRole('option', { name: 'Copper', exact: true }).count(), 0);
  assert.equal(await page.locator('#dialog').isVisible(), false);
  await page.getByRole('option', { name: 'Silver', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Silver');
  assert.equal(await page.getByLabel('Parent', { exact: true }).getAttribute('aria-expanded'), 'false');
});

test('advanced lookup renders the native empty state, then recovers to selectable results without changing the field', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Choose .* for Parent$/ });
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  const search = dialog.getByRole('searchbox', { name: 'Search lookup records' });
  await search.fill('No matching invented record');
  await dialog.getByRole('heading', { name: 'We don’t have any data for this view', exact: true }).waitFor();
  assert.equal(await dialog.getByText('Please try switching to another view', { exact: true }).isVisible(), true);
  assert.equal(await dialog.getByRole('table').count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Done', exact: true }).isDisabled(), true);
  const center = await dialog.locator('.lookup-browser-empty').evaluate(node => {
    const bounds = node.getBoundingClientRect(), title = node.querySelector('h3').getBoundingClientRect();
    return { expected: (bounds.top + bounds.bottom) / 2, actual: (title.top + title.bottom) / 2 };
  });
  assert.ok(Math.abs(center.actual - center.expected) < 35, 'empty message belongs near the center of the results area');
  await search.fill('Copper');
  await dialog.getByRole('radio', { name: 'Select Copper', exact: true }).waitFor();
  assert.equal(await dialog.locator('.lookup-browser-empty').count(), 0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Copper');
});

test('lookup invalidates selection during search, ignores stale responses and settles Escape', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Choose .* for Parent$/ });
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  let release, waiting;
  const requestStarted = new Promise(resolve => { waiting = resolve; });
  await page.route('**/_apps/api/tables/x_item?*', async route => {
    const query = JSON.parse(new URL(route.request().url()).searchParams.get('query'));
    if (query.search !== 'Copper') return route.continue();
    waiting(); await new Promise(resolve => { release = resolve; }); await route.continue();
  });
  t.after(() => release?.());
  await dialog.getByRole('searchbox', { name: 'Search lookup records' }).fill('Copper');
  assert.equal(await dialog.getByRole('button', { name: 'Done', exact: true }).isDisabled(), true);
  await requestStarted;
  await dialog.getByRole('searchbox', { name: 'Search lookup records' }).fill('Silver');
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).waitFor();
  release();
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  assert.equal(await dialog.getByRole('radio', { name: 'Select Copper', exact: true }).count(), 0);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Copper');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Select Copper', exact: true }).waitFor();
});

test('lookup target picker clears selection and preserves polymorphic target identity', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  let targetLabel;
  await page.route('**/_apps/api', async route => {
    const response = await route.fetch(), catalogue = await response.json();
    catalogue.tables.x_child.fields.x_parentid.targets = ['x_item', 'x_child'];
    targetLabel = catalogue.tables.x_child.label;
    await route.fulfill({ response, json: catalogue });
  });
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Choose .* for Parent$/ });
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  await dialog.getByRole('button', { name: 'Lookup table', exact: true }).click();
  await page.getByRole('menuitemradio', { name: targetLabel, exact: true }).click();
  await dialog.getByRole('radio', { name: 'Select Silver child', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Done', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).count(), 0);
  await dialog.getByRole('radio', { name: 'Select Silver child', exact: true }).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Silver child');
  const submitted = page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes('/_apps/api/tables/x_child/'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await submitted).postDataJSON().x_parentid.entity, 'x_child');
});

test('date-only and time-zone-independent controls retain wall time while user-local controls convert the timezone', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage({ timezoneId: 'America/New_York' });
  await page.goto(origin + '/main.aspx');
  const values = await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs');
    return ['DateOnly', 'TimeZoneIndependent', 'UserLocal'].map(dateTimeBehavior => {
      const control = renderControl({ name: 'x_date', type: 'date', dateTimeBehavior }, '2026-06-15T14:30:00Z');
      return { input: control.primary.value, time: control.element.querySelector('.date-time-input')?.value, value: control.read() };
    });
  });
  assert.deepEqual(values, [{ input: '6/15/2026', time: undefined, value: '2026-06-15' }, { input: '6/15/2026', time: '2:30 PM', value: '2026-06-15T14:30:00.000Z' }, { input: '6/15/2026', time: '10:30 AM', value: '2026-06-15T14:30:00.000Z' }]);
});

test('inline lookup rejects stale keyboard choices during debounce and after an adapter ignores cancellation', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx');
  await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs'); document.body.replaceChildren();
    window.requests = [];
    window.lookup = renderControl({ name: 'x_lookup', label: 'Related', type: 'lookup', targets: ['x_item'] }, null, { tables: { x_item: {} }, lookupSuggestions: () => new Promise(resolve => requests.push(resolve)) });
    document.body.append(lookup.element);
  });
  const input = page.getByRole('combobox', { name: 'Related', exact: true });
  await page.getByRole('button', { name: 'Look up Related', exact: true }).click();
  await page.evaluate(() => requests[0]([{ id: 'a', entity: 'x_item', name: 'Old result' }]));
  await page.getByRole('option', { name: 'Old result', exact: true }).waitFor();
  await input.fill('Second'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await input.inputValue(), 'Second');
  assert.equal(await page.getByRole('option', { name: 'Old result', exact: true }).count(), 0);
  await page.waitForFunction(() => requests.length === 2);
  await input.fill('Latest'); await page.waitForFunction(() => requests.length === 3);
  await page.evaluate(() => requests[2]([{ id: 'c', entity: 'x_item', name: 'Latest result' }]));
  await page.getByRole('option', { name: 'Latest result', exact: true }).waitFor();
  await page.evaluate(() => requests[1]([{ id: 'b', entity: 'x_item', name: 'Stale result' }]));
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => lookup.read()), { id: 'c', entity: 'x_item', name: 'Latest result' });
  await page.getByRole('button', { name: 'Look up Related', exact: true }).click();
  await page.evaluate(() => lookup.setDisabled(true));
  assert.equal(await input.getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => requests[3]([{ id: 'd', entity: 'x_item', name: 'Denied late result' }]));
  assert.deepEqual(await page.evaluate(() => lookup.read()), { id: 'c', entity: 'x_item', name: 'Latest result' });
});
