// @test-kind contract+security: offline review thresholds remain separate from Lense readiness and never request portal targets or echo source values
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixture, loopbackServer } from './fixture.mjs';
import { writeSolutionAssetEntries } from '../mirage/lib/dataverse-solution-assets.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const run = (cwd, command, config, ...args) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, 'lense', command, '--config', config, ...args],
      { cwd, env, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    ),
  );

function catalogue(fx, origin, sites = { sample: {} }) {
  const file = fx.file('analysis-catalogue.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      sourceRoot: fx.dir,
      defaultSite: 'sample',
      sites: Object.fromEntries(
        Object.entries(sites).map(([name, extra]) => [
          name,
          { source: '.', environments: { local: origin }, mirage: { port: 0, solutionRoots: [] }, ...extra },
        ]),
      ),
    }),
  );
  return file;
}

test('doctor remains advisory, analyze gates errors and neither requests a configured portal', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  let requests = 0;
  const origin = await loopbackServer(t, async (_request, response) => {
    requests++;
    response.end('unexpected');
  });
  const config = catalogue(fx, origin);
  fx.write(
    'sitesetting.yml',
    '- adx_name: Webapi/sample_record/enabled\n  adx_value: true\n- adx_name: Webapi/sample_record/fields\n  adx_value: "*"\n- adx_name: Authentication/OpenIdConnect/External/ClientSecret\n  adx_value: DO-NOT-EMIT-SECRET\n',
  );
  const results = await Promise.all([
    run(fx.dir, 'doctor', config, '--json'),
    run(fx.dir, 'doctor', config, '--fail-on', 'error', '--json'),
    run(fx.dir, 'analyze', config, '--json'),
    run(fx.dir, 'analyze', config, '--fail-on', 'none', '--json'),
    run(fx.dir, 'analyze', config),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    [0, 1, 1, 0, 1],
    results.map((result) => result.stderr).join('\n'),
  );
  const [advisory, gated, analyzed] = results.slice(0, 3).map((result) => JSON.parse(result.stdout));
  assert.equal(advisory.reports[0].lenseReady, true);
  assert.equal(gated.reports[0].lenseReady, true);
  assert.equal(gated.reports[0].analysisReady, false);
  assert.deepEqual(advisory.checks, ['lense']);
  assert.deepEqual(gated.checks, ['lense', 'analysis']);
  assert.equal(gated.errors[0].code, 'analysis_failed');
  assert.equal(analyzed.offline, true);
  assert.deepEqual(analyzed.writesFiles, []);
  assert.equal(analyzed.reports[0].analysis.complete, true);
  assert.ok(analyzed.reports[0].analysis.findings.some((finding) => finding.ruleId === 'PP-API-001'));
  for (const result of results) assert.doesNotMatch(result.stdout + result.stderr, /DO-NOT-EMIT-SECRET/);
  assert.match(results.at(-1).stdout, /PP-API-001/);
  assert.equal(requests, 0);
});

test('warning and hint thresholds are explicit and policy errors fail without running analysis', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  const config = catalogue(fx, 'http://127.0.0.1:1');
  fx.write('sitesetting.yml', '- name: Webapi/error/innererror\n  value: true\n');
  const [errorOnly, warnings, invalid, unsupported] = await Promise.all([
    run(fx.dir, 'analyze', config, '--json'),
    run(fx.dir, 'analyze', config, '--fail-on', 'warning', '--json'),
    run(fx.dir, 'analyze', config, '--fail-on', 'invalid', '--json'),
    run(fx.dir, 'audit', config, '--fail-on', 'error', '--json'),
  ]);
  assert.equal(errorOnly.status, 0, errorOnly.stdout + errorOnly.stderr);
  assert.equal(warnings.status, 1);
  assert.equal(JSON.parse(warnings.stdout).reports[0].analysis.counts.warning, 1);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).errors[0].code, 'invalid_argument');
  assert.equal(unsupported.status, 1);
  fx.write('web-files/review.html', '<img src="/image.png">');
  const hints = await run(fx.dir, 'analyze', config, '--fail-on', 'hint', '--json');
  assert.equal(hints.status, 1);
  assert.ok(JSON.parse(hints.stdout).reports[0].analysis.counts.hint > 0);
});

test('all sites report separately and incomplete syntax fails the analysis gate', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  const config = catalogue(fx, 'http://127.0.0.1:1', { sample: {}, second: {} });
  fx.write('sitesetting.yml', 'name: Before\nname: After\nvalue: PRIVATE-PARSER-CANARY\n');
  const answer = await run(fx.dir, 'analyze', config, '--all', '--json');
  assert.equal(answer.status, 1);
  const report = JSON.parse(answer.stdout);
  assert.deepEqual(
    report.reports.map((item) => item.site),
    ['sample', 'second'],
  );
  assert.ok(report.reports.every((item) => item.analysis.complete === false));
  assert.ok(
    report.reports.every((item) => item.analysis.findings.some((finding) => finding.ruleId === 'PAQ-SOURCE-001')),
  );
  assert.doesNotMatch(answer.stdout, /PRIVATE-PARSER-CANARY|Before|After/);
});

test('analyze refuses each selector it would ignore, named for the standalone mode in use', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  const config = catalogue(fx, 'http://127.0.0.1:1', { sample: {}, second: {} });
  fx.write('solution/Other/Solution.xml', '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>');
  fx.write(
    'project.json',
    JSON.stringify({ version: 2, runtime: { kind: 'dataverse-api' }, solutions: [{ id: 'schema', path: 'solution' }] }),
  );
  const project = fx.file('project.json');
  const listing = () => fs.readdirSync(fx.dir).sort();
  const before = listing();
  const cliRun = (args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [cli, 'analyze', ...args, '--json'],
        { cwd: fx.dir, env, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
      ),
    );
  for (const [mode, base] of [
    ['--source', ['--source', fx.dir]],
    ['--project', ['--project', project]],
  ])
    for (const [selector, message] of [
      [['--env', 'local'], `--env selects a catalogue environment and cannot be combined with ${mode}.`],
      [['--repo', fx.dir], `--repo selects catalogue sources and cannot be combined with ${mode}.`],
    ]) {
      const refusal = await cliRun([...base, ...selector]);
      assert.equal(refusal.status, 1, [...base, ...selector].join(' '));
      assert.deepEqual(JSON.parse(refusal.stdout).error, { code: 'invalid_argument', message }, message);
    }
  for (const [flag, value] of [
    ['--url', 'http://127.0.0.1:1'],
    ['--scope', 'changed'],
    ['--baseline', 'HEAD'],
  ]) {
    const unsupported = await run(fx.dir, 'analyze', config, flag, value, '--json');
    assert.equal(unsupported.status, 1, flag);
    assert.deepEqual(
      JSON.parse(unsupported.stdout).error,
      { code: 'unsupported_option', message: `${flag} is not supported by analyze` },
      flag,
    );
  }
  assert.deepEqual(listing(), before);
});

test('text analysis prints the skipped Dataverse file and reason for an incomplete inspection', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  fx.write('solution/Other/Solution.xml', '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>');
  fx.write('solution/Entities/inv_widget/Unknown.xml', '<SomethingElse />');
  const answer = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, 'analyze', '--source', fx.file('solution')],
      { env, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    ),
  );
  assert.equal(answer.status, 1);
  assert.match(answer.stdout, /SKIPPED: .*Unknown\.xml: unsupported-dataverse-metadata/);
});

// @test-kind contract: the analyze heading names the verdict
test('the analyze heading names the verdict: INCOMPLETE, ERROR and READY under each gate', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  fx.write('solution/Other/Solution.xml', '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>');
  fx.write('solution/customapis/inv_Ping/Unknown.xml', '<SomethingElse />');
  const analyzeSource = (dir, ...args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [cli, 'analyze', '--source', dir, ...args],
        { env, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
      ),
    );
  const incomplete = await analyzeSource(fx.file('solution'));
  assert.equal(incomplete.status, 1, incomplete.stdout + incomplete.stderr);
  assert.match(incomplete.stdout, /^local-project: INCOMPLETE$/m);
  const incompleteJson = await analyzeSource(fx.file('solution'), '--json');
  assert.equal(JSON.parse(incompleteJson.stdout).reports[0].analysis.verdict, 'incomplete');
  const ungated = await analyzeSource(fx.file('solution'), '--fail-on', 'none');
  assert.equal(ungated.status, 0, ungated.stdout + ungated.stderr);
  assert.match(ungated.stdout, /^local-project: INCOMPLETE$/m);

  const step = createFixture();
  t.after(step.cleanup);
  step.write('step/Other/Solution.xml', '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>');
  step.write(
    'step/sdkmessageprocessingsteps/step.xml',
    '<SdkMessageProcessingStep><SdkMessageName>Update</SdkMessageName><FilteringAttributes>inv_name</FilteringAttributes><Stage>20</Stage><Mode>1</Mode></SdkMessageProcessingStep>',
  );
  const errored = await analyzeSource(step.file('step'));
  assert.equal(errored.status, 1, errored.stdout + errored.stderr);
  assert.match(errored.stdout, /^local-project: ERROR$/m);
  assert.match(errored.stdout, /analysis: inventory complete, 1 error, 0 warnings, 0 hints \(fail on error\)/);
  assert.doesNotMatch(errored.stdout, /1 errors/);
});

test('analyze --source overrides the selected site portal source with --config and --site, and --all applies it to every site', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  fx.write('configured/web-files/.keep', '');
  const config = catalogue(fx, 'http://127.0.0.1:1', {
    sample: { source: 'configured' },
    second: { source: 'configured' },
  });
  fx.write('override/web-files/.keep', '');
  fx.write(
    'override/sitesetting.yml',
    '- adx_name: Webapi/sample_record/enabled\n  adx_value: true\n- adx_name: Webapi/sample_record/fields\n  adx_value: "*"\n',
  );
  const override = fx.file('override');
  const findingIds = (site) => site.analysis.findings.map((finding) => finding.ruleId);
  const configured = await run(fx.dir, 'analyze', config, '--site', 'sample', '--json');
  const configuredSite = JSON.parse(configured.stdout).reports[0];
  assert.ok(!findingIds(configuredSite).includes('PP-API-001'));
  const overridden = await run(fx.dir, 'analyze', config, '--site', 'sample', '--source', override, '--json');
  assert.equal(overridden.status, 1, overridden.stdout + overridden.stderr);
  const overriddenSite = JSON.parse(overridden.stdout).reports[0];
  assert.ok(findingIds(overriddenSite).includes('PP-API-001'));
  assert.notEqual(overriddenSite.analysis.sourceDigest, configuredSite.analysis.sourceDigest);
  const everySite = await run(fx.dir, 'analyze', config, '--all', '--source', override, '--json');
  assert.deepEqual(
    JSON.parse(everySite.stdout).reports.map((item) => [item.site, findingIds(item).includes('PP-API-001')]),
    [
      ['sample', true],
      ['second', true],
    ],
  );
});

test('analyze --source without --config reads the folder as a standalone source', async () => {
  const project = fileURLToPath(new URL('../examples/project', import.meta.url));
  const standalone = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, 'analyze', '--source', project, '--json'],
      { cwd: project, env, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    ),
  );
  assert.equal(standalone.status, 0, standalone.stderr);
  const answer = JSON.parse(standalone.stdout);
  assert.equal(answer.ok, true);
  assert.deepEqual(
    answer.reports.map((item) => item.site),
    ['local-project'],
  );
  assert.deepEqual(answer.errors, []);
});

// @test-kind contract: file labels are the same for --source and a catalogue site
test('file labels are the same for --source and a catalogue site', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  fx.write('solution/Other/Solution.xml', '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>');
  fx.write(
    'solution/sdkmessageprocessingsteps/step.xml',
    '<SdkMessageProcessingStep><SdkMessageName>Update</SdkMessageName><FilteringAttributes>inv_name</FilteringAttributes><Stage>20</Stage><Mode>1</Mode></SdkMessageProcessingStep>',
  );
  const config = catalogue(fx, 'http://127.0.0.1:1', {
    sample: { mirage: { port: 0, solutionRoots: [fx.file('solution')] } },
  });
  const stepFiles = (site) =>
    site.analysis.findings.filter(({ ruleId }) => ruleId === 'DV-PLUGIN-003').map(({ file }) => file);
  const standalone = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, 'analyze', '--source', fx.dir, '--fail-on', 'none', '--json'],
      { cwd: fx.dir, env, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    ),
  );
  const catalogued = await run(fx.dir, 'analyze', config, '--site', 'sample', '--fail-on', 'none', '--json');
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.equal(catalogued.status, 0, catalogued.stdout + catalogued.stderr);
  const expected = ['solution/sdkmessageprocessingsteps/step.xml'];
  assert.deepEqual(stepFiles(JSON.parse(standalone.stdout).reports[0]), expected);
  assert.deepEqual(stepFiles(JSON.parse(catalogued.stdout).reports[0]), expected);
});

// @test-kind contract: --source and --project label the same sources alike
test('file labels are the same for --source and --project on the same sources', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  const manifest = '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>';
  fx.write('sources/metadata/Other/Solution.xml', manifest);
  fx.write('sources/solution/Other/Solution.xml', manifest);
  fx.write(
    'sources/solution/sdkmessageprocessingsteps/step.xml',
    '<SdkMessageProcessingStep><SdkMessageName>Update</SdkMessageName><FilteringAttributes>inv_name</FilteringAttributes><Stage>20</Stage><Mode>1</Mode></SdkMessageProcessingStep>',
  );
  fx.write(
    'mirage.project.yml',
    'version: 2\nsolutions:\n  - { id: metadata, path: ./sources/metadata }\n  - { id: core, path: ./sources/solution }\n',
  );
  const analyzeLabels = (...args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [cli, 'analyze', ...args, '--fail-on', 'none', '--json'],
        { cwd: fx.dir, env, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
      ),
    );
  const stepFiles = (result) =>
    JSON.parse(result.stdout)
      .reports[0].analysis.findings.filter(({ ruleId }) => ruleId === 'DV-PLUGIN-003')
      .map(({ file }) => file);
  const bySource = await analyzeLabels('--source', fx.file('sources'));
  const byProject = await analyzeLabels('--project', fx.file('mirage.project.yml'));
  assert.equal(bySource.status, 0, bySource.stderr);
  assert.equal(byProject.status, 0, byProject.stderr);
  const expected = ['solution/sdkmessageprocessingsteps/step.xml'];
  assert.deepEqual(stepFiles(bySource), expected);
  assert.deepEqual(stepFiles(byProject), expected);
});

// @test-kind contract: terminal links resolve from the working directory and JSON labels stay stable
test('text findings print paths relative to the working directory while JSON keeps the root label', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  fx.write('solution/Other/Solution.xml', '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>');
  fx.write(
    'solution/sdkmessageprocessingsteps/step.xml',
    '<SdkMessageProcessingStep><SdkMessageName>Update</SdkMessageName><FilteringAttributes>inv_name</FilteringAttributes><Stage>20</Stage><Mode>1</Mode></SdkMessageProcessingStep>',
  );
  const analyzeIn = (cwd, ...args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [cli, 'analyze', '--source', fx.file('solution'), '--fail-on', 'none', ...args],
        { cwd, env, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
      ),
    );
  const fromRoot = await analyzeIn(fx.dir);
  const fromSolution = await analyzeIn(fx.file('solution'));
  const json = await analyzeIn(fx.dir, '--json');
  assert.equal(fromRoot.status, 0, fromRoot.stderr);
  assert.equal(fromSolution.status, 0, fromSolution.stderr);
  assert.equal(json.status, 0, json.stderr);
  assert.match(fromRoot.stdout, /\[DV-PLUGIN-003\] solution\/sdkmessageprocessingsteps\/step\.xml:\d+:\d+ \(stage\)/);
  assert.match(fromSolution.stdout, /\] sdkmessageprocessingsteps\/step\.xml:\d+:\d+ \(stage\)/);
  const finding = JSON.parse(json.stdout).reports[0].analysis.findings.find(({ ruleId }) => ruleId === 'DV-PLUGIN-003');
  assert.equal(finding.file, 'sdkmessageprocessingsteps/step.xml');
});

// @test-kind contract: a superseded packed Canvas copy is named in the text report beside its source
test('text analysis names a packed Canvas copy that its unpacked source supersedes', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  const screen =
    'Screens:\n  Home:\n    Children:\n      - Go:\n          Control: Classic/Button@2.2.0\n          Properties:\n            Text: ="Go"\n';
  fx.write('canvas/inv_app_abcde/Src/Home.pa.yaml', screen);
  fx.write(
    'solution/CanvasApps/inv_app_abcde_DocumentUri.msapp',
    writeSolutionAssetEntries([{ name: 'Src/Home.pa.yaml', data: Buffer.from(screen) }]),
  );
  fx.write('solution/Other/Solution.xml', '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>');
  const result = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, 'analyze', '--source', fx.dir, '--fail-on', 'none'],
      { cwd: fx.dir, env, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    ),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes(
      'NOT INSPECTED: solution/CanvasApps/inv_app_abcde_DocumentUri.msapp: packed copy of canvas/inv_app_abcde, whose source is analysed',
    ),
    result.stdout,
  );
});

// @test-kind contract: every path a text report names, finding or SKIPPED, resolves from the working directory
test('text report paths for two roots under --project resolve from the working directory, and JSON labels stay roots-relative', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  const manifest = '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>';
  const step =
    '<SdkMessageProcessingStep><SdkMessageName>Update</SdkMessageName><FilteringAttributes>inv_name</FilteringAttributes><Stage>20</Stage><Mode>1</Mode></SdkMessageProcessingStep>';
  for (const name of ['alpha', 'beta']) {
    fx.write(`sources/${name}/Other/Solution.xml`, manifest);
    fx.write(`sources/${name}/sdkmessageprocessingsteps/step.xml`, step);
    fx.write(`sources/${name}/Entities/inv_widget/Unknown.xml`, '<SomethingElse />');
  }
  fx.write(
    'mirage.project.yml',
    'version: 2\nsolutions:\n  - { id: alpha, path: ./sources/alpha }\n  - { id: beta, path: ./sources/beta }\n',
  );
  const analyzeFrom = (cwd, ...args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [cli, 'analyze', '--project', fx.file('mirage.project.yml'), '--fail-on', 'none', ...args],
        { cwd, env, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
      ),
    );
  const pathsNamed = (stdout) => ({
    findings: [...stdout.matchAll(/^ {2}[A-Z]+ \[[^\]]+\] (.+?):\d+:\d+/gm)].map((match) => match[1]),
    skipped: [...stdout.matchAll(/^ {2}SKIPPED: (.+?): unsupported-dataverse-metadata$/gm)].map((match) => match[1]),
  });
  for (const cwd of [fx.dir, fx.file('sources/alpha')]) {
    const text = await analyzeFrom(cwd);
    assert.equal(text.status, 0, text.stderr);
    const { findings, skipped } = pathsNamed(text.stdout);
    assert.equal(findings.length, 2, text.stdout);
    assert.equal(skipped.length, 2, text.stdout);
    for (const file of [...findings, ...skipped])
      assert.ok(fs.existsSync(path.resolve(cwd, file)), `${file} from ${cwd}`);
  }
  const json = await analyzeFrom(fx.dir, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.ok(!json.stdout.includes('labelRoots'));
  const labels = JSON.parse(json.stdout).reports[0].analysis;
  assert.deepEqual(
    labels.findings.map(({ file }) => file),
    ['alpha/sdkmessageprocessingsteps/step.xml', 'beta/sdkmessageprocessingsteps/step.xml'],
  );
  const skippedLabels = labels.coverage.domains.flatMap((domain) => (domain.skipped ?? []).map(({ file }) => file));
  assert.deepEqual(
    new Set(skippedLabels),
    new Set(['alpha/Entities/inv_widget/Unknown.xml', 'beta/Entities/inv_widget/Unknown.xml']),
  );
});
