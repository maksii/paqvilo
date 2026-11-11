// @test-kind contract+security: offline review thresholds remain separate from Lense readiness and never request portal targets or echo source values
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixture, loopbackServer } from './fixture.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const run = (cwd, command, config, ...args) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, 'lense', command, '--config', config, ...args],
      { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 },
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

test('text analysis prints the skipped Dataverse file and reason for an incomplete inspection', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  fx.write('solution/Other/Solution.xml', '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>');
  fx.write('solution/Entities/inv_widget/Unknown.xml', '<SomethingElse />');
  const answer = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, 'analyze', '--source', fx.file('solution')],
      { env, encoding: 'utf8', windowsHide: true, timeout: 30000 },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    ),
  );
  assert.equal(answer.status, 1);
  assert.match(answer.stdout, /SKIPPED: .*Unknown\.xml: unsupported-dataverse-metadata/);
});
