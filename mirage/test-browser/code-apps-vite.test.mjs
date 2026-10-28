import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer, build } from 'vite';
import { createSimulator } from '../api.mjs';
import { codeApps } from '../lib/code-apps-vite.mjs';
import { sharedBrowser } from './shared-browser.mjs';
import { ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';

const browser = sharedBrowser();
const toolkit = fileURLToPath(new URL('../../', import.meta.url));
const application = `import { getContext, setConfig } from '@microsoft/power-apps/app';
import { getClient } from '@microsoft/power-apps/data';
import { label } from './label.js';
if (!window.preamble) throw new Error('Inline module preamble did not run before the app');
setConfig({});
const context = await getContext();
window.appContext = context;
const client = getClient({ Items: { tableId: 'x_item', apis: {} } });
document.querySelector('#context').textContent = label+' · '+context.app.appId+' · '+context.user.fullName+' · '+(context.app.queryParams.panel||'')+' · '+context.app.appSettings.theme;
async function refresh(){const result=await client.retrieveMultipleRecordsAsync('Items');if(!result.success)throw result.error;document.querySelector('#items').textContent=result.data.map(row=>row.x_name).join(', ')}
document.querySelector('#create').onclick=async()=>{
  const result = await client.createRecordAsync('Items',{x_name:document.querySelector('#name').value});
  if(!result.success)throw result.error;
  await refresh();
};
await refresh();`;

test(
  'two ordinary SDK Vite apps load, switch, edit and debug through the local workbench',
  { timeout: 60000 },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paq-code-app-vite-')));
    ownedFixture(t).remove(() => removeFixtureDirectory(root));
    let release;
    ownedFixture(t).add(() => release?.());
    await fs.symlink(path.join(toolkit, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    const solution = path.join(root, 'solution');
    await fs.mkdir(path.join(solution, 'Entities/x_item'), { recursive: true });
    await fs.writeFile(
      path.join(solution, 'Entities/x_item/Entity.xml'),
      '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
    );
    for (const name of ['alpha', 'beta']) {
      const dir = path.join(root, name);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }));
      await fs.writeFile(
        path.join(dir, 'index.html'),
        '<!doctype html><html><body><p id="context"></p><label>Item name<input id="name"></label><button id="create">Create</button><p id="items"></p><script type="module">window.preamble=true;</script>' +
          (name === 'beta'
            ? `<script type="module">${application}</script>`
            : '<script type="module" src="/main.js"></script>') +
          '</body></html>',
      );
      await fs.writeFile(path.join(dir, 'main.js'), application);
      await fs.writeFile(path.join(dir, 'label.js'), `export const label=${JSON.stringify(name)};`);
    }
    const sim = await createSimulator({
      projectRoot: root,
      solutionRoots: [solution],
      runtime: { kind: 'dataverse-api' },
      simulation: { level: 'dry-run' },
      dataverse: { enabled: true, tls: false, tds: { enabled: false } },
      codeApps: [
        { name: 'alpha', dir: 'alpha' },
        { name: 'beta', dir: 'beta' },
      ],
      port: 0,
      watch: false,
    });
    ownedFixture(t).add(() => sim.close());
    const origin = sim.origin ?? sim.url;
    const servers = {};
    for (const name of ['alpha', 'beta']) {
      // Vite treats port 0 as its default port; reserve an OS-selected port before starting it.
      const reservation = net.createServer();
      await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      const vite = await createServer({
        root: path.join(root, name),
        configFile: false,
        logLevel: 'error',
        server: { port },
        plugins: [codeApps({ app: name, mirageUrl: origin, enabled: true })],
      });
      ownedFixture(t).add(() => vite.close());
      await vite.listen();
      servers[name] = `http://127.0.0.1:${vite.httpServer.address().port}`;
      await fs.writeFile(
        path.join(root, name, 'power.config.json'),
        JSON.stringify({
          appId: name + '-id',
          localAppUrl: servers[name],
          appSettings: { theme: name + '-theme' },
          databaseReferences: {
            invented: { dataSources: { Items: { logicalName: 'x_item', entitySetName: 'x_items' } } },
          },
        }),
      );
    }
    const page = await browser.page(t);
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const csrf = sim.state().csrf;
    const made = await page.request.post(origin + '/_sim/api/dataverse/users', {
      headers: { 'x-sim-csrf': csrf },
      data: { fullname: 'Invented Developer', domainname: 'developer@example.test', roles: ['System Administrator'] },
    });
    assert.equal(made.status(), 201);
    assert.equal(
      (
        await page.request.post(origin + '/_sim/api/dataverse/session', {
          headers: { 'x-sim-csrf': csrf },
          data: { userId: (await made.json()).systemuserid },
        })
      ).status(),
      200,
    );
    let requested;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const arrived = new Promise((resolve) => {
      requested = resolve;
    });
    let held = false;
    await page.route('**/_apps/code/alpha/status', async (route) => {
      if (!held) {
        held = true;
        requested();
        await gate;
      }
      await route.continue();
    });
    await page.goto(origin + '/_apps/code/?app=alpha');
    await arrived;
    // An edit made while SDK initialization is held must be the first visible application source.
    await fs.writeFile(path.join(root, 'alpha/label.js'), 'export const label="startup edit";');
    release();
    const frame = page.frameLocator('#preview');
    await frame.locator('#context').filter({ hasText: 'startup edit · alpha-id · Invented Developer' }).waitFor();
    await page.getByRole('status').filter({ hasText: 'Bridge connected' }).waitFor();
    const alphaSession = await page
      .frames()
      .find((f) => f.url().startsWith(servers.alpha))
      .evaluate(() => window.appContext.host.sessionId);
    await page.getByLabel('Parameters', { exact: true }).fill('panel=first');
    await page.getByRole('button', { name: 'Apply parameters', exact: true }).click();
    await frame.locator('#context').filter({ hasText: 'first · alpha-theme' }).waitFor();
    const cdp = await page.context().newCDPSession(page);
    const scripts = [];
    cdp.on('Debugger.scriptParsed', (script) => scripts.push(script));
    await cdp.send('Debugger.enable');
    const script = scripts.find((item) => item.url.startsWith(servers.alpha + '/main.js'));
    assert.ok(script, 'the original application source is available to the debugger');
    const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: script.scriptId });
    const lineNumber = scriptSource.split('\n').findIndex((line) => line.includes('await client.createRecordAsync'));
    assert.ok(lineNumber >= 0);
    const breakpoint = await cdp.send('Debugger.setBreakpointByUrl', { url: script.url, lineNumber });
    await frame.getByLabel('Item name').fill('Shared local record');
    const paused = once(cdp, 'Debugger.paused');
    const create = frame.getByRole('button', { name: 'Create', exact: true }).click();
    assert.ok((await paused)[0].hitBreakpoints.includes(breakpoint.breakpointId));
    await cdp.send('Debugger.resume');
    await create;
    await cdp.detach();
    await frame.locator('#items').filter({ hasText: 'Shared local record' }).waitFor();
    await fs.writeFile(path.join(root, 'alpha/label.js'), 'export const label="live edit";');
    await frame.locator('#context').filter({ hasText: 'live edit' }).waitFor();
    await page.getByLabel('App', { exact: true }).selectOption('beta');
    await frame.locator('#context').filter({ hasText: 'beta · beta-id · Invented Developer' }).waitFor();
    await frame.locator('#items').filter({ hasText: 'Shared local record' }).waitFor();
    const betaSession = await page
      .frames()
      .find((f) => f.url().startsWith(servers.beta))
      .evaluate(() => window.appContext.host.sessionId);
    assert.notEqual(betaSession, alphaSession);
    await page.getByLabel('App', { exact: true }).selectOption('alpha');
    await frame.locator('#context').filter({ hasText: 'live edit · alpha-id · Invented Developer · first' }).waitFor();
    assert.equal(await page.getByLabel('Parameters', { exact: true }).inputValue(), 'panel=first');
    // Configuration changes reload the app and are read from power.config, without restarting Mirage.
    const file = path.join(root, 'alpha/power.config.json');
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    config.appSettings.theme = 'changed-theme';
    await fs.writeFile(file, JSON.stringify(config));
    await frame.locator('#context').filter({ hasText: 'changed-theme' }).waitFor();
    assert.deepEqual(errors, []);
    const built = await build({
      root: path.join(root, 'alpha'),
      configFile: false,
      logLevel: 'error',
      plugins: [codeApps({ app: 'alpha', mirageUrl: origin, enabled: true })],
      build: { write: false, target: 'esnext' },
    });
    const output = (Array.isArray(built) ? built : [built])
      .flatMap((item) => item.output)
      .filter((item) => item.type === 'chunk')
      .map((item) => item.code)
      .join('\n');
    assert.doesNotMatch(output, /paqvilo:code-app|code-app-bootstrap|_apps\/code\/alpha/);
  },
);
