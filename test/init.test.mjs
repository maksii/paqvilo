import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import YAML from 'yaml';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { checkProject as inspectProject, scaffoldWarning } from '../lense/project-check.mjs';
import { refreshEditor } from '../lense/project-editor.mjs';
import { loadCatalogue } from '../lense/config.mjs';
import { createMirageContext } from '../mirage/api.mjs';
import { DEV_READY, DEV_BACKGROUND } from '../lense/dev-messages.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { tempDir } from './fixture.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
async function project(t) {
  const directory = await tempDir('paqvilo-init-');
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}
const read = (directory, name) => fs.readFile(path.join(directory, name), 'utf8');
const readJson = async (directory, name) => JSON.parse(await read(directory, name));
const checkProject = (directory, options = {}) => inspectProject(directory, { processEnv: {}, ...options });
// Asynchronous so that independent invocations of one test run concurrently.
const node = (args, options = {}) =>
  withProcessSlot(
    () =>
      new Promise((resolve) =>
        execFile(
          process.execPath,
          args,
          { env, encoding: 'utf8', windowsHide: true, timeout: 30000, ...options },
          (error, stdout, stderr) =>
            resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }),
        ),
      ),
  );
const run = (directory, ...args) => node([cli, 'init', directory, ...args]);

test('defaults generate a complete empty project, valid catalogue and bound offline pack', async (t) => {
  const directory = await project(t);
  const result = await prepareProject(directory, { name: 'sample' });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, []);
  for (const absent of ['.env', '.paqvilo', 'node_modules', 'package-lock.json', 'sources'])
    await assert.rejects(fs.access(path.join(directory, absent)), { code: 'ENOENT' });
  const manifest = await readJson(directory, 'package.json');
  const toolkit = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.devDependencies.paqvilo, `^${toolkit.version}`);
  assert.equal(manifest.engines.node, toolkit.engines.node);
  assert.equal((await read(directory, '.node-version')).trim(), toolkit.engines.node.match(/\d+\.\d+\.\d+/)[0]);
  assert.equal(manifest.private, true);
  assert.equal(manifest.paqvilo.scaffold, 1);
  assert.match(manifest.scripts.dev, /--profile lense --portals all/);
  assert.match(manifest.scripts['mirage:dev'], /--profile mirage --preset-mode bootstrap/);
  assert.ok(!Object.values(manifest.scripts).some((script) => /--preset\s/.test(script)));
  const catalogue = loadCatalogue({ config: path.join(directory, 'paqvilo.config.yml') }, {});
  assert.equal(catalogue.sites.portal.mirage.port, 8787);
  const context = await createMirageContext({ config: pathToFileURL(path.join(directory, 'paqvilo.config.yml')) });
  assert.deepEqual(
    context.packs.map((pack) => pack.id),
    ['sample'],
  );
  const store = new context.DataStore();
  await store.applyPreset('sample-empty');
  assert.deepEqual(store.snapshot().tables, {});
  const files = await fs.readdir(directory);
  assert.ok(files.includes('sample.code-workspace'));
  const unfinished = checkProject(directory);
  assert.equal(unfinished.ok, false);
  assert.equal(unfinished.todo.filter((item) => item.kind === 'marker').length, 7);
  assert.ok(unfinished.todo.every((item) => item.line > 0 && item.file));
  assert.match(scaffoldWarning(directory), /paqvilo init --check/);
});

test('multiple sites/packs, chrome, custom paths and dependency specification are deterministic', async (t) => {
  const first = path.join(await project(t), 'first'),
    second = path.join(await project(t), 'second');
  const options = {
    name: 'sample',
    sites: ['one', 'two'],
    packs: ['alpha', 'beta'],
    browser: 'chrome',
    defaultEnv: 'sandbox',
    sourceRoot: '../exports',
    toolkit: 'file:../toolkit',
  };
  const plan = await prepareProject(first, options);
  await prepareProject(second, options);
  for (const file of plan.created) assert.equal(await read(first, file), await read(second, file), file);
  const manifest = await readJson(first, 'package.json');
  assert.equal(manifest.devDependencies.paqvilo, 'file:../toolkit');
  for (const site of options.sites) {
    assert.match(manifest.scripts[`dev:${site}`], /--portals selected/);
    assert.match(manifest.scripts[`dev:${site}:debug`], /9222/);
    assert.match(manifest.scripts[`mirage:dev:${site}:debug`], /9223/);
    await fs.access(path.join(first, `test-browser/fixtures/${site}/.gitkeep`));
  }
  const catalogue = YAML.parse(await read(first, 'paqvilo.config.yml'));
  assert.equal(catalogue.sites.one.mirage.port, 8787);
  assert.equal(catalogue.sites.two.mirage.port, 8788);
  assert.equal(catalogue.sites.two.mirage.dataPacks.length, 2);
  const tasks = await readJson(first, '.vscode/tasks.json');
  const launches = await readJson(first, '.vscode/launch.json');
  const labels = new Set(tasks.tasks.map((task) => task.label));
  for (const task of tasks.tasks) {
    if (task.type === 'npm') assert.ok(manifest.scripts[task.script]);
    else {
      assert.equal(task.type, 'process');
      assert.equal(task.args[task.args.indexOf('--browser') + 1], 'chrome');
    }
  }
  for (const launch of launches.configurations) {
    assert.equal(launch.type, 'chrome');
    assert.ok(labels.has(launch.preLaunchTask));
    assert.equal(launch.webRoot, '${workspaceFolder}/../exports');
  }
  assert.equal(launches.configurations.length, 6);
  assert.ok(new RegExp(DEV_BACKGROUND.endsPattern).test(DEV_READY));
  const context = await createMirageContext({ config: pathToFileURL(path.join(first, 'paqvilo.config.yml')) });
  assert.deepEqual(
    context.packs.map((pack) => pack.id),
    ['alpha', 'beta'],
    'repeated per-site registration is deduplicated',
  );
});

test('no-pack/no-vscode generate runnable tests without pack adapters or editor references', async (t) => {
  const directory = await project(t);
  const plan = await prepareProject(directory, { name: 'bare', noPack: true, noVscode: true });
  assert.ok(
    !plan.created.some(
      (file) =>
        file.startsWith('pack/') ||
        file === 'support/mirage.mjs' ||
        file.startsWith('.vscode/') ||
        file.endsWith('.code-workspace'),
    ),
  );
  assert.ok(
    plan.created.includes('support/site.mjs'),
    'site-bound runners are optional independently of pack generation',
  );
  const manifest = await readJson(directory, 'package.json');
  assert.ok(!manifest.scripts.setup.includes('refresh-editor'));
  assert.equal(YAML.parse(await read(directory, 'paqvilo.config.yml')).sites.portal.mirage.dataPacks, undefined);
  assert.match(manifest.scripts.test, /test\/\*\.test\.mjs$/);
  assert.match(await read(directory, 'test-browser/smoke.test.mjs'), /from 'paqvilo\/mirage'/);
});

test('agent guidance is concise, covers setup/validation/boundaries and links to maintained toolkit docs', async (t) => {
  const directory = await project(t);
  await prepareProject(directory, { name: 'guided' });
  const instructions = await read(directory, 'AGENTS.md');
  assert.ok(instructions.trim().split(/\s+/).length <= 300);
  for (const phrase of [
    'npm run setup',
    'init --check',
    "CLI's `--help`",
    'npm run validate',
    'caution: true',
    'live writes',
    'bearer tokens',
    'Stop only sessions',
  ])
    assert.ok(instructions.includes(phrase), phrase);
  const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const base = metadata.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') + '/blob/main/';
  const links = [...instructions.matchAll(/\]\((https:[^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= 5);
  for (const link of links) {
    assert.ok(link.startsWith(base));
    await fs.access(new URL('../' + link.slice(base.length), import.meta.url));
  }
  assert.ok(!instructions.includes('{{'));
});

test('site IDs that resemble workflow names preserve project-wide picker and debugger scripts', async (t) => {
  const directory = await project(t);
  await prepareProject(directory, { name: 'names', sites: ['debug', 'pick', 'site'], noPack: true });
  const manifest = await readJson(directory, 'package.json');
  assert.equal(manifest.scripts['dev:debug'], 'npm run dev -- --debug-port 9222');
  assert.match(manifest.scripts['dev:pick'], /--pick --portals selected$/);
  for (const product of ['dev', 'mirage:dev']) {
    for (const site of ['debug', 'pick']) {
      const script = `${product}:site:${site}:dev`;
      assert.match(manifest.scripts[script], new RegExp(`--site ${site} --portals selected$`));
      assert.match(manifest.scripts[`${script}:debug`], /--debug-port 922[23]$/);
    }
  }
  const tasks = await readJson(directory, '.vscode/tasks.json');
  assert.equal(new Set(tasks.tasks.map((task) => task.label)).size, tasks.tasks.length);
  const launches = await readJson(directory, '.vscode/launch.json');
  assert.equal(launches.configurations.length, 8);
  for (const launch of launches.configurations) {
    const task = tasks.tasks.find((task) => task.label === launch.preLaunchTask);
    assert.equal(task.args[task.args.indexOf('--debug-port') + 1], String(launch.port));
  }
});

test('refresh adds/removes site tasks and uses catalogue/browser overrides without editing project scripts', async (t) => {
  const directory = await project(t);
  await prepareProject(directory, { name: 'refresh', sites: ['old'] });
  const before = await read(directory, 'package.json');
  const catalogue = YAML.parse(await read(directory, 'paqvilo.config.yml'));
  catalogue.sites.new = catalogue.sites.old;
  delete catalogue.sites.old;
  catalogue.defaultSite = 'new';
  catalogue.browser.channel = 'chrome';
  await fs.writeFile(path.join(directory, 'paqvilo.config.yml'), YAML.stringify(catalogue));
  await refreshEditor(directory, { processEnv: {} });
  const tasks = await readJson(directory, '.vscode/tasks.json');
  assert.ok(!tasks.tasks.some((task) => task.label.includes('dev:old')));
  const task = tasks.tasks.find((task) => task.label.endsWith('dev:new:debug'));
  assert.ok(task);
  assert.equal(task.args[task.args.indexOf('--site') + 1], 'new');
  assert.equal(task.args[task.args.indexOf('--browser') + 1], 'chrome');
  assert.equal(task.args[task.args.indexOf('--config') + 1], '${workspaceFolder}/paqvilo.config.yml');
  assert.equal((await readJson(directory, '.vscode/launch.json')).configurations[0].type, 'chrome');
  assert.equal(await read(directory, 'package.json'), before);
  await refreshEditor(directory, { processEnv: { PAQVILO_BROWSER: 'msedge' } });
  const overridden = (await readJson(directory, '.vscode/tasks.json')).tasks.find((item) => item.label === task.label);
  assert.equal(overridden.args[overridden.args.indexOf('--browser') + 1], 'msedge');
});

test('editor refresh preserves project-authored dev shortcuts while retiring exact generated site workflows', async (t) => {
  const directory = await project(t);
  await prepareProject(directory, { name: 'custom', sites: ['old'] });
  const manifest = await readJson(directory, 'package.json');
  manifest.scripts['dev:trace'] = 'paqvilo lense dev --config ./paqvilo.config.yml --path /trace';
  manifest.scripts['mirage:dev:scenario'] = 'paqvilo mirage dev --config ./paqvilo.config.yml --preset synthetic';
  manifest.scripts['dev:trace:debug'] = 'npm run dev:trace -- --debug-port 9333';
  manifest.scripts.dev += ' --path /project-start';
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
  const catalogue = YAML.parse(await read(directory, 'paqvilo.config.yml'));
  catalogue.sites.current = catalogue.sites.old;
  delete catalogue.sites.old;
  catalogue.defaultSite = 'current';
  await fs.writeFile(path.join(directory, 'paqvilo.config.yml'), YAML.stringify(catalogue));
  await refreshEditor(directory, { processEnv: {} });
  const tasks = (await readJson(directory, '.vscode/tasks.json')).tasks;
  for (const script of ['dev:trace', 'mirage:dev:scenario', 'dev:trace:debug']) {
    assert.equal(tasks.find((task) => task.script === script)?.type, 'npm', script);
  }
  assert.equal(tasks.find((task) => task.script === 'dev')?.label, 'Custom: dev (project script)');
  assert.equal(
    tasks.find((task) => task.script === 'dev:debug')?.label,
    'Custom: dev:debug (project script)',
    'debug wrapper retains the customized base command',
  );
  assert.equal(
    tasks.find((task) => task.label === 'Custom: dev')?.type,
    'process',
    'catalogue workflow remains available for generated launches',
  );
  assert.ok(!tasks.some((task) => task.label.includes('dev:old')));
  assert.ok(tasks.some((task) => task.args?.includes('current')));
  assert.deepEqual(await readJson(directory, 'package.json'), manifest);
});

test('completion check follows shell source selection and honors Git ignores even when all text is ignored', async (t) => {
  const directory = await project(t);
  await prepareProject(directory, { name: 'check' });
  const source = path.join(directory, 'external/portal-portal');
  await fs.mkdir(source, { recursive: true });
  assert.ok(checkProject(directory).todo.some((item) => item.kind === 'missing-source'));
  const selected = checkProject(directory, { processEnv: { PAQVILO_REPO: path.dirname(source) } });
  assert.ok(!selected.todo.some((item) => item.kind === 'missing-source'));
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  const init = spawnSync('git', ['init', '-q', directory], { env: gitEnv, windowsHide: true });
  assert.equal(init.status, 0);
  await fs.writeFile(path.join(directory, '.gitignore'), '*\n');
  assert.ok(
    !checkProject(directory).todo.some((item) => item.kind === 'marker'),
    'an empty index must not scan ignored text',
  );
});

test('completion rejects unusable site/environment selections and personal overrides do not hide shared placeholders', async (t) => {
  const directory = await project(t);
  await prepareProject(directory, { name: 'selections', noPack: true });
  const catalogue = YAML.parse(await read(directory, 'paqvilo.config.yml'));
  assert.ok(
    checkProject(directory, { processEnv: { PAQVILO_PORTAL_ENV_DEV: 'http://127.0.0.1:8787' } }).todo.some(
      (item) => item.kind === 'placeholder-origin',
    ),
  );
  catalogue.defaultSite = 'absent';
  catalogue.sites.portal.defaultEnv = 'absent';
  await fs.writeFile(path.join(directory, 'paqvilo.config.yml'), YAML.stringify(catalogue));
  const invalid = checkProject(directory).todo.filter((item) => item.kind === 'selection');
  assert.equal(invalid.length, 2);
  assert.ok(invalid.every((item) => item.line > 1));
  catalogue.defaultSite = 'portal';
  catalogue.sites.portal.environments = {};
  await fs.writeFile(path.join(directory, 'paqvilo.config.yml'), YAML.stringify(catalogue));
  assert.ok(
    checkProject(directory).todo.some(
      (item) => item.kind === 'selection' && item.text.includes('at least one environment'),
    ),
  );
  delete catalogue.defaultSite;
  catalogue.sites = {};
  await fs.writeFile(path.join(directory, 'paqvilo.config.yml'), YAML.stringify(catalogue));
  assert.ok(
    checkProject(directory).todo.some((item) => item.kind === 'selection' && item.text.includes('at least one site')),
  );
});

test('unsafe editor outputs fail before other documents change, and generated alternatives are reported as created', async (t) => {
  const directory = await project(t);
  await prepareProject(directory, { name: 'safe' });
  const before = await read(directory, '.vscode/tasks.json');
  const config = YAML.parse(await read(directory, 'paqvilo.config.yml'));
  config.browser.channel = 'chrome';
  await fs.writeFile(path.join(directory, 'paqvilo.config.yml'), YAML.stringify(config));
  const launch = path.join(directory, '.vscode/launch.json');
  await fs.unlink(launch);
  await fs.mkdir(launch);
  await assert.rejects(refreshEditor(directory, { processEnv: {} }), /regular file/);
  assert.equal(await read(directory, '.vscode/tasks.json'), before);
  await fs.rmdir(launch);
  await fs.writeFile(launch, '{"custom":true}');
  const report = await refreshEditor(directory, { processEnv: {} });
  assert.ok(report.created.includes('.vscode/launch.generated.json'));
  assert.ok(!report.updated.includes('.vscode/launch.generated.json'));
});

test('generated browser runner ignores empty pack folders and propagates real test failures', async (t) => {
  const directory = await project(t);
  await prepareProject(directory, { name: 'runner', packs: ['alpha', 'beta'], noVscode: true });
  await fs.rm(path.join(directory, 'test-browser/smoke.test.mjs'));
  const execute = () =>
    spawnSync(process.execPath, ['tools/test-browser.mjs'], {
      cwd: directory,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    });
  assert.equal(execute().status, 0, 'all-empty directories are allowed');
  await fs.writeFile(
    path.join(directory, 'packs/alpha/test-browser/local.test.mjs'),
    "import test from 'node:test'; test('invented loopback contract', () => {});\n",
  );
  let result = execute();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /invented loopback contract/);
  await fs.writeFile(
    path.join(directory, 'test-browser/failure.test.mjs'),
    "import test from 'node:test'; test('failure propagates', () => { throw new Error('Expected synthetic failure'); });\n",
  );
  result = execute();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Expected synthetic failure/);
});

test('generated smoke exercises enhanced and code-site exports instead of silently skipping them', async (t) => {
  await Promise.all(
    ['enhanced', 'code-site'].map(async (format) => {
      const directory = await project(t);
      await prepareProject(directory, { name: 'fixture', noPack: true, noVscode: true });
      const destination = path.join(directory, 'test-browser/fixtures/portal');
      await fs.cp(fileURLToPath(new URL(`../test-browser/fixtures/${format}/`, import.meta.url)), destination, {
        recursive: true,
      });
      await assert.rejects(fs.access(path.join(destination, 'website.yml')), { code: 'ENOENT' });
      await fs.mkdir(path.join(directory, 'node_modules'));
      await fs.symlink(
        fileURLToPath(new URL('../', import.meta.url)),
        path.join(directory, 'node_modules/paqvilo'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const result = await node(['tools/test-browser.mjs'], { cwd: directory });
      assert.equal(result.status, 0, format + result.stdout + result.stderr);
      assert.match(result.stdout, /pass 1/, format);
      assert.match(result.stdout, /skipped 0/, format);
    }),
  );
});

test('CLI help, JSON errors and exclusive writes protect unrelated content and symbolic paths', async (t) => {
  const directory = await project(t);
  const unrelated = path.join(directory, 'project');
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(unrelated, 'package.json'), '{"keep":true}\n');
  const invalid = [
    [['--name', '../escape'], /--name must be a lowercase slug/],
    [['--site', 'con'], /--site must be a lowercase slug/],
    [['--site', 'x', '--site', 'x'], /--site values must be unique/],
    [['--pack', 'a', '--no-pack'], /--no-pack cannot be combined with --pack/],
    [['--browser', 'firefox'], /--browser must be msedge, chrome or chromium/],
    [['--workspace-only'], /--workspace-only requires --refresh-editor/],
    [['--check', '--refresh-editor'], /separate operations/],
    [['--wat'], /Unknown option '--wat'/],
  ];
  const [help, rootHelp, ...rejected] = await Promise.all([
    run(directory, '--help'),
    node([cli, '--help']),
    ...invalid.map(([args]) => run(path.join(directory, 'invalid'), ...args, '--json')),
  ]);
  for (const [index, [args, message]] of invalid.entries()) {
    assert.equal(rejected[index].status, 1, args.join(' '));
    const report = JSON.parse(rejected[index].stdout);
    assert.equal(report.ok, false, args.join(' '));
    assert.match(report.error.message, message);
  }
  await assert.rejects(fs.access(path.join(directory, 'invalid')), { code: 'ENOENT' });
  assert.match(help.stdout, /Unlike mirage init/);
  assert.match(rootHelp.stdout, /paqvilo init/);
  let result = await run(unrelated, '--name', 'sample', '--json');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(await read(unrelated, 'package.json'), '{"keep":true}\n');
  result = await run(unrelated, '--name', 'sample', '--into-existing', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).skipped, ['package.json']);
  const before = await read(unrelated, 'paqvilo.config.yml');
  result = await run(unrelated, '--name', 'sample', '--into-existing', '--json');
  assert.equal(JSON.parse(result.stdout).created.length, 0);
  assert.equal(await read(unrelated, 'paqvilo.config.yml'), before);
  const linked = path.join(directory, 'linked');
  await fs.symlink(unrelated, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareProject(linked, { name: 'sample', intoExisting: true }), /symbolic links/);
  await assert.rejects(prepareProject(path.join(linked, 'child'), { name: 'sample' }), /symbolic links/);
  const nested = path.join(directory, 'nested');
  await fs.mkdir(nested);
  await fs.symlink(unrelated, path.join(nested, 'pack'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareProject(nested, { name: 'sample', intoExisting: true }), /symbolic links/);
  assert.deepEqual(await fs.readdir(nested), ['pack'], 'preflight refuses before writing any files');
});

test('completion checks report schema, packs, origins, paths and markers without writing or importing packs', async (t) => {
  const directory = await project(t);
  const plan = await prepareProject(directory, { name: 'sample' });
  const before = new Map(await Promise.all(plan.created.map(async (name) => [name, await read(directory, name)])));
  const fresh = await run(directory, '--check', '--json');
  assert.equal(fresh.status, 1);
  assert.equal(JSON.parse(fresh.stdout).todo.filter((item) => item.kind === 'marker').length, 7);
  for (const [name, body] of before) assert.equal(await read(directory, name), body);
  await fs.writeFile(
    path.join(directory, 'pack/pack.mjs'),
    "throw new Error('Checker must not execute trusted modules');\n",
  );
  assert.doesNotThrow(() => checkProject(directory));
  await fs.rm(path.join(directory, 'pack/pack.mjs'));
  assert.ok(checkProject(directory).todo.some((item) => item.kind === 'missing-pack'));
  await fs.writeFile(path.join(directory, 'pack/pack.mjs'), before.get('pack/pack.mjs'));
  await fs.appendFile(path.join(directory, 'paqvilo.config.yml'), 'unknownSetting: true\n');
  assert.ok(checkProject(directory).todo.some((item) => item.kind === 'schema' && /Unknown setting/.test(item.text)));
  for (const [name, body] of before) {
    const completed = body
      .replace(/^.*TODO\(paqvilo-init\):.*$/gm, (line) => line.replace(/(?:#|\/\/) TODO\(paqvilo-init\):.*$/, ''))
      .replaceAll('https://portal-dev.example.test', 'http://127.0.0.1:8787');
    await fs.writeFile(path.join(directory, name), completed);
  }
  await fs.mkdir(path.join(directory, 'sources/portal-portal'), { recursive: true });
  await fs.writeFile(path.join(directory, 'sources/portal-portal/website.yml'), 'adx_name: Invented\n');
  await fs.writeFile(path.join(directory, '.env'), 'SECRET=TODO(paqvilo-init): do not read\n');
  await fs.mkdir(path.join(directory, '.paqvilo'));
  await fs.writeFile(path.join(directory, '.paqvilo/discovery.json'), 'TODO(paqvilo-init): do not read\n');
  assert.equal(checkProject(directory).ok, true);
  assert.equal(scaffoldWarning(directory), null);
  const doctorArgs = [
    cli,
    'lense',
    'doctor',
    '--config',
    path.join(directory, 'paqvilo.config.yml'),
    '--all',
    '--json',
  ];
  const [complete, doctor] = await Promise.all([run(directory, '--check', '--json'), node(doctorArgs)]);
  assert.equal(complete.status, 0, complete.stdout);
  assert.equal(JSON.parse(doctor.stdout).warnings, undefined);
  await fs.appendFile(path.join(directory, 'README.md'), '\nTODO(paqvilo-init): complete this\n');
  const warned = await node(doctorArgs);
  assert.match(JSON.parse(warned.stdout).warnings[0], /init --check/);
  assert.equal(warned.status, doctor.status, 'guidance does not alter doctor readiness');
});

test('editor refresh follows catalogue/.env/worktree paths and preserves edited files and alternatives', async (t) => {
  const directory = await project(t);
  await prepareProject(directory, { name: 'sample' });
  const sources = path.join(directory, 'external');
  await fs.mkdir(path.join(sources, 'portal-portal'), { recursive: true });
  const config = await read(directory, 'paqvilo.config.yml');
  await fs.writeFile(path.join(directory, 'paqvilo.config.yml'), config.replace('./sources', './external'));
  const report = await refreshEditor(directory, { processEnv: {} });
  assert.ok(report.updated.includes('.vscode/launch.json'));
  let launches = await readJson(directory, '.vscode/launch.json');
  assert.equal(launches.configurations[0].webRoot, '${workspaceFolder}/external');
  const workspace = await readJson(directory, 'sample.code-workspace');
  assert.deepEqual(
    workspace.folders.map((item) => item.path),
    [directory],
  );
  const worktree = path.join(directory, 'worktree');
  await fs.mkdir(path.join(worktree, 'portal-portal'), { recursive: true });
  await refreshEditor(directory, { processEnv: { PAQVILO_REPO: worktree } });
  launches = await readJson(directory, '.vscode/launch.json');
  assert.equal(launches.configurations[0].webRoot, '${workspaceFolder}/worktree');
  const customized = JSON.stringify({
    ...launches,
    configurations: [{ name: 'My launch', type: 'chrome', request: 'attach', port: 9999 }],
  });
  await fs.writeFile(path.join(directory, '.vscode/launch.json'), customized);
  const conflict = await refreshEditor(directory, { processEnv: {} });
  assert.equal(await read(directory, '.vscode/launch.json'), customized);
  assert.equal(conflict.conflicts[0].generated, '.vscode/launch.generated.json');
  assert.equal(
    (await readJson(directory, '.vscode/launch.generated.json')).configurations[0].webRoot,
    '${workspaceFolder}/external',
  );
  await fs.writeFile(path.join(directory, '.vscode/launch.generated.json'), 'Keep my comparison');
  await refreshEditor(directory, { processEnv: {} });
  assert.equal(await read(directory, '.vscode/launch.generated.json'), 'Keep my comparison');
  const before = await read(directory, '.vscode/tasks.json');
  await refreshEditor(directory, { workspaceOnly: true, processEnv: { PAQVILO_REPO: worktree } });
  assert.equal(await read(directory, '.vscode/tasks.json'), before);
});
