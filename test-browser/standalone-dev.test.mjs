import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserChannel } from '../mirage/lib/browser-launch.mjs';
import { freeDebugPort } from './helpers/debug-port.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url)),
  execute = promisify(execFile);
const APP = '77777777-7777-4777-8777-777777777777';
// Resolves with the first match of `pattern` in the child's output, or rejects when the child exits first.
function announced(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const read = (value) => {
      output += value;
      const match = pattern.exec(output);
      if (match) {
        stop();
        resolve(match);
      }
    };
    const exit = () => {
      stop();
      reject(new Error(`dev exited before it announced ${pattern}: ${output}`));
    };
    const stop = () => {
      child.stdout.off('data', read);
      child.stderr.off('data', read);
      child.off('exit', exit);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', exit);
  });
}

test(
  'source-only public dev closes owned browser/runtime, preserves reused runtime and isolates a sibling',
  { timeout: 90000 },
  async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-standalone-dev-'));
    const project = path.join(directory, 'owned.project.json'),
      sibling = path.join(directory, 'sibling.project.json');
    const source = path.join(directory, 'solution', 'AppModules', 'x_workspace', 'AppModule.xml');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(
      source,
      `<AppModule><AppModuleId>${APP}</AppModuleId><UniqueName>x_workspace</UniqueName><LocalizedNames><LocalizedName languagecode="1033" description="Dedicated local workspace"/></LocalizedNames><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>`,
    );
    const entity = path.join(directory, 'solution', 'Entities', 'x_item', 'Entity.xml');
    await fs.mkdir(path.dirname(entity), { recursive: true });
    await fs.writeFile(
      entity,
      '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
    );
    const configuration = JSON.stringify({
      version: 2,
      runtime: { kind: 'model-driven', defaultApp: APP },
      simulation: { level: 'dry-run' },
      solutions: [{ id: 'core', path: './solution' }],
    });
    await fs.writeFile(project, configuration);
    await fs.writeFile(sibling, configuration);
    const commands = async (file, command, ...args) =>
      JSON.parse(
        (
          await execute(process.execPath, [cli, 'mirage', command, '--project', file, '--json', ...args], {
            cwd: directory,
            windowsHide: true,
            timeout: 30000,
          })
        ).stdout,
      );
    const children = [],
      browsers = [];
    const closeBrowser = async (browser) => {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close').catch((error) => {
        if (!/closed|disconnected/i.test(error.message)) throw error;
      });
    };
    t.after(async () => {
      for (const browser of browsers) if (browser.isConnected()) await closeBrowser(browser).catch(() => {});
      for (const entry of children)
        if (entry.child.exitCode === null) {
          entry.child.kill('SIGTERM');
          await Promise.race([entry.exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
        }
      await commands(project, 'stop').catch(() => {});
      await commands(sibling, 'stop').catch(() => {});
      // Windows can keep files of an exited browser profile busy for a few seconds.
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    const siblingRuntime = await commands(sibling, 'start', '--port', '0');
    const develop = async () => {
      const debugPort = await freeDebugPort();
      const child = spawn(
        process.execPath,
        [
          cli,
          'mirage',
          'dev',
          '--project',
          project,
          '--port',
          '0',
          '--browser',
          browserChannel(),
          '--profile',
          'dedicated-fixture',
          '--debug-port',
          String(debugPort),
          // Ownership and closing do not depend on a visible window; headed adds only a slower shutdown.
          '--headless',
        ],
        { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const exited = new Promise((resolve, reject) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', reject);
      });
      children.push({ child, exited });
      // The line is printed after the debugging port is confirmed and just before the first navigation.
      const [, url] = await announced(child, /Opening (http:\/\/127\.0\.0\.1:\d+)\//);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      browsers.push(browser);
      const [context] = browser.contexts();
      const page = context.pages()[0] ?? (await context.waitForEvent('page'));
      await page.waitForURL((address) => address.href.startsWith(url + '/main.aspx'));
      await page.getByLabel('Application', { exact: true }).waitFor();
      await page.waitForFunction(() =>
        document.querySelector('#apps')?.textContent.includes('Dedicated local workspace'),
      );
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

    const background = await commands(project, 'start', '--port', '0'),
      reused = await develop();
    assert.equal(reused.url, background.url);
    await closeBrowser(reused.browser);
    assert.deepEqual(await reused.exited, { code: 0, signal: null });
    assert.equal((await fetch(background.url + '/_sim/api/status')).status, 200);
    await commands(project, 'stop');
    assert.equal((await fetch(siblingRuntime.url + '/_sim/api/status')).status, 200);
    assert.equal(await fs.readFile(project, 'utf8'), configuration);
  },
);
