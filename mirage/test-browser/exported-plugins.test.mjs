import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { pluginFixture, pluginId } from '../test/plugin-fixture.mjs';
import { signInContext } from '../testing/session.mjs';

test('backend operations exposes plugin source bindings and persists an editable local rejection', async (t) => {
  const { app } = await pluginFixture(t);
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  await signInContext(page.context(), app, 'editor', { roles: ['Editor'] });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(app.adminUrl + '#operations');
  await page.getByRole('heading', { name: 'Backend operations' }).waitFor();
  // The operations view lists operations in a paginated table and renders the edit form of the selected one only;
  // the `#operations?key=` deep link selects an operation and opens its form.
  const select = (key) =>
    page.evaluate(
      (hash) => {
        location.hash = hash;
      },
      `operations?key=${encodeURIComponent(key)}`,
    );
  await select(`plugin-step:${pluginId(3)}`);
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Widget step 3', exact: true }) });
  await section.getByText('Invented.WidgetRules.Validate · Invented.WidgetRules', { exact: true }).waitFor();
  assert.match(await section.textContent(), /PreValidation.*rank 1/);
  assert.equal(await section.getByLabel('Local behavior', { exact: true }).inputValue(), 'placeholder');
  const write = (method, route, data) =>
    page.context().request.fetch(app.url + '/_api/' + route, {
      method,
      headers: { __RequestVerificationToken: app.state().csrf },
      data,
    });
  const created = await write('POST', 'fx_widgets', { fx_title: 'Placeholder recorded' });
  assert.equal(created.status(), 204, await created.text());
  assert.ok(
    app.state().diagnostics.some((item) => item.code === 'PLUGIN_STEP_PLACEHOLDER' && item.stepId === pluginId(3)),
  );
  const row = app.store.snapshot().tables.fx_widget[0];
  await section.getByLabel('Local behavior', { exact: true }).selectOption('mock');
  await section
    .getByLabel('Mock result (JSON)', { exact: true })
    .fill('{"error":{"message":"Browser configured rejection"}}');
  await section.getByRole('button', { name: 'Save local behavior', exact: true }).click();
  await page.getByText('Local operation saved.', { exact: true }).waitFor();
  const operation = app.state().config.operations.find((item) => item.key === `plugin-step:${pluginId(3)}`);
  assert.equal(operation.mode, 'mock');
  assert.equal(operation.configuration.body.error.message, 'Browser configured rejection');
  const before = app.store.snapshot();
  const rejected = await write('POST', 'fx_widgets', { fx_title: 'Must not persist' });
  assert.equal(rejected.status(), 400);
  assert.equal((await rejected.json()).error.code, '9004010D');
  assert.ok(
    app
      .state()
      .diagnostics.some(
        (item) =>
          item.code === 'PLUGIN_STEP_REJECTED' &&
          item.stepId === pluginId(3) &&
          item.message === 'Browser configured rejection',
      ),
  );
  assert.deepEqual(app.store.snapshot(), before);
  await section.getByRole('button', { name: 'Use source default', exact: true }).click();
  await page.getByText('Source operation default restored.', { exact: true }).waitFor();
  assert.equal(
    app.state().config.operations.find((item) => item.key === `plugin-step:${pluginId(3)}`).mode,
    'placeholder',
  );
  await select(`plugin-step:${pluginId(9)}`);
  const asyncSection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Widget step 9', exact: true }) });
  assert.equal(await asyncSection.getByLabel('Local behavior', { exact: true }).isDisabled(), false);
  await asyncSection.getByLabel('Local behavior', { exact: true }).selectOption('disabled');
  await asyncSection.getByRole('button', { name: 'Save local behavior', exact: true }).click();
  await page.getByText('Local operation saved.', { exact: true }).waitFor();
  assert.equal(
    app.state().config.operations.find((item) => item.key === `plugin-step:${pluginId(9)}`).mode,
    'disabled',
  );
  const updated = await write('PATCH', `fx_widgets(${row.fx_widgetid})`, { fx_title: 'Async disabled deliberately' });
  assert.equal(updated.status(), 204, await updated.text());
  await app.settle();
  assert.equal(app.store.snapshot().tables.fx_widget[0].fx_title, 'Async disabled deliberately');
  assert.ok(
    app.state().diagnostics.some((item) => item.code === 'PLUGIN_STEP_DISABLED' && item.stepId === pluginId(9)),
  );
  assert.deepEqual(errors, []);
});
