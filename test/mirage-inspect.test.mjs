import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFixture } from './fixture.mjs';
import { runToolkit } from './toolkit-cli.mjs';
import { inspectProcessResult } from '../lense/commands/mirage.mjs';

test('Lense Mirage inspect retains invalid-source diagnostic reports and the failing exit status', async (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  fixture.write('broken.sitesetting.yml', 'adx_name: [unterminated\n');
  const config = fixture.file('inspect-catalogue.yml');
  fs.writeFileSync(
    config,
    JSON.stringify({
      sourceRoot: fixture.dir,
      sites: { invented: { source: '.', environments: { local: 'http://127.0.0.1:8787' } } },
    }),
  );
  // runToolkit's hang guard leaves room for a loaded machine, where one inspect has taken longer than 15 s.
  const run = (...args) => runToolkit('mirage', 'inspect', '--config', config, ...args);
  const [result, human] = await Promise.all([run('--json'), run()]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.command, 'mirage');
  assert.equal(report.action, 'inspect');
  assert.equal(report.ok, false);
  assert.equal(report.offline, true);
  assert.deepEqual(report.writesFiles, []);
  assert.deepEqual(
    report.pages.map((page) => page.url).sort(),
    ['/', '/', '/about-us/', '/scripts/'],
    'the fixture pages are still reported beside the diagnostic',
  );
  assert.ok(
    report.diagnostics.some(
      (item) => item.code === 'invalid-yaml' && path.basename(item.file) === 'broken.sitesetting.yml',
    ),
  );
  assert.ok(report.errors.some((item) => item.code === 'invalid-yaml' && typeof item.message === 'string'));
  assert.equal(human.status, 1, `stdout: ${human.stdout}\nstderr: ${human.stderr}`);
  assert.ok(human.stdout, `inspect returned no report (status ${human.status}); stderr: ${human.stderr}`);
  assert.ok(JSON.parse(human.stdout).diagnostics.some((item) => item.code === 'invalid-yaml'));
  fs.unlinkSync(fixture.file('broken.sitesetting.yml'));
  const healthy = await run('--json');
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).ok, true);
  assert.deepEqual(JSON.parse(healthy.stdout).errors, []);
});

test('inspection report parsing distinguishes source diagnostics from crashes and corrupt output', () => {
  const report = {
    sourceDir: 'invented',
    pages: [{ id: 'home' }],
    diagnostics: [{ code: 'invalid-yaml', message: 'Broken source' }],
  };
  assert.equal(inspectProcessResult({ status: 1, stdout: JSON.stringify(report), stderr: '' }).exitCode, 1);
  const project = { configFile: 'invented.yml', portals: [report] };
  assert.equal(
    inspectProcessResult({ status: 1, stdout: JSON.stringify(project), stderr: '' }).errors[0].code,
    'invalid-yaml',
  );
  assert.throws(
    () => inspectProcessResult({ status: 1, stdout: '', stderr: 'Runtime unavailable' }),
    /Runtime unavailable/,
  );
  assert.throws(
    () =>
      inspectProcessResult({
        status: 1,
        stdout: JSON.stringify({ ...report, diagnostics: [] }),
        stderr: 'Runtime unavailable after inspection',
      }),
    /Runtime unavailable after inspection/,
  );
  assert.throws(() => inspectProcessResult({ status: 0, stdout: 'not json' }), /invalid JSON/);
  assert.throws(() => inspectProcessResult({ status: 0, stdout: 'null' }), /invalid inspection report/);
  assert.throws(
    () => inspectProcessResult({ status: 0, stdout: JSON.stringify({ configFile: 'invented', portals: [null] }) }),
    /invalid inspection report/,
  );
  assert.throws(
    () => inspectProcessResult({ status: null, signal: 'SIGTERM', stdout: JSON.stringify(report) }),
    /terminated by SIGTERM/,
  );
});
