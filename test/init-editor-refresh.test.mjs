import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { refreshEditor } from '../lense/project-editor.mjs';
import { developmentScript, developmentWorkflows, developmentScriptDrift } from '../lense/project-workflows.mjs';
import { loadCatalogue } from '../lense/config.mjs';

const scriptsFor = (options) =>
  Object.fromEntries(
    Object.entries(developmentWorkflows(options)).map(([name, workflow]) => [name, developmentScript(name, workflow)]),
  );
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-editor-refresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project');
  await prepareProject(directory, { name: 'invented', noPack: true, sites: ['alpha'] });
  const configFile = path.join(directory, 'paqvilo.config.yml');
  const config = YAML.parse(await fs.readFile(configFile, 'utf8'));
  await fs.mkdir(path.join(directory, 'sources/alpha-portal'), { recursive: true });
  return { root, directory, config, configFile, write: () => fs.writeFile(configFile, YAML.stringify(config)) };
}

test('configuration-driven shortcuts follow browser settings and drift proposals preserve custom and legacy scripts', async (t) => {
  const fx = await fixture(t);
  const current = scriptsFor({ sites: ['alpha'], browser: 'msedge' });
  current.dev = 'node tools/custom-development.mjs';
  current['my-task'] = 'node tools/custom-task.mjs';
  const manifestFile = path.join(fx.directory, 'package.json'),
    manifest = await readJson(manifestFile);
  manifest.scripts = { ...manifest.scripts, ...current };
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  const before = await fs.readFile(manifestFile, 'utf8');
  fx.config.sites.beta = { ...fx.config.sites.alpha, source: 'beta-portal' };
  delete fx.config.sites.alpha;
  fx.config.defaultSite = 'beta';
  fx.config.browser.channel = 'chrome';
  await fs.mkdir(path.join(fx.directory, 'sources/beta-portal'));
  await fx.write();
  const report = await refreshEditor(fx.directory, { processEnv: {} });
  assert.deepEqual(report.pathWarnings, []);
  assert.equal(await fs.readFile(manifestFile, 'utf8'), before, 'refresh never overwrites package scripts');
  assert.ok(report.scriptChanges.some((change) => change.action === 'add' && change.name === 'dev:beta'));
  assert.ok(report.scriptChanges.some((change) => change.action === 'remove' && change.name === 'dev:alpha'));
  assert.ok(
    report.scriptChanges.some((change) => change.action === 'update' && change.name === 'mirage:dev' && !change.custom),
  );
  assert.ok(report.scriptChanges.some((change) => change.name === 'dev' && change.custom && change.requiresReview));
  assert.equal(
    report.scriptChanges.some((change) => change.name === 'my-task'),
    false,
  );
  const tasks = await readJson(path.join(fx.directory, '.vscode/tasks.json'));
  const processTask = tasks.tasks.find((task) => task.type === 'process' && task.label === 'Invented: dev:beta');
  assert.equal(processTask.args[processTask.args.indexOf('--browser') + 1], 'chrome');
  assert.equal(
    tasks.tasks.some((task) => task.type === 'process' && task.label === 'Invented: dev:alpha'),
    false,
  );
  assert.ok(tasks.tasks.some((task) => task.type === 'npm' && task.script === 'dev'));
  assert.ok(processTask.args.includes('${workspaceFolder}/paqvilo.config.yml'));
  assert.equal(JSON.stringify(tasks).includes(fx.directory), false, 'tracked tasks use portable paths');
  const launches = await readJson(path.join(fx.directory, '.vscode/launch.json'));
  assert.equal(launches.configurations[0].type, 'chrome');
  assert.equal(launches.configurations[0].webRoot, '${workspaceFolder}/sources');
  const expected = scriptsFor({ sites: ['beta'] });
  assert.equal(
    Object.values(expected).some((command) => command.includes('--browser')),
    false,
  );
  assert.deepEqual(developmentScriptDrift({ scripts: expected, sites: ['beta'] }), []);
});

test('workspace discovers all mapped deployment repositories and preserves personal workspace conflicts', async (t) => {
  const fx = await fixture(t);
  const settings = path.join(fx.root, 'settings-repo'),
    projectSettings = path.join(fx.root, 'project-settings-repo');
  for (const repo of [settings, projectSettings]) {
    await fs.mkdir(path.join(repo, 'nested'), { recursive: true });
    await fs.mkdir(path.join(repo, '.git'));
  }
  await fs.writeFile(path.join(settings, 'nested/pages.yml'), 'private-value-sentinel: never read or disclose');
  await fs.symlink(settings, path.join(fx.root, 'settings-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  fx.config.sites.alpha.mirage.deploymentProfiles = {
    profiles: {
      first: { pages: '../settings-repo/nested/pages.yml' },
      nonselected: {
        environmentVariables: ['../settings-repo/missing.json', '../settings-repo/nested/also-missing.json'],
      },
      samePhysicalRepository: { pages: '../settings-alias/nested/missing.yml' },
    },
  };
  const projectFile = path.join(fx.directory, 'project.json');
  await fs.writeFile(
    projectFile,
    JSON.stringify({
      version: 2,
      portals: [
        {
          id: 'main',
          path: './sources/alpha-portal',
          deploymentProfiles: {
            profiles: {
              local: { pages: '../project-settings-repo/nested/missing.yml' },
            },
          },
        },
      ],
    }),
  );
  fx.config.sites.alpha.mirage.project = './project.json';
  await fx.write();
  const report = await refreshEditor(fx.directory, { processEnv: {} });
  const workspaceFile = path.join(fx.directory, 'invented.code-workspace');
  const workspace = await readJson(workspaceFile);
  assert.deepEqual(
    workspace.folders.map((folder) => folder.path),
    [fx.directory, settings, projectSettings],
  );
  assert.equal(JSON.stringify(report).includes('private-value-sentinel'), false);
  const personal = {
    ...workspace,
    folders: [...workspace.folders, { path: './personal' }],
    settings: { 'editor.wordWrap': 'on' },
  };
  await fs.writeFile(workspaceFile, JSON.stringify(personal));
  const personalBody = await fs.readFile(workspaceFile, 'utf8');
  delete fx.config.sites.alpha.mirage.deploymentProfiles;
  await fx.write();
  const conflict = await refreshEditor(fx.directory, { workspaceOnly: true, processEnv: {} });
  assert.equal(await fs.readFile(workspaceFile, 'utf8'), personalBody);
  assert.ok(conflict.conflicts.some((item) => item.generated === 'invented.generated.code-workspace'));
  const alternate = path.join(fx.directory, 'invented.generated.code-workspace');
  assert.deepEqual(
    (await readJson(alternate)).folders.map((folder) => folder.path),
    [fx.directory, projectSettings],
    'stale managed repository disappears from the proposed workspace',
  );
  await fs.writeFile(alternate, 'Personal comparison');
  await refreshEditor(fx.directory, { processEnv: {} });
  assert.equal(await fs.readFile(alternate, 'utf8'), 'Personal comparison');
});

test('selected catalogue proposals retain portable quoted paths and unsafe shell paths require manual review', async (t) => {
  const fx = await fixture(t),
    catalogues = path.join(fx.directory, 'catalogues');
  await fs.mkdir(catalogues);
  const config = { ...fx.config, sourceRoot: '../sources' };
  const selected = 'catalogues/alternate config.yml';
  await fs.writeFile(path.join(fx.directory, selected), YAML.stringify(config));
  const manifestFile = path.join(fx.directory, 'package.json'),
    before = await fs.readFile(manifestFile, 'utf8');
  const report = await refreshEditor(fx.directory, { config: selected, processEnv: {} });
  const proposal = report.scriptChanges.find((change) => change.name === 'dev');
  assert.ok(proposal);
  assert.match(proposal.proposed, /--config "\.\/catalogues\/alternate config\.yml"/);
  assert.equal(proposal.proposed.includes(fx.directory), false);
  const tasks = await readJson(path.join(fx.directory, '.vscode/tasks.json'));
  assert.ok(
    tasks.tasks
      .find((task) => task.type === 'process')
      .args.includes('${workspaceFolder}/catalogues/alternate config.yml'),
  );
  const unsafe = 'catalogues/$choice%local.yml';
  await fs.writeFile(path.join(fx.directory, unsafe), YAML.stringify(config));
  const manual = await refreshEditor(fx.directory, { config: unsafe, processEnv: {} });
  assert.ok(manual.scriptChanges.length);
  assert.ok(manual.scriptChanges.every((change) => change.requiresReview && !Object.hasOwn(change, 'proposed')));
  const unsafeTasks = await readJson(path.join(fx.directory, '.vscode/tasks.json'));
  assert.ok(
    unsafeTasks.tasks
      .find((task) => task.type === 'process')
      .args.includes('${workspaceFolder}/catalogues/$choice%local.yml'),
  );
  assert.equal(await fs.readFile(manifestFile, 'utf8'), before);
  for (const character of ['$', '`', '%', '"', "'", '&', '|', '^', '!', ';', '<', '>', '\r', '\n', '\t', '\\']) {
    const changes = developmentScriptDrift({
      scripts: scriptsFor({ sites: ['alpha'] }),
      sites: ['alpha'],
      config: `./catalogue${character}local.yml`,
    });
    assert.ok(changes.length);
    assert.ok(
      changes.every((change) => change.requiresReview && !Object.hasOwn(change, 'proposed')),
      `Unsafe ${JSON.stringify(character)} cannot become a shell proposal`,
    );
  }
});

test('cross-volume refresh retains working absolute debugger paths and explicitly requests review before commit', async (t) => {
  if (
    process.platform !== 'win32' ||
    path.parse(os.tmpdir()).root.toLowerCase() === path.parse(process.cwd()).root.toLowerCase()
  ) {
    t.skip('Requires a toolkit checkout and temporary project on different Windows volumes');
    return;
  }
  const fx = await fixture(t),
    evidenceRoot = path.resolve('.paqvilo');
  await fs.mkdir(evidenceRoot, { recursive: true });
  const sources = await fs.mkdtemp(path.join(evidenceRoot, 'editor-cross-volume-'));
  t.after(() => fs.rm(sources, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const configFile = path.join(sources, 'selected.config.yml');
  const config = {
    sourceRoot: sources,
    defaultSite: 'alpha',
    sites: { alpha: { source: '.', environments: { local: 'http://127.0.0.1:1' }, mirage: { solutionRoots: [] } } },
  };
  await fs.writeFile(configFile, YAML.stringify(config));
  const report = await refreshEditor(fx.directory, { config: configFile, processEnv: {} });
  assert.deepEqual(report.pathWarnings.map((item) => item.file).sort(), ['.vscode/launch.json', '.vscode/tasks.json']);
  assert.ok(
    report.pathWarnings.every(
      (item) =>
        item.code === 'EDITOR_ABSOLUTE_PATH' &&
        item.requiresReview &&
        item.action.includes('review it before committing'),
    ),
  );
  const launches = await readJson(path.join(fx.directory, '.vscode/launch.json'));
  assert.equal(launches.configurations[0].webRoot, sources.replaceAll('\\', '/'));
  assert.equal(path.isAbsolute(launches.configurations[0].webRoot), true);
  const tasksFile = path.join(fx.directory, '.vscode/tasks.json'),
    tasks = await readJson(tasksFile);
  assert.ok(tasks.tasks.find((task) => task.type === 'process').args.includes(configFile.replaceAll('\\', '/')));
  const before = await fs.readFile(tasksFile, 'utf8');
  const workspaceOnly = await refreshEditor(fx.directory, { config: configFile, workspaceOnly: true, processEnv: {} });
  assert.deepEqual(workspaceOnly.pathWarnings, []);
  assert.equal(await fs.readFile(tasksFile, 'utf8'), before);
});

test('canonical added shortcuts retire uppercase and underscore catalogue site IDs while custom edits stay protected', async (t) => {
  const fx = await fixture(t),
    site = 'Portal_Archive';
  const scripts = scriptsFor({ sites: ['alpha'] });
  fx.config.sites[site] = { ...fx.config.sites.alpha };
  await fx.write();
  const sites = Object.keys(loadCatalogue({ config: fx.configFile }, {}).sites);
  assert.ok(sites.includes(site), 'production catalogue accepts this identifier');
  const added = developmentScriptDrift({ scripts, sites });
  const siteNames = [`dev:${site}`, `dev:${site}:debug`, `mirage:dev:${site}`, `mirage:dev:${site}:debug`];
  assert.deepEqual(added.map((change) => change.name).sort(), [...siteNames].sort());
  assert.ok(added.every((change) => change.action === 'add' && !change.custom));
  for (const change of added) scripts[change.name] = change.proposed;
  assert.deepEqual(developmentScriptDrift({ scripts, sites }), []);
  delete fx.config.sites[site];
  await fx.write();
  const remaining = Object.keys(loadCatalogue({ config: fx.configFile }, {}).sites);
  const removed = developmentScriptDrift({ scripts, sites: remaining });
  assert.deepEqual(removed.map((change) => change.name).sort(), [...siteNames].sort());
  assert.ok(removed.every((change) => change.action === 'remove' && !change.custom));
  scripts[`dev:${site}`] = 'node tools/custom-development.mjs';
  const protectedChanges = developmentScriptDrift({ scripts, sites: remaining });
  assert.deepEqual(
    protectedChanges.map((change) => change.name).sort(),
    [`mirage:dev:${site}`, `mirage:dev:${site}:debug`].sort(),
  );
  assert.equal(scripts[`dev:${site}`], 'node tools/custom-development.mjs');
});
