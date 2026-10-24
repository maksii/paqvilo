import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MIRAGE_SETTINGS,
  configuredSettingKeys,
  catalogueKeys,
  projectKeys,
  parseSetting,
  runtimeOptions,
  runtimeIdentity,
  settingOptions,
  registerSettingParser,
  pendingSettingParsers,
  withoutSettingParser,
} from '../lib/config-keys.mjs';
import { resolveProjectConfig } from '../lib/project-config.mjs';
import { runtimeSettings } from '../lib/runtime-config.mjs';
import { simulationSettings } from '../lib/simulation-settings.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { modelDrivenSettings } from '../lib/model-driven-settings.mjs';
import { platformConfig } from '../lib/platform-config.mjs';
import { renderSettings } from '../lib/render-settings.mjs';
import { personaContextSettings } from '../lib/persona-context-settings.mjs';
import { identityProviderSettings } from '../lib/identity-provider-settings.mjs';
import { resolveDeploymentProfiles } from '../lib/deployment-profiles.mjs';
import { contentPolicyDefaults } from '../lib/content-policy-defaults.mjs';
import { validateLocalOverrides } from '../lib/local-overrides.mjs';
import { validateCatalogue } from '../../lense/config-schema.mjs';
import { resolveMirageConfig } from '../../lense/config.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const NEW_KEYS = ['connectorScripts', 'connections', 'secrets', 'localServices', 'providers', 'canvas', 'codeApps'];
const PRE_MIGRATION_CATALOGUE = [
  'project',
  'solutionRoots',
  'solutionOrder',
  'dataPacks',
  'port',
  'preset',
  'presetMode',
  'presetConfiguration',
  'confinePortalPages',
  'externalAssets',
  'externalFrameOrigins',
  'observed',
  'dataModel',
  'compat',
  'head',
  'render',
  'deploymentProfiles',
  'platform',
  'personaContexts',
  'identityProvider',
  'dataverse',
  'runtime',
  'simulation',
  'modelDriven',
];
const PRE_MIGRATION_PROJECT_SETTINGS = [
  'dataPacks',
  'solutionOrder',
  'environmentVariables',
  'deploymentProfiles',
  'platform',
  'confinePortalPages',
  'externalAssets',
  'externalFrameOrigins',
  'dataverse',
  'runtime',
  'simulation',
  'modelDriven',
];
const PLATFORM = { QueryLinkEntityLimit: 1, evidence: 'Invented organization limit' };

const outcome = (fn) => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error.message };
  }
};

test('the key lists derive from the table and keep every pre-migration key', () => {
  assert.deepEqual(
    [...catalogueKeys()].sort(),
    [...PRE_MIGRATION_CATALOGUE, ...NEW_KEYS.filter((key) => MIRAGE_SETTINGS[key].scopes.includes('catalogue'))].sort(),
  );
  assert.deepEqual([...projectKeys()].sort(), [...PRE_MIGRATION_PROJECT_SETTINGS, ...NEW_KEYS].sort());
  for (const [key, row] of Object.entries(MIRAGE_SETTINGS))
    assert.ok(
      row.scopes.every((scope) => ['catalogue', 'project', 'portal'].includes(scope)),
      key,
    );
});

// Trusted custom connector scripts are registered like data packs: a mapping list, unknown keys refused.
test('connectorScripts registers a connector and the SHA-256 of its script text', () => {
  assert.deepEqual(
    parseSetting('connectorScripts', [
      { connector: 'x_5fapi', sha256: 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855' },
    ]),
    [{ connector: 'x_5fapi', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }],
  );
  assert.deepEqual(parseSetting('connectorScripts', undefined), []);
  assert.throws(
    () => parseSetting('connectorScripts', [{ connector: 'x_5fapi', sha256: 'abc' }]),
    /sha256 must be the 64 hex digit SHA-256/,
  );
  assert.throws(
    () =>
      parseSetting('connectorScripts', [
        { connector: 'x_5fapi', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', path: 'x' },
      ]),
    /Unknown setting connectorScripts\[0\]\.path/,
  );
  assert.throws(() => parseSetting('connectorScripts', { connector: 'x_5fapi' }), /must be an array/);
});

test('every existing key parses identically through its row', () => {
  const base = path.resolve('invented-base');
  const cases = [
    ['runtime', { kind: 'dataverse-api' }, (v) => runtimeSettings(v, 'L')],
    ['runtime', { kind: 'nope' }, (v) => runtimeSettings(v, 'L')],
    ['simulation', { level: 'dry-run' }, (v) => simulationSettings(v, 'L')],
    ['simulation', { level: 'x' }, (v) => simulationSettings(v, 'L')],
    ['dataverse', { enabled: true, tls: false }, (v) => dataverseSettings(v, 'L')],
    ['dataverse', { unknown: 1 }, (v) => dataverseSettings(v, 'L')],
    ['modelDriven', { clientSources: ['client'] }, (v) => modelDrivenSettings(v, 'L', base)],
    ['modelDriven', { x: 1 }, (v) => modelDrivenSettings(v, 'L', base)],
    ['platform', PLATFORM, (v) => platformConfig(v, 'L')],
    ['platform', { QueryLinkEntityLimit: 1 }, (v) => platformConfig(v, 'L')],
    ['render', { timeLimitMs: 1000 }, (v) => renderSettings(v)],
    ['render', { other: 1 }, (v) => renderSettings(v)],
    ['personaContexts', { maxInstances: 2 }, (v) => personaContextSettings(v)],
    ['personaContexts', { maxInstances: 99 }, (v) => personaContextSettings(v)],
    ['identityProvider', { newUser: 'never' }, (v) => identityProviderSettings(v)],
    ['identityProvider', { newUser: 'x' }, (v) => identityProviderSettings(v)],
    ['deploymentProfiles', {}, (v) => resolveDeploymentProfiles(v, base)],
    ['confinePortalPages', true, (v) => contentPolicyDefaults({ confinePortalPages: v }).confinePortalPages],
    ['confinePortalPages', 'yes', (v) => contentPolicyDefaults({ confinePortalPages: v }).confinePortalPages],
    ['externalAssets', false, (v) => contentPolicyDefaults({ externalAssets: v }).externalAssets],
    [
      'externalFrameOrigins',
      ['https://frames.example.test'],
      (v) => contentPolicyDefaults({ externalFrameOrigins: v }).externalFrameOrigins,
    ],
    ['compat', {}, (v) => validateLocalOverrides({ compat: v }).compat],
    ['head', { scripts: [''] }, (v) => validateLocalOverrides({ head: v }).head],
  ];
  for (const [key, value, direct] of cases)
    assert.deepEqual(
      outcome(() => parseSetting(key, value, { label: 'L', base })),
      outcome(() => direct(value)),
      `${key} ${JSON.stringify(value)}`,
    );
  // Catalogue-only checks keep their messages.
  const messages = {
    solutionOrder: ['sideways', /L must be derived/],
    port: [70000, /L must be an integer from 0 to 65535/],
    preset: ['a b', /L must be a preset ID/],
    presetMode: ['x', /L must be bootstrap or always/],
    presetConfiguration: ['x', /L must be data-only or apply/],
    dataModel: ['x', /L must be standard or enhanced/],
    dataPacks: [[{ id: 'Bad Id', module: 'p.mjs' }], /L\[0\]\.id must match/],
    solutionRoots: ['one', /L must be an array of folders/],
    project: ['', /L must be a non-empty string/],
    observed: [[], /L must be an object such as/],
  };
  for (const [key, [value, pattern]] of Object.entries(messages))
    assert.throws(() => parseSetting(key, value, { label: 'L' }), pattern, key);
});

test('catalogue validation and resolution go through the rows', () => {
  const root = {
    portals: 'selected',
    agent: { enabled: false },
    liveReload: true,
    panel: true,
    sourceMaps: true,
    editor: 'code',
    browser: {
      channel: 'msedge',
      headless: false,
      bypassCSP: false,
      profileDir: 'p',
      profile: null,
      userDataDir: null,
      profileDirectory: null,
      cdpUrl: null,
      debugPort: null,
    },
    sites: { invented: { mirage: { dataverse: { enabled: 'yes' } } } },
  };
  assert.throws(() => validateCatalogue(root), /sites\.invented\.mirage\.dataverse\.enabled/);
  root.sites.invented.mirage = { soluton: [] };
  assert.throws(() => validateCatalogue(root), /Unknown setting sites\.invented\.mirage\.soluton/);
  const where = { configDir: path.resolve('catalogue'), sourceRoot: path.resolve('checkout') };
  const resolved = resolveMirageConfig(
    { solutionRoots: ['solutions'], dataPacks: ['pack.mjs'], platform: PLATFORM, externalAssets: true },
    where,
  );
  assert.deepEqual(resolved.solutionRoots, [path.join(where.sourceRoot, 'solutions')]);
  assert.deepEqual(resolved.dataPacks, [{ id: null, module: path.join(where.configDir, 'pack.mjs') }]);
  assert.equal(resolved.solutionOrder, 'derived');
  assert.equal(resolved.port, null);
  assert.equal(resolved.externalAssets, true);
});

test('runtimeOptions applies each row precedence and builds nested options', () => {
  const catalogue = {
    dataverse: { enabled: false },
    modelDriven: { trustedExtensions: true },
    platform: { ...PLATFORM, evidence: 'catalogue' },
    render: { timeLimitMs: 5 },
    externalAssets: true,
    observed: { loginPath: '/catalogue', evidence: 'c' },
    dataPacks: [{ id: null, module: 'c.mjs' }],
    solutionOrder: 'derived',
  };
  const project = {
    dataverse: { enabled: true },
    modelDriven: { trustedExtensions: false },
    platform: { ...PLATFORM, evidence: 'project' },
    solutionOrder: 'explicit',
    dataPacks: [{ id: 'p', module: 'p.mjs' }],
    environmentVariables: { x_Value: '1' },
  };
  const portal = {
    platform: { ...PLATFORM, evidence: 'portal' },
    confinePortalPages: true,
    externalAssets: false,
    observed: { loginPath: '/portal', evidence: 'p' },
    dataModel: null,
  };
  const options = runtimeOptions({ project, portal, catalogue });
  assert.deepEqual(options.dataverse, { enabled: true }, 'project beats catalogue');
  assert.deepEqual(options.modelDriven, { trustedExtensions: false });
  assert.equal(options.observed.loginPath, '/portal', 'portal beats catalogue');
  assert.equal(options.platform.evidence, 'catalogue', 'platform keeps the catalogue-first rule of every host');
  assert.deepEqual(options.contentPolicyDefaults, { confinePortalPages: true, externalAssets: true });
  assert.deepEqual(
    options.dataPacks,
    [{ id: null, module: 'c.mjs' }],
    'project packs reach the runtime through the project summary',
  );
  assert.equal(options.solutionOrder, 'explicit');
  assert.deepEqual(options.render, { timeLimitMs: 5 });
  assert.deepEqual(options.environmentVariables, { x_Value: '1' });
  assert.equal(Object.hasOwn(options, 'dataModel'), false, 'null is not set');
  assert.equal(runtimeOptions({ project, portal }).platform.evidence, 'portal');
  assert.deepEqual(
    settingOptions({ ...options, sourceDir: 'x', unrelated: 1 }, { exclude: ['dataverse'] }).dataverse,
    undefined,
  );
  assert.equal(settingOptions({ sourceDir: 'x' }).sourceDir, undefined);
});

test('configuredSettingKeys lists the authored setting names, including those that reach the runtime under another option', () => {
  const where = { configDir: path.resolve('catalogue'), sourceRoot: path.resolve('checkout') };
  assert.deepEqual(
    configuredSettingKeys({ catalogue: resolveMirageConfig({}, where) }),
    [],
    'resolution fallbacks are not authored settings',
  );
  const catalogue = {
    ...resolveMirageConfig({ externalAssets: true, port: 0 }, where),
    localOverrides: { compat: { invented: false }, assets: [] },
  };
  const project = {
    connections: { 'x-invented': { provider: 'fixture' } },
    environmentVariables: {},
    solutionOrder: 'derived',
  };
  const portal = { confinePortalPages: true, externalFrameOrigins: ['https://frame.example.test'] };
  assert.deepEqual(configuredSettingKeys({ project, portal, catalogue }), [
    'compat',
    'confinePortalPages',
    'connections',
    'externalAssets',
    'externalFrameOrigins',
    'port',
  ]);
  assert.deepEqual(
    configuredSettingKeys({ catalogue: { localOverrides: { compat: {}, assets: [{ kind: 'styles' }] } } }),
    ['head'],
  );
  assert.deepEqual(configuredSettingKeys(), []);
});

test('runtimeIdentity is stable, limited to identity rows and redacts secrets', () => {
  const a = runtimeIdentity({
    runtime: { kind: 'power-pages' },
    dataverse: { port: 0, enabled: true },
    secrets: { token: 'env:INVENTED_TOKEN' },
    observed: { loginPath: '/x' },
  });
  const b = runtimeIdentity({
    secrets: { token: 'env:INVENTED_TOKEN' },
    dataverse: { enabled: true, port: 0 },
    runtime: { kind: 'power-pages' },
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(Object.hasOwn(a, 'observed'), false);
  assert.match(a.secrets, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(a).includes('INVENTED_TOKEN'), false);
  assert.notEqual(runtimeIdentity({ secrets: { token: 'env:OTHER' } }).secrets, a.secrets);
  assert.equal(runtimeIdentity({}).secrets, null);
});

test('project files: v1 reports unknown keys, v2 rejects them, pending parsers report a diagnostic', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-keys-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'project.json');
  const standalone = { runtime: { kind: 'dataverse-api' }, solutions: [] };
  const v1 = await resolveProjectConfig({ version: 1, ...standalone, invented: true }, file, { checkSources: false });
  assert.deepEqual(
    v1.diagnostics.map((d) => [d.code, d.key]),
    [['PROJECT_CONFIG_KEY_UNKNOWN', 'invented']],
  );
  await assert.rejects(
    resolveProjectConfig({ version: 2, ...standalone, invented: true }, file, { checkSources: false }),
    /Unknown project configuration key 'invented'/,
  );
  // project-config.mjs loads provider-modules.mjs, which registers every parser: the pending path runs with one removed.
  await withoutSettingParser('localServices', async () => {
    assert.ok(pendingSettingParsers().includes('localServices'));
    const project = await resolveProjectConfig({ version: 2, ...standalone, localServices: { invented: {} } }, file, {
      checkSources: false,
    });
    assert.deepEqual(project.localServices, { invented: {} });
    assert.ok(project.diagnostics.some((d) => d.code === 'CONFIG_KEY_PARSER_PENDING' && d.key === 'localServices'));
    await assert.rejects(
      resolveProjectConfig({ version: 2, ...standalone, localServices: 'text' }, file, { checkSources: false }),
      /localServices must be an object/,
    );
  });
  assert.equal(pendingSettingParsers().includes('localServices'), false, 'the registered parser is restored');
});

test('registerSettingParser replaces the pending default', () => {
  const key = 'localServices';
  withoutSettingParser(key, () => {
    const diagnostics = [];
    assert.deepEqual(parseSetting(key, { a: {} }, { diagnostics }), { a: {} });
    assert.deepEqual(
      diagnostics.map((d) => [d.code, d.key]),
      [['CONFIG_KEY_PARSER_PENDING', key]],
    );
    registerSettingParser(key, (value, label) => {
      if (!value.a) throw new Error(`${label}.a is required`);
      return { a: 'parsed' };
    });
    assert.equal(pendingSettingParsers().includes(key), false);
    assert.deepEqual(parseSetting(key, { a: {} }, { diagnostics: [] }), { a: 'parsed' });
    assert.throws(() => parseSetting(key, {}, { label: 'x.localServices' }), /x\.localServices\.a is required/);
  });
  assert.throws(() => registerSettingParser(key, 'not a function'), /parse/);
  assert.notDeepEqual(parseSetting(key, {}), { a: 'parsed' }, 'the module parser is back after the test seam');
});

test('a project without dataverse leaves the catalogue site dataverse in force', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-keys-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await resolveProjectConfig(
    { version: 2, runtime: { kind: 'model-driven' }, solutions: [] },
    path.join(root, 'project.json'),
    { checkSources: false },
  );
  assert.equal(project.dataverse, undefined);
  const options = runtimeOptions({ project, catalogue: { dataverse: dataverseSettings({ enabled: true }) } });
  assert.equal(options.dataverse.enabled, true);
  const explicit = await resolveProjectConfig(
    { version: 2, runtime: { kind: 'model-driven' }, solutions: [], dataverse: { enabled: false } },
    path.join(root, 'project.json'),
    { checkSources: false },
  );
  assert.equal(
    runtimeOptions({ project: explicit, catalogue: { dataverse: dataverseSettings({ enabled: true }) } }).dataverse
      .enabled,
    false,
    'an explicit project value still wins',
  );
});

function serve(t, args, cwd) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    signal: t.signal,
    killSignal: 'SIGKILL',
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.once('error', () => {});
  t.after(async () => {
    if (child.exitCode === null) child.stdin.end('stop\n');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await closed;
    clearTimeout(timer);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CLI did not start.\nstdout: ${stdout}\nstderr: ${stderr}`)),
      60_000,
    );
    const check = () => {
      try {
        const value = JSON.parse(stdout);
        clearTimeout(timer);
        resolve(value);
      } catch {
        /* wait for complete JSON */
      }
    };
    child.stdout.on('data', check);
    closed.then(() => {
      clearTimeout(timer);
      reject(new Error(`CLI exited.\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

test(
  'multi-portal serve --project applies the project dataverse and platform to every portal',
  { timeout: 120_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-keys-cli-'));
    await fs.mkdir(path.join(root, 'portal'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'portal', 'Home.webpage.yml'),
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
    );
    await fs.writeFile(path.join(root, 'portal', 'Home.webpage.copy.html'), '<h1>Invented home</h1>');
    await fs.writeFile(
      path.join(root, 'project.json'),
      JSON.stringify({
        version: 2,
        portals: [
          { id: 'first', path: './portal' },
          { id: 'second', path: './portal' },
        ],
        dataverse: { enabled: true, tls: false, tds: { enabled: false } },
        platform: PLATFORM,
      }),
    );
    const starting = serve(
      t,
      [
        'serve',
        '--project',
        path.join(root, 'project.json'),
        '--port',
        '0',
        '--no-watch',
        '--state-dir',
        path.join(root, '.paqvilo'),
      ],
      root,
    );
    // After hooks run in registration order: the runtime stops before its folder is removed.
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const started = await starting;
    assert.equal(started.portals.length, 2);
    for (const portal of started.portals) {
      const state = await (await fetch(`${portal.url}/__sim/api/state`)).json();
      assert.equal(state.status.capabilities.dataverseApi, true, `${portal.id}: project dataverse`);
      const limit = state.config.platformSettings.find((entry) => entry.key === 'QueryLinkEntityLimit');
      assert.equal(limit.value, 1, `${portal.id}: project platform`);
    }
  },
);

test('the configuration guide lists every registered setting', async () => {
  const guide = await fs.readFile(new URL('../../docs/configuration.md', import.meta.url), 'utf8');
  const table = guide.slice(guide.indexOf('<!-- settings-table'), guide.indexOf('<!-- /settings-table -->'));
  assert.deepEqual(
    [...table.matchAll(/^\|\s*`(\w+)`\s*\|/gm)].map((match) => match[1]),
    Object.keys(MIRAGE_SETTINGS),
  );
});
