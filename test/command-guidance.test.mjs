// @test-kind contract: messages, hints and command help name commands that work in the user's context and describe only the selected command
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { paqviloCommand, paqviloPrefix } from '../lense/command-hint.mjs';
import { LENSE_COMMAND_OPTIONS, LENSE_OPTIONS, MIRAGE_ACTION_OPTIONS, parseOptions } from '../lense/cli-options.mjs';
import { MIRAGE_COMMANDS } from '../mirage/tool-registry.mjs';
import { cliArgs, portablePluginRoot, print, validateMirageArguments } from '../lense/commands/mirage.mjs';
import { inspectProjectPaths } from '../lense/project-check.mjs';
import { loadProjectConfig } from '../mirage/lib/project-config.mjs';
import { loadConfig } from '../lense/config.mjs';
import { boundedCommand } from './helpers/bounded-command.mjs';
import { tempDirSync } from './fixture.mjs';
import { workspace } from './helpers/mirage-in-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(root, 'bin', 'paqvilo.mjs');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));

function folder(t, prefix = 'paqvilo-guidance-') {
  const directory = tempDirSync(prefix);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const run = (t, cwd, ...args) => boundedCommand(t, process.execPath, [bin, ...args], { cwd, env });
/** A project that depends on paqvilo, with a portal extract and the given npm scripts. */
function project(t, scripts = {}) {
  const directory = folder(t);
  write(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'invented', private: true, scripts, devDependencies: { paqvilo: '*' } }),
  );
  fs.mkdirSync(path.join(directory, 'portal', 'web-files'), { recursive: true });
  write(
    path.join(directory, 'paqvilo.config.yml'),
    'sites:\n  example:\n    source: portal\n    defaultEnv: local\n    environments:\n      local: https://example.invalid\n',
  );
  return directory;
}

test('hints use the npm script only when it runs the same command, else the paqvilo form of the context', (t) => {
  const cwd = project(t, { dev: 'paqvilo mirage dev --config ./paqvilo.config.yml', list: 'paqvilo lense list' });
  assert.equal(paqviloCommand(['lense', 'list'], { script: 'list', cwd }), 'npm run list');
  assert.equal(
    paqviloCommand(['lense', 'list'], { script: 'list', cwd, extra: ['--site', '<site>'] }),
    'npm run list -- --site <site>',
  );
  // The project's dev script starts Mirage, so it does not stand for lense dev; use has no script at all.
  assert.equal(paqviloCommand(['lense', 'dev'], { script: 'dev', cwd }), 'npx --no-install paqvilo lense dev');
  assert.equal(paqviloCommand(['lense', 'use'], { script: 'use', cwd }), 'npx --no-install paqvilo lense use');
  // The working directory's catalogue needs no option; another one is named and bypasses the script.
  assert.equal(
    paqviloCommand(['lense', 'list'], { script: 'list', cwd, config: './paqvilo.config.yml' }),
    'npm run list',
  );
  const other = path.join(cwd, 'other config.yml');
  assert.equal(
    paqviloCommand(['lense', 'list'], { script: 'list', cwd, config: other }),
    `npx --no-install paqvilo lense list --config ${JSON.stringify(other)}`,
  );
  assert.deepEqual(paqviloPrefix(root), ['node', 'bin/paqvilo.mjs']);
  // The nearest package.json decides, even without paqvilo: a project above it is never reached.
  const outside = path.join(cwd, 'nested');
  write(path.join(outside, 'package.json'), '{}');
  assert.deepEqual(paqviloPrefix(outside), ['npx', 'paqvilo']);
  assert.deepEqual(paqviloPrefix(cwd), ['npx', '--no-install', 'paqvilo']);
});

test('the default catalogue runs through an npm script only when the script names no other catalogue', (t) => {
  const cwd = project(t, {
    list: 'paqvilo lense list --config ./other.yml',
    same: 'paqvilo lense list --config ./paqvilo.config.yml',
    plain: 'paqvilo lense list',
  });
  assert.equal(paqviloCommand(['lense', 'list'], { script: 'list', cwd }), 'npx --no-install paqvilo lense list');
  assert.equal(
    paqviloCommand(['lense', 'list'], { script: 'list', cwd, config: './paqvilo.config.yml' }),
    'npx --no-install paqvilo lense list',
  );
  assert.equal(paqviloCommand(['lense', 'list'], { script: 'same', cwd }), 'npm run same');
  assert.equal(paqviloCommand(['lense', 'list'], { script: 'plain', cwd }), 'npm run plain');
});

test('use, list and unknown selections print commands that exist in the project', async (t) => {
  const cwd = project(t, { dev: 'paqvilo mirage dev --config ./paqvilo.config.yml' });
  const used = await run(t, cwd, 'lense', 'use', 'example', 'local');
  assert.equal(used.status, 0, used.stderr);
  assert.match(used.stdout, /^start with: npx --no-install paqvilo lense dev$/m);
  assert.doesNotMatch(used.stdout, /npm run/);
  fs.rmSync(path.join(cwd, '.env'));
  const listed = await run(t, cwd, 'lense', 'list');
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /npm run|\.env\.example/, 'no script and no .env.example exist here');
  assert.match(listed.stdout, /not there yet: run "npx --no-install paqvilo lense use"/);
  assert.match(listed.stdout, /npx --no-install paqvilo lense dev --site <site> --env <environment>/);
  const unknown = await run(t, cwd, 'lense', 'status', '--site', 'nope');
  assert.match(
    unknown.stderr,
    /Unknown site "nope"\. Known sites: example\. Run "npx --no-install paqvilo lense list"/,
  );
});

test('argument errors are one clean line without a setup hint; --version prints the toolkit version', async (t) => {
  const cwd = project(t);
  for (const args of [
    ['lense', 'dev', '--headed', '--headless'],
    ['lense', 'dev', '--debug-port', '70000'],
    ['mirage', 'dev', '--startup-timeout', '600001'],
  ]) {
    const result = await run(t, cwd, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.doesNotMatch(result.stderr, /Configure this project|setup/, args.join(' '));
    assert.equal(result.stderr.trim().split(/\r?\n/).length, 1, result.stderr);
  }
  for (const product of ['lense', 'mirage']) {
    const result = await run(t, cwd, product, '--version');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
  }
  const unknown = await run(t, cwd, 'lense', 'dev', '--bogus');
  assert.equal(unknown.stderr.trim(), "paqvilo: Unknown option '--bogus'. Run with --help to see supported options.");
  assert.throws(
    () => parseOptions({ args: ['--site', '-x'], options: { site: { type: 'string' } } }),
    (error) => !/[\r\n]/.test(error.message) && /ambiguous.*Run with --help/.test(error.message),
  );
  // Node ends these two refusals without a full stop; the hint must still start a new sentence.
  for (const args of [['--site'], ['stray']])
    assert.throws(
      () => parseOptions({ args, options: { site: { type: 'string' } } }),
      (error) => /[^.]\. Run with --help to see supported options\.$/.test(error.message),
      args.join(' '),
    );
});

test('agent help claims no action and mirage status accepts --site', async (t) => {
  const cwd = project(t);
  const help = JSON.parse((await run(t, cwd, 'lense', 'agent', '--help', '--json')).stdout);
  assert.equal(help.command, 'help');
  assert.equal(Object.hasOwn(help, 'action'), false);
  const status = await run(
    t,
    cwd,
    'mirage',
    'status',
    '--config',
    './paqvilo.config.yml',
    '--site',
    'example',
    '--json',
  );
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).sessions, []);
  const unknown = JSON.parse((await run(t, cwd, 'mirage', 'status', '--site', 'nope', '--json')).stdout);
  assert.equal(unknown.error.code, 'invalid_argument');
});

test('each command help describes that command and only its options', async (t) => {
  const cwd = folder(t);
  for (const action of ['init', 'start', 'dev', 'status', 'inspect', 'stop']) {
    // mirage inspect is also a Mirage core command; its lifecycle form is lense mirage inspect.
    const result = await run(t, cwd, ...(action === 'inspect' ? ['lense'] : []), 'mirage', action, '--help');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^paqvilo mirage ${action} — `));
    assert.doesNotMatch(result.stdout, /manage a local simulation runtime/);
    const flags = new Set([...result.stdout.matchAll(/^ {2}--([\w-]+)/gm)].map((match) => match[1]));
    assert.deepEqual(flags, new Set([...MIRAGE_ACTION_OPTIONS[action], 'json', 'help']), action);
  }
  for (const command of ['dev', 'resources']) {
    const result = await run(t, cwd, 'lense', command, '--help');
    assert.doesNotMatch(result.stdout, /analyze|dev\/list:|dev\/verify:|resources:/, command);
  }
});

test('every mirage action accepts exactly the options its help lists', () => {
  const sample = (option) => {
    const declared = LENSE_OPTIONS[option];
    if (declared.type === 'boolean') return true;
    return declared.multiple ? ['value'] : '0';
  };
  for (const [action, accepted] of Object.entries(MIRAGE_ACTION_OPTIONS))
    for (const option of LENSE_COMMAND_OPTIONS.mirage) {
      let error = null;
      try {
        validateMirageArguments({ [option]: sample(option) }, action);
      } catch (caught) {
        error = caught;
      }
      if (accepted.includes(option))
        assert.notEqual(error?.code, 'unsupported_option', `${action} --${option}: ${error?.message}`);
      else {
        // --out, --force, --allow-live-writes and dev --json keep their own explanation.
        const explained = /apply only to mirage init|applies only to mirage dev and start|mirage dev is interactive/;
        assert.ok(
          error?.code === 'unsupported_option' || explained.test(error?.message),
          `${action} refuses --${option}: ${error?.message}`,
        );
        assert.doesNotMatch(error.message, /[\r\n]/);
      }
    }
});

test('every mirage action refuses an invalid option value in one line before it reads or writes anything', async (t) => {
  const invalid = {
    port: /^--port must be an integer from 0 to 65535$/,
    runtime: /^--runtime must be power-pages, model-driven or dataverse-api$/,
    simulation: /^--simulation must be dry-run, simulation or deep$/,
    'preset-mode': /^--preset-mode must be bootstrap or always$/,
  };
  for (const [action, accepted] of Object.entries(MIRAGE_ACTION_OPTIONS))
    for (const [option, message] of Object.entries(invalid))
      if (accepted.includes(option))
        assert.throws(() => validateMirageArguments({ [option]: 'x' }, action), { message }, `${action} --${option}`);
  // init in a catalogue folder: the project is not written.
  const directory = project(t);
  const result = await run(t, directory, 'mirage', 'init', '--port', 'x');
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stderr.trim(), 'paqvilo: --port must be an integer from 0 to 65535');
  assert.equal(fs.existsSync(path.join(directory, '.paqvilo')), false);
  // A --project file that does not exist is named, not reported as a raw ENOENT.
  for (const action of ['init', 'start']) {
    const missing = await run(t, directory, 'mirage', action, '--project', 'missing.yml');
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(
      missing.stderr,
      /^paqvilo: --project file not found: .+missing\.yml\. Pass an existing file\.$/m,
      action,
    );
    assert.doesNotMatch(missing.stderr, /ENOENT/);
  }
});

test('top-level, lense and mirage help list every Mirage command and the setup aliases', async (t) => {
  const cwd = folder(t);
  const top = (await run(t, cwd, '--help')).stdout;
  for (const command of MIRAGE_COMMANDS) assert.match(top, new RegExp(`\\b${command}\\b`), command);
  assert.match(top, /lense setup and mirage setup are aliases of paqvilo setup/);
  // bin/paqvilo.mjs accepts --version and -v; the help names both.
  assert.match(top, /^ {7}paqvilo --version \| -v /m);
  assert.match((await run(t, cwd, 'lense', '--help')).stdout, /^ {2}setup {4}alias of paqvilo setup/m);
  assert.match((await run(t, cwd, 'mirage', '--help')).stdout, /paqvilo mirage setup is an alias of paqvilo setup/);
});

test('doctor --setup checks the working directory catalogue browser and says when none was checked', async (t) => {
  const empty = folder(t);
  const text = await run(t, empty, 'doctor', '--setup');
  assert.match(text.stdout, /^Browser: not checked .*--browser <channel>/m);
  const json = JSON.parse((await run(t, empty, 'doctor', '--setup', '--json')).stdout);
  assert.equal(json.prerequisites.browser, null);
  assert.match(json.prerequisites.browserNotChecked, /not checked/);
  const configured = project(t);
  write(path.join(configured, 'paqvilo.config.yml'), 'browser:\n  channel: chromium\nsites: {}\n');
  const checked = JSON.parse((await run(t, configured, 'doctor', '--setup', '--json')).stdout);
  assert.equal(checked.prerequisites.browser.channel, 'chromium');
  assert.equal(checked.prerequisites.browserNotChecked, undefined);
});

test('doctor --setup in an unfinished project still checks dependencies; an invalid explicit --config fails', async (t) => {
  const unfinished = folder(t);
  write(path.join(unfinished, 'paqvilo.config.yml'), 'sites: [unclosed\n');
  const unchecked = await run(t, folder(t), 'doctor', '--setup');
  const text = await run(t, unfinished, 'doctor', '--setup');
  assert.equal(text.status, unchecked.status, text.stderr);
  assert.match(text.stdout, /^Node .*$/m);
  assert.match(
    text.stdout,
    /^Browser: not checked \(paqvilo\.config\.yml in this folder could not be read: .*not valid YAML.*\)\./m,
  );
  const json = await run(t, unfinished, 'doctor', '--setup', '--json');
  assert.equal(json.status, unchecked.status, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.prerequisites.browser, null);
  assert.match(report.prerequisites.browserNotChecked, /could not be read: .*not valid YAML/);
  assert.doesNotMatch(report.prerequisites.browserNotChecked, /[\r\n]/);
  const explicit = await run(t, unfinished, 'doctor', '--setup', '--config', 'paqvilo.config.yml');
  assert.equal(explicit.status, 1);
  assert.match(explicit.stderr, /^paqvilo doctor: paqvilo\.config\.yml is not valid YAML/);
});

test('a missing portal source folder is reported as missing by init --ready', async (t) => {
  const cwd = project(t);
  fs.rmSync(path.join(cwd, 'portal'), { recursive: true });
  const { diagnostics } = await inspectProjectPaths(cwd);
  const missing = diagnostics.find((item) => item.code === 'PORTAL_SOURCE_MISSING');
  assert.ok(missing, JSON.stringify(diagnostics));
  assert.match(missing.action, /does not exist/);
  assert.equal(
    diagnostics.some((item) => item.code === 'PORTAL_LAYOUT_UNSUPPORTED'),
    false,
  );
});

test('a scaffold without editor files tells the user to run the installed paqvilo', async (t) => {
  const target = path.join(folder(t), 'novs');
  const result = await run(t, path.dirname(target), 'init', target, '--no-vscode');
  assert.equal(result.status, 0, result.stderr);
  const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
  assert.match(readme, /`npx --no-install paqvilo init --refresh-editor --workspace-only`/);
  assert.doesNotMatch(readme, /(?<!no-install )`paqvilo init/);
});

test('a project runtime takes the site --site selects or the site that maps it, never one from --config alone', async (t) => {
  const directory = folder(t);
  const config = path.join(directory, 'catalogue.yml');
  const site = (extra = '') =>
    `    source: portal\n    defaultEnv: local\n    environments:\n      local: https://example.invalid\n${extra}`;
  write(
    config,
    `defaultSite: main\nsites:\n  main:\n${site()}  other:\n${site('    mirage:\n      project: ./mapped.project.yml\n')}  third:\n${site('    mirage:\n      project: ./elsewhere.project.yml\n')}`,
  );
  const projectOf = (name) => ({
    configFile: path.join(directory, name),
    runtime: { kind: 'power-pages' },
    defaultPortal: 'example',
  });
  const launch = async (args, name) =>
    cliArgs(
      await loadConfig({ config, ...args }, env, { checkSource: false }),
      'serve',
      { config, ...args, project: path.join(directory, name) },
      projectOf(name),
    ).values;
  const siteOf = (values) =>
    values.includes('--site') ? values.slice(values.indexOf('--site'), values.indexOf('--site') + 4) : null;
  // An unrelated catalogue: no site, the start arguments the command passed before sites were derived.
  const unrelated = await launch({}, 'unrelated.project.yml');
  assert.equal(siteOf(unrelated), null);
  assert.equal(unrelated.includes('--env'), false);
  assert.equal(unrelated[unrelated.indexOf('--config') + 1], config);
  // A non-default site that maps the project applies, without the default site's environment.
  const mapped = await launch({}, 'mapped.project.yml');
  assert.deepEqual(mapped.slice(mapped.indexOf('--site'), mapped.indexOf('--site') + 2), ['--site', 'other']);
  assert.equal(mapped.includes('--env'), false);
  // An explicit --site applies, also when its mirage.project names another file (explicit options win).
  assert.deepEqual(siteOf(await launch({ site: 'third' }, 'unrelated.project.yml')), [
    '--site',
    'third',
    '--env',
    'local',
  ]);
  assert.deepEqual(siteOf(await launch({ site: 'third' }, 'mapped.project.yml')), [
    '--site',
    'third',
    '--env',
    'local',
  ]);
  // Two sites mapping one project: a one-line choice, never a silent pick.
  write(
    config,
    `${fs.readFileSync(config, 'utf8')}  fourth:\n${site('    mirage:\n      project: ./mapped.project.yml\n')}`,
  );
  await assert.rejects(launch({}, 'mapped.project.yml'), (error) => {
    assert.equal(error.code, 'invalid_argument');
    assert.match(error.message, /^Sites other, fourth all map the project .*; choose one with --site <id>\.$/);
    return true;
  });
});

test('status and start text show the Dataverse API and omit a missing portal source', (t) => {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  t.after(() => (console.log = log));
  const links = { dataverseApi: 'http://127.0.0.1:5555', dataverseAuthority: 'http://127.0.0.1:5555/tenant' };
  print({ sessions: [{ pid: 1, url: 'http://127.0.0.1:1', processAlive: true, ready: true, runtime: { links } }] });
  print({
    url: 'http://127.0.0.1:1',
    adminUrl: 'http://127.0.0.1:2/_sim/',
    stateFile: 's',
    sourceDir: null,
    runtime: { links },
  });
  console.log = log;
  const text = lines.join('\n');
  assert.match(text, /dataverse api http:\/\/127\.0\.0\.1:5555/);
  assert.match(text, /authority http:\/\/127\.0\.0\.1:5555\/tenant/);
  assert.match(text, /^Dataverse API: http:\/\/127\.0\.0\.1:5555$/m);
  assert.doesNotMatch(text, /Source:\s+null/);
  assert.match(text, /^State: {5}s$/m);
});

test('a dry-run start does not print a state file it never writes', (t) => {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  t.after(() => (console.log = log));
  print({
    url: 'http://127.0.0.1:1',
    adminUrl: 'http://127.0.0.1:2/_sim/',
    stateFile: 'never-written.json',
    runtime: { simulation: { level: 'dry-run' } },
  });
  console.log = log;
  const text = lines.join('\n');
  assert.match(text, /^State: {5}not persisted \(dry-run keeps state in memory\)$/m);
  assert.doesNotMatch(text, /never-written/);
});

test('plug-in source roots: relative roots resolve against the project file, absolute roots are unchanged', async (t) => {
  const directory = folder(t);
  fs.mkdirSync(path.join(directory, 'portal', 'web-files'), { recursive: true });
  const projectFile = path.join(directory, '.paqvilo', 'mirage', 'example.project.yml');
  const source = (root) => ({
    version: 1,
    portals: [
      {
        id: 'example',
        path: '../../portal',
        observed: {
          evidence: 'Fixture',
          pluginSources: { 'Invented.Rules': { path: 'Rules.cs', evidence: 'Fixture', ...root } },
        },
      },
    ],
  });
  const rootOf = async (root) => {
    write(projectFile, YAML.stringify(source(root)));
    return (await loadProjectConfig(projectFile)).portals[0].observed.pluginSources['Invented.Rules'].root;
  };
  assert.equal(await rootOf({ root: '../..' }), directory);
  assert.equal(await rootOf({}), path.dirname(projectFile));
  const absolute = path.join(os.tmpdir(), 'invented-root');
  assert.equal(await rootOf({ root: absolute }), absolute);
  await assert.rejects(rootOf({ root: 7 }), /pluginSources/);
});

test('mirage init writes plug-in roots inside the catalogue folder relative to the project file', async (t) => {
  const cwd = project(t);
  write(
    path.join(cwd, 'paqvilo.config.yml'),
    'sites:\n  example:\n    source: portal\n    defaultEnv: local\n    environments:\n      local: https://example.invalid\n    mirage:\n      observed:\n        evidence: Fixture\n        pluginSources:\n          Invented.Rules: { path: components/Rules.cs, evidence: Fixture }\n',
  );
  const result = await run(t, cwd, 'mirage', 'init', '--config', './paqvilo.config.yml', '--site', 'example', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const file = JSON.parse(result.stdout).file;
  const written = YAML.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.portals[0].observed.pluginSources['Invented.Rules'].root, '../..');
  const loaded = await loadProjectConfig(file);
  assert.equal(fs.realpathSync(loaded.portals[0].observed.pluginSources['Invented.Rules'].root), fs.realpathSync(cwd));
  assert.match(JSON.parse(result.stdout).next, /^npx --no-install paqvilo mirage dev /);
});

test('mirage init writes a plug-in root that resolves to the folder the catalogue meant when sourceRoot differs', async (t) => {
  const cwd = project(t);
  fs.mkdirSync(path.join(cwd, 'checkout', 'portal', 'web-files'), { recursive: true });
  write(
    path.join(cwd, 'paqvilo.config.yml'),
    'sourceRoot: ./checkout\nsites:\n  example:\n    source: portal\n    defaultEnv: local\n    environments:\n      local: https://example.invalid\n    mirage:\n      observed:\n        evidence: Fixture\n        pluginSources:\n          Invented.Rules: { path: Rules.cs, evidence: Fixture, root: rules }\n          Invented.Default: { path: Default.cs, evidence: Fixture }\n',
  );
  const result = await run(t, cwd, 'mirage', 'init', '--config', './paqvilo.config.yml', '--site', 'example', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const file = JSON.parse(result.stdout).file;
  const written = YAML.parse(fs.readFileSync(file, 'utf8')).portals[0].observed.pluginSources;
  assert.equal(written['Invented.Rules'].root, '../../checkout/rules');
  assert.equal(written['Invented.Default'].root, '../../checkout');
  const loaded = (await loadProjectConfig(file)).portals[0].observed.pluginSources;
  assert.equal(loaded['Invented.Rules'].root, path.join(fs.realpathSync(cwd), 'checkout', 'rules'));
  assert.equal(loaded['Invented.Default'].root, path.join(fs.realpathSync(cwd), 'checkout'));
});

test('portablePluginRoot writes the same relative root for Windows and POSIX paths and keeps other drives absolute', () => {
  for (const [paths, configDir, base, root] of [
    [path.win32, String.raw`C:\work`, String.raw`C:\work\.paqvilo\mirage`, String.raw`C:\work\checkout\rules`],
    [path.posix, '/work', '/work/.paqvilo/mirage', '/work/checkout/rules'],
  ]) {
    assert.equal(portablePluginRoot(root, base, configDir, paths), '../../checkout/rules');
    assert.equal(paths.resolve(base, portablePluginRoot(root, base, configDir, paths)), root);
    assert.equal(portablePluginRoot(base, base, configDir, paths), undefined);
    const outside = paths.resolve(configDir, '..', 'elsewhere');
    assert.equal(portablePluginRoot(outside, base, configDir, paths), outside);
  }
  assert.equal(
    portablePluginRoot(String.raw`D:\rules`, String.raw`C:\work\.paqvilo`, String.raw`C:\work`, path.win32),
    String.raw`D:\rules`,
  );
});

test('a catalogue start with --simulation dry-run reports the level in JSON and prints no state file', async (t) => {
  const work = await workspace(t);
  const config = path.join(work.cwd, 'paqvilo.config.yml');
  await work.writeCatalogue(config);
  const args = ['mirage', 'start', '--config', config, '--site', 'first', '--simulation', 'dry-run', '--port', '0'];
  const started = await work.run([...args, '--json']);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const session = JSON.parse(started.stdout);
  assert.equal(session.runtime.simulation.level, 'dry-run');
  const text = await work.run(args);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, /^State: {5}not persisted \(dry-run keeps state in memory\)$/m);
  await work.replay(session.stop);
});

test('every option a printed stop hint can carry is one mirage stop accepts', () => {
  const source = fs.readFileSync(path.join(root, 'lense', 'commands', 'mirage.mjs'), 'utf8');
  const body = (name) => {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf('\n}\n', start));
  };
  const hinted = new Set();
  for (const text of [body('hintScope'), body('sessionStopArguments')])
    for (const [, option] of text.matchAll(/'--([a-z-]+)'/g)) hinted.add(option);
  for (const [, call] of source.matchAll(/mirageStopCommand\(\s*\[([^\]]*)\]/g))
    for (const [, option] of call.matchAll(/'--([a-z-]+)'/g)) hinted.add(option);
  assert.ok(hinted.has('project') && hinted.has('state'), [...hinted].join(' '));
  for (const option of hinted) assert.ok(MIRAGE_ACTION_OPTIONS.stop.includes(option), `stop accepts --${option}`);
});

test('a standalone runtime start says live writes do not apply', (t) => {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  t.after(() => (console.log = log));
  print({
    url: 'http://127.0.0.1:1',
    adminUrl: 'http://127.0.0.1:2/_sim/',
    stateFile: 's',
    runtime: { runtime: { kind: 'model-driven' } },
  });
  console.log = log;
  assert.match(lines.join('\n'), /^Live writes: do not apply \(a model-driven runtime has no live environment\)$/m);
});
