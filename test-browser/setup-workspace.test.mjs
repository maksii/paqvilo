import { makeTemporaryDirectory, drainFixture, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import YAML from 'yaml';
import { prepareDemo } from '../lense/commands/demo.mjs';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { startSetupServer } from '../lense/setup/server.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { freeDebugPort } from './helpers/debug-port.mjs';

// These cases exercise the All settings view of /_setup/ (Quick setup is the default for a new browser).
const allSettings = (page) =>
  page.context().addInitScript(() => {
    try {
      localStorage.setItem('paqvilo-setup-view', 'all');
    } catch {
      /* no storage */
    }
  });

const root = fileURLToPath(new URL('../', import.meta.url));
const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const browserOptions = { headless: true, channel: channel === 'chromium' ? undefined : channel };
let browser;
before(async () => {
  browser = await chromium.launch(browserOptions);
});
after(() => browser?.close());
// Call after temporary(t): the context closes with the test's other resources.
async function newPage(t, options) {
  const context = await browser.newContext(options);
  t.resources.push(() => context.close());
  return context.newPage();
}
async function temporary(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-setup-browser-'));
  t.resources = [];
  t.after(async () => {
    await drainFixture(t.resources.toReversed());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return directory;
}

test('setup fixture drains its browser after a sibling resource close fails and retains its directory', async (t) => {
  const hooks = [],
    context = { after: (hook) => hooks.push(hook) },
    owner = ownedFixture(t);
  let page, directory;
  owner.add(() => page?.context().close());
  owner.remove(() => directory && fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  directory = await temporary(context);
  page = await newPage(context);
  const failure = Error('Invented setup sibling close failure');
  context.resources.push(() => {
    throw failure;
  });
  await assert.rejects(hooks[0](), (error) => error === failure);
  assert.equal(page.isClosed(), true);
  assert.equal((await fs.stat(directory)).isDirectory(), true, 'failed draining retains fixture state');
});
async function localGit(directory, source) {
  await fs.cp(source, directory, { recursive: true });
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-C', directory, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
      // Repository variables of a calling Git process would redirect these commands.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    });
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Setup Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=disabled-fixture-hooks',
    'commit',
    '--quiet',
    '-m',
    'Fixture export',
  );
}
async function saveForm(page, form) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/_setup/api/config') && response.request().method() === 'POST',
    ),
    form.locator('button[type=submit]').click(),
  ]);
  assert.equal(response.ok(), true, await response.text());
  await page
    .locator('#notice')
    .filter({ hasText: /^Saved\./ })
    .waitFor();
}

test('background preview polling preserves an unsaved settings draft', async (t) => {
  const work = await temporary(t);
  await prepareProject(work, { name: 'draft-poll', noPack: true });
  const server = await startSetupServer({ directory: work, processEnv: {} });
  t.resources.push(() => server.close());
  const page = await newPage(t);
  await allSettings(page);
  await page.goto(server.url + '#settings');
  await page.waitForFunction(() => document.querySelector('#content')?.getAttribute('aria-busy') === null);
  const input = page.locator('form[data-form=settings] [name=sourceRoot]');
  await input.fill('./unsaved-draft');
  const response = page.waitForResponse((item) => item.url().endsWith('/_setup/api/preview'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await (await response).finished();
  // Allow the response handlers and their paint to finish before reading the draft.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await input.inputValue(), './unsaved-draft');
});

test(
  'setup UI configures a demo and an independent scaffold with two local Git exports and validates Mirage flows',
  { timeout: 120000 },
  async (t) => {
    const work = await temporary(t),
      demo = path.join(work, 'demo'),
      consumer = path.join(work, 'consumer');
    await prepareDemo(demo);
    const catalogueFile = path.join(demo, 'paqvilo.config.yml');
    const catalogue = await fs.readFile(catalogueFile, 'utf8');
    await fs.writeFile(
      catalogueFile,
      catalogue
        .replace('      solutionRoots: [ ./code-solution, ./metadata, ./solution ]\n', '')
        .replace(
          'local: http://127.0.0.1:8787',
          'local: http://127.0.0.1:8787 # TODO(paqvilo-init): choose an origin',
        ) + 'defaults:\n  mirage:\n    solutionRoots: [ ./code-solution, ./metadata, ./solution ]\n',
    );
    await fs.mkdir(path.join(demo, 'node_modules'));
    await fs.symlink(root, path.join(demo, 'node_modules/paqvilo'), process.platform === 'win32' ? 'junction' : 'dir');
    await prepareProject(consumer, { name: 'onboarding', sites: ['alpha', 'beta'], noPack: true });
    const sources = path.join(work, 'checkouts');
    await localGit(path.join(sources, 'classic'), path.join(root, 'examples/project/portal'));
    await localGit(path.join(sources, 'code'), path.join(root, 'test-browser/fixtures/code-site'));
    const page = await newPage(t, { viewport: { width: 1440, height: 1050 } });
    await allSettings(page);
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    const demoServer = await startSetupServer({ directory: demo, processEnv: {} });
    t.resources.push(() => demoServer.close());
    // Journey sections are collapsed except the next stage; a hash opens its section.
    await page.goto(demoServer.url + '#portals');
    await page.getByRole('heading', { name: 'Exported files', exact: true }).waitFor();
    assert.equal(await page.locator('#portals').evaluate((node) => node.open), true);
    assert.equal(await page.locator('#identity').evaluate((node) => node.open), false);
    assert.match(await page.locator('#portal-example').innerText(), /export/);
    // The local port is part of What to run.
    await page.evaluate(() => {
      location.hash = '#runtime-configuration';
    });
    const demoForm = page.locator('form[data-form=runtime][data-site=example]');
    const configurationBefore = await fs.readFile(path.join(demo, 'paqvilo.config.yml'), 'utf8');
    await demoForm.locator('[name=port]').fill('0');
    await saveForm(page, demoForm);
    assert.equal(
      await fs.readFile(path.join(demo, 'paqvilo.config.yml'), 'utf8'),
      configurationBefore.replace('port: 8787', 'port: 0'),
    );
    assert.equal(
      YAML.parse(await fs.readFile(path.join(demo, 'paqvilo.config.yml'), 'utf8')).sites.example.mirage.port,
      0,
    );
    const demoRuntime = await createSimulator({
      sourceDir: path.join(demo, 'portal'),
      watch: false,
      solutionRoots: [path.join(demo, 'metadata'), path.join(demo, 'code-solution'), path.join(demo, 'solution')],
      dataPacks: [{ id: 'example', module: path.join(demo, 'pack/pack.mjs') }],
      preset: 'example-demo',
      setup: { config: path.join(demo, 'paqvilo.config.yml'), processEnv: {} },
    });
    t.resources.push(() => demoRuntime.close());
    assert.match(await fetch(demoRuntime.url).then((response) => response.text()), /Build it three ways/);
    await page.goto(demoRuntime.url + '/_sim/');
    // The top bar link opens setup in a new tab; the AREAS switch in the sidebar carries the same name.
    const popupWait = page.waitForEvent('popup');
    await page.locator('.topbar').getByRole('link', { name: 'Project setup', exact: true }).click();
    const popup = await popupWait;
    await popup.getByRole('heading', { name: 'Project setup', exact: true }).waitFor();
    assert.equal(await popup.getByRole('link', { name: '← Back to portal', exact: true }).getAttribute('href'), '/');
    assert.equal(await popup.getByRole('link', { name: 'Administration', exact: true }).getAttribute('href'), '/_sim/');
    assert.match(await popup.locator('#overview').innerText(), /Mirage preview running/);
    await popup.close();

    const server = await startSetupServer({ directory: consumer, processEnv: {} });
    t.resources.push(() => server.close());
    await page.goto(server.url + '#settings');
    await page.getByRole('heading', { name: 'Project settings', exact: true }).waitFor();
    // Missing exports make Sources the next stage, so its section opens without a hash.
    assert.equal(await page.locator('#portals').evaluate((node) => node.open), true);
    assert.match(await page.locator('#overview').innerText(), /Select an existing local export folder/);
    let form = page.locator('form[data-form=settings]');
    await form.locator('[name=sourceRoot]').fill(sources);
    await saveForm(page, form);
    // Each website: its folders (Exported files), its live address (Live environments) and its local port (What to run).
    const open = async (hash, key) => {
      await page.evaluate((value) => {
        location.hash = value;
      }, hash);
      const node = page.locator(`details[data-section-key="${key}"]`);
      if ((await node.getAttribute('open')) === null) await node.locator('summary').first().click();
    };
    for (const [id, sourceName] of [
      ['alpha', 'classic'],
      ['beta', 'code'],
    ]) {
      await open('#portals', `files-${id}`);
      form = page.locator(`form[data-form=files][data-site=${id}]`);
      await form.locator('[name=source]').fill(sourceName);
      await form.locator('[name=solutions]').fill('');
      await saveForm(page, form);
      await open('#environments', `environments-${id}`);
      form = page.locator(`form[data-form=environments][data-site=${id}]`);
      await form.locator('[name=env-url]').fill(`http://127.0.0.1:${id === 'alpha' ? 8787 : 8788}`);
      await saveForm(page, form);
      await open('#runtime-configuration', `runtime-${id}`);
      form = page.locator(`form[data-form=runtime][data-site=${id}]`);
      await form.locator('[name=port]').fill('0');
      await saveForm(page, form);
      assert.match(await page.locator(`#portal-${id}`).innerText(), /export/);
      assert.doesNotMatch(await page.locator(`#portal-${id}`).innerText(), /No committed Git checkout/);
    }
    assert.match(await page.locator('#overview').innerText(), /Configuration ready/);
    const sharedBefore = await fs.readFile(path.join(consumer, 'paqvilo.config.yml'), 'utf8');
    await page.evaluate(() => {
      const selector = document.querySelector('#layer');
      const option = new Option('Invalid layer', '<img src=x onerror="window.invalidLayerExecuted=true">');
      selector.append(option);
      selector.value = option.value;
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => window.invalidLayerExecuted), undefined);
    assert.equal(
      await page
        .locator('form[data-form=files] .muted')
        .filter({ hasText: 'Writes the shared settings file.' })
        .count(),
      2,
    );
    await page.locator('#layer').selectOption('personal');
    form = page.locator('form[data-form=settings]');
    await form.locator('[name=browser]').selectOption('chrome');
    await saveForm(page, form);
    assert.equal(await fs.readFile(path.join(consumer, 'paqvilo.config.yml'), 'utf8'), sharedBefore);
    assert.equal(
      YAML.parse(await fs.readFile(path.join(consumer, 'paqvilo.config.local.yml'), 'utf8')).browser.channel,
      'chrome',
    );
    await page.locator('#layer').selectOption('shared');
    const originalRevision = await page.request
      .get(new URL('api/status', server.url).href)
      .then((response) => response.json());
    await fs.appendFile(path.join(consumer, 'paqvilo.config.yml'), '# external edit\n');
    form = page.locator('form[data-form=settings]');
    await form.locator('[name=sourceRoot]').fill('./unsaved');
    await form.locator('button[type=submit]').click();
    await page
      .locator('#notice.error')
      .filter({ hasText: /Reload before saving/ })
      .waitFor();
    assert.equal(await form.locator('[name=sourceRoot]').inputValue(), './unsaved');
    assert.notEqual(
      (await page.request.get(new URL('api/status', server.url).href).then((response) => response.json())).revision,
      originalRevision.revision,
    );
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.waitForFunction(
      (expected) => document.querySelector('form[data-form=settings] [name=sourceRoot]').value === expected,
      sources,
    );
    if (process.env.PAQVILO_SETUP_SCREENSHOTS) {
      await page.screenshot({
        path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'setup-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'setup-mobile.png'),
        fullPage: true,
      });
    }
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
        .map((node) => ({ tag: node.tagName, class: node.className, right: node.getBoundingClientRect().right }))
        .slice(0, 12),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      JSON.stringify(overflow),
    );
    for (const sourceName of ['classic', 'code']) {
      const runtime = await createSimulator({
        sourceDir: path.join(sources, sourceName),
        watch: false,
        setup: { config: path.join(consumer, 'paqvilo.config.yml'), processEnv: {} },
      });
      try {
        assert.equal((await fetch(runtime.url)).status, 200);
        assert.equal((await fetch(runtime.setupUrl)).status, 200);
        const state = await fetch(runtime.url + '/_setup/api/status').then((response) => response.json());
        assert.equal(state.sites.length, 2);
        assert.equal(state.ready, true);
      } finally {
        await runtime.close();
      }
    }
    assert.deepEqual(failures, []);
  },
);

test(
  'missing and invalid setup documents recover through the browser without touching exports',
  { timeout: 60000 },
  async (t) => {
    const directory = await temporary(t),
      server = await startSetupServer({ directory, processEnv: {} });
    t.resources.push(() => server.close());
    const page = await newPage(t);
    await page.goto(server.url + '#advanced');
    const create = page.locator('form[data-form=create]');
    await create.waitFor();
    await create.locator('[name=id]').fill('sample');
    await saveForm(page, create);
    const file = path.join(directory, 'paqvilo.config.yml');
    await fs.writeFile(file, 'sites: [invalid\n');
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await page.waitForFunction(() => document.querySelector('[name=yaml]').value.includes('[invalid'));
    const yaml = page.locator('form[data-form=yaml]');
    await yaml.locator('[name=yaml]').fill('sourceRoot: .\nsites: {}\n');
    await saveForm(page, yaml);
    assert.deepEqual(YAML.parse(await fs.readFile(file, 'utf8')).sites, {});
    assert.ok(!(await fs.readdir(directory)).includes('.paqvilo'));
  },
);

test(
  'Lense dev exposes a setup panel link on a loopback fixture and closes its sidecar with its browser',
  { timeout: 120000 },
  async (t) => {
    const directory = await temporary(t),
      checkout = path.join(directory, 'export');
    await localGit(checkout, path.join(root, 'examples/project/portal'));
    const consumer = path.join(directory, 'project');
    await prepareProject(consumer, { name: 'lense-setup', noPack: true });
    const simulator = await createSimulator({ sourceDir: checkout, watch: false });
    t.resources.push(() => simulator.close());
    const configFile = path.join(consumer, 'paqvilo.config.yml');
    await fs.writeFile(
      configFile,
      YAML.stringify({
        sourceRoot: checkout,
        defaultSite: 'portal',
        sites: { portal: { source: '.', environments: { dev: simulator.url }, markup: { enabled: false } } },
      }),
    );
    const port = await freeDebugPort();
    const child = spawn(
      process.execPath,
      [
        path.join(root, 'lense/cli.mjs'),
        'dev',
        '--config',
        configFile,
        '--headless',
        '--browser',
        channel,
        '--debug-port',
        String(port),
      ],
      { cwd: consumer, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      remote,
      setupUrl,
      announced;
    // Dev prints the setup address before it announces that it watches sources.
    const watching = new Promise((resolve, reject) => {
      announced = resolve;
      child.once('exit', () => reject(new Error(output)));
    });
    const read = (chunk) => {
      output += chunk;
      if (/Watching local sources|Watching sources|Browse pages and open tabs/.test(output)) announced();
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const exited = once(child, 'exit');
    t.resources.push(async () => {
      if (remote) {
        const cdp = await remote.newBrowserCDPSession().catch(() => null);
        await cdp?.send('Browser.close').catch(() => {});
        await remote.close().catch(() => {});
      }
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
      if (setupUrl) await assert.rejects(fetch(setupUrl), /fetch failed/, 'the owned setup server stops with dev');
    });
    await watching;
    setupUrl = output.match(/setup\s+(http:\/\/127\.0\.0\.1:\d+\/_setup\/)/)?.[1];
    assert.ok(setupUrl, output);
    remote = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = remote.contexts()[0].pages()[0];
    await page.waitForURL(simulator.url + '/');
    await page.locator('#paqvilo-panel').waitFor({ state: 'attached' });
    await page.keyboard.press('Alt+Shift+P');
    const link = page.locator('#paqvilo-panel a[title="Project setup"]');
    await link.waitFor();
    assert.equal(await link.locator('svg').count(), 1);
    assert.equal(await link.innerText(), '');
    if (process.env.PAQVILO_SETUP_SCREENSHOTS)
      await page.screenshot({ path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'panel-setup.png') });
    const popupPromise = page.waitForEvent('popup');
    await link.click();
    const popup = await popupPromise;
    await popup.getByRole('heading', { name: 'Project setup', exact: true }).waitFor();
    assert.equal(popup.url(), setupUrl);
    assert.match(await popup.locator('#quick-run').innerText(), /Lense preview running/);
    assert.equal(
      await popup.getByRole('link', { name: '← Back to portal', exact: true }).getAttribute('href'),
      simulator.url,
    );
    if (process.env.PAQVILO_SETUP_SCREENSHOTS)
      await popup.screenshot({
        path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'lense-setup.png'),
        fullPage: true,
      });
    assert.equal(await popup.locator('#paqvilo-panel').count(), 0);
  },
);

test(
  'setup shows real loading and save feedback, prevents duplicate writes and retains failed edits',
  { timeout: 60000 },
  async (t) => {
    const work = await temporary(t),
      demo = path.join(work, 'feedback');
    // Any project with one website exercises the feedback; a scaffold needs no demo copy.
    await prepareProject(demo, { name: 'feedback', sites: ['example'], noPack: true });
    const server = await startSetupServer({ directory: demo, processEnv: {} });
    t.resources.push(() => server.close());
    const page = await newPage(t, { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await allSettings(page);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let releaseRead;
    const reading = new Promise((resolve) => {
      releaseRead = resolve;
    });
    // Resources close in reverse order, so held routes are released before their context closes.
    t.resources.push(() => releaseRead());
    await page.route('**/_setup/api/status', async (route) => {
      await reading;
      await route.continue();
    });
    await page.goto(server.url + '#advanced');
    await page.locator('#notice.pending').filter({ hasText: 'Loading project configuration' }).waitFor();
    assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#refresh').isDisabled(), true);
    assert.equal(
      await page.locator('#notice').evaluate((node) => getComputedStyle(node, '::before').animationName),
      'none',
    );
    releaseRead();
    await page.getByRole('heading', { name: 'Exported files', exact: true }).waitFor();
    const form = page.locator('form[data-form=yaml]'),
      textarea = form.locator('textarea');
    const original = await textarea.inputValue(),
      draft = original + '\n# retained unsaved draft\n';
    await textarea.fill(draft);
    let releaseSave,
      writes = 0;
    const saving = new Promise((resolve) => {
      releaseSave = resolve;
    });
    t.resources.push(() => releaseSave());
    await page.route('**/_setup/api/config', async (route) => {
      writes++;
      await saving;
      await route.fulfill({ status: 422, json: { error: { message: 'Fixture validation rejected the draft.' } } });
    });
    const disabled = page.locator('form[data-form=settings] button[type=submit]');
    await disabled.evaluate((button) => {
      button.disabled = true;
    });
    await form.locator('button[type=submit]').click();
    await page.locator('#notice.pending').filter({ hasText: 'Validating and saving' }).waitFor();
    assert.equal(await textarea.isDisabled(), true);
    assert.equal(await page.locator('#refresh').isDisabled(), true);
    await form.evaluate((node) => {
      node.dispatchEvent(
        new SubmitEvent('submit', {
          bubbles: true,
          cancelable: true,
          submitter: node.querySelector('button[type=submit]'),
        }),
      );
    });
    if (process.env.PAQVILO_SETUP_SCREENSHOTS) {
      await fs.mkdir(path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS), { recursive: true });
      await page.screenshot({ path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'setup-saving.png') });
    }
    releaseSave();
    await page.locator('#notice[role=alert]').filter({ hasText: 'Fixture validation rejected' }).waitFor();
    assert.equal(writes, 1);
    assert.equal(await textarea.inputValue(), draft);
    assert.equal(await textarea.isDisabled(), false);
    assert.equal(await disabled.isDisabled(), true);
    assert.equal(await page.locator('#refresh').isDisabled(), false);
    assert.equal(await page.locator('#content').getAttribute('aria-busy'), null);
    // Successful saving returns focus to the same action and keeps the edited section open.
    await page.unroute('**/_setup/api/config');
    // The stage rail opens a collapsed section.
    await page
      .getByRole('navigation', { name: 'Setup stages' })
      .getByRole('link', { name: /^What to run/ })
      .click();
    const site = page.locator('form[data-form=runtime][data-site=example]');
    await site.locator('[name=port]').fill('0');
    await saveForm(page, site);
    assert.equal(await page.locator('details[data-section-key="runtime-example"]').evaluate((node) => node.open), true);
    assert.equal(await site.locator('button[type=submit]').evaluate((node) => node === document.activeElement), true);
    // A hung local write must release the editor without silently retrying an unknown outcome.
    await page.clock.install();
    let releaseTimeout,
      timeoutWrites = 0;
    const timedOut = new Promise((resolve) => {
      releaseTimeout = resolve;
    });
    t.resources.push(() => releaseTimeout());
    await page.route('**/_setup/api/config', async (route) => {
      timeoutWrites++;
      await timedOut;
      await route.abort().catch(() => {});
    });
    const timeoutDraft = (await textarea.inputValue()) + '\n# timeout draft retained\n';
    await textarea.fill(timeoutDraft);
    const attempted = page.waitForRequest('**/_setup/api/config');
    await form.locator('button[type=submit]').click();
    await attempted;
    await page.clock.fastForward(120_001);
    await page.locator('#notice[role=alert]').filter({ hasText: 'result may be unknown' }).waitFor();
    assert.equal(await textarea.inputValue(), timeoutDraft);
    assert.equal(await textarea.isDisabled(), false);
    assert.equal(await page.locator('#refresh').isDisabled(), false);
    assert.equal(timeoutWrites, 1);
    releaseTimeout();
    assert.deepEqual(errors, []);
  },
);
