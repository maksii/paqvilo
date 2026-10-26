import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareProject } from '../lense/project-scaffold.mjs';

const toolkit = fileURLToPath(new URL('../', import.meta.url));
// Ignore personal source/identity configuration while retaining the browser
// prepared by this suite (CI installs Chromium before test:browser, not npm test).
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => (!key.startsWith('PAQVILO_') || key === 'PAQVILO_BROWSER') && key !== 'NODE_TEST_CONTEXT',
  ),
);
async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'init-browser-acceptance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await prepareProject(root, { name: 'acceptance-fixture', noVscode: true, noPack: true });
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(toolkit, path.join(root, 'node_modules/paqvilo'), process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}
// One scaffolded acceptance run starts its own test runner, Mirage and browser. A run that
// exceeds this guard is killed and reported, so the whole test is bounded by its run count.
// Runs took 40-60+ s on a heavily loaded Windows host (a 60 s guard killed a healthy run).
const RUN_TIMEOUT_MS = 120_000;
const RUNS = 5;
async function run(root, signal) {
  const child = spawn(process.execPath, ['tools/test-browser.mjs', '--strict'], {
    cwd: root,
    env: environment,
    signal,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', (error) => (error.name === 'AbortError' ? undefined : reject(error)));
      child.once('close', (code) => resolve({ code, output }));
    });
  } finally {
    clearTimeout(timer);
  }
}

test(
  'optional synthetic acceptance recipe executes content/auth/denial and catches regressions or external assets',
  // Each run is bounded above; project preparation needs a few more seconds.
  { timeout: RUNS * RUN_TIMEOUT_MS + 30_000 },
  async (t) => {
    const root = await project(t);
    const guide = await fs.readFile(path.join(root, 'docs/acceptance.md'), 'utf8');
    const recipe = /```js\r?\n([\s\S]*?)\r?\n```/.exec(guide)?.[1];
    assert.ok(recipe, 'runnable public-API example exists');
    const file = path.join(root, 'test-browser/local.acceptance.test.mjs');
    await fs.writeFile(file, recipe);
    let result = await run(root, t.signal);
    assert.equal(result.code, 0, result.output);
    // Each regression must fail on its own recipe assertion, not on an unrelated error or timeout.
    for (const [changed, reason] of [
      [
        recipe.replace(
          '<h1 id="fixture-title">Invented acceptance content</h1>',
          '<h1 id="fixture-title">Regressed content</h1>',
        ),
        /rendered content and browser requests must pass/,
      ],
      [recipe.replace("roles: ['Reader']", "roles: ['Other role']"), /403 !== 200/],
      [
        recipe.replace("initial.settings.permissionMode = 'enforce'", "initial.settings.permissionMode = 'permissive'"),
        /200 !== 403/,
      ],
      [
        recipe.replace(
          '<h1 id="fixture-title">Invented acceptance content</h1>',
          '<h1 id="fixture-title">Invented acceptance content</h1><img src="https://unexpected.example.test/asset.png">',
        ),
        /rendered content and browser requests must pass|unexpected external requests fail hermetic acceptance/,
      ],
    ]) {
      assert.notEqual(changed, recipe);
      await fs.writeFile(file, changed);
      result = await run(root, t.signal);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, reason);
    }
  },
);
