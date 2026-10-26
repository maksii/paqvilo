import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { tempDir } from './fixture.mjs';

const cli = fileURLToPath(new URL('../mirage/cli.mjs', import.meta.url));
const FLOW = '77777777-7777-4777-8777-777777777777';

async function write(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

async function fixture(t) {
  const root = await tempDir('mirage-preflight-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const portal = path.join(root, 'portal'),
    solution = path.join(root, 'solution');
  await write(portal, {
    'website.yml':
      'adx_name: Invented Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
    'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
    'web-pages/home/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html': '<p>home</p>',
  });
  await write(solution, {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedPreflight</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    // A cloud flow without a portal trigger or Dataverse trigger: the operation catalogue answers it with a placeholder.
    'Workflows/invented.json': JSON.stringify({
      properties: { definition: { actions: { connector: { type: 'OpenApiConnection' } } } },
    }),
    'Workflows/invented.json.data.xml': `<Workflow WorkflowId="{${FLOW}}" Name="Invented flow"/>`,
  });
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir);
  return { root, portal, solution, stateDir, run: (...args) => runIn({ root, stateDir }, 'preflight', ...args) };
}

const env = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
  );
// Every run uses an empty state directory and the fixture root as cwd, so a write outside it cannot reach the checkout.
// Runs are independent and start concurrently; each resolves with its exit status and output.
const runIn = ({ root, stateDir }, command, ...args) =>
  withProcessSlot(
    () =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [cli, command, ...args, '--state-dir', stateDir],
          { cwd: root, encoding: 'utf8', windowsHide: true, env: env(), timeout: 60000 },
          (error, stdout, stderr) =>
            resolve({
              status: error ? error.code : 0,
              signal: error?.signal ?? null,
              killed: error?.killed ?? false,
              stdout,
              stderr,
            }),
        );
      }),
  );

test('mirage preflight reports a placeholder flow and blocks on it only with --strict or a scenario', async (t) => {
  const { root, portal, solution, stateDir, run } = await fixture(t);
  const flowScenario = path.join(root, 'flow-scenario.json'),
    pageScenario = path.join(root, 'page-scenario.json');
  await fs.writeFile(flowScenario, JSON.stringify({ id: 'invented-flow', requires: ['cloud-flow:*'] }));
  await fs.writeFile(pageScenario, JSON.stringify({ id: 'invented-page', requires: ['webpage:home'] }));
  const [plain, strict, scoped, page, human] = await Promise.all([
    run('--source', portal, '--solution-root', solution, '--json'),
    run('--source', portal, '--solution-root', solution, '--strict', '--json'),
    run('--source', portal, '--solution-root', solution, '--scenario', flowScenario, '--json'),
    run('--source', portal, '--solution-root', solution, '--scenario', pageScenario, '--json'),
    run('--source', portal, '--solution-root', solution, '--strict'),
  ]);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  const report = JSON.parse(plain.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'paqvilo.mirage.preflight');
  assert.equal(report.runtime.kind, 'power-pages');
  assert.equal(report.runtime.capabilities.powerPages, true);
  assert.ok(report.modules.some((module) => module.name === 'dataverse-standard'));
  assert.equal(report.sources.layers[0].solution, 'InventedPreflight');
  const flow = report.requirements.find((row) => row.id === `cloud-flow:${FLOW}`);
  assert.equal(flow.status, 'placeholder');
  assert.equal(flow.blocking, false);
  assert.equal(report.summary.blocking, 0);

  assert.equal(strict.status, 1, strict.stderr);
  assert.equal(JSON.parse(strict.stdout).requirements.find((row) => row.id === `cloud-flow:${FLOW}`).blocking, true);

  assert.equal(scoped.status, 1, scoped.stderr);
  assert.equal(JSON.parse(scoped.stdout).scope.scenario.id, 'invented-flow');
  // A scenario that needs only the home page does not block on the unused placeholder flow.
  assert.equal(page.status, 0, page.stderr);
  const rows = JSON.parse(page.stdout).requirements;
  assert.equal(rows.find((row) => row.id === 'webpage:home').status, 'satisfied');
  assert.equal(rows.find((row) => row.id === `cloud-flow:${FLOW}`).inScope, false);

  assert.equal(human.status, 1);
  assert.match(human.stdout, /BLOCKING placeholder cloud-flow:/);
  // Preflight opens no listener (every run above exited on its own) and writes no state or cache file.
  assert.ok(
    ![plain, strict, scoped, page, human].some((result) => result.signal || result.killed),
    'each run exited by itself',
  );
  assert.doesNotMatch(plain.stdout, /"(url|port|origin)":\s*"?http/);
  assert.deepEqual(await fs.readdir(stateDir), []);
});

test('mirage preflight exits 2 on an invocation error', async (t) => {
  const { root, solution, stateDir, run } = await fixture(t);
  const scenario = path.join(root, 'broken.json');
  await fs.writeFile(scenario, JSON.stringify({ requires: 'cloud-flow:*' }));
  const [result, sourceForApi, serve] = await Promise.all([
    run('--runtime', 'dataverse-api', '--solution-root', solution, '--scenario', scenario, '--json'),
    run('--runtime', 'dataverse-api', '--source', solution),
    runIn({ root, stateDir }, 'serve', '--source', 'preflight', '--invented-flag'),
  ]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /scenario\.id/);
  assert.equal(sourceForApi.status, 2, sourceForApi.stdout + sourceForApi.stderr);
  // Only the preflight command answers 2; the word as another command's option value does not.
  assert.equal(serve.status, 1, serve.stdout + serve.stderr);
  assert.deepEqual(await fs.readdir(stateDir), []);
});
