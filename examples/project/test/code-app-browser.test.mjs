import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startCodeApp } from './code-app-process.mjs';
import { chromium } from 'playwright-core';
import { createSimulator } from 'paqvilo/mirage';
import { browserLaunchOptions } from 'paqvilo/mirage/lib/browser-launch.mjs';
test('example uses the standalone organization and selected staff session', { timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { child, port } = await startCodeApp(
    t,
    {
      CODE_APP_PORT: '0',
      CODE_APP_CLIENT: import.meta.resolve('paqvilo/mirage/lib/code-apps-client.js'),
    },
    { ipc: true },
  );
  const sim = await createSimulator({
    projectRoot: root,
    solutionRoots: [fileURLToPath(new URL('../code-app/solution/', import.meta.url))],
    runtime: { kind: 'dataverse-api' },
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    codeApps: [{ name: 'invented-items', dir: 'code-app', localAppUrl: `http://127.0.0.1:${port}/` }],
    port: 0,
    watch: false,
  });
  t.after(() => sim.close());
  const origin = sim.origin ?? sim.url;
  child.send(origin);
  await once(child, 'message');
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const unauthorized = await page.request.get(`${origin}/_apps/code/invented-items/context`);
  assert.equal(unauthorized.status(), 401);
  const csrf = sim.state().csrf;
  const made = await page.request.post(`${origin}/_sim/api/dataverse/users`, {
    headers: { 'x-sim-csrf': csrf },
    data: { fullname: 'Example Staff', domainname: 'example@example.test', roles: ['System Administrator'] },
  });
  assert.equal(made.status(), 201);
  const selected = await page.request.post(`${origin}/_sim/api/dataverse/session`, {
    headers: { 'x-sim-csrf': csrf },
    data: { userId: (await made.json()).systemuserid },
  });
  assert.equal(selected.status(), 200);
  await page.goto(`${origin}/_apps/code/invented-items/`);
  const frame = page.frameLocator('iframe');
  await frame.getByText('Signed in locally as Example Staff').waitFor();
  await frame.getByLabel('Item name').fill('Actual item');
  // Verify browser debugging against the served application source, then continue the same interaction.
  const debuggerSession = await page.context().newCDPSession(page);
  const scripts = [];
  debuggerSession.on('Debugger.scriptParsed', (script) => scripts.push(script));
  await debuggerSession.send('Debugger.enable');
  const script = scripts.find((item) => item.url === `http://127.0.0.1:${port}/app.js`);
  assert.ok(script, 'the framed application source is available to the browser debugger');
  const { scriptSource } = await debuggerSession.send('Debugger.getScriptSource', { scriptId: script.scriptId });
  const lineNumber = scriptSource.split('\n').findIndex((line) => line.includes('await Items.create('));
  assert.ok(lineNumber >= 0);
  const breakpoint = await debuggerSession.send('Debugger.setBreakpointByUrl', { url: script.url, lineNumber });
  const paused = once(debuggerSession, 'Debugger.paused');
  const create = frame.getByRole('button', { name: 'Create' }).click();
  const [pause] = await paused;
  assert.ok(pause.hitBreakpoints.includes(breakpoint.breakpointId));
  await debuggerSession.send('Debugger.resume');
  await create;
  await debuggerSession.detach();
  await frame.getByText('Actual item', { exact: true }).waitFor();
  await frame.getByRole('button', { name: 'Rename' }).click();
  await frame.getByText('Actual item updated', { exact: true }).waitFor();
  await frame.getByRole('button', { name: 'Delete' }).click();
  await frame.getByText('Actual item updated', { exact: true }).waitFor({ state: 'detached' });
  const response = page.waitForResponse((item) => item.url().includes('/connectors/'));
  await frame.getByRole('button', { name: 'Try connector' }).click();
  const connector = await response;
  assert.equal(connector.status(), 501);
  await frame.getByText(/ConnectorNot/).waitFor();
  assert.deepEqual(errors, []);
});
