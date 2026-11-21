// @test-kind contract: an explicit --source beside a catalogue --site replaces the site's source for every source-taking Mirage command, as serve and lense dev apply it
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runMirageCommand } from '../cli-command.mjs';
import { resolveReportInputs } from '../bootstrap-report.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const BIN = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));

// The catalogue site's own source folder does not exist; the explicit export does.
async function workspace(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-source-site-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'export/website.yml': 'adx_name: Invented\nadx_websiteid: site\n',
    'export/web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
    'paqvilo.config.yml':
      'sourceRoot: .\nsites:\n  invented:\n    source: missing\n    defaultEnv: local\n    environments:\n      local: http://127.0.0.1:1\n',
  };
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
  return { dir, source: path.join(dir, 'export') };
}

async function mirage(args, cwd) {
  let stdout = '',
    stderr = '';
  const code = await runMirageCommand(args, {
    cwd,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

test('mirage inspect, preflight and data scaffold read an explicit --source beside --site', async (t) => {
  const { dir, source } = await workspace(t);
  const site = ['--site', 'invented', '--source', source];
  const inspected = await mirage(['inspect', ...site, '--json'], dir);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).sourceDir, source);
  assert.deepEqual(
    JSON.parse(inspected.stdout).pages.map((page) => page.url),
    ['/'],
  );
  const preflight = await mirage(['preflight', ...site, '--json'], dir);
  assert.doesNotMatch(preflight.stderr, /does not exist/, preflight.stderr);
  assert.equal(JSON.parse(preflight.stdout).runtime.kind, 'power-pages');
  const scaffold = await mirage(['data', 'scaffold', ...site, '--state', 'state.json'], dir);
  assert.equal(scaffold.code, 0, scaffold.stderr);
  assert.equal(JSON.parse(scaffold.stdout).bootstrapped, true);
});

test('bootstrap-report reads an explicit --source beside --site', async (t) => {
  const { dir, source } = await workspace(t);
  const inputs = await resolveReportInputs({
    config: path.join(dir, 'paqvilo.config.yml'),
    site: 'invented',
    source,
  });
  assert.equal(inputs.sourceDir, source);
});

// @test-kind contract: preflight's usage presents --project and --config --site as alternatives; it refuses both together
test('preflight refuses --project beside --config or --site in one line', async (t) => {
  const { dir } = await workspace(t);
  await fs.writeFile(
    path.join(dir, 'project.yml'),
    'version: 2\ndefaultPortal: main\nportals:\n  - id: main\n    path: ./export\nsolutions: []\n',
  );
  for (const selection of [
    ['--config', 'paqvilo.config.yml', '--site', 'invented'],
    ['--site', 'invented'],
    ['--config', 'paqvilo.config.yml'],
  ]) {
    const result = await mirage(['preflight', '--project', 'project.yml', ...selection], dir);
    assert.equal(result.code, 2, selection.join(' '));
    assert.equal(result.stderr, 'Use either --project or --config/--site, not both.\n', selection.join(' '));
  }
  const alone = await mirage(['preflight', '--project', 'project.yml', '--json'], dir);
  assert.equal(alone.code, 0, alone.stderr);
});

// @test-kind contract: a bad --runtime or --simulation value names the option typed, not the project-file key
test('a bad --runtime or --simulation value names the option', async (t) => {
  const { dir, source } = await workspace(t);
  for (const [command, code] of [
    ['inspect', 1],
    ['preflight', 2],
  ]) {
    const runtime = await mirage([command, '--source', source, '--runtime', 'bogus'], dir);
    assert.equal(runtime.code, code, command);
    assert.equal(
      runtime.stderr,
      '--runtime must be one of power-pages, model-driven or dataverse-api; got "bogus".\n',
      command,
    );
    const simulation = await mirage([command, '--source', source, '--simulation', 'bogus'], dir);
    assert.equal(simulation.code, code, command);
    assert.equal(simulation.stderr, '--simulation must be one of dry-run, simulation or deep; got "bogus".\n', command);
  }
  // A project file's value keeps naming its key.
  await fs.writeFile(
    path.join(dir, 'project.yml'),
    'version: 2\nruntime: { kind: bogus }\ndefaultPortal: main\nportals:\n  - id: main\n    path: ./export\nsolutions: []\n',
  );
  const fromFile = await mirage(['inspect', '--project', 'project.yml'], dir);
  assert.equal(fromFile.code, 1);
  assert.match(
    fromFile.stderr,
    /runtime\.kind must be one of power-pages, model-driven or dataverse-api; got "bogus"\./,
  );
  assert.doesNotMatch(fromFile.stderr, /--runtime/);
});

test('lense mirage inspect reads an explicit --source beside --site', async (t) => {
  const { dir, source } = await workspace(t);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [BIN, 'lense', 'mirage', 'inspect', '--site', 'invented', '--source', source, '--json'],
    { cwd: dir, windowsHide: true },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true, stdout);
  assert.equal(report.sourceDir, source);
});
