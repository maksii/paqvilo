// @test-kind contract: init scaffold acceptance recipe runs and fails its intended assertions on regressions
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { stopCodeAppDevServer } from '../lense/code-app-dev-stop.mjs';
import { PROFILE_RELEASE_RETRIES } from './helpers/profile-cleanup.mjs';

const toolkit = fileURLToPath(new URL('../', import.meta.url));
// Ignore personal source/identity configuration while retaining the browser
// prepared by this suite (CI installs Chromium before test:browser, not npm test).
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => (!key.startsWith('PAQVILO_') || key === 'PAQVILO_BROWSER') && key !== 'NODE_TEST_CONTEXT',
  ),
);
// The test's owned fixture first ends the whole process tree of every run (a run still going when the test ends, by
// failure or by the runner's timeout, included) and waits for its output to close; only then are the projects removed.
async function project(t) {
  const owner = ownedFixture(t);
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'init-browser-acceptance-'));
  owner.remove(() => fs.rm(root, { recursive: true, force: true, ...PROFILE_RELEASE_RETRIES }));
  await prepareProject(root, { name: 'acceptance-fixture', noVscode: true, noPack: true });
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(toolkit, path.join(root, 'node_modules/paqvilo'), process.platform === 'win32' ? 'junction' : 'dir');
  return { root, owner };
}
// The acceptance runner's action budget in every scaffolded run. Only the content variant's text step, which is meant
// to fail, sets its own shorter budget, so a loaded host never ends a step that should pass by elapsed time.
const ACTION_BUDGET_MS = 120_000;
// The scaffolded runner (templates/project/test-browser.mjs.template) bounds its one acceptance test with
// --test-timeout=300000. This test's own bound is the sum of its runs' bounds, so it is only a hang guard.
const SCAFFOLD_TEST_TIMEOUT_MS = 300_000;
const RUNS = 5;
// A run is its own process group on POSIX, so its whole tree can be signalled; Windows ends the tree with taskkill.
// A test file that leaves a handle open (a browser or simulator a failed test did not close) keeps its process, and
// with it the runner's summary, from ending; the runner itself would report nothing more. --test-force-exit (forwarded
// to node --test by the scaffolded runner) ends the run once its tests have reported, so the result and its failure
// details are judged at once and the owner below stops whatever the run left behind.
async function run({ root, owner }) {
  const child = spawn(process.execPath, ['tools/test-browser.mjs', '--strict', '--test-force-exit'], {
    cwd: root,
    env: environment,
    detached: process.platform !== 'win32',
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
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  owner.add(() =>
    stopCodeAppDevServer(
      child,
      closed.catch(() => {}),
    ),
  );
  return { code: await closed, output };
}

test(
  'optional synthetic acceptance recipe executes content/auth/denial and catches regressions or external assets',
  { timeout: RUNS * SCAFFOLD_TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await project(t);
    const { root } = fixture;
    const guide = await fs.readFile(path.join(root, 'docs/acceptance.md'), 'utf8');
    const example = /```js\r?\n([\s\S]*?)\r?\n```/.exec(guide)?.[1];
    assert.ok(example, 'runnable public-API example exists');
    // These invented fixtures are deleted on exit. Include the flow failure and
    // request counts in the nested test output so a failed run remains diagnosable.
    const assertion = "'rendered content and browser requests must pass'";
    assert.equal(example.split(assertion).length - 1, 1, 'the example has one rendered-content assertion');
    let recipe = example.replace(
      assertion,
      `${assertion} + ': ' + JSON.stringify({ sourceChanged: result.sourceChanged, implementationChanged: result.implementationChanged, flows: result.flows.map(({ name, passed, error, steps, failedRequests, failedResponses, blockedRequests, pageErrors, consoleErrors }) => ({ name, passed, error, steps: steps.map(({ action, passed }) => ({ action, passed })), failedRequests: failedRequests.length, failedResponses: failedResponses.length, blockedRequests: blockedRequests.length, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length })) })`,
    );
    const flowMarker = `    console.log('PAQVILO_ACCEPTANCE_FLOW ' + JSON.stringify({ flows: result.flows.map(({ passed, steps }) => ({ passed, steps: steps.map(({ action, passed }) => ({ action, passed })) })) }));`;
    const flowAnchor = '    assert.equal(result.passed, true,';
    assert.equal(recipe.split(flowAnchor).length - 1, 1, 'the example has one rendered-content assertion');
    recipe = recipe.replace(flowAnchor, `${flowMarker}\n${flowAnchor}`);
    const budgetAnchor = 'runAcceptance({ ';
    assert.equal(recipe.split(budgetAnchor).length - 1, 1, 'the example has one acceptance run');
    recipe = recipe.replace(budgetAnchor, `${budgetAnchor}timeout: ${ACTION_BUDGET_MS}, `);
    assert.notEqual(recipe, example, 'the acceptance assertion receives diagnostic context');
    const file = path.join(root, 'test-browser/local.acceptance.test.mjs');
    await fs.writeFile(file, recipe);
    const started = Date.now();
    const result = await run(fixture);
    t.diagnostic(`baseline CLI completed after ${Date.now() - started} ms`);
    assert.equal(result.code, 0, result.output);
    const textStep = "{ action: 'text', selector: '#fixture-title', value: 'Invented acceptance content' }";
    assert.equal(recipe.split(textStep).length - 1, 1, 'the recipe has one unique content text step');
    const contentStep =
      "{ action: 'text', selector: '#fixture-title', value: 'Invented acceptance content', timeout: 1000 }";
    const variants = [
      [
        'content',
        recipe
          .replace(
            '<h1 id="fixture-title">Invented acceptance content</h1>',
            '<h1 id="fixture-title">Regressed content</h1>',
          )
          .replace(textStep, contentStep),
        'rendered content and browser requests must pass',
      ],
      [
        'authenticated access',
        recipe.replace("roles: ['Reader']", "roles: ['Other role']"),
        'authenticated fixture read must succeed',
      ],
      [
        'anonymous denial',
        recipe.replace("initial.settings.permissionMode = 'enforce'", "initial.settings.permissionMode = 'permissive'"),
        'anonymous fixture read must be denied',
      ],
      [
        'external asset',
        recipe.replace(
          '<h1 id="fixture-title">Invented acceptance content</h1>',
          '<h1 id="fixture-title">Invented acceptance content</h1><img src="https://unexpected.example.test/asset.png">',
        ),
        'unexpected external requests fail hermetic acceptance',
      ],
    ];
    const outcomes = await Promise.allSettled(
      variants.map(([name, changed, expected]) =>
        withProcessSlot(
          async () => {
            assert.notEqual(changed, recipe);
            const isolated = await project(t);
            await fs.writeFile(path.join(isolated.root, 'test-browser/local.acceptance.test.mjs'), changed);
            const rejected = await run(isolated);
            t.diagnostic(`${name} CLI completed after ${Date.now() - started} ms`);
            assert.equal(rejected.code, 1, rejected.output);
            assert.ok(
              rejected.output.includes(expected),
              `${name} must fail its intended assertion: ${rejected.output}`,
            );
            if (name === 'content') {
              const matches = [...rejected.output.matchAll(/PAQVILO_ACCEPTANCE_FLOW (\{[^\r\n]*\})/g)];
              assert.equal(matches.length, 1, 'content failure emits one structured flow record');
              const diagnostic = JSON.parse(matches[0][1]);
              assert.equal(diagnostic.flows.length, 1);
              assert.equal(diagnostic.flows[0].passed, false);
              assert.deepEqual(diagnostic.flows[0].steps, [
                { action: 'navigate', passed: true },
                { action: 'text', passed: false },
              ]);
            }
          },
          2,
          { signal: t.signal },
        ),
      ),
    );
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  },
);
