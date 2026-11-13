// @test-kind contract: local compatibility adapters read actual markup even when DOMStringMap has inherited values.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

test('Bootstrap compatibility uses actual data attributes rather than inherited dataset values', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<div id="dropdown"><button type="button" id="toggle" data-toggle="dropdown">Menu</button><div class="dropdown-menu"></div></div><a id="expand" data-toggle="collapse" href="#panel">Expand</a><div id="panel" hidden>Panel</div><div id="other" hidden>Other</div>',
  );
  const require = createRequire(import.meta.url);
  await page.addScriptTag({ path: require.resolve('jquery/dist/jquery.js') });
  await page.addScriptTag({ path: fileURLToPath(new URL('../lib/bootstrap-plugins-compat.js', import.meta.url)) });
  const dropdown = await page.evaluate(() => {
    Object.defineProperties(DOMStringMap.prototype, {
      bsToggle: { configurable: true, value: 'modal' },
      target: { configurable: true, value: '#other' },
    });
    globalThis.jQuery('#toggle').dropdown('toggle');
    return {
      open: document.getElementById('dropdown').classList.contains('open'),
      show: document.getElementById('toggle').classList.contains('show'),
    };
  });
  assert.deepEqual(dropdown, { open: true, show: false });
  await page.locator('#expand').click();
  assert.equal(await page.locator('#panel').evaluate((element) => element.hidden), false);
  assert.equal(await page.locator('#other').evaluate((element) => element.hidden), true);
});

// @test-kind contract: client API choice updates preserve the checked radio as the change event target.
test('Pages client API picklist updates dispatch change on the chosen radio', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<div class="crmEntityFormView" data-form-name="Example"><div class="control" data-logical-name="x_choice"><span id="x_choice" class="picklist"><input id="first" type="radio" name="choice" value="1" checked><input id="second" type="radio" name="choice" value="2"></span></div></div>',
  );
  await page.addScriptTag({ path: fileURLToPath(new URL('../lib/pages-client-api.js', import.meta.url)) });
  const result = await page.evaluate(() => {
    const events = [];
    document.getElementById('x_choice').addEventListener('change', (event) => events.push(event.target.id));
    globalThis.__paqviloPages.currentPage.forms
      .getFormByName('Example')
      .getControlByLogicalName('x_choice')
      .setValue('2');
    return {
      events,
      first: document.getElementById('first').checked,
      second: document.getElementById('second').checked,
    };
  });
  assert.deepEqual(result, { events: ['second'], first: false, second: true });
});

// @test-kind contract: composite editability uses actual attribute presence, including empty values.
test('address composite editability ignores inherited dataset values and preserves empty attributes', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<div class="crmEntityFormView" data-form-name="Example">' +
      '<div class="control" data-logical-name="missing"><textarea id="missing" class="addressCompositeControl" readonly></textarea></div>' +
      '<div class="control" data-logical-name="empty"><textarea id="empty" class="addressCompositeControl" readonly data-editable=""></textarea></div>' +
      '<div class="control" data-logical-name="disabled"><textarea id="disabled" class="addressCompositeControl" data-editable="False"></textarea></div>' +
      '<div class="control" data-logical-name="inherited"><textarea id="inherited" class="addressCompositeControl"></textarea></div>' +
      '</div>',
  );
  await page.addScriptTag({ path: fileURLToPath(new URL('../lib/pages-client-api.js', import.meta.url)) });
  const result = await page.evaluate(() => {
    Object.defineProperty(DOMStringMap.prototype, 'editable', { configurable: true, value: 'False' });
    const form = globalThis.__paqviloPages.currentPage.forms.getFormByName('Example');
    return Object.fromEntries(
      ['missing', 'empty', 'disabled', 'inherited'].map((name) => {
        const control = form.getControlByLogicalName(name);
        let writable = true;
        try {
          control.setValue({ city: 'Example' });
        } catch {
          writable = false;
        }
        return [name, { readOnly: control.isReadOnly, writable }];
      }),
    );
  });
  assert.deepEqual(result, {
    missing: { readOnly: false, writable: false },
    empty: { readOnly: false, writable: true },
    disabled: { readOnly: true, writable: false },
    inherited: { readOnly: false, writable: true },
  });
});

// @test-kind contract: the no-jQuery portal helper retains concat spreading of caller-supplied collections.
test('portal checkbox label helper accepts a concat-spreadable collection without jQuery', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<label id="label">Choice</label>');
  await page.addScriptTag({ path: fileURLToPath(new URL('../lib/platform-app-compat.js', import.meta.url)) });
  await page.evaluate(() => {
    const collection = { 0: document.getElementById('label'), length: 1, [Symbol.isConcatSpreadable]: true };
    globalThis.portal.addRoleOnCheckboxLabel(collection);
  });
  assert.equal(await page.locator('#label').getAttribute('role'), 'none');
});
