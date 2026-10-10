import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { SITE } from '../test/fixture.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';
import { assemblyXml, stepXml } from '../mirage/test/plugin-fixture.mjs';

for (const mirage of [false, true]) test(`${mirage ? 'Mirage' : 'live-source Lense'} Inspect opens applicable plugin metadata and explicitly mapped C# source`, { timeout: 45_000 }, async t => {
  const fx = inspectionFixture();
  const assembly = path.join(fx.solution, 'PluginAssemblies/Synthetic/Synthetic.xml');
  const step = path.join(fx.solution, 'SdkMessageProcessingSteps/update.xml');
  const code = path.join(fx.work, 'components/Plugins/Rules.cs');
  for (const [file, body] of [[assembly, assemblyXml], [step, stepXml(7, { message: 'Update', attributes: 'fx_title' })], [code, 'namespace Invented.WidgetRules { class Validate {} }']]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
  }
  const observed = { evidence: 'Invented source navigation fixture', pluginSources: { 'Invented.WidgetRules.Validate': { path: 'components/Plugins/Rules.cs', root: fx.work, evidence: 'Exact invented C# mapping' } } };
  const project = path.join(fx.work, 'project.json');
  fs.writeFileSync(project, JSON.stringify({ version: 2, portals: [{ id: 'fixture', path: './portal', observed }], solutions: [{ id: 'sample', path: './solution' }] }));
  let app, server, browser, panel, detach;
  t.after(async () => {
    await panel?.dispose(); await detach?.(); await browser?.close(); await app?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fx.cleanup();
  });
  let origin;
  if (mirage) {
    app = await createSimulator({ sourceDir: fx.portal, solutionRoots: [fx.solution], observed, stateFile: path.join(fx.work, 'state.json'), watch: false });
    origin = app.url;
  } else {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Invented source fixture</title><form data-entityname="fx_widget"><label for="fx_title">Title</label><input id="fx_title"></form>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(10_000);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
  const session = new OverlaySession({ sourceDir: fx.portal, origin, site: structuredClone(SITE), sourceMaps: false, siteName: 'Plugin fixture', envName: 'loopback', stateDir: fx.work, browser: {}, mirage, mirageSourceRoots: [fx.portal, fx.solution], mirageConfig: { project } });
  detach = await attachSession(context, session);
  const opened = [];
  panel = enablePanel(context, session, { open: async (...args) => { opened.push(args); return null; } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const scope = page.locator('#paqvilo-panel');
  await scope.locator('.pill').click();
  await scope.locator('[data-act="tab"][data-v="runtime"]').click();
  const logic = scope.locator('[data-group="runtime-logic"]');
  await logic.getByText('Widget step 7', { exact: true }).waitFor();
  assert.match(await logic.innerText(), /fx_widget Update.*PreValidation.*input attributes: fx_title.*live execution unknown/);
  for (const [suffix, exact] of [['update.xml', step], ['Synthetic.xml', assembly], ['Rules.cs', code]]) {
    await logic.locator(`[data-rel$="${suffix}"] [data-act="open"]`).first().click();
    await page.waitForTimeout(100);
    assert.equal(opened.at(-1)[1], exact);
  }
  assert.deepEqual(errors, []);
});
