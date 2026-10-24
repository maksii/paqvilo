import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserChannel } from '../mirage/lib/browser-launch.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url)), execute = promisify(execFile);
const APP = '77777777-7777-4777-8777-777777777777';
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function eventually(fn, message) {
  const deadline = Date.now() + 20000; let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}

test('source-only public dev closes owned browser/runtime, preserves reused runtime and isolates a sibling', { timeout: 90000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-standalone-dev-'));
  const project = path.join(directory, 'owned.project.json'), sibling = path.join(directory, 'sibling.project.json');
  const source = path.join(directory, 'solution', 'AppModules', 'x_workspace', 'AppModule.xml');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, `<AppModule><AppModuleId>${APP}</AppModuleId><UniqueName>x_workspace</UniqueName><LocalizedNames><LocalizedName languagecode="1033" description="Dedicated local workspace"/></LocalizedNames><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>`);
  const entity = path.join(directory, 'solution', 'Entities', 'x_item', 'Entity.xml');
  await fs.mkdir(path.dirname(entity), { recursive: true });
  await fs.writeFile(entity, '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>');
  const configuration = JSON.stringify({ version: 2, runtime: { kind: 'model-driven', defaultApp: APP }, simulation: { level: 'dry-run' }, solutions: [{ id: 'core', path: './solution' }] });
  await fs.writeFile(project, configuration); await fs.writeFile(sibling, configuration);
  const commands = async (file, command, ...args) => JSON.parse((await execute(process.execPath,
    [cli, 'mirage', command, '--project', file, '--json', ...args], { cwd: directory, windowsHide: true, timeout: 30000 })).stdout);
  const children = [], browsers = [];
  const closeBrowser = async browser => {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(error => { if (!/closed|disconnected/i.test(error.message)) throw error; });
  };
  t.after(async () => {
    for (const browser of browsers) if (browser.isConnected()) await closeBrowser(browser).catch(() => {});
    for (const entry of children) if (entry.child.exitCode === null) {
      entry.child.kill('SIGTERM'); await Promise.race([entry.exited, new Promise(resolve => setTimeout(resolve, 10000))]);
    }
    await commands(project, 'stop').catch(() => {}); await commands(sibling, 'stop').catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  const siblingRuntime = await commands(sibling, 'start', '--port', '0');
  const develop = async () => {
    const debugPort = await freePort();
    const child = spawn(process.execPath, [cli, 'mirage', 'dev', '--project', project, '--port', '0',
      '--browser', browserChannel(), '--profile', 'dedicated-fixture', '--debug-port', String(debugPort),
      process.platform === 'win32' ? '--headed' : '--headless'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    children.push({ child, exited });
    const url = await eventually(() => {
      if (child.exitCode !== null) throw new Error(`dev exited early: ${output}`);
      return /Opening (http:\/\/127\.0\.0\.1:\d+)\//.exec(output)?.[1];
    }, 'dev did not open its local browser');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); browsers.push(browser);
    const page = await eventually(() => browser.contexts()[0].pages().find(page => page.url().startsWith(url + '/main.aspx')), 'dedicated browser did not navigate to the local model app');
    await page.getByLabel('Application', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#apps')?.textContent.includes('Dedicated local workspace'));
    assert.equal(await page.getByLabel('Application', { exact: true }).textContent(), 'Dedicated local workspace');
    await page.locator('#content table').waitFor();
    assert.equal(await page.getByRole('link', { name: 'Project setup', exact: true }).count(), 0);
    return { url, browser, child, exited };
  };
  const owned = await develop();
  await closeBrowser(owned.browser);
  assert.deepEqual(await owned.exited, { code: 0, signal: null });
  await assert.rejects(fetch(owned.url + '/_sim/api/status', { signal: AbortSignal.timeout(2000) }), /fetch failed/);
  assert.equal((await fetch(siblingRuntime.url + '/_sim/api/status')).status, 200);

  const background = await commands(project, 'start', '--port', '0'), reused = await develop();
  assert.equal(reused.url, background.url);
  await closeBrowser(reused.browser);
  assert.deepEqual(await reused.exited, { code: 0, signal: null });
  assert.equal((await fetch(background.url + '/_sim/api/status')).status, 200);
  await commands(project, 'stop');
  assert.equal((await fetch(siblingRuntime.url + '/_sim/api/status')).status, 200);
  assert.equal(await fs.readFile(project, 'utf8'), configuration);
});
