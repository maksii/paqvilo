// @test-kind contract: local setup journeys, configuration revision handling and owned workspace lifecycle.
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
import { startOnFreePort } from './helpers/debug-port.mjs';
import { setupNotice } from './helpers/setup-notice.mjs';
import { browserClosed, stopOwnedChild } from './helpers/workspace-task.mjs';
import { SCENARIO_HANG_GUARD_MS } from '../test/helpers/bounded-command.mjs';

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
  // Hang guard only: the drain waits for owned processes to stop; a hook gets the lane timeout without its own.
  t.after(
    async () => {
      await drainFixture(t.resources.toReversed());
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
    { timeout: SCENARIO_HANG_GUARD_MS },
  );
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
  await setupNotice(page, /^Saved\./);
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
  // The page handles that answer in a task queued when its body arrived. An answer the page requests now is delivered
  // by the same queue after it, so the handling (and any repaint of the form) has run when this returns.
  await page.evaluate(() =>
    fetch('/_setup/api/preview', { headers: { accept: 'application/json' } }).then((r) => r.json()),
  );
  assert.equal(await input.inputValue(), './unsaved-draft');
});

// ---- Presses and repaints. A repaint replaces the pressed control, and a click whose press began on a replaced node
// is lost; these cases hold the answer that repaints until the control is pressed.
const GATE = 'x-paqvilo-test-gate';
const YAML_SAVE = 'form[data-form=yaml] button[type=submit]';
const noPreview = (data) => ({ ...data, sessions: [] });
// A preview found running for the site "example"; its live views are read through the relay, answered below.
const livePreview = (data) => ({ ...data, sessions: [{ site: 'example', ready: true, url: 'http://127.0.0.1:9/' }] });
const isRelay = (name) => (response) => new URL(response.url()).pathname === `/_setup/api/runtime/${name}`;
/**
 * Holds the page's preview polls. Install before goto: the status read while loading passes, every later poll waits
 * for handled(). Relay reads of a found preview are refused at once unless `relay` routes them.
 */
async function holdPreviewPolls(t, page, { relay } = {}) {
  const queue = [];
  let arrived = null,
    loaded = false,
    closed = false;
  t.resources.push(() => {
    closed = true;
    for (const release of queue.splice(0)) release(null);
  });
  await page.route('**/_setup/api/runtime/**', (route) =>
    relay ? relay(route) : route.fulfill({ status: 503, json: { error: { message: 'No fixture runtime.' } } }),
  );
  await page.route('**/_setup/api/preview', async (route) => {
    const request = route.request();
    if (closed || !loaded || request.method() !== 'GET' || request.headers()[GATE]) {
      loaded ||= request.method() === 'GET' && !request.headers()[GATE];
      return route.continue();
    }
    const answer = await new Promise((resolve) => {
      queue.push(resolve);
      arrived?.();
      arrived = null;
    });
    if (!answer) return route.continue().catch(() => {});
    const response = await route.fetch();
    await route.fulfill({ response, json: answer(await response.json()) });
  });
  return {
    /** Answers the next poll with answer(server answer) and resolves once the page has handled it. */
    async handled(answer = (data) => data, { relayed = false } = {}) {
      if (!queue.length) {
        const arrival = new Promise((resolve) => {
          arrived = resolve;
        });
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await arrival;
      }
      const answered = page.waitForResponse(
          (item) => item.url().endsWith('/_setup/api/preview') && !item.request().headers()[GATE],
        ),
        // A change of the found preview rereads its status and packs before the page repaints.
        reads = relayed ? Promise.all(['status', 'packs'].map((name) => page.waitForResponse(isRelay(name)))) : null;
      queue.shift()(answer);
      await (await answered).finished();
      await reads;
      await gate(page);
    },
  };
}
// The page handles an answer in a task queued when its body arrived; an answer it requests now arrives after it, so
// the handling (and any repaint) has run when this returns.
const gate = (page) =>
  page.evaluate(
    (header) =>
      fetch('/_setup/api/preview', { headers: { accept: 'application/json', [header]: '1' } }).then((r) => r.json()),
    GATE,
  );
/** Counts configuration writes; each waits until the returned release(). */
async function holdWrites(t, page) {
  const writes = { count: 0 };
  let release;
  const saving = new Promise((resolve) => {
    release = resolve;
  });
  t.resources.push(() => release());
  await page.route('**/_setup/api/config', async (route) => {
    writes.count++;
    await saving;
    await route.continue();
  });
  writes.release = release;
  return writes;
}
async function pointerDownOn(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}
/** After the press ended on the YAML Save: it started saving, the save succeeds and wrote once. */
async function assertSavedOnce(page, writes, end) {
  const response = page.waitForResponse(
    (item) => item.url().endsWith('/_setup/api/config') && item.request().method() === 'POST',
  );
  await end();
  assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'true', 'the pressed Save started saving');
  writes.release();
  assert.equal((await response).ok(), true);
  await setupNotice(page, /^Saved\./);
  assert.equal(writes.count, 1);
}
const markSave = (page) =>
  page.evaluate((selector) => {
    globalThis.markedSave = document.querySelector(selector);
  }, YAML_SAVE);
const markedSaveShown = (page) => page.evaluate(() => globalThis.markedSave.isConnected);
async function advancedPage(t, sites) {
  const work = await temporary(t);
  await prepareProject(work, { name: 'press-poll', noPack: true, ...(sites ? { sites } : {}) });
  const server = await startSetupServer({ directory: work, processEnv: {} });
  t.resources.push(() => server.close());
  const page = await newPage(t);
  await allSettings(page);
  return { page, server };
}
const opened = (page) =>
  page.waitForFunction(() => document.querySelector('#content')?.getAttribute('aria-busy') === null);

test('the first preview poll leaves a pressed Save in place so its click saves once', async (t) => {
  const { page, server } = await advancedPage(t);
  const polls = await holdPreviewPolls(t, page),
    writes = await holdWrites(t, page);
  await page.goto(server.url + '#advanced');
  await opened(page);
  await pointerDownOn(page, page.locator(YAML_SAVE));
  await polls.handled(noPreview);
  await assertSavedOnce(page, writes, () => page.mouse.up());
});

test('the first preview poll after loading does not repaint an unchanged preview state', async (t) => {
  const { page, server } = await advancedPage(t);
  const polls = await holdPreviewPolls(t, page);
  await page.goto(server.url + '#advanced');
  await opened(page);
  await markSave(page);
  await polls.handled(noPreview);
  assert.equal(await markedSaveShown(page), true, 'the poll found what loading showed and left the page alone');
});

test('a preview change during a press is applied by a later poll, after the click saved', async (t) => {
  const { page, server } = await advancedPage(t, ['example']);
  const polls = await holdPreviewPolls(t, page),
    writes = await holdWrites(t, page);
  await page.goto(server.url + '#advanced');
  await opened(page);
  await pointerDownOn(page, page.locator(YAML_SAVE));
  await polls.handled(livePreview, { relayed: true });
  await assertSavedOnce(page, writes, () => page.mouse.up());
  await markSave(page);
  await polls.handled(livePreview, { relayed: true });
  assert.equal(await markedSaveShown(page), false, 'the deferred preview change repaints on the next poll');
});

test('a press that ends without pointerup no longer holds back preview repaints', async (t) => {
  const { page, server } = await advancedPage(t, ['example']);
  const polls = await holdPreviewPolls(t, page);
  await page.goto(server.url + '#advanced');
  await opened(page);
  const ends = {
    'window blur': () => globalThis.dispatchEvent(new Event('blur')),
    'context menu': () => document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    'pointer moving with no button': () =>
      document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 0 })),
  };
  let live = false;
  for (const [name, end] of Object.entries(ends)) {
    await markSave(page);
    await pointerDownOn(page, page.locator('#advanced h2').first());
    await page.evaluate(end);
    live = !live;
    await polls.handled(live ? livePreview : noPreview, { relayed: live });
    assert.equal(await markedSaveShown(page), false, `${name} ends the press, so the preview change repaints`);
    await page.mouse.up();
  }
});

test('a held Space on Save keeps it in place through a preview change so its activation saves once', async (t) => {
  const { page, server } = await advancedPage(t, ['example']);
  const polls = await holdPreviewPolls(t, page),
    writes = await holdWrites(t, page);
  await page.goto(server.url + '#advanced');
  await opened(page);
  await page.locator(YAML_SAVE).focus();
  await page.keyboard.down('Space');
  await polls.handled(livePreview, { relayed: true });
  await assertSavedOnce(page, writes, () => page.keyboard.up('Space'));
});

/** Runs trigger, which reloads the status, and asserts the load finished: the page is no longer busy. */
async function assertLoaded(page, trigger) {
  const reads = ['status', 'quick'].map((name) =>
    page.waitForResponse((item) => new URL(item.url()).pathname === `/_setup/api/${name}`),
  );
  await trigger();
  for (const read of reads) await (await read).finished();
  await gate(page);
  assert.deepEqual(
    await page.evaluate(() => ({
      busy: document.querySelector('#content').getAttribute('aria-busy'),
      refresh: document.querySelector('#refresh').disabled,
    })),
    { busy: null, refresh: false },
    'the load finished',
  );
}
// A draft makes Refresh ask before it discards it.
async function unsavedDraft(page) {
  const yaml = page.locator('form[data-form=yaml] textarea');
  await yaml.fill((await yaml.inputValue()) + '\n# unsaved draft\n');
}

test('Enter held on Refresh does not hold back the load it started', async (t) => {
  const { page, server } = await advancedPage(t);
  await page.goto(server.url + '#advanced');
  await opened(page);
  await page.locator('#refresh').focus();
  // Enter clicks on keydown; its release is not needed to finish anything.
  await assertLoaded(page, () => page.keyboard.down('Enter'));
  await page.keyboard.up('Enter');
});

test('Enter on Refresh with unsaved changes and an accepted dialog loads, and a following save works', async (t) => {
  const { page, server } = await advancedPage(t);
  await page.goto(server.url + '#advanced');
  await opened(page);
  await unsavedDraft(page);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#refresh').focus();
  // The Enter key is still down while the dialog answers: its release went to the dialog.
  await assertLoaded(page, () => page.keyboard.down('Enter'));
  await page.keyboard.up('Enter');
  await saveForm(page, page.locator('form[data-form=yaml]'));
});

test('Space held on a button when a dialog opens leaves no press that blocks the load', async (t) => {
  const { page, server } = await advancedPage(t);
  await page.goto(server.url + '#advanced');
  await opened(page);
  await unsavedDraft(page);
  await page.locator(YAML_SAVE).focus();
  await page.keyboard.down('Space');
  page.once('dialog', (dialog) => dialog.accept());
  // Its release would go to the dialog; the page never sees it.
  await assertLoaded(page, () => page.locator('#refresh').click());
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.up('Space');
  await saveForm(page, page.locator('form[data-form=yaml]'));
});

test('a preview start answer arriving during a press leaves the pressed control in place', async (t) => {
  const work = await temporary(t);
  await prepareProject(work, { name: 'press-start', sites: ['example'], noPack: true });
  const server = await startSetupServer({ directory: work, processEnv: {} });
  t.resources.push(() => server.close());
  const page = await newPage(t);
  let arrived, release;
  const started = new Promise((resolve) => {
      arrived = resolve;
    }),
    answer = new Promise((resolve) => {
      release = resolve;
    });
  t.resources.push(() => release());
  // Polls are held, so only the start answer repaints the steps while the test presses.
  await holdPreviewPolls(t, page);
  // The start is refused by the fixture: nothing starts, and the answer still repaints the steps.
  await page.route('**/_setup/api/preview', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    arrived();
    await answer;
    await route.fulfill({ status: 500, json: { error: { message: 'Fixture refused the start.' } } });
  });
  await page.goto(server.url);
  await opened(page);
  await page.locator('#quick [data-preview=start]').click();
  await started;
  await pointerDownOn(page, page.locator('#quick [data-quick-edit=kind]'));
  const answered = page.waitForResponse(
    (item) => item.url().endsWith('/_setup/api/preview') && item.request().method() === 'POST',
  );
  release();
  await (await answered).finished();
  await gate(page);
  await page.mouse.up();
  assert.equal(await page.locator('#quick-kind form').count(), 1, 'the pressed Change opened its step');
});

/**
 * Every website of the page runs (each poll finds them ready), so the page reads runtime details through the relay.
 * hold(start) runs start; the next relay status read waits, and hold() resolves once it arrived and the page handled
 * the live map read started with it. release() answers the held read and resolves once the page
 * has handled its answer. Other relay reads are refused at once.
 */
async function runningWebsites(t, page, sites) {
  let arrived,
    answer,
    holding = false;
  t.resources.push(() => answer?.());
  await page.route('**/_setup/api/runtime/**', async (route) => {
    if (holding && new URL(route.request().url()).pathname === '/_setup/api/runtime/status') {
      holding = false;
      await new Promise((resolve) => {
        answer = resolve;
        arrived();
      });
    }
    await route.fulfill({ status: 503, json: { error: { message: 'No fixture runtime.' } } });
  });
  await page.route('**/_setup/api/preview', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(),
      data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, sessions: sites.map((site) => ({ site, ready: true, url: 'http://127.0.0.1:9/' })) },
    });
  });
  return {
    async hold(start) {
      holding = true;
      const read = new Promise((resolve) => {
          arrived = resolve;
        }),
        // The step also reads the live map; its refused answer repaints the page before the test presses anything.
        map = page.waitForResponse(isRelay('dashboard'));
      await Promise.all([start(), read]);
      await (await map).finished();
      await gate(page);
    },
    async release() {
      // The packs read was refused at once; the held status read is the last one the page waits for.
      const status = page.waitForResponse(isRelay('status'));
      answer();
      await (await status).finished();
      await gate(page);
    },
  };
}

test('runtime details read after choosing another website leave a pressed Save in place', async (t) => {
  const { page, server } = await advancedPage(t, ['example', 'second']);
  const websites = await runningWebsites(t, page, ['example', 'second']),
    writes = await holdWrites(t, page);
  await page.goto(server.url + '#advanced');
  await opened(page);
  await websites.hold(() =>
    page.locator('#run-site').evaluate((select) => {
      select.value = 'second';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }),
  );
  await pointerDownOn(page, page.locator(YAML_SAVE));
  await websites.release();
  await assertSavedOnce(page, writes, () => page.mouse.up());
});

test('runtime details read after switching to Quick setup leave a pressed Change in place', async (t) => {
  const { page, server } = await advancedPage(t, ['example']);
  const websites = await runningWebsites(t, page, ['example']);
  await page.goto(server.url + '#advanced');
  await opened(page);
  await websites.hold(() => page.locator('[data-view=quick]').first().click());
  await pointerDownOn(page, page.locator('#quick [data-quick-edit=kind]'));
  await websites.release();
  await page.mouse.up();
  assert.equal(await page.locator('#quick-kind form').count(), 1, 'the pressed Change opened its step');
});

test('setup UI configures a demo and opens its Mirage setup flow', async (t) => {
  const work = await temporary(t),
    demo = path.join(work, 'demo');
  await prepareDemo(demo);
  const catalogueFile = path.join(demo, 'paqvilo.config.yml');
  const catalogue = await fs.readFile(catalogueFile, 'utf8');
  await fs.writeFile(
    catalogueFile,
    catalogue
      .replace('      solutionRoots: [ ./code-solution, ./metadata, ./solution ]\n', '')
      .replace('local: http://127.0.0.1:8787', 'local: http://127.0.0.1:8787 # TODO(paqvilo-init): choose an origin') +
      'defaults:\n  mirage:\n    solutionRoots: [ ./code-solution, ./metadata, ./solution ]\n',
  );
  await fs.mkdir(path.join(demo, 'node_modules'));
  await fs.symlink(root, path.join(demo, 'node_modules/paqvilo'), process.platform === 'win32' ? 'junction' : 'dir');
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
  assert.deepEqual(failures, []);
});

// @test-kind contract+security: independent scaffold configuration preserves revision isolation and renders a hostile layer label as inert text.
test('setup UI configures an independent scaffold with two local Git exports and validates both Mirage flows', async (t) => {
  const work = await temporary(t),
    consumer = path.join(work, 'consumer'),
    sources = path.join(work, 'checkouts');
  await prepareProject(consumer, { name: 'onboarding', sites: ['alpha', 'beta'], noPack: true });
  await localGit(path.join(sources, 'classic'), path.join(root, 'examples/project/portal'));
  await localGit(path.join(sources, 'code'), path.join(root, 'test-browser/fixtures/code-site'));
  const page = await newPage(t, { viewport: { width: 1440, height: 1050 } });
  await allSettings(page);
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
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
  // A label rendered as markup would run its handler when its image fails to load, after the change handler returned.
  // An image of the same address created now fails no earlier, so its failure marks the point to read the flag at.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const probe = new Image();
        probe.onerror = resolve;
        probe.src = 'x';
      }),
  );
  assert.equal(await page.evaluate(() => window.invalidLayerExecuted), undefined);
  assert.equal(
    await page.locator('form[data-form=files] .muted').filter({ hasText: 'Writes the shared settings file.' }).count(),
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
});

test('missing and invalid setup documents recover through the browser without touching exports', async (t) => {
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
});

test('Lense dev exposes a setup panel link on a loopback fixture and closes its sidecar with its browser', async (t) => {
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
  // The command of the latest start; a start that lost its debugging port has already closed.
  let child, exited, output, remote, setupUrl;
  // The settings file the setup server at setupUrl serves; undefined when nothing answers there as a setup server.
  const setupProject = () =>
    fetch(new URL('api/status', setupUrl))
      .then((response) => response.json())
      .then(
        (status) => status?.layers?.shared?.file,
        () => undefined,
      );
  t.resources.push(async () => {
    let closing = false;
    if (remote) {
      const cdp = await remote.newBrowserCDPSession().catch(() => null);
      if (cdp) closing = await browserClosed(remote, cdp);
      await remote.close().catch(() => {});
    }
    // Closing its browser is dev's own stop, and dev then removes what its browser left in the temporary directory.
    // Only a dev whose browser could not be asked to close is ended at once; one that does not stop after its browser
    // closed is ended by the hang guard of stopOwnedChild and fails the test.
    if (child) await stopOwnedChild(child, exited, { graceful: closing });
    // Whatever answers on the released port afterwards, on a busy host, is not this project's setup server.
    if (setupUrl) assert.notEqual(await setupProject(), configFile, 'the owned setup server stops with dev');
  });
  const port = await startOnFreePort(async (port) => {
    child = spawn(
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
    output = '';
    let announced;
    // Dev prints the setup address before it announces that it watches sources. 'close' follows the last output.
    const watching = new Promise((resolve, reject) => {
      announced = resolve;
      child.once('close', () => reject(new Error(output)));
    });
    const read = (chunk) => {
      output += chunk;
      if (/Watching local sources|Watching sources|Browse pages and open tabs/.test(output)) announced();
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    exited = once(child, 'exit');
    await watching;
    return port;
  });
  setupUrl = output.match(/setup\s+(http:\/\/127\.0\.0\.1:\d+\/_setup\/)/)?.[1];
  assert.ok(setupUrl, output);
  assert.equal(await setupProject(), configFile, 'the setup server reports the project it serves');
  remote = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = remote.contexts()[0];
  const page = context.pages()[0];
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
});

test('setup shows real loading and save feedback, prevents duplicate writes and retains failed edits', async (t) => {
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
  // Read in one page task. locator.evaluate() resolves its element and evaluates it in two round trips; a repaint
  // between the two round trips moves the focus to the replacing button, so the resolved node would be the replaced one.
  assert.deepEqual(
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('form[data-form=runtime][data-site=example] button[type=submit]');
      return {
        open: document.querySelector('details[data-section-key="runtime-example"]')?.open,
        focused: buttons.length === 1 && buttons[0] === document.activeElement,
      };
    }),
    { open: true, focused: true },
  );
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
});
