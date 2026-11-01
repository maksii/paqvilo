import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { codeAppsWorkbenchHtml } from '../lib/code-apps-workbench.mjs';
import { sharedBrowser, loopbackServer } from './shared-browser.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
const browser = sharedBrowser();
async function listen(t, handler) {
  return (await loopbackServer(t, handler)).origin;
}
test('workbench switches local apps, keeps parameters separate and accepts only selected frame events', async (t) => {
  const app1 = await listen(t, (_req, res) => res.end('<p>First local app</p>'));
  const app2 = await listen(t, (_req, res) => res.end('<p>Second local app</p>'));
  const js = await fs.readFile(new URL('../lib/code-apps-workbench.js', import.meta.url));
  const css = await fs.readFile(new URL('../lib/code-apps-workbench.css', import.meta.url));
  const apps = [
    {
      name: 'first',
      localAppUrl: app1 + '/',
      launchUrl: '/_apps/code/first/',
      diagnostics: [{ code: 'INVENTED', message: 'Review binding' }],
      connectionReferences: [{ key: 'ref', apiId: 'x_connector', dataSources: ['Source'] }],
      entitySets: { source: 'x_items' },
    },
    {
      name: 'second',
      localAppUrl: app2 + '/',
      launchUrl: '/_apps/code/second/',
      diagnostics: [],
      connectionReferences: [],
      entitySets: {},
    },
  ];
  const origin = await listen(t, (req, res) => {
    if (new URL(req.url, 'http://fixture').pathname === '/_apps/code/_api/apps') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ mode: 'simulation', apps }));
    }
    if (req.url === '/_apps/code/_assets/workbench.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(js);
    }
    if (req.url === '/_apps/code/_assets/workbench.css') {
      res.setHeader('content-type', 'text/css');
      return res.end(css);
    }
    res.setHeader('content-type', 'text/html');
    res.end(codeAppsWorkbenchHtml());
  });
  const page = await browser.page(t);
  await page.goto(origin + '/_apps/code/?app=first');
  await page.frameLocator('#preview').getByText('First local app').waitFor();
  assert.match(await page.locator('#diagnostics').innerText(), /INVENTED.*Review binding/);
  assert.match(await page.locator('#connections').innerText(), /ref.*x_connector/);
  assert.match(await page.locator('#mappings').innerText(), /x_items/);
  assert.equal(await page.locator('#connection').innerText(), 'Waiting for bridge');
  await page.frameLocator('#preview').getByText('First local app').waitFor();
  const original = page.frame({ url: app1 + '/' });
  await original.evaluate(() => {
    window.localMarker = 'still running';
  });
  await page.locator('#parameters').fill('draft=unsaved');
  apps[0].server = { state: 'unavailable' };
  apps[0].appSettingNames = ['showHeader'];
  apps[0].diagnostics = [{ code: 'UPDATED', message: 'Changed configuration' }];
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/_apps/code/_api/apps?probe=1'));
  await page.getByRole('button', { name: 'Refresh apps' }).click();
  await refreshed;
  await page.getByText(/Server unavailable/).waitFor();
  assert.equal(await page.locator('#parameters').inputValue(), 'draft=unsaved');
  assert.equal(await original.evaluate(() => window.localMarker), 'still running');
  assert.match(await page.locator('#diagnostics').innerText(), /UPDATED/);
  assert.match(await page.locator('#app-settings').innerText(), /showHeader/);
  await page.locator('#parameters').fill('record=one');
  await page.getByRole('button', { name: 'Apply parameters' }).click();
  await page.waitForFunction(() => document.querySelector('#preview').src.includes('record=one'));
  const frame1 = page.frame({ url: /record=one/ });
  await frame1.evaluate(() =>
    parent.postMessage(
      {
        type: 'paqvilo:code-app',
        app: 'first',
        event: {
          kind: 'bridge-ready',
          path: '/_apps/code/first/dataverse/items(secret-id)?secret=not-visible',
          message: 'private-value',
        },
      },
      '*',
    ),
  );
  await page.getByText('Bridge connected').waitFor();
  assert.match(await page.locator('#events').innerText(), /items\(\.\.\.\)/);
  assert.doesNotMatch(await page.locator('#events').innerText(), /not-visible|private-value|secret-id/);
  await frame1.evaluate(() =>
    parent.postMessage(
      {
        type: 'paqvilo:code-app',
        app: 'first',
        event: {
          kind: 'request',
          method: 'POST',
          status: 501,
          path: '/_apps/code/first/connectors/reference/' + '('.repeat(20000) + 'private-unclosed-key',
        },
      },
      '*',
    ),
  );
  await page.locator('#events li').last().filter({ hasText: 'POST' }).waitFor();
  const malformed = await page.locator('#events li').last().innerText();
  assert.equal(malformed, 'request · POST · /_apps/code/first/connectors/reference/(...) · 501');
  await frame1.evaluate(() => {
    parent.postMessage({ type: 'paqvilo:code-app', app: 'first', event: { kind: 'private-kind' } }, '*');
    parent.postMessage({ type: 'paqvilo:code-app', app: 'first', event: { kind: 'request', path: '/outside' } }, '*');
    for (let i = 0; i < 105; i++)
      parent.postMessage(
        {
          type: 'paqvilo:code-app',
          app: 'first',
          event: { kind: 'request', path: '/_apps/code/first/dataverse/items', status: 200 },
        },
        '*',
      );
  });
  await page.waitForFunction(() => document.querySelectorAll('#events li').length === 100);
  assert.doesNotMatch(await page.locator('#events').innerText(), /private-kind|outside/);
  await page.selectOption('#app', 'second');
  await page.frameLocator('#preview').getByText('Second local app').waitFor();
  assert.equal(await page.locator('#parameters').inputValue(), '');
  assert.equal(await page.locator('#events li').count(), 0);
  await page.evaluate(() =>
    window.postMessage({ type: 'paqvilo:code-app', app: 'second', event: { kind: 'bridge-ready' } }, '*'),
  );
  const second = page.frame({ url: app2 + '/' });
  await second.evaluate(() =>
    parent.postMessage({ type: 'paqvilo:code-app', app: 'first', event: { kind: 'bridge-ready' } }, '*'),
  );
  assert.equal(await page.locator('#connection').innerText(), 'Waiting for bridge');
  assert.equal(await page.locator('#events li').count(), 0);
  await page.selectOption('#app', 'first');
  assert.equal(await page.locator('#parameters').inputValue(), 'record=one');
  assert.equal(new URL(page.url()).searchParams.get('app'), 'first');
  assert.equal(await page.locator('#open').getAttribute('href'), origin + '/_apps/code/first/?record=one');
  await page.getByRole('button', { name: 'Reload app' }).click();
  await page.frameLocator('#preview').getByText('First local app').waitFor();
  apps[0].localAppUrl = app2 + '/changed';
  apps[0].server = { state: 'reachable', status: 200 };
  const changed = page.waitForResponse((response) => response.url().endsWith('/_apps/code/_api/apps?probe=1'));
  await page.getByRole('button', { name: 'Refresh apps' }).click();
  await changed;
  await page.frameLocator('#preview').getByText('Second local app').waitFor();
  assert.equal(await page.locator('#parameters').inputValue(), 'record=one');
  assert.match(await page.locator('#server').innerText(), /Server reachable.*readiness is not verified/);
});

test('a reload from the previous app document cannot replace an applied launch', async (t) => {
  let release, arrived, opened, closed;
  const gate = new Promise((resolve) => (release = resolve)),
    held = new Promise((resolve) => (arrived = resolve)),
    connected = new Promise((resolve) => (opened = resolve)),
    disconnected = new Promise((resolve) => (closed = resolve));
  const streams = new Set(),
    served = [];
  ownedFixture(t).add(() => {
    release();
    for (const stream of streams) stream.destroy();
  });
  // Each document reloads itself on a server event, as a Vite client does on a full-reload broadcast.
  const app = await listen(t, async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(':\n\n');
      streams.add(res);
      opened();
      req.on('close', () => {
        streams.delete(res);
        closed();
      });
      return;
    }
    served.push(req.url);
    const applied = req.url.includes('record=late');
    if (applied) {
      arrived();
      await gate;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<p>${applied ? 'Applied launch' : 'Previous launch'}</p><script>new EventSource('/events').onmessage=()=>location.reload()</script>`,
    );
  });
  const js = await fs.readFile(new URL('../lib/code-apps-workbench.js', import.meta.url));
  const apps = [{ name: 'first', localAppUrl: app + '/', launchUrl: '/_apps/code/first/' }];
  const origin = await listen(t, (req, res) => {
    if (new URL(req.url, 'http://fixture').pathname === '/_apps/code/_api/apps') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ mode: 'simulation', apps }));
    }
    if (req.url === '/_apps/code/_assets/workbench.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(js);
    }
    res.setHeader('content-type', 'text/html');
    res.end(codeAppsWorkbenchHtml());
  });
  const page = await browser.page(t);
  await page.goto(origin + '/_apps/code/?app=first');
  await page.frameLocator('#preview').getByText('Previous launch').waitFor();
  await connected;
  await page.locator('#parameters').fill('record=late');
  await page.getByRole('button', { name: 'Apply parameters' }).click();
  // The applied document is still in flight when the previous document is told to reload.
  await held;
  for (const stream of streams) stream.write('data: reload\n\n');
  await disconnected;
  release();
  await page.frameLocator('#preview').getByText('Applied launch').waitFor();
  assert.deepEqual(served, ['/', '/?record=late']);
});
