import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { createFrameReadiness } from '../lib/frame-readiness.mjs';
import { DataError } from '../lib/data.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

test('real frame load follows queued ready handlers, tolerates exceptions and does not wait for absent jQuery', async (t) => {
  const diagnostics = [],
    readiness = createFrameReadiness({ diagnostic: (item) => diagnostics.push(item) });
  const jquery = await fs.readFile(createRequire(import.meta.url).resolve('jquery/dist/jquery.min.js'));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (readiness.handle(req, res, url)) return;
    if (url.pathname === '/jquery.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(jquery);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    const hasJquery = !url.searchParams.has('none');
    const body = `<!doctype html><html><head>${hasJquery ? '<script src="/jquery.js"></script>' : ''}</head><body><script>${hasJquery ? '$(function(){window.readySawGlobal=Boolean(window.injected);window.readyAt=performance.now();' + (url.searchParams.has('throw') ? "throw Error('invented ready failure');" : '') + '});' : ''}</script></body></html>`;
    res.end(readiness.decorate(body, { path: url.pathname }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext();
  t.after(async () => {
    await context.close();
    readiness.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await context.newPage();
  const failedRequests = [];
  page.on('requestfailed', (request) =>
    failedRequests.push({ url: request.url(), error: request.failure()?.errorText }),
  );
  await page.goto(`http://127.0.0.1:${server.address().port}/?none`);
  for (const query of ['', '?throw', '?none']) {
    await page.evaluate((query) => {
      window.loaded = null;
      const frame = document.createElement('iframe');
      frame.onload = () => {
        const win = frame.contentWindow;
        win.loadAt = win.performance.now();
        win.injected = true;
        window.loaded = {
          readyAt: win.readyAt ?? null,
          loadAt: win.loadAt,
          sawGlobal: win.readySawGlobal ?? null,
          ordering: win.__portalSimulation?.frameLoadOrdering,
        };
      };
      frame.src = '/frame' + query;
      document.body.replaceChildren(frame);
    }, query);
    await page.waitForFunction(() => window.loaded);
    const value = await page.evaluate(() => window.loaded);
    if (query !== '?none') {
      assert.ok(value.readyAt < value.loadAt, JSON.stringify(value));
      assert.equal(value.sawGlobal, false);
      assert.equal(value.ordering, 'jquery-ready');
    } else {
      assert.equal(value.readyAt, null);
      assert.equal(value.ordering, 'dom-ready');
    }
  }
  assert.ok(diagnostics.some((item) => item.ordering === 'jquery-ready'));
  assert.ok(!diagnostics.some((item) => item.code === 'FRAME_READY_TIMEOUT'));
  assert.deepEqual(failedRequests, []);
});

async function fixture(t, transport, errorMarkup = 'inline') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-save-feedback-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: invented-site\nadx_name: Invented frame',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<!doctype html><html><body><h1>Host</h1></body></html>',
    'Create.basicform.yml':
      'adx_entityformid: create\nadx_name: Create\nadx_entityname: sample\nadx_mode: 100000000\nadx_hideformonsuccess: false',
    'Create.basicform.custom_javascript.js':
      '$(function(){window.readyAt=performance.now();window.readySawGlobal=Boolean(window.hostInjected);});',
  };
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const fields = [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'parentid', label: 'Parent', type: 'lookup', targets: ['account'] },
  ];
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    observed: {
      nativeFormTransport: transport,
      formSubmissionErrorMarkup: errorMarkup,
      evidence: 'Synthetic loopback submission fixture',
    },
    initial: {
      mappings: {
        sample: {
          entitySet: 'samples',
          idColumn: 'sampleid',
          fields: { title: { dataverseType: 'nvarchar' } },
          relationships: { parent_account: { entity: 'account', from: 'parentid', to: 'accountid', many: false } },
        },
        account: { entitySet: 'accounts', idColumn: 'accountid', nameColumn: 'name' },
        contact: { entitySet: 'contacts', idColumn: 'contactid' },
      },
      tables: {
        sample: [],
        account: [
          { accountid: '22222222-2222-4222-8222-222222222222', name: 'Invented parent', ownercontact: 'editor' },
        ],
        contact: [{ contactid: 'editor', fullname: 'Synthetic editor' }],
      },
      permissions: [
        {
          id: 'parent-own',
          entity: 'account',
          roles: ['Editor'],
          scope: 'contact',
          field: 'ownercontact',
          operations: ['read', 'appendTo'],
        },
        {
          id: 'child',
          entity: 'sample',
          roles: ['Editor'],
          scope: 'parent',
          parentPermissionId: 'parent-own',
          relationship: { entity: 'account', from: 'parentid', to: 'accountid', many: false },
          operations: ['read', 'create', 'append'],
        },
      ],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        live: {},
        identity: { roles: [] },
        endpoints: [],
        componentSchemas: { create: { entity: 'sample', fields } },
        observed: {
          nativeFormTransport: transport,
          formSubmissionErrorMarkup: errorMarkup,
          evidence: 'Synthetic loopback submission fixture',
        },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  return app;
}

for (const transport of ['json', 'postback'])
  for (const markup of ['inline', 'paragraph'])
    test(`${transport} ${markup} modal save failures re-render posted values and support a successful retry`, async (t) => {
      const app = await fixture(t, transport, markup);
      const context = await browser.newContext();
      ownedFixture(t).add(() => context.close());
      await signInContext(context, app, 'editor', { roles: ['Editor'] });
      assert.equal(
        app.store.allowed(
          'sample',
          'create',
          { parentid: { id: '22222222-2222-4222-8222-222222222222', logical_name: 'account' } },
          { contactId: 'editor', roles: ['Editor'] },
        ),
        true,
      );
      const page = await context.newPage(),
        errors = [],
        writes = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/forms/')) writes.push(request.postDataJSON());
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.url);
      const open = async () => {
        await page.evaluate(() => {
          window.loads = 0;
          window.states = [];
          const frame = document.createElement('iframe');
          frame.id = 'modal-frame';
          frame.onload = () => {
            const win = frame.contentWindow;
            window.loads++;
            window.states.push({
              ready: win.readyAt,
              loaded: win.performance.now(),
              sawGlobal: win.readySawGlobal,
              message: win.document.querySelector('#MessagePanel')?.textContent,
            });
            win.hostInjected = true;
          };
          frame.src = '/_portal/modal-form-template-path/invented-site?entityformid=create';
          document.body.replaceChildren(frame);
        });
        await page.waitForFunction(() => window.loads === 1);
        return (await page.locator('#modal-frame').elementHandle()).contentFrame();
      };
      let frame = await open();
      const title = '<span>Posted & kept</span>';
      await frame.locator('#title').fill(title);
      await frame.locator('#InsertButton').click();
      await page.waitForFunction(() => window.loads === 2);
      assert.equal(await frame.locator('#title').count(), 1, await frame.content());
      assert.equal(await frame.locator('#title').inputValue(), title);
      assert.equal(await frame.locator('#MessagePanel.alert-danger').isVisible(), true);
      assert.match(await frame.locator('#MessagePanel').innerText(), /appropriate permissions/);
      if (markup === 'paragraph')
        assert.match(await frame.locator('#MessagePanel p').innerText(), /appropriate permissions/);
      assert.equal(await frame.locator('#EntityFormPanel').isVisible(), true);
      assert.equal(app.store.snapshot().tables.sample.length, 0);
      const denied = app
        .state()
        .diagnostics.filter((item) => ['PermissionDenied', 'TABLE_PERMISSION_DENIED'].includes(item.code));
      assert.equal(denied.length, 1, 'one detailed permission diagnostic per denied JSON or postback submission');
      assert.equal(denied[0].code, 'TABLE_PERMISSION_DENIED');
      assert.equal(denied[0].permissions[0].parentLink.childColumn, 'parentid');
      assert.equal(denied[0].permissions[0].parentLink.value, null);
      await frame.evaluate(() => {
        document.getElementById('parentid').value = '22222222-2222-4222-8222-222222222222';
        document.getElementById('parentid_entityname').value = 'account';
        document.getElementById('parentid_name').value = 'Invented parent';
      });
      await frame.locator('#InsertButton').click();
      await page.waitForFunction(() => window.loads === 3);
      assert.equal(
        app.store.snapshot().tables.sample.length,
        1,
        JSON.stringify({
          diagnostics: app
            .state()
            .diagnostics.filter((item) => !item.code.includes('PLATFORM') && !item.code.includes('FRAME')),
          writes,
        }),
      );
      assert.equal(app.store.snapshot().tables.sample[0].title, title);
      assert.match(await frame.locator('#MessagePanel').innerText(), /successfully/);
      const states = await page.evaluate(() => window.states);
      assert.ok(
        states.every((item) => item.ready < item.loaded && item.sawGlobal === false),
        JSON.stringify(states),
      );

      // A plugin error occurs inside the same atomic write; its details stay in
      // diagnostics while the form retains editable controls and an error panel.
      app.store.setPluginPipeline(
        () => {
          throw new DataError('Synthetic invalid-plugin-execution failure', 400, 'PluginValidation');
        },
        () => true,
      );
      frame = await open();
      await frame.locator('#title').fill('Plugin rejected');
      await frame.evaluate(() => {
        document.getElementById('parentid').value = '22222222-2222-4222-8222-222222222222';
        document.getElementById('parentid_entityname').value = 'account';
      });
      await frame.locator('#InsertButton').click();
      await page.waitForFunction(() => window.loads === 2);
      assert.equal(await frame.locator('#title').inputValue(), 'Plugin rejected');
      assert.equal(await frame.locator('#MessagePanel.alert-danger').isVisible(), true);
      assert.equal(app.store.snapshot().tables.sample.length, 1);
      assert.ok(
        app.state().diagnostics.some((item) => item.code === 'PluginValidation' && item.message.includes('Synthetic')),
      );
      assert.deepEqual(errors, []);
    });
