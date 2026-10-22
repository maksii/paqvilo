import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCatalogue, mirageOnlySite, resolveMirageConfig } from './config.mjs';
import YAML from 'yaml';
import { readLocalFileSync } from './local-file.mjs';
import { loadConfig } from './config.mjs';
import { detectSourceDialect } from '../mirage/lib/source-dialect.mjs';
import { discoverSolutionTrees } from '../mirage/lib/solution-schema.mjs';
import { developmentScriptDrift } from './project-workflows.mjs';

const MARKER = 'TODO(paqvilo-init):';
const ignored = new Set(['.git', 'node_modules', '.paqvilo', 'paqvilo.config.local.yml', 'coverage']);
const localName = name => process.platform === 'win32' ? name.toLowerCase() : name;
const privateLocalName = value => { const name = localName(value); return ['.paqvilo', 'node_modules', 'paqvilo.config.local.yml'].includes(name) || name.startsWith('.env') && name !== '.env.example'; };
const privateName = value => ignored.has(localName(value)) || privateLocalName(value);
const textFile = name => /\.(?:[cm]?js|json|md|ya?ml|txt|html|css|xml|template)$/.test(name) || localName(name) === '.env.example';
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
      // A Mirage-only site (standalone runtime) needs no environment and no portal export.
      const mirageOnly = mirageOnlySite(site);
      if (!mirageOnly && !Object.keys(site.environments).length) add('selection', `sites.${name}: configure at least one environment`, `sites.${name}.environments`);
      if (site.defaultEnv && !Object.hasOwn(site.environments, site.defaultEnv)) add('selection', `sites.${name}.defaultEnv does not name a configured environment`, `sites.${name}.defaultEnv`);
      if (site.sourceDir) folder(site.sourceDir, `sites.${name}.source`);
      else if (!mirageOnly) add('missing-source', `sites.${name}.source: select a portal export folder`, `sites.${name}.source`, 'warning');
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

/** Read-only adoption guidance. Existing manifests, scripts and ignores are never rewritten. */
export function inspectProjectAdoption(directory, { config = 'paqvilo.config.yml', processEnv = process.env } = {}) {
  const diagnostics = [], target = path.resolve(directory);
  const add = (code, file, action) => diagnostics.push({ code, file, action });
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
  }
  catch { manifest = null; add('PACKAGE_MANIFEST_INVALID', 'package.json', 'Create or repair the project package manifest.'); }
  if (manifest) {
    if (!['dependencies', 'devDependencies'].some(key => typeof manifest[key]?.paqvilo === 'string' && manifest[key].paqvilo.trim()))
      add('PAQVILO_DEPENDENCY_MISSING', 'package.json', 'Add the intended installed Paqvilo release to devDependencies and update the lockfile deliberately.');
    const required = ['check:setup', 'check:scaffold', 'check:project', 'configure', 'validate', 'validate:configured'];
    if (manifest.paqvilo?.vscode || fs.existsSync(path.join(target, '.vscode'))) required.push('editor:refresh');
    for (const name of required) if (!Object.hasOwn(manifest.scripts ?? {}, name) || typeof manifest.scripts[name] !== 'string' || !manifest.scripts[name].trim())
      add('PROJECT_SCRIPT_MISSING', 'package.json', `Add the ${name} script; review the generated project workflow guide for its command.`);
    try {
      const catalogue = loadCatalogue({ config: path.resolve(target, config) }, processEnv);
      for (const change of developmentScriptDrift({ scripts: manifest.scripts, sites: Object.keys(catalogue.sites), config: slash(config.startsWith('.') || path.isAbsolute(config) ? config : './' + config) }))
        diagnostics.push({ code: 'DEVELOPMENT_SCRIPT_DRIFT', file: 'package.json', script: change.name, severity: change.custom ? 'warning' : 'error',
          action: `${change.action === 'remove' ? 'Remove the obsolete shortcut' : 'Review the proposed shortcut'} ${change.name}. ${change.reason}`, ...(change.proposed ? { proposed: change.proposed } : {}), requiresReview: change.requiresReview });
    } catch { /* Completion/path diagnostics explain catalogue failures. */ }
  }
  if (!fs.existsSync(path.resolve(target, config))) add('CATALOGUE_MISSING', slash(config), 'Create a project catalogue or select it with --config.');
  let ignore = '';
  try { ignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf8'); } catch { /* diagnostics below */ }
  // Accept the documented root patterns (including slash-prefixed variants). Complex custom
  // rules require review rather than claiming a private file is safe from a partial match.
  const rules = new Set(ignore.split(/\r?\n/).map(line => line.trim().replace(/^\//, '')));
  // A representative probe cannot certify every private filename: e.g. excluding
  // .paqvilo/* and then unignoring one discovery file still excludes the probe.
  // Require review for private-targeted or wildcard exceptions, even inside Git.
  const privateException = [...rules].some(rule => {
    if (!rule.startsWith('!')) return false;
    const exception = rule.slice(1).replace(/^\//, '');
    if (exception === '.env.example') return false;
    return /(?:^|\/)(?:\.paqvilo|node_modules|\.env[^/]*|paqvilo\.config\.local\.yml)(?:\/|$)/i.test(exception) || /[*?\[]/.test(exception);
  });
  if (privateException) add('PRIVATE_IGNORE_REVIEW', '.gitignore', 'Review private-path or wildcard ignore exceptions; representative probes cannot establish that every private evidence or environment file remains excluded.');
  for (const rule of ['.paqvilo/', 'node_modules/', 'paqvilo.config.local.yml']) if (!rules.has(rule))
    add('PRIVATE_IGNORE_REVIEW', '.gitignore', `Ensure ${rule} is ignored; preserve existing project rules.`);
  if (!rules.has('.env*') && !(rules.has('.env') && rules.has('.env.*'))) add('PRIVATE_IGNORE_REVIEW', '.gitignore', 'Ignore personal .env files while allowing .env.example.');
  // Ask Git about representative, nonexistent paths: no private files are opened or
  // created. This catches overrides later in .gitignore and nested negation rules.
  const probes = ['.paqvilo/readiness-private-probe', 'node_modules/readiness-private-probe', '.env', '.env.local', 'paqvilo.config.local.yml'];
  const git = spawnSync('git', ['--no-optional-locks', '-C', target, 'check-ignore', '--no-index', '-z', '--stdin'], {
    input: probes.join('\0') + '\0', encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
  });
  if (git.status === 0 || git.status === 1) {
    const excluded = new Set(git.stdout.split('\0').filter(Boolean));
    for (const file of probes) if (!excluded.has(file)) add('PRIVATE_IGNORE_REVIEW', '.gitignore', `Ensure ${file.split('/')[0]} is ignored; Git reports that its representative private path is not excluded.`);
    // Ignore rules do not remove files already present in Git's index. Inspect only
    // indexed path names, never their contents, and leave removal to the project owner.
    const index = spawnSync('git', ['--no-optional-locks', '-C', target, 'ls-files', '--cached', '-z', '--', '.'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    });
    if (index.status !== 0) add('PRIVATE_INDEX_REVIEW', '.gitignore', 'Git index path inspection failed; review tracked private paths before declaring adoption complete.');
    else for (const file of new Set(index.stdout.split('\0').filter(Boolean))) {
      if (file.split('/').some(privateLocalName))
        add('PRIVATE_FILE_TRACKED', file, 'This private local path is already tracked. Preserve needed evidence and deliberately remove it from the index; ignore rules alone do not untrack it.');
    }
  } else if ([...rules].some(rule => rule.startsWith('!') && rule !== '!.env.example')) {
    add('PRIVATE_IGNORE_REVIEW', '.gitignore', 'Review custom ignore exceptions after initializing Git; documented patterns alone cannot establish that private paths remain excluded.');
  }
  return { ok: diagnostics.every(item => item.severity === 'warning'), diagnostics };
}

const pathExists = (file, kind) => { try { return fs.statSync(file)[kind](); } catch { return false; } };

/** Cheap layout/path checks share the runtime's dialect and Solution discovery rules. */
export async function inspectProjectPaths(directory, { config, processEnv = process.env } = {}) {
  const diagnostics = [], sites = [], target = path.resolve(directory);
  const configFile = path.resolve(target, config ?? 'paqvilo.config.yml');
  const add = (site, code, file, action) => diagnostics.push({ site, code, file, action });
  let catalogue;
  try { catalogue = loadCatalogue({ config: configFile }, processEnv); }
  catch { return { ok: false, sites, diagnostics: [{ code: 'CATALOGUE_INVALID', file: configFile, action: 'Repair the catalogue using init --check or the local configuration workspace.' }] }; }
  for (const name of Object.keys(catalogue.sites)) {
    try {
      const cfg = await loadConfig({ config: configFile, site: name, env: catalogue.sites[name].defaultEnv ?? Object.keys(catalogue.sites[name].environments)[0] }, processEnv, { checkSource: false });
      const layout = detectSourceDialect(cfg.sourceDir);
      sites.push({ site: name, source: cfg.sourceDir, dialect: layout.dialect, imported: layout.imported });
      if (!layout.imported) add(name, 'PORTAL_LAYOUT_UNSUPPORTED', cfg.sourceDir, 'Select a supported portal export containing pages; an existing empty directory is insufficient.');
      const configured = cfg.mirageConfig;
      let project;
      if (configured.project) {
        if (!pathExists(configured.project, 'isFile')) add(name, 'PROJECT_FILE_MISSING', configured.project, 'Create the configured Mirage project file or correct its path.');
        else {
          try {
            const { resolveProjectConfig } = await import('../mirage/lib/project-config.mjs');
            const source = fs.readFileSync(configured.project, 'utf8');
            project = await resolveProjectConfig(/\.json$/i.test(configured.project) ? JSON.parse(source) : YAML.parse(source), configured.project, { checkSources: false });
          } catch { add(name, 'PROJECT_FILE_INVALID', configured.project, 'Repair the configured Mirage project structure.'); }
        }
      }
      for (const root of project?.solutionRoots ?? configured.solutionRoots) if (!(await discoverSolutionTrees(root)).length)
        add(name, 'SOLUTION_LAYOUT_MISSING', root, 'Select an unpacked Solution root containing Other/Solution.xml, directly or one directory below.');
      for (const portal of project?.portals ?? []) if (!detectSourceDialect(portal.sourceDir).imported)
        diagnostics.push({ site: name, portal: portal.id, code: 'PROJECT_PORTAL_LAYOUT_UNSUPPORTED', file: portal.sourceDir, action: 'Select a supported portal export for this project portal.' });
      for (const pack of [...configured.dataPacks, ...(project?.dataPacks ?? [])]) if (!pathExists(pack.module, 'isFile'))
        add(name, 'PACK_MODULE_MISSING', pack.module, 'Create the registered pack module or correct its registration. No pack code was executed.');
      const profileGroups = [configured.deploymentProfiles, ...(project?.portals.map(portal => portal.deploymentProfiles) ?? [])].filter(Boolean);
      const seen = new Set();
      for (const profiles of profileGroups) for (const [profile, sections] of Object.entries(profiles.profiles)) for (const [section, files] of Object.entries(sections)) for (const file of [].concat(files)) {
        const key = JSON.stringify([profile, section, file]);
        if (!seen.has(key) && !pathExists(file, 'isFile')) diagnostics.push({ site: name, code: 'PROFILE_FILE_MISSING', profile, section, file, action: 'Create the mapped deployment file or correct its mapping, including nonselected profiles.' });
        seen.add(key);
      }
    } catch { add(name, 'SITE_CONFIGURATION_INVALID', configFile, 'Repair this site configuration; init --check supplies completion diagnostics.'); }
  }
  return { ok: sites.length > 0 && diagnostics.length === 0, sites, diagnostics };
}

/** Offline configured-project gate. Adoption/path inspection never imports registered packs.
 * Doctor may create its normal ignored state/cache probes, but launches no browser or portal request.
 * Deliberately project only status/path metadata: neither arbitrary error text nor runtime/profile values.
 */
export async function readyProject(directory, { config, processEnv = process.env } = {}) {
  const target = path.resolve(directory), configFile = path.resolve(target, config ?? 'paqvilo.config.yml');
  let checked;
  try { checked = checkProject(target, { config, processEnv }); }
  catch { checked = { ok: false, todo: [{ kind: 'project-unreadable', file: '.', line: 1 }] }; }
  const completion = { ok: checked.ok, diagnostics: checked.todo.map(item => ({ code: `COMPLETION_${item.kind.toUpperCase().replaceAll('-', '_')}`, file: item.file, line: item.line, severity: item.severity ?? 'error' })) };
  const adoption = inspectProjectAdoption(target, { config, processEnv });
  const paths = await inspectProjectPaths(target, { config, processEnv });
  let doctor;
  try {
    const { collectDoctor } = await import('./commands/doctor.mjs');
    const { report } = await collectDoctor({ config: configFile, all: true, mirage: true }, { processEnv });
    doctor = { ok: report.ready, sites: report.reports.map(item => ({ site: item.site, ready: item.ready && (item.counts?.pages ?? 0) > 0, lenseReady: item.lenseReady ?? false, sourcesReady: (item.sourcesReady ?? false) && (item.counts?.pages ?? 0) > 0,
      mirageReady: item.mirage?.ready ?? false, source: item.source,
      diagnostics: [...(item.errors ?? []).map(error => ({ code: typeof error === 'object' ? error.code : 'LENSE_CHECK_FAILED' })), ...(item.mirage?.errors ?? []).map(() => ({ code: 'MIRAGE_CHECK_FAILED' })), ...(item.counts?.pages === 0 ? [{ code: 'PORTAL_PAGES_MISSING' }] : [])],
      profiles: (item.mirage?.deploymentProfiles?.profiles ?? []).map(profile => ({ id: profile.id, valid: profile.valid, files: profile.files, ...(!profile.valid ? { code: 'PROFILE_INVALID' } : {}) })) })) };
    // Doctor intentionally gates only its default profile. Require every profile in each
    // site's effective runtime mapping; dormant project mappings receive path-only checks.
    for (const site of doctor.sites) site.ready &&= site.profiles.every(profile => profile.valid);
    doctor.ok &&= doctor.sites.every(site => site.ready && site.profiles.every(profile => profile.valid));
  } catch { doctor = { ok: false, sites: [], diagnostics: [{ code: 'DOCTOR_CONFIGURATION_FAILED' }] }; }
  return { schemaVersion: 1, ok: completion.ok && adoption.ok && paths.ok && doctor.ok, offline: true, directory: target,
    checks: ['completion', 'adoption', 'paths', 'lense', 'sources', 'mirage'], completion, adoption, paths, doctor };
}
