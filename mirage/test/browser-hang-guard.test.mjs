// @test-kind contract: the owned browser launches and the CDP attach of the parity suite, acceptance, baseline capture and shell capture are bounded by the shared browser hang guard
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BROWSER_HANG_GUARD_MS } from '../lib/browser-launch.mjs';
import { openOwnedBrowser } from '../parity-suite.mjs';
import { launchCaptureBrowser } from '../capture-shell.mjs';
import { runAcceptance } from '../acceptance.mjs';
import { __testing as baselineSuite } from '../baseline-suite.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// No browser starts: each entry point stops at the mocked launch or attach, which records the options it was given.
const sentinel = new Error('invented launch stop');
const stopAt = (t, method) => {
  const seen = [];
  t.mock.method(chromium, method, async (...args) => {
    seen.push(args.at(-1));
    throw sentinel;
  });
  return seen;
};
const fakeBrowser = { newContext: async () => ({}), close: async () => {} };

async function temporaryDirectory(t, prefix) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function acceptanceRun(t, flows, extra = {}) {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      config: { mode: 'local', pageMode: 'local' },
      status: { sourceFingerprint: 'invented-source', implementationFingerprint: 'invented-implementation' },
    }),
  );
  return temporaryDirectory(t, 'paqvilo-hang-guard-acceptance-').then((outputDir) =>
    runAcceptance({ localUrl: 'http://127.0.0.1:9', outputDir, flows, channel: 'chromium', ...extra }),
  );
}

test('the parity suite launches its owned browser under the hang guard', async (t) => {
  const seen = stopAt(t, 'launch');
  await assert.rejects(openOwnedBrowser({ channel: 'chromium' }), sentinel);
  assert.equal(seen[0].timeout, BROWSER_HANG_GUARD_MS);
});

test('shell capture launches its anonymous browser under the hang guard', async (t) => {
  const seen = stopAt(t, 'launchPersistentContext');
  await assert.rejects(launchCaptureBrowser('chromium'), sentinel);
  assert.equal(seen[0].timeout, BROWSER_HANG_GUARD_MS);
});

test('acceptance launches its owned browser under the hang guard', async (t) => {
  const seen = stopAt(t, 'launch');
  const result = await acceptanceRun(t, [{ name: 'invented', steps: [] }]);
  assert.equal(result.error, sentinel.message);
  assert.equal(seen[0].timeout, BROWSER_HANG_GUARD_MS);
});

test('acceptance attaches to the live browser under the hang guard', async (t) => {
  t.mock.method(chromium, 'launch', async () => fakeBrowser);
  const seen = stopAt(t, 'connectOverCDP');
  const result = await acceptanceRun(t, [{ name: 'invented', mode: 'live', steps: [] }], {
    liveOrigin: 'https://portal.invalid',
    cdpUrl: 'http://127.0.0.1:9',
  });
  assert.equal(result.error, sentinel.message);
  assert.equal(seen[0].timeout, BROWSER_HANG_GUARD_MS);
});

test('the baseline Mirage side launches its browser under the hang guard', async (t) => {
  const root = await temporaryDirectory(t, 'paqvilo-hang-guard-baseline-');
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'website.yml'), 'adx_websiteid: invented\nadx_name: Invented fixture');
  let options;
  t.mock.method(chromium, 'launch', async (launchOptions) => {
    options = launchOptions;
    return fakeBrowser;
  });
  const side = await baselineSuite.mirageSide({
    matrix: { version: 1, scenarios: [] },
    source,
    workDir: path.join(root, 'runtime'),
  });
  await side.close();
  assert.equal(options.timeout, BROWSER_HANG_GUARD_MS);
});

test('a browser launch that fails stops the isolated Mirage it was opened for', async (t) => {
  const sentinel = new Error('launch failed');
  let closed = 0;
  const workspace = await temporaryDirectory(t, 'paq-side-');
  const owned = {
    url: 'http://127.0.0.1:9',
    app: {
      close: async () => {
        closed += 1;
      },
    },
    workspace,
  };
  await assert.rejects(
    baselineSuite.openSideBrowser(owned, async () => {
      throw sentinel;
    }),
    (error) => error === sentinel,
  );
  assert.equal(closed, 1);
  await assert.rejects(fs.access(workspace));
});

test('a browser context that fails closes the browser and stops the isolated Mirage', async (t) => {
  const sentinel = new Error('context failed');
  let closed = 0;
  const workspace = await temporaryDirectory(t, 'paq-side-');
  const owned = {
    url: 'http://127.0.0.1:9',
    app: {
      close: async () => {
        closed += 1;
      },
    },
    workspace,
  };
  const browser = {
    closed: 0,
    async newContext() {
      throw sentinel;
    },
    async close() {
      this.closed += 1;
    },
  };
  await assert.rejects(
    baselineSuite.openSideBrowser(owned, async () => browser),
    (error) => error === sentinel,
  );
  assert.equal(browser.closed, 1);
  assert.equal(closed, 1);
  await assert.rejects(fs.access(workspace));
});

test('a failed isolated Mirage start removes its workspace', async (t) => {
  const root = await temporaryDirectory(t, 'paq-start-');
  const sourceDir = path.join(root, 'source');
  const workDir = path.join(root, 'work');
  await fs.mkdir(sourceDir);
  await fs.mkdir(workDir);
  await fs.writeFile(path.join(sourceDir, 'website.yml'), 'adx_websiteid: site\nadx_name: Leak');
  const { startIsolatedMirage } = await import('../parity-suite.mjs');
  await assert.rejects(
    startIsolatedMirage({ sourceDir, workDir, preset: 'invented-missing-preset', origin: 'https://baseline.invalid' }),
  );
  assert.deepEqual(await fs.readdir(workDir), []);
});
