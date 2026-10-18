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
import { observedConfig, resolveProjectConfig, projectOrigin } from '../../mirage/lib/project-config.mjs';
import { detectSourceDialect } from '../../mirage/lib/source-dialect.mjs';

const run = promisify(execFile);
const LIMIT = 256 * 1024;
const blocked = new Set(['__proto__', 'prototype', 'constructor']);
export const setupError = (message, status = 400) => Object.assign(new Error(message), { status });
const docs = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
export const setupVersion = docs.version;
const docRoot = docs.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') + '/blob/main/';
export const setupDocs = Object.fromEntries(Object.entries({ setup: 'docs/getting-started.md', configuration: 'docs/configuration.md', sources: 'docs/project-extensions.md', lense: 'docs/lense.md', mirage: 'mirage/README.md', packs: 'mirage/docs/data-packs.md' }).map(([key, value]) => [key, docRoot + value]));

async function textFile(file) {
  await assertScaffoldPath(file);
  try {
    return await readLocalFile(file, { root: path.dirname(file), maxBytes: LIMIT, encoding: 'utf8' });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.message === 'Local file is not regular or exceeds its read limit') throw setupError('Configuration exceeds 256 KiB', 413);
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
  try { status.exists = (await fs.stat(directory)).isDirectory(); } catch { return status; }
  if (!status.exists) return status;
  if (portal) {
    status.exportPath = portalSourceDir(directory); status.layout = detectSourceDialect(directory);
    status.format = status.layout.imported ? detectFormat(status.exportPath) : null;
  }
  try {
    const opts = { cwd: directory, windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
    const location = await runGit('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], opts);
    const [repository, branch] = location.stdout.trim().split(/\r?\n/);
    const commit = await runGit('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--short', 'HEAD'], opts);
    status.git = { branch, commit: commit.stdout.trim(), changed: null };
    // Serialize expensive status calls sharing a checkout and scope each label to its folder.
    const previous = gitQueues.get(repository) ?? Promise.resolve();
    const changes = previous.catch(() => {}).then(() => runGit('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '-uno', '--', '.'], opts));
    gitQueues.set(repository, changes);
    try { status.git.changed = Boolean((await changes).stdout.trim()); status.gitState = 'ready'; }
    catch (error) { status.gitState = error.killed || error.code === 'ETIMEDOUT' ? 'timeout' : 'unavailable'; }
  } catch (error) {
    status.gitState = error.killed || error.code === 'ETIMEDOUT' ? 'timeout'
      : /not a git repository/i.test(error.stderr ?? '') ? 'not-checkout'
      : /ambiguous argument ['"]?HEAD|unknown revision|does not have any commits/i.test(error.stderr ?? '') ? 'uncommitted' : 'unavailable';
  }
  return status;
}
const placeholder = value => { try { return /(?:^|\.)example\.test$/.test(new URL(value).hostname); } catch { return true; } };

/** Fixed configuration destinations. No arbitrary filesystem read/write endpoint. */
export class SetupStore {
  constructor({ directory = process.cwd(), config, project, processEnv = process.env } = {}) {
    this.kind = config || !project ? 'catalogue' : 'project';
    this.file = path.resolve(directory, config ?? project ?? 'paqvilo.config.yml');
    this.directory = path.dirname(this.file);
    this.localFile = this.kind === 'catalogue' ? path.join(this.directory, 'paqvilo.config.local.yml') : null;
    if (this.localFile === this.file) throw setupError('Select the shared catalogue with --config; personal settings are a separate layer.');
    this.processEnv = processEnv;
  }
  async files() {
    const shared = await textFile(this.file);
    const personal = this.localFile ? await textFile(this.localFile) : null;
    // Hash .env for conflicts only. Its content never leaves the store.
    const envFile = path.join(this.directory, '.env');
    const env = this.kind === 'catalogue' ? await textFile(envFile) : null;
    const ignores = await textFile(path.join(this.directory, '.gitignore'));
    const revision = createHash('sha256').update(JSON.stringify([shared, personal, env, ignores])).digest('hex');
    return { shared, personal, revision };
  }
  async validate(shared, personal) {
    const base = document(shared, 'Shared configuration').raw;
    if (this.kind === 'project') return resolveProjectConfig(base, this.file, { checkSources: false });
    // Validate both the shared document and the effective merge. Overrides cannot hide schema errors.
    catalogueRoot(base);
    const root = catalogueRoot(base, document(personal, 'Personal configuration').raw);
    for (const [name, site] of Object.entries(root.sites ?? {})) observedConfig(site.mirage?.observed, `sites.${name}.mirage.observed`);
    observedConfig(root.defaults?.mirage?.observed, 'defaults.mirage.observed');
    return root;
  }
  async snapshot() {
    const gitQueues = new Map();
    const inspectSource = (directory, options = {}) => sourceStatus(directory, { ...options, gitQueues });
    const files = await this.files();
    const result = {
      schemaVersion: 1, kind: this.kind, directory: this.directory, version: docs.version, docs: setupDocs,
      revision: files.revision, ready: false, layers: { shared: { file: this.file, exists: files.shared !== null, text: files.shared ?? '' },
        ...(this.localFile ? { personal: { file: this.localFile, exists: files.personal !== null, text: files.personal ?? '' } } : {}) },
      sites: [], findings: [], settings: {},
    };
    if (files.shared === null) result.findings.push({ code: 'missing-config', message: 'Create a catalogue to connect your exports and environments.' });
    try {
      if (files.shared === null) return result;
      const valid = await this.validate(files.shared, files.personal);
      if (this.kind === 'project') {
        result.settings = { defaultSite: valid.defaultPortal, sourceRoot: this.directory };
        const packs = await Promise.all(valid.dataPacks.map(async pack => ({ id: pack.id, path: pack.module, exists: await fs.stat(pack.module).then(stat => stat.isFile(), () => false) })));
        result.sites = await Promise.all(valid.portals.map(async site => {
          const origin = projectOrigin(valid, site);
          return { id: site.id, source: site.sourcePath, packs,
            sourceStatus: await inspectSource(site.sourceDir, { portal: true }), environments: origin ? { reference: { url: origin } } : {},
            mirage: { solutionRoots: site.solutionRoots, dataPacks: valid.dataPacks }, solutions: await Promise.all(site.solutionRoots.map(folder => inspectSource(folder))) };
        }));
      } else {
        const catalogue = loadCatalogue({ config: this.file }, this.processEnv);
        const { values, origin } = readEnvSettings(this.directory, this.processEnv);
        result.settings = { sourceRoot: catalogue.root.sourceRoot ?? '.', resolvedSourceRoot: catalogue.sourceRoot,
          defaultSite: catalogue.root.defaultSite ?? '', browser: catalogue.root.browser, portals: catalogue.root.portals,
          liveReload: catalogue.root.liveReload, panel: catalogue.root.panel,
          solutionRoots: catalogue.root.defaults?.mirage?.solutionRoots ?? [],
          effective: Object.fromEntries(['PAQVILO_SITE', 'PAQVILO_ENV', 'PAQVILO_BROWSER', 'PAQVILO_REPO', 'PAQVILO_SCOPE', 'PAQVILO_BASELINE'].filter(key => values[key]).map(key => [key, { value: values[key], origin: origin[key] }])),
          provenance: catalogue.provenance };
        result.sites = await Promise.all(Object.entries(catalogue.sites).map(async ([id, site]) => {
          const mirage = resolveMirageConfig(site.mirage, catalogue);
          return { id, source: site.source ?? '', defaultEnv: site.defaultEnv ?? '', environments: site.environments,
            startPath: site.startPath, scope: site.scope, routes: site.routes, mirage: site.mirage ?? {},
            sourceStatus: await inspectSource(site.sourceDir, { portal: true }),
            solutions: await Promise.all(mirage.solutionRoots.map(folder => inspectSource(folder))),
            packs: await Promise.all(mirage.dataPacks.map(async pack => ({ id: pack.id, path: pack.module, exists: await fs.stat(pack.module).then(stat => stat.isFile(), () => false) }))),
          };
        }));
      }
      if (!result.sites.length) result.findings.push({ code: 'no-sites', message: 'Add a portal and select its local export folder.' });
      if (result.settings.defaultSite && !result.sites.some(site => site.id === result.settings.defaultSite)) result.findings.push({ code: 'default-site', message: 'Choose a default portal that exists.' });
      for (const site of result.sites) {
        const add = (code, message) => result.findings.push({ code, site: site.id, message });
        if (!site.sourceStatus.exists) add('missing-source', 'Select an existing local export folder.');
        else if (!site.sourceStatus.format) add('source-layout', 'This folder is not a recognized portal export. Select the export inside the checkout.');
        if (this.kind === 'catalogue' && !Object.keys(site.environments).length) add('no-environments', 'Add an environment for catalogue workflows. Local Mirage targets can use a loopback origin.');
        if (site.defaultEnv && !site.environments[site.defaultEnv]) add('default-env', 'Choose a default environment that exists.');
        for (const [env, setting] of Object.entries(site.environments)) if (placeholder(setting.url)) add('placeholder-origin', `${env}: replace the placeholder before connecting Lense.`);
        for (const solution of site.solutions) if (!solution.exists) add('missing-solution', `Solution folder does not exist: ${solution.path}`);
        for (const pack of site.packs ?? []) if (!pack.exists) add('missing-pack', `Pack module does not exist: ${pack.path}`);
      }
      if (result.settings.portals === 'all') {
        const origins = new Map(), ports = new Map();
        for (const site of result.sites) {
          for (const [env, setting] of Object.entries(site.environments)) {
            const origin = new URL(setting.url).origin, label = `${site.id}@${env}`;
            if (origins.has(origin)) result.findings.push({ code: 'duplicate-origin', site: site.id, message: `${label} shares an origin with ${origins.get(origin)}. Choose distinct origins or selected development targets for Lense.` });
            else origins.set(origin, label);
          }
          const port = site.mirage.port;
          if (Number.isInteger(port) && port > 0) {
            if (ports.has(port)) result.findings.push({ code: 'duplicate-port', site: site.id, message: `Mirage port ${port} is also selected by ${ports.get(port)}. Choose distinct ports or 0 for free ports.` });
            else ports.set(port, site.id);
          }
        }
      }
    } catch (error) { result.findings.push({ code: 'configuration', message: error.message }); }
    result.ready = files.shared !== null && result.findings.length === 0;
    return result;
  }
  async save(input) {
    if (!input || !['shared', 'personal'].includes(input.layer) || (input.layer === 'personal' && !this.localFile)) throw setupError('Choose an available configuration layer.');
    if (typeof input.revision !== 'string') throw setupError('A configuration revision is required.');
    const file = input.layer === 'shared' ? this.file : this.localFile;
    await assertScaffoldPath(file);
    const ignoreFile = path.join(this.directory, '.gitignore');
    await assertScaffoldPath(ignoreFile);
    await fs.mkdir(this.directory, { recursive: true });
    const lockFile = this.file + '.setup.lock';
    await assertScaffoldPath(lockFile);
    let lock;
    try { lock = await fs.open(lockFile, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw setupError('Configuration is being saved. Retry shortly.', 409); throw error; }
    let temporary;
    try {
      const before = await this.files();
      if (before.revision !== input.revision) throw setupError('Configuration changed outside this page. Reload before saving.', 409);
      let text;
      if (typeof input.text === 'string') text = input.text;
      else {
        const { doc } = document(before[input.layer], 'Configuration');
        if (!Array.isArray(input.operations) || input.operations.length > 100) throw setupError('Send at most 100 configuration edits.');
        for (const edit of input.operations) {
          if (!edit || !['set', 'delete'].includes(edit.op) || !Array.isArray(edit.path) || !edit.path.length || edit.path.length > 12 || edit.path.some(key => !(typeof key === 'string' && key && !blocked.has(key) || Number.isInteger(key) && key >= 0))) throw setupError('Invalid configuration field path.');
          if (edit.op === 'delete') doc.deleteIn(edit.path);
          else {
            let value = edit.value;
            if (edit.yaml !== undefined) {
              if (typeof edit.yaml !== 'string' || edit.value !== undefined) throw setupError('A YAML field edit must contain only YAML text.');
              const parsed = YAML.parseDocument(edit.yaml);
              if (parsed.errors.length) throw setupError(parsed.errors[0].message);
              value = parsed.toJS({ maxAliasCount: 50 });
            }
            // Environment shorthand remains usable through guided nested field edits.
            if (this.kind === 'catalogue' && edit.path[0] === 'sites' && edit.path[2] === 'environments' && edit.path.length > 4) {
              const at = edit.path.slice(0, 4), previous = doc.getIn(at);
              if (typeof previous === 'string') doc.setIn(at, doc.createNode({ url: previous }));
            }
            doc.setIn(edit.path, doc.createNode(value));
          }
        }
        const originalText = before[input.layer] ?? '{}\n';
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
            if (YAML.isScalar(next) && next.range && Object.is(node.value, next.value)) replacements.push({ start: next.range[0], end: next.range[1], value: originalText.slice(node.range[0], node.range[1]) });
          }
        };
        preserve(original.contents);
        text = replacements.sort((a, b) => b.start - a.start).reduce((value, edit) => value.slice(0, edit.start) + edit.value + value.slice(edit.end), rendered);
      }
      if (Buffer.byteLength(text) > LIMIT) throw setupError('Configuration exceeds 256 KiB', 413);
      await this.validate(input.layer === 'shared' ? text : before.shared, input.layer === 'personal' ? text : before.personal);
      if (input.layer === 'personal') {
        const tracked = await run('git', ['ls-files', '--error-unmatch', '--', path.basename(file)], { cwd: this.directory, windowsHide: true, timeout: 3000 }).then(() => true, () => false);
        if (tracked) throw setupError('Personal configuration is already tracked by Git. Untrack it before saving private overrides.');
      }
      // JSON projects keep their original encoding.
      if (this.kind === 'project' && /\.json$/i.test(file)) text = JSON.stringify(document(text, 'Project').raw, null, 2) + '\n';
      if ((await this.files()).revision !== before.revision) throw setupError('Configuration changed while saving. Reload before saving.', 409);
      temporary = file + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await assertScaffoldPath(file);
      // Make personal files and future local runtime state safe in a newly configured folder.
      const ignores = (await textFile(ignoreFile)) ?? '';
      const lines = ignores.split(/\r?\n/).map(line => line.trim());
      const rules = ['.paqvilo/', '.env', 'paqvilo.config.local.yml'].filter(rule => !lines.includes(rule) && !lines.includes('/' + rule));
      if (rules.length) await fs.appendFile(ignoreFile, `\n# Paqvilo local settings and state\n${rules.map(rule => '/' + rule).join('\n')}\n`);
      await fs.rename(temporary, file);
    } finally {
      await lock.close();
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
      await fs.rm(lockFile, { force: true });
    }
    return this.snapshot();
  }
}
