// @test-kind contract: Paqvilo Mirage CLI design: catalogue solution roots, one-line refusals naming the option and path, and the documented exit codes
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { runMirageCommand } from '../cli-command.mjs';
import { parseToolArgs } from '../tool-options.mjs';
import { assertOfflineState } from '../lib/offline-state.mjs';
import { initialState } from '../lib/bootstrap.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const ENTITY =
  '<Entity><Name>x_case</Name><EntityInfo><entity Name="x_case"><EntitySetName>x_cases</EntitySetName><PrimaryIdAttribute>x_caseid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_caseid"><Type>primarykey</Type><LogicalName>x_caseid</LogicalName></attribute><attribute PhysicalName="x_name"><Type>nvarchar</Type><LogicalName>x_name</LogicalName></attribute></attributes></entity></EntityInfo></Entity>';

async function workspace(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-command-errors-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': 'adx_name: Invented\nadx_websiteid: site\n',
    'portal/web-pages/.keep': '',
    'portal/sitesetting.yml': '- adx_name: Webapi/x_case/enabled\n  adx_value: true\n',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>invented</UniqueName></SolutionManifest></ImportExportXml>',
    'solution/Other/Customizations.xml': `<ImportExportXml><Entities>${ENTITY}</Entities></ImportExportXml>`,
    // The catalogue site names its solution roots; nothing could be discovered next to the portal.
    'paqvilo.config.yml':
      'sourceRoot: .\nsites:\n  invented:\n    source: portal\n    defaultEnv: local\n    environments:\n      local: http://127.0.0.1:1\n    mirage:\n      solutionRoots: [./solution]\n',
  };
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
  return dir;
}

async function mirage(args, cwd = process.cwd()) {
  let stdout = '',
    stderr = '';
  const code = await runMirageCommand(args, {
    cwd,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

test('data scaffold with --config and --site uses the catalogue site solution roots', async (t) => {
  const dir = await workspace(t);
  const result = await mirage(
    ['data', 'scaffold', '--config', 'paqvilo.config.yml', '--site', 'invented', '--state', 'state.json'],
    dir,
  );
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.resolution, {
    kind: 'catalogue',
    site: 'invented',
    solutionRoots: 'catalogue',
  });
  assert.deepEqual(report.solutionRoots, [path.join(dir, 'solution')]);
  assert.deepEqual(report.report.referencedWithoutMetadata, []);
  assert.equal(report.rows.x_case.added, 3);
});

test('a missing or malformed input file is one line naming the option and the path', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'bad.json'), '{bad');
  await fs.writeFile(path.join(dir, 'bad.yml'), 'a: [\n');
  await fs.writeFile(path.join(dir, 'bad-scenario.json'), JSON.stringify({ id: 'invented', requires: 'nope' }));
  const cases = [
    [
      ['preflight', '--source', 'portal', '--scenario', 'bad-scenario.json'],
      2,
      /^--scenario file .*bad-scenario\.json is not a valid scenario: scenario\.requires must be an array of requirement ids or patterns\.\n$/,
    ],
    [
      ['preflight', '--project', './nope.yml'],
      2,
      /^--project file not found: .*nope\.yml\. Pass an existing file\.\n$/,
    ],
    [['preflight', '--source', './nope'], 2, /^--source directory not found: .*nope\. Pass an existing directory\.\n$/],
    [
      ['preflight', '--source', 'portal', '--scenario', 'bad.json'],
      2,
      /^--scenario file .*bad\.json is not valid JSON \(line 1, column 2\)\.\n$/,
    ],
    [['preflight', '--source', 'portal', '--solution-root', 'bad.json'], 2, /^--solution-root must name a directory/],
    [
      ['preflight', '--project', 'bad.yml'],
      2,
      /^Project file .*bad\.yml is not valid YAML \([A-Z_]+ at line \d+, column \d+\)\. Fix the file\.\n$/,
    ],
    [['inspect', '--source', './nope'], 1, /^--source directory not found: /],
    [['data', 'scaffold', '--source', 'nope', '--state', 's.json'], 1, /^--source directory not found: /],
    [
      ['data', 'generate', '--pack', 'x', '--state', 's.json', '--pack-module', './nope.mjs'],
      1,
      /^--pack-module module file not found: /,
    ],
  ];
  for (const [args, code, message] of cases) {
    const result = await mirage(args, dir);
    assert.equal(result.code, code, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
    assert.doesNotMatch(result.stderr, /ENOENT|realpath|\n.+\n/, args.join(' '));
  }
});

// @test-kind security: a malformed input file can hold a credential; its refusal reaches logs and CI output, so it names the option, path and position but never the file's content.
test('a malformed JSON or YAML input file is refused without quoting its content', async (t) => {
  const dir = await workspace(t);
  const secret = 'eyJhbGciOiJIUzI1NiJ9.invented-token-value';
  await fs.writeFile(path.join(dir, 'token.json'), `token=${secret}`);
  await fs.writeFile(path.join(dir, 'late.json'), `{\n  "a": 1,\n  "token": ${secret}\n}`);
  await fs.writeFile(path.join(dir, 'token.yml'), `a: b: token=${secret}\n`);
  await fs.writeFile(path.join(dir, 'token-project.json'), `token=${secret}`);
  for (const [args, message] of [
    [['preflight', '--source', 'portal', '--scenario', 'token.json'], /is not valid JSON \(line 1, column 2\)\.\n$/],
    [['preflight', '--source', 'portal', '--scenario', 'late.json'], /is not valid JSON \(line 3, column 12\)\.\n$/],
    [['preflight', '--project', 'token.yml'], /is not valid YAML \(BLOCK_AS_IMPLICIT_KEY at line 1, column 4\)/],
    [['preflight', '--project', 'token-project.json'], /is not valid JSON \(line 1, column 2\)\. Fix the file\.\n$/],
  ]) {
    const result = await mirage(args, dir);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
    for (const part of ['eyJ', 'token=', 'invented-token-value'])
      assert.equal(result.stderr.includes(part), false, `${args.join(' ')}: ${result.stderr}`);
  }
  // Nor does the error object a caller logs whole (message, stack and cause).
  const { readJsonOption } = await import('../lib/path-options.mjs');
  const { loadProjectConfig } = await import('../lib/project-config.mjs');
  for (const failing of [
    () => readJsonOption('scenario', path.join(dir, 'token.json')),
    () => loadProjectConfig(path.join(dir, 'token.yml')),
  ]) {
    const error = await failing().then(
      () => assert.fail('the file is refused'),
      (failure) => failure,
    );
    assert.equal(inspect(error, { depth: 5 }).includes('invented-token-value'), false, inspect(error));
  }
});

test('a negative number after a numeric option gets the option validation, not the parser text', async () => {
  for (const args of [
    ['data', 'scaffold', '--rows', '-1', '--source', 'x', '--state', 'y'],
    ['data', 'scaffold', '--rows=-1', '--source', 'x', '--state', 'y'],
  ]) {
    const result = await mirage(args);
    assert.equal(result.stderr, '--rows must be a non-negative integer\n', args.join(' '));
  }
  const unknown = await mirage(['serve', '--bogus']);
  assert.equal(unknown.stderr, "Unknown option '--bogus'. Run with --help to see supported options.\n");
});

test('an offline write against the state of a running runtime names the attempted operation', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-offline-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state.json');
  await fs.writeFile(
    path.join(dir, `session-${process.pid}.json`),
    JSON.stringify({ pid: process.pid, stateFile: state }),
  );
  await assert.rejects(
    assertOfflineState(state, { directory: dir, isRunning: () => true, operation: 'scaffolding data' }),
    {
      message: `Stop the Mirage using this state (${state}) before scaffolding data.`,
    },
  );
});

test('inspect refuses a dataverse-api runtime with its HTTP API switched off, as serve does, in its JSON envelope', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-inspect-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'solution'));
  await fs.writeFile(
    path.join(dir, 'project.yml'),
    'version: 2\nruntime: { kind: dataverse-api }\ndataverse: { enabled: false }\nsolutions:\n  - id: core\n    path: solution\n',
  );
  const result = await mirage(['inspect', '--project', 'project.yml', '--json'], dir);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).error, {
    code: 'MIRAGE_FAILED',
    message: 'A dataverse-api runtime requires its HTTP API to be enabled: remove dataverse.enabled: false.',
  });
});

test('mirage --help lists setup as an accepted command', async () => {
  const result = await mirage(['--help']);
  assert.match(result.stdout, /^Also accepted: setup \(the same as paqvilo setup\)$/m);
});

test('initialState names its required portal argument', () => {
  assert.throws(() => initialState(), { name: 'TypeError', message: /^initialState\(portal\) requires a portal/ });
});

test('public entry points called without their required argument name it', async () => {
  const modules = {
    api: await import('../api.mjs'),
    acceptance: await import('../acceptance-api.mjs'),
    packs: await import('../packs.mjs'),
    fixtures: await import('../fixtures.mjs'),
    testing: await import('../testing.mjs'),
  };
  const calls = {
    api: ['applySolutionData', 'initialState', 'migrateScenarioState', 'resolveSolutionRoots'],
    acceptance: [
      'assertRichText',
      'classifyNavigationObservations',
      'collectFetchXmlPages',
      'editRichText',
      'observeContextLifecycle',
      'reconcileSupersededRead',
      'resolveRichTextMode',
      'richTextBody',
      'settleHostModal',
      'stateFingerprint',
      'validateRichTextConfiguration',
    ],
    packs: ['configurationPresetDiagnostics', 'resolvePreset', 'validatePackExports'],
    fixtures: [
      'buildPermissionModel',
      'createPortalRenderer',
      'findDanglingLookups',
      'formatViolations',
      'schemaViolations',
      'stateFileFingerprint',
    ],
    testing: ['replayParityCases', 'replayParityDirectory', 'runStorageContract', 'signInContext', 'signInHeaders'],
  };
  for (const [entry, names] of Object.entries(calls))
    for (const name of names) {
      let failure;
      try {
        await modules[entry][name]();
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof TypeError, `${entry} ${name}`);
      assert.match(failure.message, new RegExp(String.raw`^${name}\(.*\) requires .+\.$`), `${entry} ${name}`);
    }
});

test('a persona catalogue that is not an object is named without a stray dot', async () => {
  const { validatePersonaCatalog } = await import('../packs.mjs');
  assert.throws(() => validatePersonaCatalog(null), { message: 'State: personaCatalog must be an object' });
});

test('a repeated single-value option is refused in one line; repeatable options stay repeatable', async (t) => {
  const dir = await workspace(t);
  for (const [args, code] of [
    [['inspect', '--project', 'a.yml', '--project', 'b.yml'], 1],
    [['data', 'scaffold', '--state', 'a.json', '--state', 'b.json', '--profile', 'smoke'], 1],
    [['preflight', '--source', 'portal', '--runtime', 'power-pages', '--runtime', 'dataverse-api'], 2],
  ]) {
    const result = await mirage(args, dir);
    assert.equal(result.code, code, args.join(' '));
    const name = args.find((arg, index) => arg.startsWith('--') && args.indexOf(arg) !== index);
    assert.equal(result.stderr, `${name} may be given only once\n`, args.join(' '));
  }
  const repeated = await mirage(
    ['preflight', '--source', 'portal', '--solution-root', 'solution', '--solution-root', 'solution', '--json'],
    dir,
  );
  assert.doesNotMatch(repeated.stderr, /may be given only once/);
});

test('the public tools share the repeated-option refusal; their repeatable options stay repeatable', () => {
  assert.throws(() => parseToolArgs('query-inventory', ['--portal', 'a', '--portal', 'b']), {
    code: 'invalid_argument',
    message: '--portal may be given only once',
  });
  assert.deepEqual(parseToolArgs('render-sweep', ['--solution-root', 'a', '--solution-root', 'b'])['solution-root'], [
    'a',
    'b',
  ]);
});

test('an unknown key of a version-1 project is reported by inspect and at startup, not refused', async (t) => {
  const dir = await workspace(t);
  const file = path.join(dir, 'project.json');
  await fs.writeFile(
    path.join(dir, 'portal', 'web-pages', 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
  );
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, portals: [{ id: 'main', path: './portal' }], solutions: [], inventedKey: true }),
  );
  const result = await mirage(['inspect', '--project', 'project.json'], dir);
  assert.equal(result.code, 0, result.stderr);
  const unknown = (entries) =>
    entries.filter((entry) => entry.code === 'PROJECT_CONFIG_KEY_UNKNOWN').map((entry) => entry.key);
  assert.deepEqual(unknown(JSON.parse(result.stdout).diagnostics), ['inventedKey']);
  const { loadProjectConfig, projectSummary } = await import('../lib/project-config.mjs');
  const { createSimulator } = await import('../api.mjs');
  const project = await loadProjectConfig(file);
  const sim = await createSimulator({
    sourceDir: project.portals[0].sourceDir,
    project: projectSummary(project, 'main'),
    stateFile: path.join(dir, 'state.json'),
    port: 0,
    watch: false,
  });
  t.after(() => sim.close());
  const findings = await (await fetch(`${sim.url}/_sim/api/diagnostics`)).json();
  assert.deepEqual(unknown(findings.diagnostics), ['inventedKey']);
});
