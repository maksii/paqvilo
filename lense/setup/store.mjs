import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import YAML from 'yaml';
import { catalogueRoot, loadCatalogue, readEnvSettings, resolveMirageConfig } from '../config.mjs';
import { assertScaffoldPath } from '../scaffold.mjs';
import { readLocalFile } from '../local-file.mjs';
import { detectFormat, portalSourceDir } from '../portal-model.mjs';
import {
  defaultedSetting,
  observedConfig,
  resolveProjectConfig,
  projectOrigin,
} from '../../mirage/lib/project-config.mjs';
import { detectSourceDialect } from '../../mirage/lib/source-dialect.mjs';
import { runtimeSettings } from '../../mirage/lib/runtime-config.mjs';
import { simulationSettings } from '../../mirage/lib/simulation-settings.mjs';
import { projectKeys, runtimeIdentity, runtimeOptions } from '../../mirage/lib/config-keys.mjs';
import { docsLinks } from '../../mirage/lib/docs-links.mjs';
import { renderTemplate } from './templates.mjs';

const run = promisify(execFile);
const LIMIT = 256 * 1024;
const blocked = new Set(['__proto__', 'prototype', 'constructor']);
export const setupError = (message, status = 400) => Object.assign(new Error(message), { status });
const docs = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
export const setupVersion = docs.version;
/** `{ key: { href, path, label } }`, pinned to the installed release tag (mirage/lib/docs-links.mjs). */
export const setupDocs = docsLinks(docs.version, docs.repository.url);
const LINKED = /^project:([a-zA-Z0-9][a-zA-Z0-9_-]*)$/;
const exists = (file, kind = 'isFile') =>
  fs.stat(file).then(
    (stat) => stat[kind](),
    () => false,
  );
const packStatus = (pack) =>
  exists(pack.module).then((found) => ({ id: pack.id, module: pack.module, path: pack.module, exists: found }));
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Structural keys of a project file (mirage/lib/project-config.mjs PROJECT_ONLY_KEYS) plus every registered setting.
const PROJECT_KEYS = new Set([
  'version',
  'defaultPortal',
  'default_portal',
  'portals',
  'solutions',
  'references',
  'referenceEnvironments',
  'presets',
  'lcid',
  'watch',
  'stateDirectory',
  'state_directory',
  ...projectKeys(),
]);
/** A linked file is shown and editable only when it is a Mirage project document: version 1 or 2 with project keys only. */
const projectDocument = (raw) =>
  plain(raw) && [1, 2].includes(raw.version) && Object.keys(raw).every((key) => PROJECT_KEYS.has(key));
/**
 * Settings as the structured status carries them: secrets become { kind } markers and connection settings
 * their key names. The verbatim YAML editor (layers.*.text) is the only place a secret reference appears.
 */
export function redactSettings(mirage) {
  if (!plain(mirage)) return mirage;
  const result = { ...mirage };
  if (plain(mirage.secrets))
    result.secrets = Object.fromEntries(
      Object.entries(mirage.secrets).map(([name, entry]) => [
        name,
        { kind: entry?.source === 'protected' || entry?.protectedValue !== undefined ? 'protected' : 'variable' },
      ]),
    );
  if (plain(mirage.connections))
    result.connections = Object.fromEntries(
      Object.entries(mirage.connections).map(([id, entry]) => [
        id,
        plain(entry) && entry.settings !== undefined
          ? { ...entry, settings: plain(entry.settings) ? Object.keys(entry.settings) : [] }
          : entry,
      ]),
    );
  return result;
}
const redactDefaults = (defaults) =>
  plain(defaults)
    ? { ...defaults, ...(plain(defaults.mirage) ? { mirage: redactSettings(defaults.mirage) } : {}) }
    : defaults;

/** The section of /_setup/ that fixes a finding. */
function sectionOf(finding) {
  // A missing file is created in the project status strip; linked-project documents and the catalogue's mirage.project are
  // edited in the Settings file.
  if (finding.code === 'missing-config') return '#overview';
  if (
    finding.layer ||
    ['configuration', 'project-outside', 'project-invalid', 'missing-project'].includes(finding.code)
  )
    return '#advanced';
  if (finding.code === 'missing-pack') return '#packs';
  if (['no-environments', 'default-env', 'placeholder-origin', 'duplicate-origin'].includes(finding.code))
    return '#environments';
  return '#portals';
}

const STAGES = [
  { id: 1, title: 'Project', anchor: '#overview', codes: ['missing-config', 'configuration'], required: true },
  { id: 2, title: 'What to run', anchor: '#runtime-configuration', codes: [], required: true },
  {
    id: 3,
    title: 'Exported files',
    anchor: '#portals',
    codes: [
      'no-sites',
      'default-site',
      'missing-source',
      'source-layout',
      'missing-solution',
      'missing-project',
      'project-outside',
      'project-invalid',
    ],
    required: true,
  },
  // Shown in this order (the rail numbers them by position); ids are stable keys of settings-catalogue.mjs stages.
  {
    id: 5,
    title: 'Sample data',
    anchor: '#packs',
    codes: ['missing-pack'],
    configured: (mirages, snapshot) => packsOf(snapshot).length > 0,
  },
  {
    id: 4,
    title: 'Live environments',
    anchor: '#environments',
    codes: ['no-environments', 'default-env', 'placeholder-origin', 'duplicate-origin'],
  },
  {
    id: 6,
    title: 'Test people & sign-in',
    anchor: '#personas',
    codes: [],
    configured: (mirages) => mirages.some((item) => item.personaContexts || item.identityProvider),
  },
  {
    id: 8,
    title: 'Outside services',
    anchor: '#providers',
    codes: [],
    configured: (mirages) =>
      mirages.some((item) =>
        ['providers', 'connections', 'secrets', 'localServices', 'environmentVariables', 'connectorScripts'].some(
          (key) => item[key] && Object.keys(item[key]).length,
        ),
      ),
  },
  {
    id: 9,
    title: 'Web API access',
    anchor: '#identity',
    codes: [],
    configured: (mirages) => mirages.some((item) => item.dataverse?.enabled === true),
  },
  { id: 10, title: 'Start & check', anchor: '#guidance', codes: ['duplicate-port'], required: true },
];
const packsOf = (snapshot) => snapshot.packs ?? (snapshot.sites ?? []).flatMap((site) => site.packs ?? []);

/** Journey stages (docs/setup.md): done, next (the first open stage), blocked (open behind it) or optional. */
export function setupStages(snapshot, runtime = null) {
  const mirages =
    snapshot.kind === 'project'
      ? [
          {
            ...(snapshot.settings?.mirage ?? {}),
            simulation: snapshot.settings?.simulation,
            dataverse: snapshot.settings?.dataverse,
          },
        ]
      : (snapshot.sites ?? []).map((site) => site.effectiveMirage ?? site.mirage ?? {});
  const portal =
    snapshot.kind === 'catalogue' &&
    (snapshot.sites ?? []).some((site) => (site.runtime?.kind ?? 'power-pages') === 'power-pages');
  const created = snapshot.layers?.shared?.exists === true;
  let open = false;
  const pending = () => {
    const status = open ? 'blocked' : 'next';
    open = true;
    return status;
  };
  return STAGES.map((stage) => {
    const findings = [
      ...new Set((snapshot.findings ?? []).filter((item) => stage.codes.includes(item.code)).map((item) => item.code)),
    ];
    let status;
    // An example live address matters to Lense only; the local preview runs without it.
    if (findings.length && stage.id === 4 && findings.every((code) => code === 'placeholder-origin'))
      status = 'optional';
    else if (findings.length) status = pending();
    else if (stage.id === 10)
      status = !snapshot.ready ? 'blocked' : runtime?.restartRequired === false ? 'done' : pending();
    else if (stage.required || (stage.id === 4 && portal)) status = created ? 'done' : pending();
    else status = created && stage.configured?.(mirages, snapshot) ? 'done' : 'optional';
    return { id: stage.id, title: stage.title, status, findings, anchor: stage.anchor };
  });
}

async function textFile(file, root = path.dirname(file)) {
  await assertScaffoldPath(file);
  try {
    return await readLocalFile(file, { root, maxBytes: LIMIT, encoding: 'utf8' });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.message === 'Local file is not regular or exceeds its read limit')
      throw setupError('Configuration exceeds 256 KiB', 413);
    throw error;
  }
}
function document(text, label) {
  const doc = YAML.parseDocument(text ?? '{}\n', { uniqueKeys: true });
  if (doc.errors.length) throw setupError(`${label}: ${doc.errors[0].message}`);
  const raw = doc.toJS({ maxAliasCount: 50 });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw setupError(`${label} must be a mapping`);
  return { doc, raw };
}
export async function sourceStatus(directory, { portal = false, runGit = run, gitQueues = new Map() } = {}) {
  const status = { path: directory, exists: false, format: null, git: null };
  if (!directory) return status;
  try {
    status.exists = (await fs.stat(directory)).isDirectory();
  } catch {
    return status;
  }
  if (!status.exists) return status;
  if (portal) {
    status.exportPath = portalSourceDir(directory);
    status.layout = detectSourceDialect(directory);
    status.format = status.layout.imported ? detectFormat(status.exportPath) : null;
  }
  try {
    const opts = {
      cwd: directory,
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    };
    const location = await runGit(
      'git',
      ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'],
      opts,
    );
    const [repository, branch] = location.stdout.trim().split(/\r?\n/);
    const commit = await runGit('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--short', 'HEAD'], opts);
    status.git = { branch, commit: commit.stdout.trim(), changed: null };
    // Serialize expensive status calls sharing a checkout and scope each label to its folder.
    const previous = gitQueues.get(repository) ?? Promise.resolve();
    const changes = previous
      .catch(() => {})
      .then(() => runGit('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '-uno', '--', '.'], opts));
    gitQueues.set(repository, changes);
    try {
      status.git.changed = Boolean((await changes).stdout.trim());
      status.gitState = 'ready';
    } catch (error) {
      status.gitState = error.killed || error.code === 'ETIMEDOUT' ? 'timeout' : 'unavailable';
    }
  } catch (error) {
    status.gitState =
      error.killed || error.code === 'ETIMEDOUT'
        ? 'timeout'
        : /not a git repository/i.test(error.stderr ?? '')
          ? 'not-checkout'
          : /ambiguous argument ['"]?HEAD|unknown revision|does not have any commits/i.test(error.stderr ?? '')
            ? 'uncommitted'
            : 'unavailable';
  }
  return status;
}
const placeholder = (value) => {
  try {
    return /(?:^|\.)example\.test$/.test(new URL(value).hostname);
  } catch {
    return true;
  }
};

/** Fixed configuration destinations. No arbitrary filesystem read/write endpoint. */
export class SetupStore {
  constructor({ directory = process.cwd(), config, project, processEnv = process.env } = {}) {
    this.kind = config || !project ? 'catalogue' : 'project';
    this.file = path.resolve(directory, config ?? project ?? 'paqvilo.config.yml');
    this.directory = path.dirname(this.file);
    this.localFile = this.kind === 'catalogue' ? path.join(this.directory, 'paqvilo.config.local.yml') : null;
    if (this.localFile === this.file)
      throw setupError('Select the shared catalogue with --config; personal settings are a separate layer.');
    this.processEnv = processEnv;
  }
  async files() {
    const shared = await textFile(this.file);
    const personal = this.localFile ? await textFile(this.localFile) : null;
    // Hash .env for conflicts only. Its content never leaves the store.
    const envFile = path.join(this.directory, '.env');
    const env = this.kind === 'catalogue' ? await textFile(envFile) : null;
    const ignores = await textFile(path.join(this.directory, '.gitignore'));
    // Linked project files (sites.<id>.mirage.project) are layers of the same session and revision.
    // Only files inside the catalogue folder, outside .paqvilo/, that are project documents become layers;
    // any other linked file is refused with a finding and its text never leaves the store.
    const projects = {},
      refused = {};
    for (const [site, file] of Object.entries(this.linkedProjects(shared, personal))) {
      const relative = path.relative(this.directory, file);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith('..' + path.sep) ||
        path.isAbsolute(relative) ||
        relative.split(/[\\/]/).some((part) => part.toLowerCase() === '.paqvilo')
      ) {
        refused[site] = { file, code: 'project-outside' };
        continue;
      }
      let text;
      try {
        text = await textFile(file, this.directory);
      } catch (error) {
        refused[site] = {
          file,
          code: /outside|symbolic/i.test(error.message) ? 'project-outside' : 'project-invalid',
          reason: error.message,
        };
        continue;
      }
      let raw = null;
      if (text !== null)
        try {
          raw = document(text, 'Project configuration').raw;
        } catch {
          raw = null;
        }
      if (text !== null && !projectDocument(raw)) {
        refused[site] = { file, code: 'project-invalid' };
        continue;
      }
      projects[site] = { file, text, raw };
    }
    const linked = Object.keys(projects)
      .sort()
      .map((site) => [site, projects[site].file, projects[site].text]);
    const refusals = Object.keys(refused)
      .sort()
      .map((site) => [site, refused[site].file, refused[site].code]);
    const revision = createHash('sha256')
      .update(JSON.stringify([shared, personal, env, ignores, ...linked, ...refusals]))
      .digest('hex');
    return { shared, personal, projects, refused, revision };
  }
  /** Resolved `mirage.project` file of each catalogue site (a site value wins over defaults; null clears). */
  linkedProjects(shared, personal) {
    if (this.kind !== 'catalogue' || shared === null) return {};
    let root;
    try {
      root = catalogueRoot(
        document(shared, 'Shared configuration').raw,
        document(personal, 'Personal configuration').raw,
      );
    } catch {
      return {};
    }
    const result = {};
    for (const [site, value] of Object.entries(root.sites ?? {})) {
      const project =
        value?.mirage && Object.hasOwn(value.mirage, 'project') ? value.mirage.project : root.defaults?.mirage?.project;
      // Only YAML or JSON project files become editable layers.
      if (typeof project === 'string' && /\.(?:ya?ml|json)$/i.test(project.trim()))
        result[site] = path.resolve(this.directory, project.trim());
    }
    return result;
  }
  /**
   * Digest of what a running preview loaded from this configuration: the registered identity settings
   * (runtimeIdentity, as lense/commands/mirage.mjs compares them) plus sources, Solutions, packs, port and
   * startup preset. Edits elsewhere (.gitignore, comments, other sites) leave it unchanged. A Lense runtime also
   * loaded the site's environments, start page, scope and routes and the catalogue browser.
   */
  async runtimeIdentity(siteId = null, product = 'Mirage') {
    const files = await this.files();
    if (files.shared === null) return null;
    let value;
    if (this.kind === 'project') {
      const project = await this.validate(files.shared, null);
      const portal = project.portals.find((item) => item.id === project.defaultPortal) ?? null;
      value = {
        settings: runtimeIdentity(runtimeOptions({ project, portal })),
        sourceDir: portal?.sourceDir ?? null,
        solutionRoots: portal?.solutionRoots ?? project.solutionRoots,
        solutionOrder: project.solutionOrder,
        dataPacks: project.dataPacks,
        environmentVariables: project.environmentVariables,
      };
    } else {
      const catalogue = loadCatalogue({ config: this.file }, this.processEnv);
      const id =
        siteId && catalogue.sites[siteId]
          ? siteId
          : catalogue.root.defaultSite && catalogue.sites[catalogue.root.defaultSite]
            ? catalogue.root.defaultSite
            : Object.keys(catalogue.sites)[0];
      const site = catalogue.sites[id];
      if (!site) return null;
      const mirage = resolveMirageConfig(site.mirage, catalogue);
      const linked = files.projects[id]?.text
        ? await resolveProjectConfig(
            document(files.projects[id].text, 'Project configuration').raw,
            files.projects[id].file,
            { checkSources: false },
          )
        : null;
      const portal = linked?.portals.find((item) => item.id === linked.defaultPortal) ?? null;
      const { port, preset, presetMode, presetConfiguration, solutionRoots, solutionOrder, dataPacks, project } =
        mirage;
      value = {
        site: id,
        settings: runtimeIdentity(runtimeOptions({ project: linked, portal, catalogue: mirage })),
        sourceDir: site.sourceDir,
        solutionRoots,
        solutionOrder,
        dataPacks,
        port,
        preset,
        presetMode,
        presetConfiguration,
        project,
        linked: linked && {
          solutionRoots: linked.solutionRoots,
          dataPacks: linked.dataPacks,
          environmentVariables: linked.environmentVariables,
        },
        ...(product === 'Lense'
          ? {
              lense: {
                environments: site.environments,
                startPath: site.startPath,
                scope: site.scope,
                routes: site.routes,
                browser: catalogue.root.browser,
              },
            }
          : {}),
      };
    }
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  async validate(shared, personal) {
    const base = document(shared, 'Shared configuration').raw;
    if (this.kind === 'project') return resolveProjectConfig(base, this.file, { checkSources: false });
    // Validate both the shared document and the effective merge. Overrides cannot hide schema errors.
    catalogueRoot(base);
    const root = catalogueRoot(base, document(personal, 'Personal configuration').raw);
    for (const [name, site] of Object.entries(root.sites ?? {}))
      observedConfig(site.mirage?.observed, `sites.${name}.mirage.observed`);
    observedConfig(root.defaults?.mirage?.observed, 'defaults.mirage.observed');
    return root;
  }
  async snapshot() {
    const gitQueues = new Map();
    const inspectSource = (directory, options = {}) => sourceStatus(directory, { ...options, gitQueues });
    const files = await this.files();
    const result = {
      schemaVersion: 1,
      kind: this.kind,
      directory: this.directory,
      version: docs.version,
      docs: setupDocs,
      revision: files.revision,
      ready: false,
      layers: {
        shared: { file: this.file, exists: files.shared !== null, text: files.shared ?? '' },
        ...(this.localFile
          ? { personal: { file: this.localFile, exists: files.personal !== null, text: files.personal ?? '' } }
          : {}),
        // values: the parsed linked document with secrets reduced to references, for the setting editor.
        ...Object.fromEntries(
          Object.entries(files.projects).map(([site, item]) => [
            `project:${site}`,
            {
              file: item.file,
              exists: item.text !== null,
              text: item.text ?? '',
              site,
              values: redactSettings(item.raw ?? {}),
            },
          ]),
        ),
      },
      sites: [],
      findings: [],
      settings: {},
    };
    if (files.shared === null)
      result.findings.push({
        code: 'missing-config',
        section: '#overview',
        message:
          this.kind === 'project'
            ? 'Create the project file above: choose what to run, then Create project file.'
            : 'Create the settings file above: choose what to run, then Create settings file.',
      });
    try {
      if (files.shared === null) return result;
      const valid = await this.validate(files.shared, files.personal);
      if (this.kind === 'project') {
        const authored = document(files.shared, 'Project configuration').raw;
        result.layers.shared.values = redactSettings(authored);
        result.settings = {
          defaultSite: valid.defaultPortal,
          sourceRoot: this.directory,
          runtime: valid.runtime,
          simulation: defaultedSetting(valid, 'simulation'),
          modelDriven: defaultedSetting(valid, 'modelDriven'),
          dataverse: defaultedSetting(valid, 'dataverse'),
          solutions: valid.solutions.map((item) => ({ id: item.id, path: item.sourcePath })),
          solutionEntries: authored.solutions ?? [],
          dataPackEntries: authored.dataPacks ?? authored.presets ?? [],
          dataPacks: valid.dataPacks,
          solutionRoots: valid.solutionRoots,
          // Resolved setting rows the file sets (connections, providers, secrets by reference, …) for the planned topology.
          mirage: redactSettings(
            Object.fromEntries(
              projectKeys()
                .filter((key) => valid[key] !== undefined)
                .map((key) => [key, valid[key]]),
            ),
          ),
          // Authored project-only keys, as the file writes them.
          lcid: authored.lcid,
          watch: authored.watch,
          stateDirectory: authored.stateDirectory ?? authored.state_directory,
          references: authored.references ?? authored.referenceEnvironments,
          presets: authored.presets,
          portals: authored.portals,
        };
        result.solutions = await Promise.all(valid.solutionRoots.map((folder) => inspectSource(folder)));
        const packs = (result.packs = await Promise.all(valid.dataPacks.map(packStatus)));
        result.sites = await Promise.all(
          valid.portals.map(async (site) => {
            const origin = projectOrigin(valid, site);
            return {
              id: site.id,
              source: site.sourcePath,
              packs,
              sourceStatus: await inspectSource(site.sourceDir, { portal: true }),
              environments: origin ? { reference: { url: origin } } : {},
              runtime: valid.runtime,
              mirage: {
                runtime: valid.runtime,
                simulation: defaultedSetting(valid, 'simulation'),
                modelDriven: defaultedSetting(valid, 'modelDriven'),
                dataverse: defaultedSetting(valid, 'dataverse'),
                solutionRoots: site.solutionRoots,
                dataPacks: valid.dataPacks,
              },
              solutions: await Promise.all(site.solutionRoots.map((folder) => inspectSource(folder))),
            };
          }),
        );
      } else {
        const catalogue = loadCatalogue({ config: this.file }, this.processEnv);
        const { values, origin } = readEnvSettings(this.directory, this.processEnv);
        result.settings = {
          sourceRoot: catalogue.root.sourceRoot ?? '.',
          resolvedSourceRoot: catalogue.sourceRoot,
          defaultSite: catalogue.root.defaultSite ?? '',
          browser: catalogue.root.browser,
          portals: catalogue.root.portals,
          liveReload: catalogue.root.liveReload,
          panel: catalogue.root.panel,
          // Root keys the guided Settings form shows; defaults carries references only.
          includeCaution: catalogue.root.includeCaution,
          agent: catalogue.root.agent ?? {},
          editor: catalogue.root.editor,
          sourceMaps: catalogue.root.sourceMaps,
          defaults: redactDefaults(catalogue.root.defaults ?? {}),
          solutionRoots: catalogue.root.defaults?.mirage?.solutionRoots ?? [],
          runtime: runtimeSettings(catalogue.root.defaults?.mirage?.runtime),
          simulation: simulationSettings(catalogue.root.defaults?.mirage?.simulation),
          dataverse: catalogue.root.defaults?.mirage?.dataverse ?? {},
          modelDriven: catalogue.root.defaults?.mirage?.modelDriven ?? {},
          effective: Object.fromEntries(
            ['PAQVILO_SITE', 'PAQVILO_ENV', 'PAQVILO_BROWSER', 'PAQVILO_REPO', 'PAQVILO_SCOPE', 'PAQVILO_BASELINE']
              .filter((key) => values[key])
              .map((key) => [key, { value: values[key], origin: origin[key] }]),
          ),
          provenance: catalogue.provenance,
        };
        result.sites = await Promise.all(
          Object.entries(catalogue.sites).map(async ([id, site]) => {
            const mirage = resolveMirageConfig(site.mirage, catalogue);
            // `mirage` stays the site mapping merged over defaults.mirage (the current form values); `authoredMirage`
            // is the site's own mapping and `inherited` marks keys that only defaults.mirage sets (form placeholders).
            const authored = catalogue.root.sites?.[id]?.mirage ?? {};
            const inherited = Object.fromEntries(
              Object.keys(catalogue.root.defaults?.mirage ?? {})
                .filter((key) => !Object.hasOwn(authored, key))
                .map((key) => [key, true]),
            );
            const own = catalogue.root.sites?.[id] ?? {};
            return {
              id,
              source: site.source ?? '',
              defaultEnv: site.defaultEnv ?? '',
              environments: site.environments,
              startPath: site.startPath,
              scope: site.scope,
              routes: site.routes,
              webFiles: own.webFiles,
              inline: own.inline,
              markup: own.markup,
              mirage: redactSettings(site.mirage ?? {}),
              authoredMirage: redactSettings(authored),
              inherited,
              runtime: mirage.runtime ?? runtimeSettings(),
              effectiveMirage: redactSettings(mirage),
              sourceStatus: await inspectSource(site.sourceDir, { portal: true }),
              solutions: await Promise.all(mirage.solutionRoots.map((folder) => inspectSource(folder))),
              packs: await Promise.all(mirage.dataPacks.map(packStatus)),
            };
          }),
        );
      }
      const standalone = this.kind === 'project' && result.settings.runtime?.kind !== 'power-pages';
      if (!result.sites.length && !standalone)
        result.findings.push({ code: 'no-sites', message: 'Add a target and select its local sources.' });
      if (result.settings.defaultSite && !result.sites.some((site) => site.id === result.settings.defaultSite))
        result.findings.push({ code: 'default-site', message: 'Choose a default portal that exists.' });
      for (const site of result.sites) {
        const add = (code, message) => result.findings.push({ code, site: site.id, message });
        const portal = (site.runtime?.kind ?? 'power-pages') === 'power-pages';
        if (portal && !site.sourceStatus.exists) add('missing-source', 'Select an existing local export folder.');
        else if (portal && !site.sourceStatus.format)
          add('source-layout', 'This folder is not a recognized portal export. Select the export inside the checkout.');
        if (portal && this.kind === 'catalogue' && !Object.keys(site.environments).length)
          add(
            'no-environments',
            'Add an environment for catalogue workflows. Local Mirage targets can use a loopback origin.',
          );
        if (portal && site.defaultEnv && !site.environments[site.defaultEnv])
          add('default-env', 'Choose a default environment that exists.');
        if (portal)
          for (const [env, setting] of Object.entries(site.environments))
            if (placeholder(setting.url))
              add(
                'placeholder-origin',
                `Live environment ${env} still has an example address. Only Lense uses it; the local preview runs without it.`,
              );
        for (const solution of site.solutions)
          if (!solution.exists) add('missing-solution', `Solution folder does not exist: ${solution.path}`);
        for (const pack of site.packs ?? [])
          if (!pack.exists) add('missing-pack', `Pack module does not exist: ${pack.path}`);
      }
      if (standalone) {
        for (const solution of result.solutions)
          if (!solution.exists)
            result.findings.push({
              code: 'missing-solution',
              message: `Solution folder does not exist: ${solution.path}`,
            });
        for (const pack of result.packs)
          if (!pack.exists)
            result.findings.push({ code: 'missing-pack', message: `Pack module does not exist: ${pack.path}` });
      }
      for (const [site, linked] of Object.entries(files.projects)) {
        const add = (code, message) => result.findings.push({ code, site, layer: `project:${site}`, message });
        if (linked.text === null) {
          add('missing-project', `Project file does not exist: ${linked.file}`);
          continue;
        }
        try {
          const project = await resolveProjectConfig(document(linked.text, 'Project configuration').raw, linked.file, {
            checkSources: false,
          });
          for (const solution of project.solutions)
            if (!(await exists(solution.root, 'isDirectory')))
              add('missing-solution', `Solution folder does not exist: ${solution.root}`);
          for (const pack of project.dataPacks)
            if (!(await exists(pack.module))) add('missing-pack', `Pack module does not exist: ${pack.module}`);
        } catch (error) {
          add('configuration', `${path.basename(linked.file)}: ${error.message}`);
        }
      }
      for (const [site, item] of Object.entries(files.refused))
        result.findings.push({
          code: item.code,
          site,
          message:
            item.code === 'project-outside'
              ? `Linked project file ${item.file} must be inside the catalogue folder and outside .paqvilo/. Setup neither shows nor edits it; change sites.${site}.mirage.project.`
              : `${path.basename(item.file)} is not a Mirage project document (version 1 or 2 with project keys only)${item.reason ? ` (${item.reason})` : ''}. Setup neither shows nor edits it; change sites.${site}.mirage.project or repair the file outside setup.`,
        });
      if (result.settings.portals === 'all') {
        const origins = new Map(),
          ports = new Map();
        for (const site of result.sites) {
          for (const [env, setting] of Object.entries(site.environments)) {
            const origin = new URL(setting.url).origin,
              label = `${site.id}@${env}`;
            if (origins.has(origin))
              result.findings.push({
                code: 'duplicate-origin',
                site: site.id,
                message: `${label} shares an origin with ${origins.get(origin)}. Choose distinct origins or selected development targets for Lense.`,
              });
            else origins.set(origin, label);
          }
          const port = site.mirage.port;
          if (Number.isInteger(port) && port > 0) {
            if (ports.has(port))
              result.findings.push({
                code: 'duplicate-port',
                site: site.id,
                message: `Mirage port ${port} is also selected by ${ports.get(port)}. Choose distinct ports or 0 for free ports.`,
              });
            else ports.set(port, site.id);
          }
        }
      }
    } catch (error) {
      result.findings.push({ code: 'configuration', message: error.message });
    }
    for (const finding of result.findings) finding.section = sectionOf(finding, this.kind);
    result.ready = files.shared !== null && result.findings.length === 0;
    return result;
  }
  async save(input) {
    const linkedSite = typeof input?.layer === 'string' ? LINKED.exec(input.layer)?.[1] : undefined;
    if (
      !input ||
      !(['shared', 'personal'].includes(input.layer) || linkedSite) ||
      (input.layer === 'personal' && !this.localFile)
    )
      throw setupError('Choose an available configuration layer.');
    if (typeof input.revision !== 'string') throw setupError('A configuration revision is required.');
    if (input.template !== undefined && (input.layer !== 'shared' || typeof input.template !== 'string'))
      throw setupError('A template creates the shared configuration.');
    const file = linkedSite
      ? (await this.files()).projects[linkedSite]?.file
      : input.layer === 'shared'
        ? this.file
        : this.localFile;
    if (!file) throw setupError('Choose an available configuration layer.');
    const layerText = (files) => (linkedSite ? (files.projects[linkedSite]?.text ?? null) : files[input.layer]);
    const projectFile = linkedSite || this.kind === 'project';
    await assertScaffoldPath(file);
    const ignoreFile = path.join(this.directory, '.gitignore');
    await assertScaffoldPath(ignoreFile);
    await fs.mkdir(this.directory, { recursive: true });
    if (linkedSite) await fs.mkdir(path.dirname(file), { recursive: true });
    const lockFile = this.file + '.setup.lock';
    await assertScaffoldPath(lockFile);
    let lock;
    try {
      lock = await fs.open(lockFile, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') throw setupError('Configuration is being saved. Retry shortly.', 409);
      throw error;
    }
    let temporary;
    try {
      const before = await this.files();
      if (before.revision !== input.revision)
        throw setupError('Configuration changed outside this page. Reload before saving.', 409);
      if (linkedSite && before.projects[linkedSite]?.file !== file)
        throw setupError('Configuration changed outside this page. Reload before saving.', 409);
      let text;
      if (input.template !== undefined) {
        if (before.shared !== null)
          throw setupError('A template creates a new configuration; edit the existing file instead.', 409);
        const created = renderTemplate(this.kind, input.template, input.values);
        text = /\.json$/i.test(file) ? JSON.stringify(created, null, 2) + '\n' : YAML.stringify(created);
      } else if (typeof input.text === 'string') text = input.text;
      else {
        // A new layer starts as an empty block mapping, so guided edits write block-style YAML.
        const { doc } =
          layerText(before) === null ? { doc: new YAML.Document({}) } : document(layerText(before), 'Configuration');
        if (!Array.isArray(input.operations) || input.operations.length > 100)
          throw setupError('Send at most 100 configuration edits.');
        for (const edit of input.operations) {
          if (
            !edit ||
            !['set', 'delete'].includes(edit.op) ||
            !Array.isArray(edit.path) ||
            !edit.path.length ||
            edit.path.length > 12 ||
            edit.path.some(
              (key) => !((typeof key === 'string' && key && !blocked.has(key)) || (Number.isInteger(key) && key >= 0)),
            )
          )
            throw setupError('Invalid configuration field path.');
          if (edit.op === 'delete') doc.deleteIn(edit.path);
          else {
            let value = edit.value;
            if (edit.yaml !== undefined) {
              if (typeof edit.yaml !== 'string' || edit.value !== undefined)
                throw setupError('A YAML field edit must contain only YAML text.');
              const parsed = YAML.parseDocument(edit.yaml);
              if (parsed.errors.length) throw setupError(parsed.errors[0].message);
              value = parsed.toJS({ maxAliasCount: 50 });
            }
            // Environment shorthand remains usable through guided nested field edits.
            if (
              this.kind === 'catalogue' &&
              !linkedSite &&
              edit.path[0] === 'sites' &&
              edit.path[2] === 'environments' &&
              edit.path.length > 4
            ) {
              const at = edit.path.slice(0, 4),
                previous = doc.getIn(at);
              if (typeof previous === 'string') doc.setIn(at, doc.createNode({ url: previous }));
            }
            doc.setIn(edit.path, doc.createNode(value));
          }
        }
        const originalText = layerText(before) ?? '{}\n';
        const original = document(originalText, 'Configuration').doc;
        // YAML serialization may reflow untouched plain strings. Restore their
        // original scalar tokens, including authored wrapping and quoting.
        const rendered = doc.toString({ lineWidth: 0 });
        const serialized = document(rendered, 'Configuration').doc;
        const replacements = [];
        const preserve = (node, at = []) => {
          if (YAML.isMap(node)) for (const pair of node.items) preserve(pair.value, [...at, pair.key.value]);
          else if (YAML.isSeq(node)) node.items.forEach((item, index) => preserve(item, [...at, index]));
          else if (YAML.isScalar(node) && node.range) {
            const next = serialized.getIn(at, true);
            if (YAML.isScalar(next) && next.range && Object.is(node.value, next.value))
              replacements.push({
                start: next.range[0],
                end: next.range[1],
                value: originalText.slice(node.range[0], node.range[1]),
              });
          }
        };
        preserve(original.contents);
        text = replacements
          .sort((a, b) => b.start - a.start)
          .reduce((value, edit) => value.slice(0, edit.start) + edit.value + value.slice(edit.end), rendered);
      }
      if (Buffer.byteLength(text) > LIMIT) throw setupError('Configuration exceeds 256 KiB', 413);
      if (linkedSite) {
        const raw = document(text, 'Project configuration').raw;
        await resolveProjectConfig(raw, file, { checkSources: false });
        if (!projectDocument(raw))
          throw setupError('A linked project file holds version 1 or 2 and project keys only.');
      } else
        await this.validate(
          input.layer === 'shared' ? text : before.shared,
          input.layer === 'personal' ? text : before.personal,
        );
      if (input.layer === 'personal') {
        const tracked = await run('git', ['ls-files', '--error-unmatch', '--', path.basename(file)], {
          cwd: this.directory,
          windowsHide: true,
          timeout: 3000,
        }).then(
          () => true,
          () => false,
        );
        if (tracked)
          throw setupError(
            'Personal configuration is already tracked by Git. Untrack it before saving private overrides.',
          );
      }
      // JSON projects keep their original encoding.
      if (projectFile && /\.json$/i.test(file)) text = JSON.stringify(document(text, 'Project').raw, null, 2) + '\n';
      if ((await this.files()).revision !== before.revision)
        throw setupError('Configuration changed while saving. Reload before saving.', 409);
      temporary = file + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await assertScaffoldPath(file);
      // Make personal files and future local runtime state safe in a newly configured folder.
      const ignores = (await textFile(ignoreFile)) ?? '';
      const lines = ignores.split(/\r?\n/).map((line) => line.trim());
      const rules = ['.paqvilo/', '.env', 'paqvilo.config.local.yml'].filter(
        (rule) => !lines.includes(rule) && !lines.includes('/' + rule),
      );
      if (rules.length)
        await fs.appendFile(
          ignoreFile,
          `\n# Paqvilo local settings and state\n${rules.map((rule) => '/' + rule).join('\n')}\n`,
        );
      await fs.rename(temporary, file);
    } finally {
      await lock.close();
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
      await fs.rm(lockFile, { force: true });
    }
    return this.snapshot();
  }
}
