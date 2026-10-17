import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCatalogue, resolveMirageConfig } from './config.mjs';
import YAML from 'yaml';
import { readLocalFileSync } from './local-file.mjs';

const MARKER = 'TODO(paqvilo-init):';
const ignored = new Set(['.git', 'node_modules', '.paqvilo', 'paqvilo.config.local.yml', 'coverage']);
const privateName = name => ignored.has(name) || (name.startsWith('.env') && name !== '.env.example');
const textFile = name => /\.(?:[cm]?js|json|md|ya?ml|txt|html|css|xml|template)$/.test(name) || name === '.env.example';
const slash = value => value.replaceAll('\\', '/');
function safeTextFile(directory, name) {
  const parts = name.split('/');
  if (parts.some(privateName) || !textFile(parts.at(-1))) return false;
  for (let index = 1; index <= parts.length; index++) {
    try { if (fs.lstatSync(path.join(directory, ...parts.slice(0, index))).isSymbolicLink()) return false; }
    catch { return false; }
  }
  return fs.statSync(path.join(directory, name)).isFile();
}
function projectFiles(directory) {
  // Include untracked starter files, and honor project ignores once Git is initialized.
  const git = spawnSync('git', ['-C', directory, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  if (git.status === 0) return [...new Set(git.stdout.split('\0').filter(Boolean))].filter(name => safeTextFile(directory, name)).sort();
  const names = [];
  const walk = (folder, prefix = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (privateName(entry.name) || entry.isSymbolicLink()) continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), name + '/');
      else if (entry.isFile() && textFile(entry.name)) names.push(name);
    }
  };
  walk(directory);
  return names.sort();
}

export function scaffoldMarkers(directory) {
  const todo = [];
  for (const file of projectFiles(directory)) {
    const filename = path.join(directory, file);
    let text;
    try { text = readLocalFileSync(filename, { root: directory, maxBytes: 1024 * 1024, encoding: 'utf8' }); }
    catch (error) {
      if (error.code === 'ENOENT' || error.message === 'Local file is not regular or exceeds its read limit') continue;
      throw error;
    }
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const at = line.indexOf(MARKER);
      if (at >= 0) todo.push({ file, line: index + 1, kind: 'marker', text: line.slice(at) });
    }
  }
  return todo;
}

export function scaffoldWarning(directory) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (manifest.paqvilo?.scaffold && scaffoldMarkers(directory).length) return 'Project scaffold has unfinished markers; run paqvilo init --check.';
  } catch { /* Optional guidance must not change doctor readiness. */ }
  return null;
}

export function checkProject(directory, { config, processEnv = process.env } = {}) {
  const target = path.resolve(directory);
  const todo = scaffoldMarkers(target);
  const configFile = path.resolve(target, config ?? 'paqvilo.config.yml');
  const relative = slash(path.relative(target, configFile));
  let document;
  const lineCounter = new YAML.LineCounter();
  try { document = YAML.parseDocument(fs.readFileSync(configFile, 'utf8'), { lineCounter }); } catch { /* loadCatalogue reports it */ }
  const lineOf = field => {
    try { const node = document?.getIn(field.split('.'), true); return node?.range ? lineCounter.linePos(node.range[0]).line : 1; }
    catch { return 1; }
  };
  const add = (kind, text, field, severity = 'error') => todo.push({ file: relative, line: lineOf(field), kind, severity, text });
  let catalogue;
  try { catalogue = loadCatalogue({ config: configFile }, processEnv); }
  catch (error) { add('schema', error.message, error.message.match(/(?:Unknown setting )?([\w.-]+)(?: must| is|$)/)?.[1]?.replace(/^config\./, '') ?? ''); }
  if (catalogue) {
    if (!Object.keys(catalogue.sites).length) add('selection', 'Configure at least one site before completing the scaffold', 'sites');
    if (catalogue.root.defaultSite && !Object.hasOwn(catalogue.sites, catalogue.root.defaultSite)) {
      add('selection', 'defaultSite does not name a configured site', 'defaultSite');
    }
    const originFields = new Set();
    const origin = (value, field) => {
      let url;
      try { url = new URL(value); } catch { return; } // The effective catalogue validator reports malformed URLs.
      if ((url.hostname === 'example.test' || url.hostname.endsWith('.example.test')) && !originFields.has(field)) {
        originFields.add(field);
        add('placeholder-origin', `${field}: replace the placeholder origin`, field);
      }
    };
    // A personal environment must not hide an unfinished shared placeholder.
    for (const [name, site] of Object.entries(document?.toJS()?.sites ?? {})) {
      for (const [env, settings] of Object.entries(site?.environments ?? {})) origin(typeof settings === 'string' ? settings : settings?.url, `sites.${name}.environments.${env}`);
    }
    const folder = (value, field) => {
      try { if (fs.statSync(value).isDirectory()) return; } catch { /* diagnostic below */ }
      add('missing-source', `${field}: folder does not exist: ${value}`, field, 'warning');
    };
    folder(catalogue.sourceRoot, 'sourceRoot');
    for (const [name, site] of Object.entries(catalogue.sites)) {
      if (!Object.keys(site.environments).length) add('selection', `sites.${name}: configure at least one environment`, `sites.${name}.environments`);
      if (site.defaultEnv && !Object.hasOwn(site.environments, site.defaultEnv)) add('selection', `sites.${name}.defaultEnv does not name a configured environment`, `sites.${name}.defaultEnv`);
      if (site.sourceDir) folder(site.sourceDir, `sites.${name}.source`);
      else add('missing-source', `sites.${name}.source: select a portal export folder`, `sites.${name}.source`, 'warning');
      for (const [env, settings] of Object.entries(site.environments)) {
        origin(settings.url, `sites.${name}.environments.${env}`);
      }
      const mirage = resolveMirageConfig(site.mirage, {...catalogue,sourceDir:site.sourceDir});
      for (const root of mirage.solutionRoots) folder(root, `sites.${name}.mirage.solutionRoots`);
      for (const pack of mirage.dataPacks) {
        try { if (fs.statSync(pack.module).isFile()) continue; } catch { /* diagnostic below */ }
        add('missing-pack', `sites.${name}.mirage.dataPacks: module does not exist: ${pack.module}`, `sites.${name}.mirage.dataPacks`);
      }
    }
  }
  return { schemaVersion: 1, ok: todo.length === 0, directory: target, todo };
}
