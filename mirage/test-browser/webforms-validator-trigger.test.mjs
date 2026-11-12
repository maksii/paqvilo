// @test-kind compatibility: WebUIValidation hooks the control's inline on<event> property, which jQuery's trigger calls
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { closeServer } from './shared-browser.mjs';

const webForms = await fs.readFile(new URL('../lib/webforms-compat.js', import.meta.url), 'utf8');
const jquery = await fs.readFile(new URL('../node_modules/jquery/dist/jquery.js', import.meta.url), 'utf8');

test('a required field shown invalid after a submit attempt is re-validated by a jQuery change trigger', async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head></head><body>
      <form>
        <label for="Title">Title</label>
        <input id="Title" type="text" value="" onchange="window.__changes=(window.__changes||0)+1;">
        <span id="RequiredFieldValidatorTitle" style="display:none">Title is required.</span>
      </form>
    </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.addScriptTag({ content: webForms });
  await page.addScriptTag({ content: jquery });
  // The validator is the span itself (WebUIValidation.js expando properties), hooked by ValidatorOnLoad.
  await page.evaluate(() => {
    const validator = document.getElementById('RequiredFieldValidatorTitle');
    Object.assign(validator, {
      controltovalidate: 'Title',
      evaluationfunction: 'RequiredFieldValidatorEvaluateIsValid',
      display: 'Dynamic',
      initialvalue: '',
    });
    window.Page_Validators = [validator];
    window.ValidatorOnLoad();
  });
  const validator = page.locator('#RequiredFieldValidatorTitle');
  assert.equal(await page.evaluate(() => window.Page_ClientValidate()), false);
  assert.equal(await validator.evaluate((span) => span.style.display), 'inline');
  assert.equal(await page.evaluate(() => window.Page_IsValid), false);
  await page.evaluate(() => window.jQuery('#Title').val('x').trigger('change'));
  assert.equal(await validator.evaluate((span) => span.isvalid), true);
  assert.equal(await validator.evaluate((span) => span.style.display), 'none');
  assert.equal(await page.evaluate(() => window.Page_IsValid), true);
  // The page's own inline change handler still runs, once per trigger.
  assert.equal(await page.evaluate(() => window.__changes), 1);
  assert.deepEqual(errors, []);
});
