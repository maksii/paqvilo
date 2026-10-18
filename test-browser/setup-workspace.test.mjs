import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';
import { chromium } from 'playwright-core';
import YAML from 'yaml';
import { prepareDemo } from '../lense/commands/demo.mjs';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { startSetupServer } from '../lense/setup/server.mjs';
import { createSimulator } from '../mirage/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const browserOptions = { headless: true, channel: channel === 'chromium' ? undefined : channel };
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-setup-browser-'));
  t.resources = [];
  t.after(async () => {
    for (const dispose of t.resources.reverse()) await dispose();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return directory;
}
async function localGit(directory, source) {
  await fs.cp(source, directory, { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-C', directory, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Setup Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-fixture-hooks', 'commit', '--quiet', '-m', 'Fixture export');
}
async function saveForm(page, form) {
  const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/_setup/api/config') && response.request().method() === 'POST'), form.locator('button[type=submit]').click()]);
  assert.equal(response.ok(), true, await response.text());
  await page.locator('#notice').filter({ hasText: /^Saved\./ }).waitFor();
}

test('setup UI configures a demo and an independent scaffold with two local Git exports and validates Mirage flows', { timeout: 120000 }, async t => {
  const work = await temporary(t), demo = path.join(work, 'demo'), consumer = path.join(work, 'consumer');
  await prepareDemo(demo);
  const catalogueFile = path.join(demo, 'paqvilo.config.yml');
  const catalogue = await fs.readFile(catalogueFile, 'utf8');
  await fs.writeFile(catalogueFile, catalogue
    .replace('      solutionRoots: [ ./code-solution, ./metadata, ./solution ]\n', '')
    .replace('local: http://127.0.0.1:8787', 'local: http://127.0.0.1:8787 # TODO(paqvilo-init): choose an origin')
    + 'defaults:\n  mirage:\n    solutionRoots: [ ./code-solution, ./metadata, ./solution ]\n');
  await fs.mkdir(path.join(demo, 'node_modules'));
  await fs.symlink(root, path.join(demo, 'node_modules/paqvilo'), process.platform === 'win32' ? 'junction' : 'dir');
  await prepareProject(consumer, { name: 'onboarding', sites: ['alpha', 'beta'], noPack: true });
  const sources = path.join(work, 'checkouts');
  await localGit(path.join(sources, 'classic'), path.join(root, 'examples/project/portal'));
  await localGit(path.join(sources, 'code'), path.join(root, 'test-browser/fixtures/code-site'));
  const browser = await chromium.launch(browserOptions); t.resources.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  const demoServer = await startSetupServer({ directory: demo, processEnv: {} }); t.resources.push(() => demoServer.close());
  await page.goto(demoServer.url);
  await page.getByRole('heading', { name: 'Portals & sources', exact: true }).waitFor();
  assert.match(await page.locator('#portal-example').innerText(), /Source found/);
  const demoForm = page.locator('form[data-form=site][data-site=example]');
  await page.locator('#portal-example summary').first().click();
  const configurationBefore = await fs.readFile(path.join(demo, 'paqvilo.config.yml'), 'utf8');
  await demoForm.locator('[name=port]').fill('0');
  await saveForm(page, demoForm);
  assert.equal(await fs.readFile(path.join(demo, 'paqvilo.config.yml'), 'utf8'), configurationBefore.replace('port: 8787', 'port: 0'));
  assert.equal(YAML.parse(await fs.readFile(path.join(demo, 'paqvilo.config.yml'), 'utf8')).sites.example.mirage.port, 0);
  const demoRuntime = await createSimulator({ sourceDir: path.join(demo, 'portal'), watch: false,
    solutionRoots: [path.join(demo, 'metadata'), path.join(demo, 'code-solution'), path.join(demo, 'solution')],
    dataPacks: [{ id: 'example', module: path.join(demo, 'pack/pack.mjs') }], preset: 'example-demo',
    setup: { config: path.join(demo, 'paqvilo.config.yml'), processEnv: {} } });
  t.resources.push(() => demoRuntime.close());
  assert.match(await fetch(demoRuntime.url).then(response => response.text()), /Build it three ways/);
  await page.goto(demoRuntime.url + '/_sim/');
  const popupWait = page.waitForEvent('popup'); await page.getByRole('link', { name: 'Project setup', exact: true }).click();
  const popup = await popupWait; await popup.getByRole('heading', { name: 'Project setup', exact: true }).waitFor();
  assert.equal(await popup.getByRole('link', { name: '← Back to portal', exact: true }).getAttribute('href'), '/');
  assert.equal(await popup.getByRole('link', { name: 'Manage data and personas', exact: true }).getAttribute('href'), '/_sim/');
  assert.match(await popup.locator('#overview').innerText(), /Mirage preview running/); await popup.close();

  const server = await startSetupServer({ directory: consumer, processEnv: {} }); t.resources.push(() => server.close());
  await page.goto(server.url);
  await page.getByRole('heading', { name: 'Project settings', exact: true }).waitFor();
  assert.match(await page.locator('#overview').innerText(), /Select an existing local export folder/);
  let form = page.locator('form[data-form=settings]');
  await form.locator('[name=sourceRoot]').fill(sources); await saveForm(page, form);
  for (const [id, sourceName] of [['alpha', 'classic'], ['beta', 'code']]) {
    await page.locator(`#portal-${id} summary`).first().click(); form = page.locator(`form[data-form=site][data-site=${id}]`);
    await form.locator('[name=source]').fill(sourceName); await form.locator('[name=solutions]').fill('');
    await form.locator('[name=env-url]').fill(`http://127.0.0.1:${id === 'alpha' ? 8787 : 8788}`);
    await form.locator('[name=port]').fill('0');
    await saveForm(page, form);
    assert.match(await page.locator(`#portal-${id}`).innerText(), /Source found/);
    assert.doesNotMatch(await page.locator(`#portal-${id}`).innerText(), /No committed Git checkout/);
  }
  assert.match(await page.locator('#overview').innerText(), /Configuration ready/);
  const sharedBefore = await fs.readFile(path.join(consumer, 'paqvilo.config.yml'), 'utf8');
  await page.evaluate(() => {
    const selector = document.querySelector('#layer');
    const option = new Option('Invalid layer', '<img src=x onerror="window.invalidLayerExecuted=true">');
    selector.append(option); selector.value = option.value;
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => window.invalidLayerExecuted), undefined);
  assert.equal(await page.locator('form[data-form=site] .hint').filter({ hasText: 'Writes the shared configuration.' }).count(), 2);
  await page.locator('#layer').selectOption('personal');
  form = page.locator('form[data-form=settings]'); await form.locator('[name=browser]').selectOption('chrome'); await saveForm(page, form);
  assert.equal(await fs.readFile(path.join(consumer, 'paqvilo.config.yml'), 'utf8'), sharedBefore);
  assert.equal(YAML.parse(await fs.readFile(path.join(consumer, 'paqvilo.config.local.yml'), 'utf8')).browser.channel, 'chrome');
  await page.locator('#layer').selectOption('shared');
  const originalRevision = await page.request.get(new URL('api/status', server.url).href).then(response => response.json());
  await fs.appendFile(path.join(consumer, 'paqvilo.config.yml'), '# external edit\n');
  form = page.locator('form[data-form=settings]'); await form.locator('[name=sourceRoot]').fill('./unsaved');
  await form.locator('button[type=submit]').click(); await page.locator('#notice.error').filter({ hasText: /Reload before saving/ }).waitFor();
  assert.equal(await form.locator('[name=sourceRoot]').inputValue(), './unsaved');
  assert.notEqual((await page.request.get(new URL('api/status', server.url).href).then(response => response.json())).revision, originalRevision.revision);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('form[data-form=settings] [name=sourceRoot]').value === expected, sources);
  if (process.env.PAQVILO_SETUP_SCREENSHOTS) {
    await page.screenshot({ path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'setup-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'setup-mobile.png'), fullPage: true });
  }
  const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => ({ tag: node.tagName, class: node.className, right: node.getBoundingClientRect().right })).slice(0, 12));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, JSON.stringify(overflow));
  for (const sourceName of ['classic', 'code']) {
    const runtime = await createSimulator({ sourceDir: path.join(sources, sourceName), watch: false, setup: { config: path.join(consumer, 'paqvilo.config.yml'), processEnv: {} } });
    try {
      assert.equal((await fetch(runtime.url)).status, 200);
      assert.equal((await fetch(runtime.setupUrl)).status, 200);
      const state = await fetch(runtime.url + '/_setup/api/status').then(response => response.json());
      assert.equal(state.sites.length, 2); assert.equal(state.ready, true);
    } finally { await runtime.close(); }
  }
  assert.deepEqual(failures, []);
});

test('missing and invalid setup documents recover through the browser without touching exports', { timeout: 60000 }, async t => {
  const directory = await temporary(t), server = await startSetupServer({ directory, processEnv: {} }); t.resources.push(() => server.close());
  const browser = await chromium.launch(browserOptions); t.resources.push(() => browser.close());
  const page = await browser.newPage(); await page.goto(server.url);
  const create = page.locator('form[data-form=create]'); await create.waitFor();
  await create.locator('[name=id]').fill('sample'); await saveForm(page, create);
  const file = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(file, 'sites: [invalid\n'); await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.waitForFunction(() => document.querySelector('[name=yaml]').value.includes('[invalid'));
  const yaml = page.locator('form[data-form=yaml]');
  await yaml.locator('[name=yaml]').fill('sourceRoot: .\nsites: {}\n'); await saveForm(page, yaml);
  assert.deepEqual(YAML.parse(await fs.readFile(file, 'utf8')).sites, {});
  assert.ok(!(await fs.readdir(directory)).includes('.paqvilo'));
});

test('Lense dev exposes a setup panel link on a loopback fixture and closes its sidecar with its browser', { timeout: 120000 }, async t => {
  const directory = await temporary(t), checkout = path.join(directory, 'export');
  await localGit(checkout, path.join(root, 'examples/project/portal'));
  const consumer = path.join(directory, 'project'); await prepareProject(consumer, { name: 'lense-setup', noPack: true });
  const simulator = await createSimulator({ sourceDir: checkout, watch: false }); t.resources.push(() => simulator.close());
  const configFile = path.join(consumer, 'paqvilo.config.yml');
  await fs.writeFile(configFile, YAML.stringify({ sourceRoot: checkout, defaultSite: 'portal', sites: { portal: { source: '.', environments: { dev: simulator.url }, markup: { enabled: false } } } }));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'lense/cli.mjs'), 'dev', '--config', configFile, '--headless', '--browser', channel, '--debug-port', String(port)], { cwd: consumer, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', browser, setupUrl;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  t.resources.push(async () => {
    if (browser) { const cdp = await browser.newBrowserCDPSession().catch(() => null); await cdp?.send('Browser.close').catch(() => {}); await browser.close().catch(() => {}); }
    if (child.exitCode === null) child.kill('SIGTERM'); await exited;
    if (setupUrl) await assert.rejects(fetch(setupUrl), 'the owned setup server stops with dev');
  });
  const deadline = Date.now() + 45000;
  while (!/Watching local sources/.test(output) && !/Watching sources/.test(output) && !/Browse pages and open tabs/.test(output) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  setupUrl = output.match(/setup\s+(http:\/\/127\.0\.0\.1:\d+\/_setup\/)/)?.[1]; assert.ok(setupUrl, output);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0]; await page.waitForURL(simulator.url + '/');
  await page.locator('#paqvilo-panel').waitFor({ state: 'attached' });
  await page.keyboard.press('Alt+Shift+P');
  const link = page.locator('#paqvilo-panel a[title="Project setup"]'); await link.waitFor();
  assert.equal(await link.locator('svg').count(), 1);
  assert.equal(await link.innerText(), '');
  if (process.env.PAQVILO_SETUP_SCREENSHOTS) await page.screenshot({ path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'panel-setup.png') });
  const popupPromise = page.waitForEvent('popup'); await link.click(); const popup = await popupPromise;
  await popup.getByRole('heading', { name: 'Project setup', exact: true }).waitFor();
  assert.equal(popup.url(), setupUrl); assert.match(await popup.locator('#overview').innerText(), /Lense preview running/);
  assert.equal(await popup.getByRole('link', { name: '← Back to portal', exact: true }).getAttribute('href'), simulator.url);
  if (process.env.PAQVILO_SETUP_SCREENSHOTS) await popup.screenshot({ path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'lense-setup.png'), fullPage: true });
  assert.equal(await popup.locator('#paqvilo-panel').count(), 0);
});
