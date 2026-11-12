// @test-kind tooling: Sonar coverage artifacts exactly partition the real package test globs and preserve all logical lanes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { ciLanes } from '../.github/scripts/change-scope.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner

const root = process.cwd();
const workflowFile = path.join(root, '.github/workflows/sonarqube.yml');
const ciModule = await import(pathToFileURL(path.join(root, 'scripts/ci.mjs')));
const { shardFiles } = ciModule;
const artifactName = ({ suite, lane, shard = '' }) =>
  `${suite}-${lane}${shard ? `-${shard.replace('/', '-of-')}` : ''}`;
const expected = [
  ...ciLanes('unit', ['lense']).map((row) => [
    row.suite,
    'unit',
    row.shard ?? '',
    artifactName({ ...row, lane: 'unit' }),
  ]),
  ...ciLanes('browser', ['lense']).map((row) => [
    row.suite,
    'browser',
    row.shard ?? '',
    artifactName({ ...row, lane: 'browser' }),
  ]),
  ...ciLanes('unit', ['mirage']).map((row) => [
    row.suite,
    'unit',
    row.shard ?? '',
    artifactName({ ...row, lane: 'unit' }),
  ]),
  ...ciLanes('browser', ['mirage']).map((row) => [
    row.suite,
    'browser',
    row.shard ?? '',
    artifactName({ ...row, lane: 'browser' }),
  ]),
  ...['unit', 'browser'].map((lane) => ['examples', lane, '', `examples-${lane}`]),
];
const reportPath = (artifact) => `coverage/sonar-coverage-${artifact}/lcov.info`;
function matrix(workflow) {
  return workflow.jobs.coverage.strategy.matrix.include;
}
function scriptGlob(directory, name) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8'));
  const words = pkg.scripts[name].split(' ');
  return { flags: words.slice(2, -1), files: fs.globSync(words.at(-1), { cwd: path.join(root, directory) }).sort() };
}
function assertPartition(directory, script, kind, suite) {
  const { files } = scriptGlob(directory, script);
  const lanes = ciLanes(kind, [suite]);
  const shards = lanes.map((lane) => (lane.shard ? shardFiles(files, lane.shard) : files));
  assert.ok(
    shards.every((filesForShard) => filesForShard.length > 0),
    `${directory} ${script} has a nonempty shard`,
  );
  assert.equal(new Set(shards.flat()).size, files.length, `${directory} ${script} has no duplicate assignments`);
  assert.deepEqual(shards.flat().sort(), files, `${directory} ${script} shards cover the complete real glob`);
}

test('Sonar workflow maps nine physical jobs to the unchanged six logical suite/lane pairs', async () => {
  const workflow = parse(fs.readFileSync(workflowFile, 'utf8'));
  const jobs = matrix(workflow);
  assert.deepEqual(
    jobs.map(({ suite, lane, shard, artifact }) => [suite, lane, shard, artifact]),
    expected,
  );
  assert.equal(new Set(jobs.map((job) => job.artifact)).size, 9);
  assert.ok(jobs.every((job) => !job.artifact.includes('/')));
  const logical = new Set(jobs.map(({ suite, lane }) => `${suite}/${lane}`));
  assert.deepEqual([...logical].sort(), [
    'examples/browser',
    'examples/unit',
    'lense/browser',
    'lense/unit',
    'mirage/browser',
    'mirage/unit',
  ]);
  const coverage = workflow.jobs.coverage;
  const prepare = coverage.steps.find((step) => step.name === 'Prepare the existing test lane').run;
  const verify = coverage.steps.find((step) => step.name === 'Run the existing test lane with Node coverage').run;
  assert.match(prepare, /ci:prepare.*matrix\.shard.*--shard/);
  assert.match(verify, /ci:verify.*matrix\.shard.*--shard/);
  assert.equal(coverage.strategy['fail-fast'], false);
});

test('both scanners require exactly the nine nonempty artifact reports', async () => {
  const workflow = parse(fs.readFileSync(workflowFile, 'utf8'));
  const analysis = workflow.jobs.analysis;
  assert.equal(analysis.needs, 'coverage');
  const scans = analysis.steps.filter((step) => step.uses?.startsWith('SonarSource/sonarqube-scan-action@'));
  assert.equal(scans.length, 2);
  const expectedPaths = expected.map((row) => reportPath(row[3])).sort();
  const gate = analysis.steps.find((step) => step.name === 'Verify every coverage shard produced a report').run;
  const gateLabels = gate.match(/for report in \\\n([\s\S]*?); do/)[1].match(/[a-z]+-[a-z]+(?:-\d-of-\d)?/g);
  assert.deepEqual(gateLabels.map(reportPath).sort(), [...expectedPaths].sort());
  for (const scanner of scans) {
    const match = scanner.with.args.match(/-Dsonar\.javascript\.lcov\.reportPaths=([^\s]+)/);
    assert.ok(match);
    assert.deepEqual(match[1].split(',').sort(), expectedPaths);
    assert.ok(scanner.with.args.includes('-Dsonar.qualitygate.wait=true'));
  }
  const branchGate = analysis.steps.findIndex((step) => step.run === 'node scripts/verify-sonar-branch.mjs');
  assert.ok(branchGate > analysis.steps.indexOf(scans[0]) && branchGate < analysis.steps.indexOf(scans[1]));
});

test('Mirage unit and browser shards are nonempty, disjoint, and cover their actual package globs', () => {
  assertPartition('mirage', 'test', 'unit', 'mirage');
  assertPartition('mirage', 'test:browser', 'browser', 'mirage');
});

test('the real Mirage verify lane executes volume and toolkit files once on shard one', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-shard-fixture-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  for (const directory of [
    'scripts',
    '.github/scripts',
    'mirage/test',
    'mirage/test-volume',
    'mirage/test-sdk/toolkit-client',
    'mirage/test-sdk/tds/node_modules/tedious/lib',
  ])
    fs.mkdirSync(path.join(fixtureRoot, directory), { recursive: true });
  for (const file of [
    'scripts/ci.mjs',
    'scripts/ensure-dependencies.mjs',
    'scripts/verified-download.mjs',
    'scripts/ci-workspace-lease.mjs',
    'scripts/npm-cli.mjs',
    '.github/scripts/change-scope.mjs',
  ])
    fs.copyFileSync(path.join(root, file), path.join(fixtureRoot, file));
  fs.copyFileSync(path.join(root, 'global.json'), path.join(fixtureRoot, 'global.json'));
  fs.writeFileSync(
    path.join(fixtureRoot, 'mirage/package.json'),
    JSON.stringify({ scripts: { test: 'node --test ./test/*.test.mjs' } }),
  );
  fs.writeFileSync(path.join(fixtureRoot, 'mirage/test-sdk/tds/node_modules/tedious/lib/tedious.js'), '');
  const marker = path.join(fixtureRoot, 'markers.txt');
  const markerTestSource = String.raw`import test from 'node:test';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const label = readFileSync(fileURLToPath(new URL(import.meta.url + '.name')), 'utf8');
test(label, () => appendFileSync(process.env.MARKER, label + '\n'));
`;
  const markerFixtures = [
    ['mirage/test/ordinary-a.test.mjs', 'ordinary-a'],
    ['mirage/test/ordinary-b.test.mjs', 'ordinary-b'],
    ['mirage/test/ordinary-c.test.mjs', 'ordinary-c'],
    ['mirage/test-volume/write-volume.test.mjs', 'volume-extra'],
    ['mirage/test-sdk/toolkit-client/gate.test.mjs', 'toolkit-extra'],
  ];
  for (const [relative, label] of markerFixtures) {
    const fixtureFile = path.join(fixtureRoot, relative);
    fs.writeFileSync(fixtureFile, markerTestSource);
    fs.writeFileSync(`${fixtureFile}.name`, label, 'utf8');
  }
  const entry = path.join(fixtureRoot, 'run-lane.mjs');
  fs.writeFileSync(
    entry,
    `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => command === 'dotnet' && args?.[0] === '--version'
  ? { status: 0, stdout: '10.0.114\\n', stderr: '', pid: process.pid }
  : originalSpawnSync(command, args, options);
syncBuiltinESMExports();
Object.defineProperty(process, 'platform', { value: 'linux' });
const { verifyLane } = await import('./scripts/ci.mjs');
verifyLane('mirage', { unit: true, browser: false, shard: process.argv[2] });
`,
  );
  for (const shard of ['1/3', '2/3', '3/3']) {
    const env = { ...process.env, MARKER: marker };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [entry, shard], {
      cwd: fixtureRoot,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_HANG_GUARD_MS,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const markers = fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).sort();
  assert.deepEqual(markers, ['ordinary-a', 'ordinary-b', 'ordinary-c', 'toolkit-extra', 'volume-extra'].sort());
});
