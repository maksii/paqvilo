import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import {
  checkProject,
  inspectProjectAdoption,
  inspectProjectPaths,
  readyProject,
  scaffoldMarkers,
} from '../lense/project-check.mjs';
import { developmentScript, developmentWorkflows } from '../lense/project-workflows.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { tempDir } from './fixture.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
);
// Asynchronous so that independent invocations of one test run concurrently.
const run = (directory, ...args) =>
  withProcessSlot(
    () =>
      new Promise((resolve) =>
        execFile(
          process.execPath,
          [cli, 'init', directory, ...args],
          { env, encoding: 'utf8', windowsHide: true, timeout: 30000 },
          (error, stdout, stderr) =>
            resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }),
        ),
      ),
  );
const secret = 'INVENTED_PROFILE_VALUE_MUST_NOT_APPEAR';
const write = async (directory, file, body) => {
  await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
  await fs.writeFile(path.join(directory, file), body);
};
const configFile = 'paqvilo.config.json';
async function fixture(t) {
  const directory = await tempDir('paqvilo-ready-');
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = {
    sourceRoot: './sources',
    defaultSite: 'classic',
    defaults: { scope: 'all', markup: { enabled: false }, mirage: { port: 0, solutionRoots: ['solution'] } },
    sites: Object.fromEntries(
      ['classic', 'enhanced'].map((site) => [
        site,
        {
          source: site,
          environments: { dev: 'http://127.0.0.1:1' },
          mirage: {
            dataPacks: [{ id: 'throwing', module: './pack.mjs' }],
            deploymentProfiles: {
              default: 'local',
              profiles: {
                local: { environmentVariables: './local.json' },
                other: { environmentVariables: './other.json' },
              },
            },
          },
        },
      ]),
    ),
  };
  const scripts = {
    'check:setup': 'paqvilo doctor --setup',
    'check:scaffold': 'paqvilo init --check',
    'check:project': 'paqvilo init --ready',
    configure: 'paqvilo setup',
    validate: 'node --test',
    'validate:configured': 'npm run check:project && npm run validate',
    ...Object.fromEntries(
      Object.entries(developmentWorkflows({ sites: ['classic', 'enhanced'], config: './' + configFile })).map(
        ([name, workflow]) => [name, developmentScript(name, workflow)],
      ),
    ),
  };
  await write(
    directory,
    'package.json',
    JSON.stringify({ private: true, type: 'module', scripts, devDependencies: { paqvilo: '^0.9.6' } }),
  );
  await write(directory, '.gitignore', '.paqvilo/\nnode_modules/\n.env*\n!.env.example\npaqvilo.config.local.yml\n');
  await write(directory, configFile, JSON.stringify(config));
  await write(directory, 'pack.mjs', "throw new Error('PACK_MUST_NOT_EXECUTE');\n");
  for (const name of ['local', 'other'])
    await write(
      directory,
      `${name}.json`,
      JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'sample_endpoint', Value: secret }] }),
    );
  await write(directory, 'sources/classic/website.yml', 'adx_websiteid: fixture\nadx_name: Fixture');
  await write(
    directory,
    'sources/classic/web-pages/home/Home.webpage.yml',
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /',
  );
  await write(
    directory,
    'sources/enhanced/powerpagecomponents/home/powerpagecomponent.xml',
    '<powerpagecomponent powerpagecomponentid="home"><content>{"isroot":true,"partialurl":"/"}</content><name>Home</name><powerpagecomponenttype>2</powerpagecomponenttype></powerpagecomponent>',
  );
  await write(
    directory,
    'sources/solution/Other/Solution.xml',
    '<ImportExportXml><SolutionManifest><UniqueName>Fixture</UniqueName></SolutionManifest></ImportExportXml>',
  );
  const save = () => write(directory, configFile, JSON.stringify(config));
  return { directory, config, save };
}
const check = (directory, ...args) => run(directory, '--ready', '--config', configFile, '--json', ...args);

test('public init --ready composes all sites and classic/enhanced layouts without executing packs or disclosing profile values', async (t) => {
  const { directory } = await fixture(t);
  const result = await check(directory);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.offline, true);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.paths.sites.map((site) => site.dialect),
    ['standard-yaml', 'enhanced-solution'],
  );
  assert.deepEqual(
    report.doctor.sites.map((site) => site.site),
    ['classic', 'enhanced'],
  );
  assert.ok(
    report.doctor.sites.every((site) => site.profiles.length === 2 && site.profiles.every((profile) => profile.valid)),
  );
  assert.doesNotMatch(
    result.stdout + result.stderr,
    new RegExp(`${secret}|PACK_MUST_NOT_EXECUTE|127\\.0\\.0\\.1:1|EnvironmentVariables|observed`),
  );
});

test('completion permits an empty export while readiness rejects it and an empty enhanced component folder', async (t) => {
  const { directory } = await fixture(t);
  await fs.rm(path.join(directory, 'sources/classic'), { recursive: true });
  await fs.mkdir(path.join(directory, 'sources/classic'));
  await fs.rm(path.join(directory, 'sources/enhanced/powerpagecomponents/home'), { recursive: true });
  assert.equal(checkProject(directory, { config: configFile, processEnv: {} }).ok, true);
  const result = await check(directory),
    report = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(report.completion.ok, true);
  assert.ok(
    report.paths.diagnostics.some((item) => item.site === 'classic' && item.code === 'PORTAL_LAYOUT_UNSUPPORTED'),
  );
  assert.ok(
    report.doctor.sites.some(
      (site) => site.site === 'enhanced' && site.diagnostics.some((item) => item.code === 'PORTAL_PAGES_MISSING'),
    ),
  );
});

test('all mapped profile files including nonselected files, empty Solution roots and pack paths gate readiness', async (t) => {
  const { directory } = await fixture(t);
  await fs.rm(path.join(directory, 'other.json'));
  await fs.rm(path.join(directory, 'pack.mjs'));
  await fs.rm(path.join(directory, 'sources/solution/Other'), { recursive: true });
  const result = await check(directory),
    report = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  for (const site of ['classic', 'enhanced'])
    for (const code of ['PROFILE_FILE_MISSING', 'PACK_MODULE_MISSING', 'SOLUTION_LAYOUT_MISSING'])
      assert.ok(
        report.paths.diagnostics.some((item) => item.site === site && item.code === code),
        `${site}: ${code}`,
      );
  assert.ok(
    report.paths.diagnostics
      .filter((item) => item.code === 'PROFILE_FILE_MISSING')
      .every((item) => item.profile === 'other'),
  );
});

test('nonselected invalid profile gates project readiness while preserving the existing doctor verdict and parser privacy', async (t) => {
  const { directory } = await fixture(t);
  await write(directory, 'other.json', `{"credential":"${secret}",}`);
  const result = await check(directory),
    report = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(report.paths.ok, true);
  assert.equal(report.doctor.ok, false);
  assert.ok(
    report.doctor.sites.every((site) =>
      site.profiles.some((profile) => profile.id === 'other' && profile.code === 'PROFILE_INVALID'),
    ),
  );
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret + '|credential'));
  const doctor = spawnSync(
    process.execPath,
    [cli, 'lense', 'doctor', '--config', path.join(directory, configFile), '--all', '--mirage', '--json'],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(
    JSON.parse(doctor.stdout).ready,
    true,
    'the existing doctor verdict gates only the selected default profile',
  );
});

test('adoption diagnoses missing wiring read-only and leaves unrelated existing manifests/config/ignores unchanged on repeated calls', async (t) => {
  const { directory } = await fixture(t);
  const custom = {
    private: true,
    scripts: { build: 'echo keep', dev: 'node custom.mjs --token PRIVATE_SCRIPT_VALUE' },
    dependencies: { unrelated: '1.2.3' },
  };
  await write(directory, 'package.json', JSON.stringify(custom));
  await write(directory, '.gitignore', 'custom-output/\n');
  const files = ['package.json', configFile, '.gitignore', 'pack.mjs'];
  const before = await Promise.all(files.map((file) => fs.readFile(path.join(directory, file))));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await check(directory),
      report = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(report.adoption.ok, false);
    for (const code of [
      'PAQVILO_DEPENDENCY_MISSING',
      'PROJECT_SCRIPT_MISSING',
      'PRIVATE_IGNORE_REVIEW',
      'DEVELOPMENT_SCRIPT_DRIFT',
    ])
      assert.ok(report.adoption.diagnostics.some((item) => item.code === code));
    assert.doesNotMatch(result.stdout, /PRIVATE_SCRIPT_VALUE/);
    assert.ok(report.adoption.diagnostics.some((item) => item.script === 'dev' && item.requiresReview));
  }
  for (const [index, file] of files.entries())
    assert.deepEqual(await fs.readFile(path.join(directory, file)), before[index], file);
});

test('custom development scripts remain advisory when required wiring is present', async (t) => {
  const { directory } = await fixture(t);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  manifest.scripts.dev = 'node custom.mjs';
  await write(directory, 'package.json', JSON.stringify(manifest));
  const adoption = inspectProjectAdoption(directory, { config: configFile, processEnv: {} });
  assert.equal(adoption.ok, true);
  assert.ok(
    adoption.diagnostics.some((item) => item.script === 'dev' && item.severity === 'warning' && item.requiresReview),
  );
});

test('adoption detects effective private-path unignore rules without creating or reading private files', async (t) => {
  const { directory } = await fixture(t);
  assert.equal(
    inspectProjectAdoption(directory, { config: configFile, processEnv: {} }).ok,
    true,
    'a valid starter works before Git initialization',
  );
  const git = spawnSync('git', ['-C', directory, 'init', '-q'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  assert.equal(inspectProjectAdoption(directory, { config: configFile, processEnv: {} }).ok, true);
  await fs.appendFile(path.join(directory, '.gitignore'), '!.paqvilo/\n!.env\n!paqvilo.config.local.yml\n');
  const ignored = spawnSync('git', ['-C', directory, 'check-ignore', '--no-index', '--stdin'], {
    input: '.paqvilo/fixture\n.env\npaqvilo.config.local.yml\n',
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(ignored.status, 1, 'Git confirms each overridden private path is unignored');
  const adoption = inspectProjectAdoption(directory, { config: configFile, processEnv: {} });
  assert.equal(adoption.ok, false);
  for (const name of ['.paqvilo', '.env', 'paqvilo.config.local.yml'])
    assert.ok(
      adoption.diagnostics.some((item) => item.code === 'PRIVATE_IGNORE_REVIEW' && item.action.includes(name)),
      name,
    );
  for (const name of ['.paqvilo', '.env', '.env.local', 'paqvilo.config.local.yml', 'node_modules'])
    await assert.rejects(fs.access(path.join(directory, name)), { code: 'ENOENT' });
  await fs.rm(path.join(directory, '.git'), { recursive: true });
  assert.equal(
    inspectProjectAdoption(directory, { config: configFile, processEnv: {} }).ok,
    false,
    'outside Git, custom exceptions require review rather than a false ready verdict',
  );
});

test('targeted private exceptions require review even when representative Git probes remain excluded', async (t) => {
  const { directory } = await fixture(t);
  const git = spawnSync('git', ['-C', directory, 'init', '-q'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  await fs.appendFile(path.join(directory, '.gitignore'), '!.paqvilo/\n.paqvilo/*\n!.paqvilo/private-discovery.json\n');
  const inspect = (input) =>
    spawnSync('git', ['-C', directory, 'check-ignore', '--no-index', '--stdin'], {
      input,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
  assert.equal(inspect('.paqvilo/readiness-private-probe\n').status, 0, 'the generic probe is still ignored');
  assert.equal(inspect('.paqvilo/private-discovery.json\n').status, 1, 'a different private file is unignored');
  assert.equal(inspectProjectAdoption(directory, { config: configFile, processEnv: {} }).ok, false);
  await assert.rejects(fs.access(path.join(directory, '.paqvilo')), { code: 'ENOENT' });
  // A plain unrelated literal exception need not block adoption; broad exceptions
  // require review because they can affect private names that were not probed.
  await write(
    directory,
    '.gitignore',
    '.paqvilo/\nnode_modules/\n.env*\n!.env.example\npaqvilo.config.local.yml\n!README.md\n',
  );
  assert.equal(inspectProjectAdoption(directory, { config: configFile, processEnv: {} }).ok, true);
  await fs.appendFile(path.join(directory, '.gitignore'), '!**/private-*.json\n');
  assert.equal(inspectProjectAdoption(directory, { config: configFile, processEnv: {} }).ok, false);
});

test('adoption reports indexed private paths even when ignore rules are correct without altering the index or private files', async (t) => {
  const { directory } = await fixture(t);
  const git = (args) => spawnSync('git', ['-C', directory, ...args], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(git(['init', '-q']).status, 0);
  await write(directory, '.env', 'INVENTED_PRIVATE_FILE_DO_NOT_READ=fixture');
  await write(directory, '.ENV.FIXTURE', 'INVENTED_CASE_VARIANT_DO_NOT_READ');
  await write(directory, '.paqvilo/private-discovery.json', 'INVENTED_DISCOVERY_BODY_DO_NOT_READ');
  assert.equal(git(['add', '-f', '.env', '.ENV.FIXTURE', '.paqvilo/private-discovery.json']).status, 0);
  const before = git(['ls-files', '--stage']).stdout;
  const adoption = inspectProjectAdoption(directory, { config: configFile, processEnv: {} });
  assert.equal(adoption.ok, false);
  assert.deepEqual(
    adoption.diagnostics
      .filter((item) => item.code === 'PRIVATE_FILE_TRACKED')
      .map((item) => item.file)
      .sort(),
    [...(process.platform === 'win32' ? ['.ENV.FIXTURE'] : []), '.env', '.paqvilo/private-discovery.json'],
  );
  assert.doesNotMatch(
    JSON.stringify(adoption),
    /INVENTED_PRIVATE_FILE_DO_NOT_READ|INVENTED_DISCOVERY_BODY_DO_NOT_READ/,
  );
  assert.equal(git(['ls-files', '--stage']).stdout, before);
  assert.equal(await fs.readFile(path.join(directory, '.env'), 'utf8'), 'INVENTED_PRIVATE_FILE_DO_NOT_READ=fixture');
  assert.equal(
    await fs.readFile(path.join(directory, '.paqvilo/private-discovery.json'), 'utf8'),
    'INVENTED_DISCOVERY_BODY_DO_NOT_READ',
  );
});

test(
  'completion excludes Windows case aliases of private paths while retaining the public environment example',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { directory } = await fixture(t);
    await write(directory, '.ENV.FIXTURE', 'TODO(paqvilo-init): private alias must not be scanned');
    await write(directory, '.PAQVILO/private.txt', 'TODO(paqvilo-init): private evidence alias must not be scanned');
    await write(directory, '.ENV.EXAMPLE', 'TODO(paqvilo-init): public example should be scanned');
    const git = (args) => spawnSync('git', ['-C', directory, ...args], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['add', '-f', '.ENV.FIXTURE', '.PAQVILO/private.txt', '.ENV.EXAMPLE']).status, 0);
    const markers = scaffoldMarkers(directory);
    assert.deepEqual(
      markers.map((item) => item.file),
      ['.ENV.EXAMPLE'],
    );
  },
);

test('readiness validates project-owned paths without importing project packs', async (t) => {
  const { directory, config, save } = await fixture(t);
  config.sites.classic.mirage.project = './project.json';
  await save();
  const result = await check(directory),
    report = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.ok(report.paths.diagnostics.some((item) => item.code === 'PROJECT_FILE_MISSING'));
  await write(
    directory,
    'project.json',
    JSON.stringify({
      version: 2,
      portals: [
        {
          id: 'local',
          path: './sources/classic',
          deploymentProfiles: { profiles: { alternative: { environmentVariables: './absent-project-profile.json' } } },
        },
      ],
      solutions: ['./sources/solution'],
      dataPacks: [{ id: 'project-pack', module: './absent-project-pack.mjs' }],
    }),
  );
  const paths = await inspectProjectPaths(directory, { config: configFile, processEnv: {} });
  assert.ok(
    paths.diagnostics.some(
      (item) => item.code === 'PACK_MODULE_MISSING' && item.file.endsWith('absent-project-pack.mjs'),
    ),
  );
  assert.ok(paths.diagnostics.some((item) => item.code === 'PROFILE_FILE_MISSING' && item.profile === 'alternative'));
  await write(directory, 'absent-project-pack.mjs', "throw new Error('DORMANT_PACK_MUST_NOT_EXECUTE');\n");
  await write(directory, 'absent-project-profile.json', 'dormant project mapping: only its file path is checked');
  assert.equal((await inspectProjectPaths(directory, { config: configFile, processEnv: {} })).ok, true);
  assert.equal(
    (await readyProject(directory, { config: configFile, processEnv: {} })).ok,
    true,
    'catalogue runtime mappings override dormant project mappings; those bodies are not a new syntax gate',
  );
});

test('public readiness errors and mode conflicts are structured and do not create a project', async (t) => {
  const { directory } = await fixture(t);
  const conflicts = [
    [['--ready', '--check'], /separate operations/],
    [['--ready', '--refresh-editor'], /separate operations/],
    [['--ready', '--site', 'other'], /Generation options cannot be combined/],
  ];
  const malformed = ['{"SECRET_INPUT":', 'true', '[]'];
  for (const [index, contents] of malformed.entries()) await write(directory, `malformed-${index}.json`, contents);
  const absent = path.join(directory, 'not-created');
  const [missing, unavailable, ...results] = await Promise.all([
    run(absent, '--ready', '--json'),
    run(directory, '--ready', '--config', 'missing.json', '--json'),
    ...conflicts.map(([args]) => run(directory, ...args, '--json')),
    ...malformed.map((_contents, index) => run(directory, '--ready', '--config', `malformed-${index}.json`, '--json')),
  ]);
  for (const [index, [args, message]] of conflicts.entries()) {
    const result = results[index];
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.match(JSON.parse(result.stdout).error.message, message);
  }
  for (const [index, contents] of malformed.entries()) {
    const result = results[conflicts.length + index];
    assert.equal(result.status, 1, contents);
    assert.equal(JSON.parse(result.stdout).ok, false, contents);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET_INPUT|node:internal/);
  }
  assert.equal(unavailable.status, 1);
  assert.ok(JSON.parse(unavailable.stdout).adoption.diagnostics.some((item) => item.code === 'CATALOGUE_MISSING'));
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);
  await assert.rejects(fs.access(absent), { code: 'ENOENT' });
});

test('readiness performs no fetch and path-only inspection never reads deployment bodies', async (t) => {
  const { directory } = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Offline readiness must not fetch');
  });
  await write(directory, 'other.json', 'invalid profile body is irrelevant to path-only checking');
  assert.equal((await inspectProjectPaths(directory, { config: configFile, processEnv: {} })).ok, true);
  assert.equal((await readyProject(directory, { config: configFile, processEnv: {} })).ok, false);
});
