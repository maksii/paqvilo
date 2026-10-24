import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { personaFixture, contactId } from '../test/fixtures/persona-catalog.mjs';
import { createPersonaBrowserContext } from '../testing/personas.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

test(
  'persona pickers: search/facets, pinning, shared routes, contact role picker and local metadata editor',
  { timeout: 60000 },
  async (t) => {
    const { app } = await personaFixture(t);
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.url + '/_sim/#identity?q=requester&tag=edit');
    const picker = page.locator('#browser-persona-picker');
    await picker.locator('[data-persona-result-count]').filter({ hasText: '1 of 60' }).waitFor();
    assert.equal(await picker.locator('[data-persona-query]').inputValue(), 'requester');
    await picker.locator('[data-persona-clear]').click();
    await picker.locator('[data-persona-result-count]').filter({ hasText: '60 of 60' }).waitFor();
    await picker.locator('[data-persona-query]').fill('synthetic account reviewer');
    await picker.locator('[data-persona-result-count]').filter({ hasText: '1 of 60' }).waitFor();
    await picker.locator('[data-persona-pin="person-1"]').first().click();
    assert.equal(await picker.locator('[data-persona-shortcuts="pinned"] [data-persona-row]').count(), 1);
    await picker.locator('[data-persona-clear]').click();
    await picker.locator('[data-persona-query]').fill('nothing-matches');
    await picker.locator('[data-persona-empty]:not([hidden])').waitFor();
    await picker.locator('[data-persona-clear]').click();
    await picker.locator('[data-persona-facet="tags"] summary').click();
    await picker.locator('[data-persona-filter="tags"][value="review"]').check();
    await picker.locator('[data-persona-result-count]').filter({ hasText: '27 of 60' }).waitFor();
    assert.match(page.url(), /tag=review/);
    await page.reload();
    await page.locator('#browser-persona-picker [data-persona-result-count]').filter({ hasText: '27 of 60' }).waitFor();
    await page.getByRole('button', { name: 'Choose persona', exact: true }).click();
    const dialog = page.locator('dialog.persona-picker-dialog');
    await dialog.waitFor();
    await dialog.locator('[data-persona-query]').fill('person-3');
    await dialog.locator('[data-persona-row="person-3"] [data-persona-choose]').first().click();
    assert.equal(await page.locator('#persona-contact').inputValue(), contactId(3));
    await page.locator('[data-persona-management] > summary').click();
    await page.locator('[data-add-entry]').click();
    const editor = page.locator('dialog.persona-dialog');
    await editor.locator('[name="key"]').fill('new-alias');
    await editor.locator('[name="contactId"]').fill(contactId(60));
    await editor.locator('[name="label"]').fill('New alias');
    await editor.locator('[name="group"]').selectOption('group-0');
    await editor.getByRole('button', { name: 'Save local metadata' }).click();
    await editor.waitFor({ state: 'detached' });
    const report = await fetch(app.url + '/_sim/api/personas').then((r) => r.json());
    assert.ok(report.personas.some((p) => p.key === 'new-alias'));
    await page.locator('[data-persona-management] > summary').click();
    await page.locator('[data-kind]').selectOption('contexts');
    await page.locator('[data-edit-entry="review"]').click();
    const setup = page.locator('dialog.persona-dialog');
    await setup.locator('[data-map="environmentVariables"] [data-map-value]').fill('"Edited variable"');
    await setup.locator('[data-map="snippetOverrides"] [data-map-value]').fill('"Edited greeting"');
    await setup.locator('[name="locale"]').fill('de-DE');
    await setup.getByRole('button', { name: 'Save local metadata' }).click();
    await setup.waitFor({ state: 'detached' });
    const edited = await fetch(app.url + '/_sim/api/personas').then((r) => r.json());
    assert.equal(edited.contexts.find((c) => c.id === 'review').environmentVariables.sample_Url, 'Edited variable');
    await page.goto(app.url + '/_sim/#identity?q=person-2');
    await page.locator('#browser-persona-picker [data-persona-row="person-2"] [data-persona-choose]').first().click();
    await page.locator('[data-persona-launch]').click();
    await page.waitForURL((url) => url.origin !== app.url);
    assert.equal(await page.locator('h1').textContent(), 'Edited greeting');
    assert.deepEqual(errors, []);
    await context.close();
  },
);

test(
  'native grouped sign-in remains usable without JS; browser automation applies context options',
  { timeout: 30000 },
  async (t) => {
    const { app } = await personaFixture(t);
    const context = await browser.newContext({ javaScriptEnabled: false });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(app.url + '/SignIn');
    await page.locator('[data-persona-group="group-0"]').waitFor();
    await page.locator('[data-persona-row="person-1"] [name="personaKey"]').first().click();
    await page.waitForURL(app.url + '/');
    const session = await context.request.get(app.url + '/_sim/api/session').then((r) => r.json());
    assert.equal(session.contactId, contactId(1));
    await context.close();
    const opened = await createPersonaBrowserContext(browser, {
      origin: app.url,
      personaKey: 'person-2',
      instanceKey: 'browser-test',
    });
    assert.notEqual(opened.origin, app.url);
    assert.deepEqual(opened.context.pages(), []);
    t.after(() => opened.context.close());
    const childPage = await opened.context.newPage();
    assert.deepEqual(childPage.viewportSize(), { width: 1100, height: 750 });
    await childPage.goto(opened.url);
    assert.equal(await childPage.evaluate(() => navigator.language), 'fr-FR');
    assert.equal(await childPage.locator('h1').textContent(), 'Context greeting');
    await opened.context.close();
  },
);

test(
  'a pending persona launch keeps the picker and its caption bound to the submitted persona',
  { timeout: 60000 },
  async (t) => {
    const { app } = await personaFixture(t);
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(app.url + '/_sim/#identity');
    const picker = page.locator('#browser-persona-picker');
    await picker.locator('[data-persona-result-count]').waitFor();
    const launch = page.locator('[data-persona-launch]'),
      key = await launch.getAttribute('data-persona-launch'),
      caption = await launch.innerText();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let calls = 0;
    await page.route('**/__sim/api/personas/launch', async (route) => {
      calls++;
      await gate;
      await route.fulfill({ status: 422, json: { error: { message: 'Fixture refused this launch.' } } });
    });
    await launch.click();
    await page.locator('#persona-session-panel[data-pending-action]').waitFor();
    assert.equal(await picker.locator('[data-persona-query]').isDisabled(), true);
    await picker.evaluate((node) =>
      node.querySelector('[data-persona-choose]').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    assert.equal(await launch.getAttribute('data-persona-launch'), key);
    release();
    await page.locator('#notification').filter({ hasText: 'Fixture refused this launch.' }).waitFor();
    assert.equal(await launch.getAttribute('data-persona-launch'), key);
    assert.equal(await launch.innerText(), caption);
    assert.equal(await picker.locator('[data-persona-query]').isDisabled(), false);
    assert.equal(calls, 1);
  },
);
