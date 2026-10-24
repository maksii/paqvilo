import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEV_PROBLEM_MATCHER } from './dev-messages.mjs';
import { assertScaffoldPath } from './scaffold.mjs';
import { loadCatalogue, resolveMirageConfig } from './config.mjs';
import { resolveCatalogue } from './resolved-catalogue.mjs';
import { loadProjectConfig } from '../mirage/lib/project-config.mjs';
import {
  developmentScriptDrift,
  generatedDevelopmentScripts,
  developmentWorkflows,
  siteWorkflowName,
} from './project-workflows.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const digest = (value) => createHash('sha256').update(json(value)).digest('hex');
function owned(value) {
  return json({ ...value, paqvilo: { scaffold: 1, generatedHash: digest(value) } });
}
function unedited(body) {
  try {
    const { paqvilo, ...value } = JSON.parse(body);
    return paqvilo?.scaffold === 1 && paqvilo.generatedHash === digest(value);
  } catch {
    return false;
  }
}

export function editorFiles({
  name,
  sites,
  browser,
  sourceRoot,
  scripts,
  folders = ['.'],
  config = '${workspaceFolder}/paqvilo.config.yml',
}) {
  const prefix = name[0].toUpperCase() + name.slice(1);
  const label = (script) => `${prefix}: ${script}`;
  const workflows = developmentWorkflows({ sites, browser, config });
  // Remove stale generated site tasks while keeping project-authored shortcuts.
  const generated = generatedDevelopmentScripts(scripts, sites);
  const tasks = Object.entries(scripts)
    .filter(([script]) => !generated.has(script))
    .map(([script]) => ({
      label: label(script) + (workflows[script] ? ' (project script)' : ''),
      type: 'npm',
      script,
      options: { cwd: '${workspaceFolder}' },
      problemMatcher: [],
    }));
  for (const [script, workflow] of Object.entries(workflows)) {
    tasks.push({
      label: label(script),
      type: 'process',
      command: 'node',
      args: ['${workspaceFolder}/node_modules/paqvilo/bin/paqvilo.mjs', ...workflow.args],
      options: { cwd: '${workspaceFolder}' },
      ...(workflow.background ? { isBackground: true, problemMatcher: DEV_PROBLEM_MATCHER } : { problemMatcher: [] }),
    });
  }
  const configurations = [];
  for (const product of ['dev', 'mirage:dev']) {
    for (const site of [null, ...sites]) {
      const script = site ? `${siteWorkflowName(product, site)}:debug` : `${product}:debug`;
      configurations.push({
        name: label(script),
        type: browser === 'msedge' ? 'msedge' : 'chrome',
        request: 'attach',
        port: product === 'dev' ? 9222 : 9223,
        webRoot: sourceRoot,
        timeout: 60000,
        preLaunchTask: label(script),
        skipFiles: [
          '**/bootstrap*.js',
          '**/jquery*.js',
          '**/preform*.bundle*.js',
          '**/postform*.bundle*.js',
          '**/*.min.js',
        ],
      });
    }
  }
  return {
    '.vscode/tasks.json': owned({ version: '2.0.0', tasks }),
    '.vscode/launch.json': owned({ version: '0.2.0', configurations }),
    [`${name}.code-workspace`]: owned({ folders: folders.map((folder) => ({ path: folder })) }),
  };
}

const nested = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const editorPath = (target, file) => {
  const relative = path.relative(target, file);
  return path.isAbsolute(relative)
    ? file.replaceAll('\\', '/')
    : '${workspaceFolder}' + (relative ? '/' + relative.replaceAll('\\', '/') : '');
};

/** Locate repository boundaries from path metadata only; deployment file bodies are never read. */
async function mappedRepository(file) {
  const directory = path.dirname(file);
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      if (await fs.stat(path.join(current, '.git'))) return current;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    if (path.dirname(current) === current) return directory;
  }
}

async function deploymentFolders(catalogue, resolved) {
  const files = new Set(),
    projects = new Map();
  const add = (profiles) => {
    for (const sections of Object.values(profiles?.profiles ?? {}))
      for (const paths of Object.values(sections)) for (const file of [].concat(paths)) files.add(file);
  };
  for (const site of resolved.sites) {
    const mirage = resolveMirageConfig(catalogue.sites[site.name].mirage, { ...catalogue, sourceDir: site.sourceDir });
    add(mirage.deploymentProfiles);
    if (mirage.project) {
      if (!projects.has(mirage.project)) projects.set(mirage.project, loadProjectConfig(mirage.project));
      for (const portal of (await projects.get(mirage.project)).portals) add(portal.deploymentProfiles);
    }
  }
  return Promise.all([...files].map(mappedRepository));
}

export async function refreshEditor(directory, { config, workspaceOnly = false, processEnv = process.env } = {}) {
  const target = await assertScaffoldPath(directory, { directory: true });
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'));
  if (manifest.paqvilo?.scaffold !== 1)
    throw new Error('Editor refresh requires a package generated by paqvilo init (scaffold 1).');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.name))
    throw new Error('Editor refresh requires a portable scaffold package name.');
  if (manifest.paqvilo.vscode === false && !workspaceOnly)
    throw new Error('This scaffold disabled VS Code generation.');
  const configFile = path.resolve(target, config ?? 'paqvilo.config.yml');
  const relativeConfig = path.relative(target, configFile).split(path.sep).join('/');
  const scriptConfig =
    path.isAbsolute(relativeConfig) || relativeConfig.startsWith('.') ? relativeConfig : './' + relativeConfig;
  const catalogue = loadCatalogue({ config: configFile }, processEnv);
  const resolved = await resolveCatalogue({ config: configFile }, processEnv);
  const candidates = [
    target,
    resolved.sourceRoot,
    ...resolved.sites.flatMap((site) => [site.sourceDir, ...site.solutionRoots]),
    ...(await deploymentFolders(catalogue, resolved)),
  ];
  const folders = [],
    realFolders = new Set();
  for (const folder of candidates.filter(Boolean)) {
    try {
      if (!(await fs.stat(folder)).isDirectory()) continue;
      const real = await fs.realpath(folder);
      if (realFolders.has(real) || [...realFolders].some((parent) => nested(parent, real))) continue;
      // Keep the project folder first; a broader external dependency supersedes
      // any narrower dependency already selected under it.
      for (let index = folders.length - 1; index > 0; index--) {
        const existing = await fs.realpath(folders[index]);
        if (nested(real, existing)) {
          realFolders.delete(existing);
          folders.splice(index, 1);
        }
      }
      realFolders.add(real);
      folders.push(folder);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const webRoot = editorPath(target, resolved.sourceRoot),
    editorConfig = editorPath(target, configFile);
  const pathWarnings = [];
  if (!workspaceOnly) {
    for (const [file, field, value] of [
      ['.vscode/launch.json', 'configurations[].webRoot', webRoot],
      ['.vscode/tasks.json', 'tasks[].args --config', editorConfig],
    ]) {
      if (path.isAbsolute(value))
        pathWarnings.push({
          code: 'EDITOR_ABSOLUTE_PATH',
          file,
          field,
          requiresReview: true,
          action:
            'A path on another volume cannot use a relative workspace reference. The working absolute path is retained; review it before committing this editor file, or select paths on the project volume.',
        });
    }
  }
  const files = editorFiles({
    name: manifest.name,
    sites: resolved.sites.map((site) => site.name),
    browser: catalogue.settings.values.PAQVILO_BROWSER ?? catalogue.root.browser.channel,
    sourceRoot: webRoot,
    scripts: manifest.scripts ?? {},
    folders,
    config: editorConfig,
  });
  // Refuse unsafe output paths before updating any editor document.
  const outputs = Object.keys(files).filter((name) => !workspaceOnly || name.endsWith('.code-workspace'));
  for (const name of outputs) {
    await assertScaffoldPath(path.join(target, name));
    const alternate = name.endsWith('.json')
      ? name.replace(/\.json$/, '.generated.json')
      : name.replace(/\.code-workspace$/, '.generated.code-workspace');
    await assertScaffoldPath(path.join(target, alternate));
  }
  const created = [],
    updated = [],
    skipped = [],
    conflicts = [];
  for (const [name, body] of Object.entries(files)) {
    if (workspaceOnly && !name.endsWith('.code-workspace')) continue;
    const file = path.join(target, name);
    await assertScaffoldPath(file);
    let existing;
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing === body) {
      skipped.push(name);
      continue;
    }
    let destination = file;
    let destinationExists = existing !== undefined;
    if (existing !== undefined && !unedited(existing)) {
      destination = name.endsWith('.json')
        ? file.replace(/\.json$/, '.generated.json')
        : file.replace(/\.code-workspace$/, '.generated.code-workspace');
      conflicts.push({ file: name, generated: path.relative(target, destination).replaceAll('\\', '/') });
      await assertScaffoldPath(destination);
      let alternate;
      try {
        alternate = await fs.readFile(destination, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      destinationExists = alternate !== undefined;
      if (alternate !== undefined && !unedited(alternate)) {
        skipped.push(path.relative(target, destination).replaceAll('\\', '/'));
        continue;
      }
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, body, { flag: destinationExists ? 'w' : 'wx' });
    (destinationExists ? updated : created).push(path.relative(target, destination).replaceAll('\\', '/'));
  }
  return {
    schemaVersion: 1,
    ok: true,
    directory: target,
    created,
    updated,
    skipped,
    conflicts,
    pathWarnings,
    scriptChanges: developmentScriptDrift({
      scripts: manifest.scripts ?? {},
      sites: resolved.sites.map((site) => site.name),
      config: scriptConfig,
    }),
  };
}
