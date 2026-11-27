// @test-kind contract: a command that reads a catalogue validates every Mirage setting through the settings contracts alone (mirage/lib/settings-contracts.mjs); those contracts resolve each setting exactly as the provider runtimes do, and loading them loads no provider runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { MIRAGE_SETTINGS } from '../mirage/lib/config-keys.mjs';
import { settingsCatalogue } from '../lense/setup/settings-catalogue.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESOLVER = fileURLToPath(new URL('./fixtures/settings-contracts-resolver.mjs', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'paqvilo.mjs');
const KEYS = Object.keys(MIRAGE_SETTINGS);
const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The catalogue files of the repository: the toolkit's own, the example project's and the project template's.
const CATALOGUE_FILES = [
  'paqvilo.config.yml',
  'examples/project/paqvilo.config.yml',
  'templates/project/configuration.example.yml',
];
// Folders whose Markdown carries settings samples in fenced YAML blocks.
const DOCUMENT_FOLDERS = ['docs', 'mirage/docs', 'templates/project', 'examples/project'];
const DOCUMENT_FILES = ['README.md', 'mirage/README.md'];

// The provider runtimes and the engines behind them: none belongs to reading settings.
const RUNTIME_MODULES = [
  'mirage/server',
  'mirage/lib/provider-modules',
  'mirage/lib/project-config',
  'mirage/lib/connector-runtime',
  'mirage/lib/storage-provider',
  'mirage/lib/message-bus',
  'mirage/lib/outbox',
  'mirage/lib/local-services',
  'mirage/lib/secret-resolver',
  'mirage/lib/code-apps-config',
  'mirage/lib/canvas-source',
  'mirage/lib/canvas-power-fx',
  'mirage/lib/service-fixtures',
  'mirage/lib/flow-actions',
  'mirage/lib/flow-triggers',
  'mirage/lib/flow-runtime',
  'mirage/lib/dataverse-calculated',
  'mirage/lib/dataverse-business-rules',
  'mirage/lib/dataverse-rollup',
  'mirage/lib/dataverse-formula',
  'mirage/lib/dataverse-virtual-providers',
  'mirage/lib/dataverse-hierarchy',
  'mirage/lib/dataverse-state-transitions',
  'mirage/lib/dataverse-security',
  'mirage/lib/dataverse-webhooks',
  'mirage/lib/dataverse-odata',
  'mirage/lib/dataverse-api',
  'mirage/lib/data',
  'mirage/lib/importer',
  'mirage/lib/solution-inventory',
  'mirage/lib/fetchxml-engine',
  'mirage/lib/platform-settings',
  'mirage/lib/organization-host',
];
// The toolkit modules (lense/ and mirage/ source files) a process may load to import lense/config.mjs and resolve
// catalogue settings. It counts module files, not time: 37 on the day of writing (the configuration reader, the settings
// table and one validation module per setting), against 217 while the same import registered the parsers by loading the
// provider runtimes. The headroom allows new settings modules; a runtime graph is several times larger.
const CONFIG_MODULE_BOUND = 60;

// The Markdown files under `folder` (relative to `root`). Installed packages (node_modules, whose paqvilo entry links
// back to this checkout), dot folders (.paqvilo, .git, .vscode: local state other tests create and remove) and links
// are not documentation, so the walk never enters them.
async function markdownUnder(root, folder, files = []) {
  for (const entry of await fs.readdir(path.join(root, folder), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const relative = `${folder}/${entry.name}`;
    if (entry.isDirectory()) await markdownUnder(root, relative, files);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative);
  }
  return files;
}

async function markdownFiles() {
  const files = [...DOCUMENT_FILES];
  for (const folder of DOCUMENT_FOLDERS) await markdownUnder(ROOT, folder, files);
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

// Every mapping inside a parsed document that names at least one Mirage setting, with its path in the document.
function settingMaps(value, at = '$', found = []) {
  if (Array.isArray(value)) value.forEach((item, index) => settingMaps(item, `${at}[${index}]`, found));
  else if (isMap(value)) {
    if (KEYS.some((key) => Object.hasOwn(value, key))) found.push({ at, settings: value });
    for (const [key, item] of Object.entries(value)) settingMaps(item, `${at}.${key}`, found);
  }
  return found;
}

// Wrong shapes tried for every setting: each one either resolves or is refused with a message.
const PROBES = [null, 'text', '', 7, -1, true, [], ['x'], [{}], {}, { x: 1 }, { unknown: {} }];
// Deeper samples of the contract settings, valid and invalid, each resolving or failing below its first level.
const CONTRACT_SAMPLES = [
  { connections: { x_conn: { provider: 'http', connector: 'x_widgets' } } },
  { connections: { x_conn: { password: 'literal' } } },
  { connections: { x_conn: { provider: 'smtp' } } },
  { connections: { x_conn: { settings: { auth: { token: 'literal' } } } } },
  { connections: { x_conn: { settings: { auth: { token: 'env:X_TOKEN' }, parameters: { apiKey: 'literal' } } } } },
  { connections: { x_conn: { settings: { rewrites: { 'https://x.example.test/': 'http://127.0.0.1:7071/' } } } } },
  { connections: { x_conn: { settings: { rewrites: { 'https://x.example.test/?a=1': 'http://127.0.0.1:7071/' } } } } },
  { connections: { x_conn: { principal: { pack: 'x-pack', identity: 'owner' }, evidence: 'Invented' } } },
  { connections: { x_conn: { principal: { identity: '' } } } },
  { connections: { ' ': {} } },
  { secrets: { 'x-vault/x-secret': { variable: 'X_SECRET' } } },
  { secrets: { 'X-Vault/X-Secret': { variable: 'X_SECRET', allow: ['77777777-7777-4777-8777-777777777777'] } } },
  { secrets: { 'x-vault/x-secret': { value: 'literal' } } },
  { secrets: { 'x-vault/x-secret': { source: 'protected', protectedValue: 'AAAA' } } },
  { secrets: { 'x-vault/x-secret': { source: 'protected', protectedValue: 'not base64!' } } },
  { secrets: { 'x-vault/x-secret': { source: 'file' } } },
  { secrets: { 'x-vault/x-secret': { variable: 'X_SECRET', versions: { current: 'v1' }, expiresOn: '2030-01-01' } } },
  { secrets: { 'x-vault/x-secret': { variable: 'X_SECRET', expiresOn: 'soon' } } },
  { secrets: { 'x-vault/x-secret': { variable: 'X_SECRET', allow: ['everyone'] } } },
  { secrets: { 'not a key': { variable: 'X_SECRET' } } },
  { localServices: { 'x-api': { kind: 'http', baseUrl: 'http://127.0.0.1:7071', probe: '/health' } } },
  { localServices: { 'x-api': { kind: 'http', baseUrl: 'https://remote.example.test' } } },
  { localServices: { 'x-api': { kind: 'http', baseUrl: 'http://user:pass@127.0.0.1:7071' } } },
  { localServices: { 'x-api': { kind: 'http', baseUrl: 'http://localhost:7071', probe: '//remote.example.test' } } },
  { localServices: { 'x-blob': { kind: 'azure-storage', blob: 'http://127.0.0.1:10000/devstoreaccount1' } } },
  { localServices: { 'x-bus': { kind: 'service-bus', connectionStringVariable: 'X_BUS', required: true } } },
  { localServices: { 'x-bus': { kind: 'service-bus', connectionString: 'Endpoint=sb://x' } } },
  { localServices: { 'x-bus': { kind: 'smtp' } } },
  { canvas: { enabled: true, sources: ['apps/x'], codeComponents: false } },
  { canvas: { enabled: 'yes' } },
  { canvas: { sources: [''] } },
  { canvas: { screens: [] } },
  { codeApps: [{ name: 'x-app', dir: 'apps/x' }] },
  { codeApps: [{ name: 'x-app', dir: 'apps/x', localAppUrl: 'http://localhost:5173', config: 'x.config.json' }] },
  { codeApps: [{ name: 'x-app', dir: 'apps/x', localAppUrl: 'https://remote.example.test' }] },
  { codeApps: [{ name: 'x app', dir: 'apps/x' }] },
  { codeApps: [{ name: 'x-app', dir: '../outside' }] },
  {
    codeApps: [
      { name: 'x-app', dir: 'apps/x' },
      { name: 'X-App', dir: 'apps/y' },
    ],
  },
  {
    codeApps: [
      { name: 'x-app', dir: 'apps/x', devServer: { command: ['npm', 'run', 'dev'], cwd: 'web', timeoutMs: 5000 } },
    ],
  },
  { codeApps: [{ name: 'x-app', dir: 'apps/x', devServer: { command: [] } }] },
  { codeApps: [{ name: 'x-app', dir: 'apps/x', devServer: { command: ['npm'], env: { 'A=B': 'x' } } }] },
  { providers: { storage: { disk: { kind: 'local-disk', root: 'blobs' } }, routes: { annotations: 'disk' } } },
  { providers: { storage: { disk: { kind: 'local-disk', root: '../outside' } } } },
  { providers: { storage: { blob: { kind: 'azurite', connectionString: 'env:X_STORAGE', timeoutMs: 500 } } } },
  { providers: { storage: { blob: { kind: 'azurite', connectionString: 'UseDevelopmentStorage=true' } } } },
  { providers: { storage: { blob: { kind: 'azurite' } } } },
  { providers: { storage: { blob: { kind: 'pack:x-pack/blob', container: 'x-files', options: { tier: 'hot' } } } } },
  { providers: { storage: { Blob: { kind: 'local-disk' } } } },
  { providers: { routes: { annotations: 'missing' } } },
  { providers: { routes: { portalWebFiles: 'export' } } },
  { providers: { routes: { annotations: 'export' } } },
  { providers: { routes: { mail: 'local' } } },
  { providers: { messaging: { queue: { kind: 'local-queue', retry: { maxAttempts: 3, backoffMs: [10, 20] } } } } },
  { providers: { messaging: { queue: { kind: 'local-queue' }, endpoints: { 'x-endpoint': 'queue/orders' } } } },
  { providers: { messaging: { endpoints: { 'x-endpoint': 'missing/orders' } } } },
  { providers: { messaging: { bus: { kind: 'servicebus-emulator', connectionString: 'env:X_BUS', amqpPort: 5672 } } } },
  { providers: { messaging: { bus: { kind: 'servicebus-emulator' } } } },
  { providers: { messaging: { queue: { kind: 'smtp' } } } },
  { providers: { messaging: { queue: { kind: 'local-queue', retry: { maxAttempts: 0 } } } } },
  { providers: { messaging: {} } },
  { providers: { outbox: { retention: 10 } } },
  { providers: { outbox: { kind: 'pack:x-pack' } } },
  { providers: { outbox: { kind: 'smtp' } } },
  { providers: { outbox: { retention: 0 } } },
  { providers: { outbox: {} } },
  { providers: { mail: {} } },
  { platform: { evidence: 'Invented organization settings' } },
  { platform: { evidence: 'Invented', notASetting: 1 } },
  { dataverse: { organizationId: '77777777-7777-4777-8777-777777777777' } },
  { dataverse: { organizationId: 'not-a-guid' } },
];

async function buildCorpus() {
  const cases = [];
  const sources = { catalogueFiles: [], documentBlocks: 0, documentFiles: new Set(), examples: 0 };
  const add = (id, entry) => cases.push({ id: `${String(cases.length).padStart(4, '0')} ${id}`, ...entry });
  const addDocument = (origin, document) => {
    if (isMap(document) && isMap(document.sites)) {
      add(`${origin} catalogue`, { catalogue: document });
      // A site resolves its mirage mapping over defaults.mirage, as loadCatalogue merges it.
      for (const [site, entry] of Object.entries(document.sites))
        if (isMap(entry))
          add(`${origin} site ${site}`, { settings: { ...document.defaults?.mirage, ...entry.mirage } });
    }
    for (const { at, settings } of settingMaps(document)) add(`${origin} ${at}`, { settings });
  };

  for (const file of CATALOGUE_FILES) {
    addDocument(file, YAML.parse(await fs.readFile(path.join(ROOT, file), 'utf8')));
    sources.catalogueFiles.push(file);
  }
  for (const file of await markdownFiles()) {
    const text = await fs.readFile(path.join(ROOT, file), 'utf8');
    let index = 0;
    for (const [, body] of text.matchAll(/^[ \t]*```ya?ml[^\n]*\n([\s\S]*?)^[ \t]*```/gm)) {
      index += 1;
      let document;
      try {
        document = YAML.parse(body);
      } catch {
        continue; // An elided or multi-document sample is not a settings document.
      }
      const before = cases.length;
      addDocument(`${file}#${index}`, document);
      if (cases.length > before) {
        sources.documentBlocks += 1;
        sources.documentFiles.add(file);
      }
    }
  }
  // The invented example of every setting in the setup reference (lense/setup/settings-catalogue.mjs).
  for (const kind of ['catalogue', 'project'])
    for (const entry of settingsCatalogue(kind)) {
      if (!Object.hasOwn(MIRAGE_SETTINGS, entry.key) || typeof entry.example !== 'string') continue;
      add(`setup ${kind} ${entry.scope} ${entry.key}`, { settings: YAML.parse(entry.example) });
      sources.examples += 1;
    }
  // Unset: every key absent, every key undefined, every key null; then each wrong shape for each key.
  add('unset absent', { settings: {} });
  add('unset undefined', { settings: {}, unset: KEYS });
  add('unset null', { settings: Object.fromEntries(KEYS.map((key) => [key, null])) });
  for (const key of KEYS)
    PROBES.forEach((probe, index) => add(`probe ${key} ${index}`, { settings: { [key]: probe } }));
  CONTRACT_SAMPLES.forEach((settings, index) => add(`contract sample ${index}`, { settings }));
  add('not a mapping', { settings: 'text' });
  return { cases, sources };
}

const run = (file, args, options) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [...args.preload, file, ...args.rest],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...options },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    ),
  );

// Runs a script with a preload that reports, at exit, every toolkit module file the process loaded (no extension).
async function recorded(t, directory, script, rest, options = {}) {
  const preload = path.join(directory, 'record-loads.mjs');
  // The record goes to a file of its own: written to stderr at exit it can be cut short, because macOS pipes are
  // asynchronous (and a synchronous write to a full non-blocking pipe may be partial).
  await fs.writeFile(
    preload,
    `import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const seen = new Set();
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) seen.add(url);
    return nextLoad(url, context);
  },
});
process.on('exit', () => writeFileSync(process.env.PAQ_TEST_LOADED_MODULES, JSON.stringify([...seen])));
`,
  );
  const record = path.join(directory, `loaded-${crypto.randomUUID()}.json`);
  const result = await run(
    script,
    { preload: ['--import', pathToFileURL(preload).href], rest },
    {
      cwd: directory,
      signal: t.signal,
      ...options,
      env: { ...(options.env ?? process.env), PAQ_TEST_LOADED_MODULES: record },
    },
  );
  const urls = JSON.parse(await fs.readFile(record, 'utf8').catch(() => 'null'));
  assert.ok(urls, `the process reported its modules: ${result.stderr}`);
  const modules = urls
    .map((url) => path.relative(ROOT, fileURLToPath(url)).replaceAll('\\', '/'))
    .filter((name) => /^(?:lense|mirage)\//.test(name) && !name.includes('node_modules/'))
    .map((name) => name.replace(/\.mjs$/, ''));
  return { ...result, modules };
}

async function workspace(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-settings-contracts-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// @test-kind tooling: the documentation harvest of the settings corpus reads the checkout's own Markdown only
test('the settings corpus walk skips node_modules, dot folders and links', async (t) => {
  const root = await workspace(t);
  const outside = path.join(root, 'outside');
  for (const dir of ['docs/guide', 'docs/.cache', 'docs/node_modules/pkg', 'outside'])
    await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const file of ['docs/a.md', 'docs/guide/b.md', 'docs/.cache/c.md', 'docs/node_modules/pkg/d.md', 'outside/e.md'])
    await fs.writeFile(path.join(root, file), '# x');
  await fs.symlink(outside, path.join(root, 'docs', 'linked'), 'junction');
  assert.deepEqual((await markdownUnder(root, 'docs')).sort(), ['docs/a.md', 'docs/guide/b.md']);
});

test('the settings contracts resolve every settings sample as the provider runtimes do, without loading them', async (t) => {
  const directory = await workspace(t);
  const { cases, sources } = await buildCorpus();
  // The harvest is the evidence: an empty one would compare nothing.
  assert.deepEqual(sources.catalogueFiles, CATALOGUE_FILES);
  assert.ok(sources.documentBlocks >= 10, `settings samples found in the documentation: ${sources.documentBlocks}`);
  assert.ok(sources.examples >= KEYS.length, `setup reference examples: ${sources.examples}`);
  const corpusFile = path.join(directory, 'corpus.json');
  await fs.writeFile(corpusFile, JSON.stringify({ base: path.join(directory, 'invented'), cases }));

  const [light, full] = await Promise.all([
    recorded(t, directory, RESOLVER, ['light', corpusFile]),
    recorded(t, directory, RESOLVER, ['full', corpusFile]),
  ]);
  assert.equal(light.code, 0, light.stderr);
  assert.equal(full.code, 0, full.stderr);
  const lightResults = JSON.parse(light.stdout),
    fullResults = JSON.parse(full.stdout);

  // Every contract parser is registered on both paths, so no case took the pending (unvalidated) path.
  assert.deepEqual(lightResults.pending, []);
  assert.deepEqual(fullResults.pending, []);
  assert.deepEqual(
    Object.keys(lightResults.results),
    cases.map(({ id }) => id),
  );
  // Case by case first, so a difference names its sample; then the whole output.
  for (const { id } of cases) assert.deepEqual(lightResults.results[id], fullResults.results[id], id);
  assert.deepEqual(lightResults, fullResults);
  assert.doesNotMatch(light.stdout, /CONFIG_KEY_PARSER_PENDING/);

  // The corpus exercises both outcomes of every setting: a resolved value and a refusal with its message.
  const outcomes = Object.values(lightResults.results).flatMap((result) => Object.entries(result.keys ?? {}));
  for (const key of KEYS) {
    const own = outcomes.filter(([name]) => name === key).map(([, outcome]) => outcome);
    assert.ok(
      own.some((outcome) => 'value' in outcome),
      `${key} resolved in at least one sample`,
    );
    // environmentVariables accepts any value: its validation belongs to the Solution it overrides.
    if (key !== 'environmentVariables')
      assert.ok(
        own.some((outcome) => outcome.error?.message),
        `${key} was refused in at least one sample`,
      );
  }

  // The light path loaded no provider runtime; the full path did, so the recorder sees them when they load.
  assert.deepEqual(
    light.modules.filter((name) => RUNTIME_MODULES.includes(name)),
    [],
  );
  for (const name of ['mirage/lib/provider-modules', 'mirage/lib/connector-runtime', 'mirage/lib/dataverse-security'])
    assert.ok(full.modules.includes(name), `${name} loads with the provider modules`);
  assert.ok(light.modules.includes('lense/config') && light.modules.includes('mirage/lib/settings-contracts'));
  assert.ok(
    light.modules.length <= CONFIG_MODULE_BOUND,
    `lense/config.mjs and catalogue resolution loaded ${light.modules.length} toolkit modules (bound ${CONFIG_MODULE_BOUND}): ${light.modules.join(', ')}`,
  );
});

test('mirage status and stop read a catalogue whose site sets contract settings without loading a provider runtime', async (t) => {
  const directory = await workspace(t);
  const config = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(
    config,
    YAML.stringify({
      sites: {
        invented: {
          source: 'portal',
          environments: { dev: 'https://invented-portal.example.test' },
          mirage: {
            port: 0,
            connections: { x_conn: { provider: 'http', connector: 'x_widgets' } },
            secrets: { 'x-vault/x-secret': { variable: 'X_SECRET' } },
            localServices: { 'x-api': { kind: 'http', baseUrl: 'http://127.0.0.1:7071' } },
            providers: {
              storage: { disk: { kind: 'local-disk', root: 'blobs' } },
              routes: { annotations: 'disk' },
              messaging: { queue: { kind: 'local-queue' } },
              outbox: { retention: 10 },
            },
            canvas: { enabled: true },
            platform: { evidence: 'Invented organization settings' },
            dataverse: { organizationId: '77777777-7777-4777-8777-777777777777' },
          },
        },
      },
    }),
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PAQVILO_')));
  const status = await recorded(t, directory, CLI, ['mirage', 'status', '--config', config, '--json'], { env });
  assert.equal(status.code, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.sessions, []);
  assert.ok(status.modules.includes('lense/config') && status.modules.includes('mirage/lib/settings-contracts'));
  // The command module supervises code app dev servers, so it loads code-apps-config.mjs (file and URL helpers, no runtime).
  const runtimes = (modules) =>
    modules.filter((name) => RUNTIME_MODULES.includes(name) && name !== 'mirage/lib/code-apps-config');
  assert.deepEqual(runtimes(status.modules), []);

  // mirage stop refuses a catalogue it cannot read: an invalid contract setting is refused by its contract, with the
  // contract's message, still without a provider runtime.
  await fs.writeFile(
    config,
    YAML.stringify({
      sites: {
        invented: {
          source: 'portal',
          environments: { dev: 'https://invented-portal.example.test' },
          mirage: { connections: { x_conn: { password: 'literal' } } },
        },
      },
    }),
  );
  const refused = await recorded(t, directory, CLI, ['mirage', 'stop', '--config', config, '--json'], { env });
  assert.equal(refused.code, 1);
  assert.equal(
    JSON.parse(refused.stdout).error.message,
    "Unknown sites.invented.mirage.connections.x_conn key 'password'",
  );
  assert.deepEqual(runtimes(refused.modules), []);
});
