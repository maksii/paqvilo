import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { clientDateControlsRuntime } from '../lib/date-controls.mjs';

test('browser date fallback builds the native picker group from the bound box and preserves low calendar years in UserLocal hidden values', async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    // The response markup is the platform's: the bound box alone, no picker group, no local attributes.
    response.end(`<!doctype html><html><head><link href="/dist/preform.BootstrapV5.bundle-x.css" rel="stylesheet"><script>window.setIsDirty=()=>{};</script></head><body>
      <label for="owned-date" id="owned-date_label">Date</label><span id="RequiredFieldValidatorowned-date" style="display:none;">*</span>
      <input id="owned-date" type="text" data-ui="datetimepicker" data-type="date" data-behavior="UserLocal">
      <input id="owned-time" type="text" data-ui="datetimepicker" data-type="datetime" data-behavior="UserLocal">
      <input id="owned-readonly" type="text" value="2026-03-04T10:30:00.0000000Z" data-ui="datetimepicker" data-type="datetime" data-behavior="UserLocal" readonly="readonly">
    </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext({ timezoneId: 'UTC' });
  t.after(() => context.close());
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.addScriptTag({ content: clientDateControlsRuntime() });
  // crmentityformview-datetime.js contract (live runtime DOM): hidden bound box, the picker
  // group with the *_datepicker_description box and the calendar button, the label retargeted.
  assert.equal(await page.locator('#owned-date').evaluate((input) => input.style.display), 'none');
  assert.equal(
    await page.locator('#owned-date + div').getAttribute('class'),
    'input-append input-group datetimepicker',
  );
  assert.equal(await page.locator('#owned-date + div').getAttribute('role'), 'none');
  assert.equal(await page.locator('#owned-date_datepicker_description').getAttribute('aria-required'), 'true');
  assert.equal(await page.locator('#owned-time_datepicker_description').getAttribute('aria-required'), null);
  assert.equal(await page.locator('label[for="owned-date_datepicker_description"]').count(), 1);
  assert.equal(
    await page
      .locator(
        '#owned-date + div > span.input-group-addon.btn[role="button"][title="Choose a date"] > span.fa-calendar',
      )
      .count(),
    1,
  );
  // A read-only picker keeps no input group, marks its box readonly and hides the button.
  assert.equal(await page.locator('#owned-readonly + div').getAttribute('class'), 'datetimepicker');
  assert.equal(await page.locator('#owned-readonly_datepicker_description').getAttribute('readonly'), 'readonly');
  assert.equal(
    await page.locator('#owned-readonly + div > span.input-group-addon').evaluate((span) => span.style.display),
    'none',
  );
  assert.equal(
    await page
      .locator('[data-sim-date-value], [data-sim-date-target], [data-sim-date-only], [data-sim-date-ready]')
      .count(),
    0,
  );
  const display = (id) => page.locator('#' + id + '_datepicker_description');
  assert.equal(await display('owned-date').getAttribute('type'), 'date');
  assert.equal(await display('owned-time').getAttribute('type'), 'datetime-local');
  await display('owned-date').fill('0026-02-28');
  await display('owned-date').dispatchEvent('change');
  await display('owned-time').fill('0099-12-31T12:34');
  await display('owned-time').dispatchEvent('change');
  assert.equal(await page.locator('#owned-date').inputValue(), '0026-02-28T00:00:00.0000000Z');
  assert.equal(await page.locator('#owned-time').inputValue(), '0099-12-31T12:34:00.0000000Z');
  await display('owned-date').fill('0004-02-29');
  await display('owned-date').dispatchEvent('change');
  assert.equal(await page.locator('#owned-date').inputValue(), '0004-02-29T00:00:00.0000000Z');
  assert.deepEqual(errors, []);
});
