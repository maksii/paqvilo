import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import { spawnSync } from 'node:child_process';
import { classifyChanges, ciLanes, browserLanes } from '../.github/scripts/change-scope.mjs';
import { fullSdkGate, validationSteps, ciBrowser } from '../scripts/ci.mjs';

test('maintenance PRs retain CI and every main CodeQL configuration', () => {
  for (const name of ['ci', 'security']) {
    const workflow = YAML.parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
    for (const branch of ['main', '0.9.8'])
      assert.ok(workflow.on.pull_request.branches.includes(branch), `${name}: ${branch}`);
    assert.equal(workflow.jobs.gate.name, name === 'ci' ? 'CI gate' : 'Security gate');
  }
  const scope = classifyChanges(['docs/cli.md']);
  assert.equal(scope.codeql, true);
  assert.deepEqual(JSON.parse(scope.languages), ['actions', 'csharp', 'javascript-typescript']);
});

test(
  'hosted Windows port preparation accepts an already stopped HTTP service and rejects a remaining listener',
  { skip: process.platform !== 'win32' },
  () => {
    const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    const script = ci.jobs.windows.steps.find((step) => step.name === 'Release port 80 for the ServiceClient gate').run;
    const run = (status, held = false, stopExit = 0) =>
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `
    $ErrorActionPreference = 'Stop'
    function Get-Service { [pscustomobject]@{Status='${status}'} }
    function Get-NetTCPConnection { ${held ? "[pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=123}" : ''} }
    function net { ${status === 'Stopped' ? "throw 'Stopping an already stopped service is an error'" : `$global:LASTEXITCODE=${stopExit}`} }
    ${script}
  `,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
    const stopped = run('Stopped');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(run('Running').status, 0);
    const listener = run('Stopped', true);
    assert.notEqual(listener.status, 0);
    assert.match(listener.stderr, /Port 80 is still held/);
    assert.equal(run('Running', false, 5).status, 5, 'service stop failure remains fatal');
  },
);

test('every browser partition retains Linux Chromium and adds Windows Chromium and Edge', () => {
  const suites = ['lense', 'mirage', 'examples'];
  const lanes = browserLanes(suites);
  for (const lane of ciLanes('browser', suites)) {
    const variants = lanes.filter((candidate) => candidate.suite === lane.suite && candidate.shard === lane.shard);
    assert.deepEqual(
      variants.map(({ os, channel }) => [os, channel]),
      [
        ['ubuntu-24.04', 'chromium'],
        ['windows-2025', 'chromium'],
        ['windows-2025', 'msedge'],
      ],
    );
  }
  assert.equal(lanes.length, ciLanes('browser', suites).length * 3);
  assert.equal(ciBrowser({ PAQVILO_BROWSER: 'msedge' }, 'win32'), 'chromium');
  assert.equal(ciBrowser({ PAQ_CI_BROWSER: 'msedge' }, 'win32'), 'msedge');
  for (const [channel, platform] of [
    ['msedge', 'linux'],
    ['chrome', 'win32'],
    ['unknown', 'linux'],
  ])
    assert.throws(() => ciBrowser({ PAQ_CI_BROWSER: channel }, platform));
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.jobs.browser['runs-on'], '${{ matrix.os }}');
  assert.equal(ci.jobs.browser.env.PAQ_CI_BROWSER, '${{ matrix.channel }}');
});

test('applicable Mirage and shared PRs select the full SDK assertions locally and on both hosted platforms', () => {
  for (const file of ['mirage/lib/dataverse-soap.mjs', 'mirage/test/data.test.mjs', 'scripts/ci.mjs', 'package.json']) {
    const scope = classifyChanges([file]);
    assert.equal(scope.sdk, true, file);
    for (const platform of ['win32', 'linux']) {
      assert.equal(fullSdkGate(scope, platform), true, `${file}: ${platform}`);
      assert.ok(validationSteps(scope, ['mirage'], {}, platform).some((step) => step.label === 'sdk gates'));
    }
  }
  assert.equal(classifyChanges(['docs/faq.md']).sdk, false);
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.jobs['sdk-linux'].if, "needs.changes.outputs.sdk == 'true'");
  const sdk = ci.jobs.windows.steps.find(
    (step) => step.name === 'Verify the full Windows SDK clients and storage volume',
  );
  assert.match(sdk.if, /outputs\.sdk == 'true'/);
  assert.doesNotMatch(sdk.if, /outputs\.full/);
});

test('standalone Linux SDK commands inherit npm executable ownership through lifecycle scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['ci:sdk:prepare'], 'node scripts/ci.mjs sdk-prepare');
  assert.equal(manifest.scripts['ci:sdk'], 'node scripts/ci.mjs sdk');
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const commands = ci.jobs['sdk-linux'].steps
    .filter((step) => step.name?.includes('SDK client'))
    .map((step) => step.run);
  assert.deepEqual(commands, ['npm run ci:sdk:prepare', 'npm run ci:sdk']);
});
