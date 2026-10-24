import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { AssetCache } from '../lib/asset-cache.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const require = createRequire(import.meta.url);
const SITE = '7b2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c3d';
const CONTACT = 'c2000000-0000-4000-8000-000000000011';
const ACCOUNT = 'a2000000-0000-4000-8000-000000000011';
const FORM = '2d000000-0000-4000-8000-000000000011';

let sharedBrowser;
before(async () => {
  sharedBrowser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => sharedBrowser?.close());

async function fixture(t, { captured = false, currentLookup = false, targetRead = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-affordance-'));
  const owner = ownedFixture(t);
  let app;
  owner.add(() => app?.close());
  owner.remove(() => fs.rm(dir, { recursive: true, force: true }));
  const jquery = await fs.readFile(
    path.join(path.dirname(require.resolve('jquery/package.json')), 'dist', 'jquery.min.js'),
  );
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Widgets`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: form',
    'FormPage.pagetemplate.yml':
      'adx_pagetemplateid: form\nadx_webtemplateid: formcontent\nadx_usewebsiteheaderandfooter: true',
    'FormContent.webtemplate.yml': 'adx_webtemplateid: formcontent\nadx_name: Form content',
    'FormContent.webtemplate.source.html':
      '<link rel="stylesheet" href="/resource/powerappsportal/dist/preform.BootstrapV5.bundle-e3e84e09a3.css"><link rel="stylesheet" href="/resource/powerappsportal/dist/font-awesome.BootstrapV5.bundle-2ce6efb497.css"><link rel="stylesheet" href="/resource/powerappsportal/dist/privatemode.bundle-049b12b66e.css"><script src="/jquery.min.js"></script><div class="page-header"><h1>Widget</h1></div>{% entityform name: "Widget" %}',
    'Widget.basicform.yml': `adx_entityformid: ${FORM}\nadx_name: Widget\nadx_entityname: contact\nadx_mode: 100000000\nadx_onsuccess: 756150000\nadx_successmessage: Widget saved.\nadx_hideformonsuccess: false`,
    'jquery.min.js.webfile.yml':
      'adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js',
    'sitesetting.yml':
      '- adx_sitesettingid: 5e200000-0000-4000-8000-000000000011\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"',
  };
  if (currentLookup)
    files['Widget.basicform.yml'] = files['Widget.basicform.yml'].replace('adx_mode: 100000000', 'adx_mode: 100000001');
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, 'jquery.min.js'), jquery);
  const initial = {
    version: 1,
    mappings: {
      contact: {
        entitySet: 'contacts',
        idColumn: 'contactid',
        nameColumn: 'fullname',
        relationships: {
          parentcustomerid_account: {
            from: 'parentcustomerid',
            to: 'accountid',
            entity: 'account',
            many: false,
            schemaName: 'contact_customer_accounts',
          },
          managingpartnerid: {
            from: 'managingpartnerid',
            to: 'accountid',
            entity: 'account',
            many: false,
            schemaName: 'contact_managingpartner',
          },
        },
      },
      account: { entitySet: 'accounts', idColumn: 'accountid', nameColumn: 'name' },
    },
    tables: { contact: [{ contactid: CONTACT, fullname: 'Grace' }], account: [{ accountid: ACCOUNT, name: 'Acme' }] },
    permissions: [
      {
        id: 'contact',
        entity: 'contact',
        scope: 'global',
        roles: ['Member'],
        operations: ['read', 'create', 'append', 'appendTo'],
      },
      {
        id: 'account',
        entity: 'account',
        scope: 'global',
        roles: ['Member'],
        operations: ['read', 'append', 'appendTo'],
      },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      identity: { id: CONTACT, contactId: CONTACT, roles: ['Member'] },
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        Widget: {
          entity: 'contact',
          mode: 100000000,
          fields: [
            { name: 'fullname', label: 'Full name', required: true, maxLength: 100 },
            { name: 'jobtitle', label: 'Code', readOnly: true },
            {
              name: 'preferredcontactmethodcode',
              label: 'Preferred',
              dataverseType: 'picklist',
              options: [
                { value: 1, label: 'Email' },
                { value: 2, label: 'Phone' },
              ],
            },
            { name: 'parentcustomerid', label: 'Company', type: 'lookup', lookupTargets: ['account'] },
            { name: 'managingpartnerid', label: 'Partner', type: 'lookup', lookupTargets: ['account'] },
          ],
        },
      },
    },
  };
  if (currentLookup) {
    initial.tables.contact[0].parentcustomerid = { id: ACCOUNT, logical_name: 'account', name: 'Acme' };
    initial.simulator.componentSchemas.Widget.mode = 100000001;
    initial.permissions[0].operations.push('update');
  }
  if (!targetRead)
    initial.permissions[1].operations = initial.permissions[1].operations.filter((operation) => operation !== 'read');
  if (captured) {
    const origin = 'https://native.example.test';
    initial.simulator.live.origin = origin;
    const cache = await new AssetCache({ directory: path.join(dir, 'assets'), origin }).init();
    await cache.capture(captured === 'preform' ? bundlePaths.slice(0, 1) : bundlePaths, {
      origin,
      request: async (resource) => ({
        status: 200,
        headers: { 'content-type': 'text/css' },
        body: Buffer.from(`/* Invented captured fixture: ${resource} */ body{--captured-sheet:1}`),
      }),
    });
  }
  app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    initial,
    watch: false,
    observed: {
      siteVisibility: 'private',
      evidence: 'Invented private-site fixture for structural fallback regression',
    },
  });
  // Each test opens contexts on the shared browser; they close with the test.
  const newContext = async (options) => {
    const context = await sharedBrowser.newContext(options);
    owner.add(() => context.close());
    return context;
  };
  return {
    app,
    launchBrowser: async () => ({ newContext, newPage: async (options) => (await newContext(options)).newPage() }),
  };
}

const bundlePaths = [
  '/resource/powerappsportal/dist/preform.BootstrapV5.bundle-e3e84e09a3.css',
  '/resource/powerappsportal/dist/font-awesome.BootstrapV5.bundle-2ce6efb497.css',
  '/resource/powerappsportal/dist/privatemode.bundle-049b12b66e.css',
];

test('captured platform style bytes win over all three toolkit structural fallbacks', async (t) => {
  const { app } = await fixture(t, { captured: true });
  for (const resource of bundlePaths) {
    const response = await fetch(app.url + resource);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `/* Invented captured fixture: ${resource} */ body{--captured-sheet:1}`);
    assert.notEqual(response.headers.get('x-sim-resource-provider'), 'local-platform-equivalent');
  }
});

test('capturing preform alone retains hidden offline notification through its PWA bundle', async (t) => {
  const { app, launchBrowser } = await fixture(t, { captured: 'preform' });
  const browser = await launchBrowser();

  const page = await browser.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(app.url);
  assert.equal(await page.locator('#offlineNotificationBar').isVisible(), false);
  const response = await fetch(app.url + '/resource/powerappsportal/dist/pwa-style.bundle-55718a4c0d.css');
  assert.equal(response.headers.get('x-sim-resource-provider'), 'local-platform-partial');
});

test('existing lookup selection is visible on open and keyboard Remove value changes only the local field', async (t) => {
  const { app, launchBrowser } = await fixture(t, { currentLookup: true });
  const browser = await launchBrowser();

  const context = await browser.newContext();
  await signInContext(context, app, CONTACT, { roles: ['Member'] });
  const page = await context.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(app.url + '/?id=' + CONTACT);
  await page.locator('button.launchentitylookup[aria-label*="Company"]').click();
  const dialog = page.locator('#parentcustomerid_lookupmodal section.modal-lookup');
  const checkbox = dialog.locator('tbody [role="checkbox"]').first();
  await checkbox.waitFor();
  assert.equal(await checkbox.getAttribute('aria-checked'), 'true');
  assert.equal(await dialog.locator('tbody tr.selected').count(), 1);
  assert.equal(await dialog.locator('.modal-footer button.primary').isDisabled(), false);
  const remove = dialog.locator('.modal-footer .remove-value');
  assert.equal(await remove.isDisabled(), false);
  await remove.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#parentcustomerid').inputValue(), '');
  assert.equal(await page.locator('#parentcustomerid_entityname').inputValue(), '');
  assert.equal(
    app.store.snapshot().tables.contact.find((row) => row.contactid === CONTACT).parentcustomerid.id,
    ACCOUNT,
    'removing a field value must not save or mutate data before submit',
  );
});

for (const targetRead of [true, false]) {
  test(`lookup preselection cannot select a foreign target or a row outside readable results (targetRead=${targetRead})`, async (t) => {
    const { app, launchBrowser } = await fixture(t, { currentLookup: true, targetRead });
    const browser = await launchBrowser();
    const context = await browser.newContext();
    await signInContext(context, app, CONTACT, { roles: ['Member'] });
    const page = await context.newPage();
    await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
    await page.goto(app.url + '/?id=' + CONTACT);
    if (targetRead)
      await page.locator('#parentcustomerid_entityname').evaluate((input) => {
        input.value = 'contact';
      });
    await page.locator('button.launchentitylookup[aria-label*="Company"]').click();
    const dialog = page.locator('#parentcustomerid_lookupmodal section.modal-lookup');
    await dialog.waitFor({ state: 'visible' });
    if (targetRead) await dialog.locator('tbody tr').first().waitFor();
    else await dialog.locator('.view-access-denied').waitFor();
    assert.equal(await dialog.locator('tbody tr.selected').count(), 0);
    assert.equal(await dialog.locator('.modal-footer button.primary').isDisabled(), true);
    assert.equal(await dialog.locator('.modal-footer .remove-value').isDisabled(), true);
  });
}

for (const width of [1200, 390]) {
  test(`fallback platform affordances remain visible and keyboard usable at ${width}px`, async (t) => {
    const { app, launchBrowser } = await fixture(t);
    const browser = await launchBrowser();

    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await signInContext(context, app, CONTACT, { roles: ['Member'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
    await page.goto(app.url);
    for (const resource of bundlePaths.slice(1)) {
      const response = await fetch(app.url + resource);
      assert.equal(response.headers.get('x-sim-resource-provider'), 'local-platform-partial');
    }
    const diagnostics = await (
      await fetch(app.url + '/__sim/api/diagnostics', { headers: { 'x-sim-csrf': app.state().csrf } })
    ).json();
    assert.ok(
      (Array.isArray(diagnostics) ? diagnostics : (diagnostics.diagnostics ?? [])).some(
        (row) => row.code === 'PLATFORM_BUNDLE_PARTIAL_FALLBACK' && row.bundle === 'font-awesome',
      ),
    );
    const banner = page.locator('#privateModeText');
    const bannerBox = await banner.boundingBox();
    assert.ok(bannerBox.height > 0 && bannerBox.height < 100, JSON.stringify(bannerBox));
    assert.ok(bannerBox.width <= width);
    const required = await page
      .locator('label[for="fullname"]')
      .evaluate((label) => getComputedStyle(label, '::after').content);
    assert.match(
      required,
      /\*/,
      await page.locator('label[for="fullname"]').evaluate((label) =>
        JSON.stringify({
          parent: label.parentElement.className,
          grand: label.parentElement.parentElement.className,
          styles: [...document.styleSheets].map((s) => s.href),
        }),
      ),
    );
    const readOnly = await page.locator('#jobtitle').evaluate((input) => ({
      readOnly: input.readOnly,
      border: getComputedStyle(input).borderColor,
      background: getComputedStyle(input).backgroundColor,
    }));
    assert.equal(readOnly.readOnly, true);
    assert.equal(readOnly.border, 'rgba(0, 0, 0, 0)');
    assert.notEqual(
      await page.locator('#parentcustomerid_name').evaluate((input) => getComputedStyle(input).borderColor),
      'rgba(0, 0, 0, 0)',
      'editable lookup name must retain its input affordance',
    );
    const trigger = page.locator('button.launchentitylookup[aria-label*="Company"]');
    const symbol = await trigger
      .locator('.fa, .fa-solid')
      .first()
      .evaluate((span) => getComputedStyle(span, '::before').content);
    assert.ok(symbol && !['none', 'normal', '""'].includes(symbol), 'lookup launch symbol must be visible');
    await trigger.click();
    const dialog = page.locator('#parentcustomerid_lookupmodal section.modal-lookup');
    const checkbox = dialog.locator('tbody [role="checkbox"]').first();
    await checkbox.waitFor();
    const box = await checkbox.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      border: getComputedStyle(element).borderStyle,
      label: element.getAttribute('aria-label'),
    }));
    assert.ok(box.width >= 10 && box.height >= 10, JSON.stringify(box));
    assert.equal(box.border, 'solid');
    assert.ok(box.label);
    await checkbox.focus();
    await page.keyboard.press('Space');
    assert.equal(await checkbox.getAttribute('aria-checked'), 'true');
    const checked = await checkbox.evaluate((element) => getComputedStyle(element, '::before').content);
    assert.ok(checked && !['none', 'normal', '""'].includes(checked));
    const select = dialog.locator('.modal-footer button.primary');
    await select.focus();
    const target = await select.evaluate((button) => {
      const r = button.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === button,
      };
    });
    assert.ok(
      target.left >= 0 && target.right <= width && target.top >= 0 && target.bottom <= 844 && target.hit,
      JSON.stringify(target),
    );
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#parentcustomerid').inputValue(), ACCOUNT);
    assert.equal(await page.locator('#parentcustomerid_name').inputValue(), 'Acme');
    assert.equal(await page.locator('#parentcustomerid_entityname').inputValue(), 'account');
    const emitted = new Set();
    for (const entry of await fs.readdir(new URL('../lib/', import.meta.url), { withFileTypes: true })) {
      if (!entry.isFile() || !/^.+\.(?:js|mjs)$/.test(entry.name)) continue;
      const source = await fs.readFile(new URL('../lib/' + entry.name, import.meta.url), 'utf8');
      for (const name of source.match(/\bfa-[a-z0-9-]+\b/g) ?? []) emitted.add(name);
    }
    const modifiers = new Set(['fa-fw', 'fa-spin', 'fa-4x', 'fa-solid']);
    const missing = await page.evaluate(
      (names) =>
        names.filter((name) => {
          const span = document.createElement('span');
          span.className = 'fa ' + name;
          document.body.append(span);
          const content = getComputedStyle(span, '::before').content;
          span.remove();
          return ['none', 'normal', '""'].includes(content);
        }),
      [...emitted].filter((name) => !modifiers.has(name)),
    );
    assert.deepEqual(
      missing,
      [],
      'every icon identifier emitted statically by core must have a visible fallback symbol',
    );
    await page.locator('#fullname').fill('Keyboard selected widget');
    await Promise.all([page.waitForEvent('load'), page.locator('#InsertButton').click()]);
    const saved = app.store.snapshot().tables.contact.find((row) => row.fullname === 'Keyboard selected widget');
    assert.ok(saved, 'actual native form POST must create the row');
    assert.equal(saved.parentcustomerid?.id ?? saved.parentcustomerid, ACCOUNT);
    assert.deepEqual(errors, []);
  });
}
