import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test(
  'real simulator admin lazy records, audit API/Liquid correlation, valid-token denial, sanitized export and #audit landing in Activity',
  { timeout: 60000 },
  async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-admin-audit-'));
    const files = {
      'website.yml': 'adx_websiteid: site\nadx_name: Audit fixture',
      'sitesetting.yml':
        "- adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_name: Webapi/contact/fields\n  adx_value: '*'",
      'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: template',
      'Main.pagetemplate.yml':
        'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
      'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
      'Main.webtemplate.source.html':
        '<!doctype html><html><head><title>Audit fixture</title></head><body>{% fetchxml records %}<fetch><entity name="contact"><attribute name="fullname"/></entity></fetch>{% endfetchxml %}<h1>Visible contacts: {{ records.results.entities.size }}</h1></body></html>',
    };
    for (const [name, contents] of Object.entries(files)) await fs.writeFile(path.join(directory, name), contents);
    const app = await createSimulator({
      sourceDir: directory,
      stateFile: path.join(directory, 'state.json'),
      watch: false,
      // The contact field list is the wildcard, which hosted sites reject unless exempt.
      observed: { webApiWildcard: 'exempt', evidence: 'synthetic fixture with a wildcard field list' },
      initial: {
        version: 1,
        mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
        tables: {
          contact: Array.from({ length: 81 }, (_, i) => ({
            contactid: `contact${i}`,
            fullname: `Synthetic member ${i}`,
          })),
        },
        permissions: [
          {
            id: 'read',
            entity: 'contact',
            scope: 'global',
            roles: ['Reader'],
            operations: ['read'],
          },
        ],
        plugins: [],
        presets: {},
        settings: { permissionMode: 'enforce' },
        simulator: {
          mode: 'local',
          pageMode: 'local',
          identity: { id: 'contact0', roles: ['Reader'] },
          live: {},
          endpoints: [],
        },
      },
    });
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(async () => {
      await browser.close();
      await app.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const context = await browser.newContext({ serviceWorkers: 'block' }),
      page = await context.newPage(),
      calls = [],
      errors = [];
    // Portal requests of this context run as the Reader (a session role override).
    await signInContext(context, app, 'contact0', { roles: ['Reader'] });
    page.on('request', (request) => calls.push(new URL(request.url()).pathname + new URL(request.url()).search));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(app.adminUrl + '#home');
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
    assert.ok(calls.includes('/__sim/api/state?summary=1'));
    assert.ok(!calls.some((url) => url.includes('/records/') || url.includes('/audit')));
    await page.locator('#navigation').getByRole('link', { name: 'Data records', exact: true }).click();
    assert.equal(await page.getByLabel('Table', { exact: true }).inputValue(), 'contact');
    await page.getByLabel('Table', { exact: true }).selectOption('contact');
    await page.waitForFunction(() => document.querySelectorAll('table[data-table="records"] tbody tr').length === 20);
    assert.ok(calls.includes('/__sim/api/records/contact?page=1&pageSize=20&search='));
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('table[data-table="records"] tbody')?.textContent.includes('Synthetic member 20'),
    );
    // D-M-11: the record search sits in the toolbar row (a summary-mode workspace searches on the runtime).
    await page.getByRole('searchbox', { name: 'Search record values' }).fill('member 80');
    await page.waitForFunction(() => document.querySelectorAll('table[data-table="records"] tbody tr').length === 1);
    assert.match(await page.locator('table[data-table="records"] tbody').innerText(), /Synthetic member 80/);
    assert.ok(calls.some((url) => url.includes('search=member+80')));
    const rendered = await context.request.get(app.url + '/?access_token=DO_NOT_RETAIN');
    assert.equal(rendered.status(), 200);
    assert.match(await rendered.text(), /Visible contacts: 81/);
    const parentId = rendered.headers()['x-sim-trace-id'];
    const api = await context.request.get(app.url + '/_api/contacts?$select=fullname&$top=1', {
      headers: { 'X-Sim-Parent-Trace': parentId },
    });
    assert.equal(api.status(), 200);
    const denied = await context.request.post(app.url + '/_api/contacts', {
      headers: { __RequestVerificationToken: app.state().csrf },
      data: { fullname: 'WRITE_BODY_MUST_NOT_RETAIN' },
    });
    assert.equal(denied.status(), 403);
    assert.equal((await denied.json()).error.code, '90040103');
    // The request audit is read in Activity: an old #audit address lands there with its filters renamed.
    await page.goto(app.adminUrl + '#audit?kind=api&outcome=denied');
    await page.waitForFunction(() => location.hash === '#activity?auditKind=api&result=denied');
    await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
    const exported = await (await context.request.get(app.url + '/__sim/api/audit/export')).json(),
      liquid = exported.items.find((item) => item.kind === 'liquid-fetchxml'),
      read = exported.items.find((item) => item.kind === 'api' && item.method === 'GET');
    assert.equal(liquid.parentId, parentId);
    assert.equal(read.correlationId, liquid.correlationId);
    assert.equal(liquid.rowCount, 81);
    assert.equal(read.rowCount, 1);
    assert.equal(read.identity.contactId, 'contact0');
    assert.deepEqual(read.identity.roles, ['Reader']);
    assert.ok(exported.items.every((item) => item.provider === 'local' && typeof item.durationMs === 'number'));
    assert.doesNotMatch(JSON.stringify(exported), /DO_NOT_RETAIN|WRITE_BODY_MUST_NOT_RETAIN/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'Activity fits a 390 px viewport',
    );
    const hostile = '"><img src=x onerror="window.auditInjected=true">';
    await page.goto(app.adminUrl + '#audit?kind=' + encodeURIComponent(hostile));
    await page.waitForFunction(() => location.hash.startsWith('#activity?auditKind='));
    assert.equal(
      new URLSearchParams((await page.evaluate(() => location.hash)).split('?')[1]).get('auditKind'),
      hostile,
    );
    await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
    assert.equal(await page.locator('#content img').count(), 0);
    assert.equal(await page.evaluate(() => window.auditInjected), undefined);
    // Invalid hash names cannot dispatch inherited Object methods or become HTML.
    await page.goto(app.adminUrl + '#__proto__');
    await page.reload();
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  },
);
