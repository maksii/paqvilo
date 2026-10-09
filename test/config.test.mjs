import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadCatalogue, loadDevTargets } from '../lense/config.mjs';
import { setEnvLine, rememberSelection } from '../lense/commands/use.mjs';

const CATALOGUE = `
defaultSite: alpha
sites:
  alpha:
    source: portals/alpha
    defaultEnv: dev
    environments:
      dev: https://alpha-dev.example.com
      test:
        url: https://alpha-test.example.com/some/path
        baseline: origin/release/test
        scope: changed
        startPath: /home/
      prod:
        url: https://alpha.example.com
        caution: true
  beta:
    source: portals/beta
    environments:
      uat: https://beta-uat.example.com
    markup:
      baseline: origin/beta
defaults:
  scope: all
  markup:
    baseline: HEAD
browser:
  channel: msedge
  debugPort: 9222
`;

let dir;
let config;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-cfg-')));
  config = path.join(dir, 'paqvilo.config.yml');
  write('paqvilo.config.yml', CATALOGUE);
  for (const site of ['alpha', 'beta', 'gamma']) fs.mkdirSync(path.join(dir, 'portals', site, 'web-files'), { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// the shell's environment is passed in, so the developer's real PAQVILO_* variables do not leak into tests
const load = (opts = {}, shell = {}) => loadConfig({ config, ...opts }, shell);
const targets = (opts = {}, shell = {}) => loadDevTargets({ config, ...opts }, shell);

test('standalone source root resolves all portals in an independent worktree with CLI precedence', async () => {
  for (const root of ['shared-checkout', 'personal-checkout', 'shell-checkout', 'cli-checkout']) {
    for (const site of ['alpha', 'beta']) fs.mkdirSync(path.join(dir, root, 'portals', site, 'web-files'), { recursive: true });
  }
  write('paqvilo.config.local.yml', 'sourceRoot: shared-checkout\n');
  assert.equal((await load()).sourceDir, path.join(dir, 'shared-checkout', 'portals', 'alpha'));
  write('.env', 'PAQVILO_REPO=personal-checkout\n');
  assert.equal((await load()).sourceDir, path.join(dir, 'personal-checkout', 'portals', 'alpha'));
  const shell = { PAQVILO_REPO: 'shell-checkout' };
  assert.equal((await load({}, shell)).sourceDir, path.join(dir, 'shell-checkout', 'portals', 'alpha'));
  const selected = await targets({ repo: path.join(dir, 'cli-checkout'), portals: 'all' }, shell);
  assert.ok(selected.targets.every((cfg) => cfg.sourceDir.startsWith(path.join(dir, 'cli-checkout'))));
  assert.equal(selected.initial.sourceRoot, path.join(dir, 'cli-checkout'));
});

test('source root keeps absolute and named personal source paths independent and reports missing checkouts', async () => {
  write('paqvilo.config.local.yml', 'sourceRoot: not-present\n');
  await assert.rejects(load(), /not-present.*does not look like a portal extract/);
  const personal = await load({}, { PAQVILO_ALPHA_SOURCE: 'portals/alpha' });
  assert.equal(personal.sourceDir, path.join(dir, 'portals', 'alpha'));
  write('paqvilo.config.local.yml', `sourceRoot: not-present\nsites:\n  alpha:\n    source: ${JSON.stringify(path.join(dir, 'portals', 'alpha'))}\n`);
  assert.equal((await load()).sourceDir, path.join(dir, 'portals', 'alpha'));
  write('paqvilo.config.local.yml', 'sourceRoot: false\n');
  await assert.rejects(load(), /sourceRoot must be a non-empty string/);
  await assert.rejects(load({ repo: '' }), /sourceRoot must be a non-empty string|repository root must be a non-empty path/);
});

test('with nothing chosen the catalogue defaults apply', async () => {
  const cfg = await load();
  assert.equal(cfg.siteName, 'alpha');
  assert.equal(cfg.envName, 'dev');
  assert.equal(cfg.origin, 'https://alpha-dev.example.com');
  assert.equal(cfg.sourceDir, path.join(dir, 'portals', 'alpha'));
  assert.equal(cfg.site.scope, 'all');
  assert.equal(cfg.site.markup.baseline, 'HEAD');
  assert.equal(cfg.caution, false);
  assert.deepEqual(cfg.chosen, { site: 'paqvilo.config.yml', env: 'paqvilo.config.yml' });
});

test('directory route globs can preserve file suffixes and nested segments', async () => {
  write('paqvilo.config.local.yml', 'defaults:\n  routes:\n    - {url: /assets/*.js, dir: build}\n    - {url: /nested/**/*.css, dir: styles}\n');
  const cfg = await load();
  assert.deepEqual(cfg.site.routes, [{ url: '/assets/*.js', dir: 'build' }, { url: '/nested/**/*.css', dir: 'styles' }]);
});

test('.env chooses site and environment', async () => {
  write('.env', 'PAQVILO_SITE=beta\nPAQVILO_ENV=uat\n');
  const cfg = await load();
  assert.equal(`${cfg.siteName}@${cfg.envName}`, 'beta@uat');
  assert.deepEqual(cfg.chosen, { site: '.env', env: '.env' });
  // a site's own settings win over the shared defaults
  assert.equal(cfg.site.markup.baseline, 'origin/beta');
});

test('precedence: command line > shell > .env > catalogue', async () => {
  write('.env', 'PAQVILO_ENV=test\nPAQVILO_SCOPE=all\n');
  assert.equal((await load()).envName, 'test');
  assert.equal((await load({}, { PAQVILO_ENV: 'prod' })).envName, 'prod');
  assert.equal((await load({ env: 'dev' }, { PAQVILO_ENV: 'prod' })).envName, 'dev');
  // scope: the environment says 'changed', .env says 'all', the command line has the last word
  assert.equal((await load()).site.scope, 'all');
  assert.equal((await load({ scope: 'changed' })).site.scope, 'changed');
});

test("an environment's own baseline, scope and start page apply unless overridden", async () => {
  const cfg = await load({ env: 'test' });
  assert.equal(cfg.origin, 'https://alpha-test.example.com');
  assert.equal(cfg.site.markup.baseline, 'origin/release/test');
  assert.equal(cfg.site.scope, 'changed');
  assert.equal(cfg.site.startPath, '/home/');
  const over = await load({ env: 'test', baseline: 'HEAD', path: '/x' }, { PAQVILO_SCOPE: 'all' });
  assert.equal(over.site.markup.baseline, 'HEAD');
  assert.equal(over.site.scope, 'all');
  assert.equal(over.site.startPath, '/x');
});

test('--site for another site than the remembered one uses that site’s default environment', async () => {
  write('.env', 'PAQVILO_SITE=beta\nPAQVILO_ENV=uat\n');
  const cfg = await load({ site: 'alpha' });
  assert.equal(`${cfg.siteName}@${cfg.envName}`, 'alpha@dev');
  assert.match(cfg.notes[0], /PAQVILO_ENV=uat was chosen for site "beta"/);
  // naming the remembered site keeps the remembered environment
  assert.equal((await load({ site: 'beta' })).envName, 'uat');
  // even when the other site has an environment of the same name
  write('.env', 'PAQVILO_SITE=alpha\nPAQVILO_ENV=test\n');
  write('paqvilo.config.local.yml', 'sites:\n  beta:\n    environments:\n      test: https://beta-test.example.com\n');
  assert.equal((await load({ site: 'beta' })).envName, 'uat');
});

test('a caution environment is flagged', async () => {
  assert.equal((await load({ env: 'prod' })).caution, true);
});

test('.env can add an environment, repoint a site, and add a whole site', async () => {
  fs.mkdirSync(path.join(dir, 'elsewhere', 'web-pages'), { recursive: true });
  write(
    '.env',
    [
      'PAQVILO_ALPHA_ENV_MY_SANDBOX=https://sandbox.example.com',
      'PAQVILO_ALPHA_SOURCE=elsewhere',
      'PAQVILO_GAMMA_SOURCE=portals/gamma',
      'PAQVILO_GAMMA_ENV_DEV=https://gamma-dev.example.com',
    ].join('\n'),
  );
  const sandbox = await load({ env: 'my-sandbox' });
  assert.equal(sandbox.origin, 'https://sandbox.example.com');
  assert.equal(sandbox.sourceDir, path.join(dir, 'elsewhere'));
  // the catalogue's environments of that site are still there
  assert.deepEqual(Object.keys(loadCatalogue({ config }, {}).sites.alpha.environments), ['dev', 'test', 'prod', 'my-sandbox']);
  const gamma = await load({ site: 'gamma' });
  assert.equal(`${gamma.siteName}@${gamma.envName} ${gamma.origin}`, 'gamma@dev https://gamma-dev.example.com');
  // and it gets the shared defaults like any catalogue site
  assert.deepEqual(gamma.site.inline.kinds, ['page-js', 'page-css', 'basic-form-js', 'advanced-form-step-js', 'list-js']);
});

test('one-off URL and source', async () => {
  const cfg = await load({ url: 'https://anything.example.com/x', source: path.join(dir, 'portals', 'beta') });
  assert.equal(cfg.envName, 'custom');
  assert.equal(cfg.origin, 'https://anything.example.com');
  assert.equal(cfg.sourceDir, path.join(dir, 'portals', 'beta'));
});

test('browser and behaviour settings come from .env', async () => {
  write('.env', 'PAQVILO_BROWSER=chrome\nPAQVILO_DEBUG_PORT=0\nPAQVILO_LIVE_RELOAD=false\nPAQVILO_SOURCE_MAPS=no\nPAQVILO_HEADLESS=true\n');
  const cfg = await load();
  assert.equal(cfg.browser.channel, 'chrome');
  assert.equal(cfg.browser.debugPort, null);
  assert.equal(cfg.browser.headless, true);
  assert.equal(cfg.liveReload, false);
  assert.equal(cfg.sourceMaps, false);
  assert.equal((await load({ 'debug-port': '9333' })).browser.debugPort, 9333);
});

test('agent access defaults to enabled and can be disabled with validated personal settings', async () => {
  assert.equal((await load()).agent.enabled, true);
  assert.equal((await load({}, { PAQVILO_AGENT: 'false' })).agent.enabled, false);
  await assert.rejects(load({}, { PAQVILO_AGENT: 'maybe' }), /PAQVILO_AGENT must be true or false/);
  write('paqvilo.config.local.yml', 'agent: { enabled: false }');
  assert.equal((await load()).agent.enabled, false);
});

test('mistakes are explained', async () => {
  await assert.rejects(load({ site: 'nope' }), /Unknown site "nope"\. Known sites: alpha, beta/);
  await assert.rejects(load({ env: 'nope' }), /Unknown environment "nope" for site "alpha"\. Known: dev, test, prod/);
  await assert.rejects(load({ scope: 'some' }), /scope must be 'all' or 'changed'/);
  await assert.rejects(load({}, { PAQVILO_BROWSER: 'netscape' }), /browser must be/);
  await assert.rejects(load({}, { PAQVILO_LIVE_RELOAD: 'maybe' }), /PAQVILO_LIVE_RELOAD must be true or false/);
  await assert.rejects(load({}, { PAQVILO_SCOPEE: 'all' }), /Unknown setting PAQVILO_SCOPEE/);
  fs.rmSync(path.join(dir, 'portals', 'alpha'), { recursive: true });
  await assert.rejects(load(), /does not look like a portal extract/);
  write('paqvilo.config.yml', 'sites: [unclosed');
  await assert.rejects(load(), /paqvilo\.config\.yml is not valid YAML/);
});

test('diagnostic switches in the shell are not taken for settings', async () => {
  assert.equal((await load({}, { PAQVILO_DEBUG: '1', PAQVILO_KEEP_TEMP: '1' })).siteName, 'alpha');
});

test('paqvilo.config.local.yml adds to the catalogue', async () => {
  write('paqvilo.config.local.yml', 'sites:\n  alpha:\n    environments:\n      mine: https://mine.example.com\n');
  assert.equal((await load({ env: 'mine' })).origin, 'https://mine.example.com');
  assert.equal((await load()).envName, 'dev');
});

test('use: writes the choice into .env text without disturbing the rest', () => {
  const example = '# comment\n#PAQVILO_SITE=sample\n\n#PAQVILO_ENV=sandbox\nPAQVILO_SCOPE=changed\n';
  let text = setEnvLine(example, 'PAQVILO_SITE', 'second');
  text = setEnvLine(text, 'PAQVILO_ENV', 'test');
  assert.equal(text, '# comment\nPAQVILO_SITE=second\n\nPAQVILO_ENV=test\nPAQVILO_SCOPE=changed\n');
  assert.equal(setEnvLine(text, 'PAQVILO_SITE', 'third'), text.replace('second', 'third'));
  assert.equal(setEnvLine('A=1', 'PAQVILO_SITE', 'sample'), 'A=1\nPAQVILO_SITE=sample\n');
  assert.equal(setEnvLine('', 'PAQVILO_SITE', 'sample'), 'PAQVILO_SITE=sample\n');
});

test('configuration fails early for malformed schemas and unsafe identifiers', async () => {
  for (const text of [
    'sites: []', 'sites: { alpha: nope }', 'liveReload: "false"',
    'defaults: { inline: { minSimilarity: 2 } }', 'defaults: { inlien: {} }',
    'defaults: { routes: [{url: /x, file: a, dir: b}] }',
    'sites: { "../escape": {source: portals/alpha} }',
    'sites: { alpha: { environments: { dev: { caution: "false" } } } }',
  ]) {
    write('paqvilo.config.local.yml', text);
    await assert.rejects(load(), undefined, text);
  }
});

test('URLs, start paths and debugger ports are validated before launching', async () => {
  for (const url of ['file:///tmp/site', 'javascript:alert(1)', 'ftp://example.com', 'https://user:secret@example.com']) await assert.rejects(load({ url }), /URL/);
  for (const value of ['@evil.example/', '//evil.example/', '/\\evil.example/', 'https://evil.example/']) await assert.rejects(load({ path: value }), /same-origin/);
  for (const port of ['-1', '65536', '1.5', 'Infinity']) await assert.rejects(load({ 'debug-port': port }), /port|Port/);
  assert.equal((await load({ path: '/about?q=yes#section', 'debug-port': '65535' })).site.startPath, '/about?q=yes#section');
  await assert.rejects(load({ headed: true, headless: true }), /cannot be used together/);
});

test('a local override can extend a shorthand environment and disable the debugger', async () => {
  write('paqvilo.config.local.yml', 'browser: { debugPort: null }\nsites: { alpha: { environments: { dev: { baseline: release } } } }');
  const cfg = await load();
  assert.equal(cfg.origin, 'https://alpha-dev.example.com');
  assert.equal(cfg.site.markup.baseline, 'release');
  assert.equal(cfg.browser.debugPort, null);
});

test('an explicit environment wins over a remembered one-off URL', async () => {
  write('.env', 'PAQVILO_URL=https://old.example.com\n');
  assert.equal((await load({ env: 'dev' })).origin, 'https://alpha-dev.example.com');
  assert.equal((await load()).origin, 'https://old.example.com');
  assert.equal((await load({ env: 'dev', url: 'https://explicit.example.com' })).origin, 'https://explicit.example.com');
});

test('use updates export, spacing and duplicate values while preserving CRLF', () => {
  assert.equal(setEnvLine('export PAQVILO_SITE = alpha\r\nPAQVILO_SITE=beta\r\nX=1\r\n', 'PAQVILO_SITE', 'gamma'), 'PAQVILO_SITE=gamma\r\nPAQVILO_SITE=gamma\r\nX=1\r\n');
  assert.equal(setEnvLine('X=1\r\n', 'PAQVILO_SITE', 'alpha'), 'X=1\r\nPAQVILO_SITE=alpha\r\n');
  assert.throws(() => setEnvLine('', 'PAQVILO_SITE', 'alpha\nINJECTED=true'), /Invalid/);
});

test('prototype names are never usable as site selections or environment additions', async () => {
  await assert.rejects(load({ site: 'constructor' }), /Unknown site/);
  await assert.rejects(load({ env: 'constructor' }), /Unknown environment/);
  await assert.rejects(load({}, { PAQVILO_CONSTRUCTOR_SOURCE: 'x' }), /Invalid configuration key|site name/);
  assert.equal(Object.source, undefined);
});

test('selecting a site cannot silently reuse a one-off source from another checkout', async () => {
  write('.env', `PAQVILO_SOURCE=${path.join(dir, 'portals', 'beta')}\n`);
  assert.equal((await load({ site: 'alpha' })).sourceDir, path.join(dir, 'portals', 'alpha'));
  assert.equal((await load({ env: 'dev' })).sourceDir, path.join(dir, 'portals', 'beta'));
});

test('remembered selections disable stale one-off target settings in the file', () => {
  const text = rememberSelection('PAQVILO_URL=https://old.example.com\r\nexport PAQVILO_SOURCE = old\r\n', 'beta', 'test', 'alpha');
  assert.match(text, /# PAQVILO_URL=https:\/\/old.example.com/);
  assert.match(text, /# export PAQVILO_SOURCE = old/);
  assert.match(text, /PAQVILO_SITE=beta\r\nPAQVILO_ENV=test\r\n$/);
});

test('portal mode defaults to selected and follows CLI, shell and .env precedence', async () => {
  const selected = await targets();
  assert.equal(selected.mode, 'selected');
  assert.equal(selected.initial.portals, 'selected');
  assert.deepEqual(selected.targets, [selected.initial]);
  write('.env', 'PAQVILO_PORTALS=all\n');
  assert.equal((await load()).portals, 'all');
  assert.equal((await targets()).targets.length, 4);
  assert.equal((await targets({}, { PAQVILO_PORTALS: 'selected' })).targets.length, 1);
  assert.equal((await targets({ portals: 'all' }, { PAQVILO_PORTALS: 'selected' })).targets.length, 4);
  assert.equal((await targets({ portals: 'selected' }, { PAQVILO_PORTALS: 'all' })).targets.length, 1);
  for (const portals of ['', 'ALL', 'every']) await assert.rejects(targets({ portals }), /portals must be/);
});

test('all portal targets retain environment defaults, isolated settings and initial-only paths', async () => {
  write('.env', 'PAQVILO_SITE=beta\nPAQVILO_ENV=uat\nPAQVILO_START_PATH=/remembered-start/\n');
  const result = await targets({ portals: 'all', path: '/initial-only/' });
  assert.equal(result.initial.siteName, 'beta');
  assert.equal(result.initial.site.startPath, '/initial-only/');
  assert.equal(result.targets.find((cfg) => cfg.siteName === 'beta'), result.initial);
  const testEnv = result.targets.find((cfg) => cfg.siteName === 'alpha' && cfg.envName === 'test');
  assert.equal(testEnv.site.startPath, '/home/');
  assert.equal(testEnv.site.scope, 'changed');
  assert.equal(testEnv.site.markup.baseline, 'origin/release/test');
  assert.equal(result.initial.site.markup.baseline, 'origin/beta');
  assert.equal(result.targets.find((cfg) => cfg.envName === 'prod').caution, true);
  testEnv.site.inline.enabled = false;
  testEnv.site.routes.push({ url: '/only-test', passthrough: true });
  const devEnv = result.targets.find((cfg) => cfg.siteName === 'alpha' && cfg.envName === 'dev');
  assert.equal(devEnv.site.inline.enabled, true);
  assert.deepEqual(devEnv.site.routes, []);
  const global = await targets({ portals: 'all', scope: 'all', baseline: 'explicit-ref' }, { PAQVILO_SCOPE: 'changed', PAQVILO_BASELINE: 'shell-ref' });
  assert.ok(global.targets.every((cfg) => cfg.site.scope === 'all' && cfg.site.markup.baseline === 'explicit-ref'));
  const shell = await targets({ portals: 'all' }, { PAQVILO_SCOPE: 'changed', PAQVILO_BASELINE: 'shell-ref' });
  assert.ok(shell.targets.every((cfg) => cfg.site.scope === 'changed' && cfg.site.markup.baseline === 'shell-ref'));
});

test('all portal coverage includes .env site/source/environment additions with one catalogue read and no network', async (t) => {
  write('.env', 'PAQVILO_PORTALS=all\nPAQVILO_ALPHA_SOURCE=portals/gamma\nPAQVILO_ALPHA_ENV_SANDBOX=https://sandbox.example.com\nPAQVILO_GAMMA_SOURCE=portals/gamma\nPAQVILO_GAMMA_ENV_EXTRA=https://gamma-extra.example.com\n');
  const read = fs.readFileSync;
  const reads = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => { reads.push(String(file)); return read(file, ...args); });
  t.mock.method(globalThis, 'fetch', () => assert.fail('target discovery must remain offline'));
  const result = await targets();
  assert.equal(result.targets.length, 6);
  assert.ok(result.targets.filter((cfg) => cfg.siteName === 'alpha').every((cfg) => cfg.sourceDir === path.join(dir, 'portals', 'gamma')));
  assert.equal(result.targets.find((cfg) => cfg.siteName === 'gamma').origin, 'https://gamma-extra.example.com');
  assert.equal(reads.filter((file) => file === config).length, 1);
  assert.equal(reads.filter((file) => file === path.join(dir, '.env')).length, 1);
});

test('all portal mode rejects every one-off URL/source conflict even when selection would ignore it', async () => {
  for (const option of [{ url: 'https://custom.example.com' }, { source: 'portals/gamma' }]) {
    await assert.rejects(targets({ portals: 'all', site: 'alpha', ...option }), /portals=all cannot be combined with --(?:url|source)/);
  }
  for (const setting of [{ PAQVILO_URL: 'https://custom.example.com' }, { PAQVILO_SOURCE: 'portals/gamma' }]) {
    await assert.rejects(targets({ portals: 'all', site: 'alpha', env: 'dev' }, setting), /portals=all cannot be combined with PAQVILO_(?:URL|SOURCE)/);
  }
  write('.env', 'PAQVILO_PORTALS=all\nPAQVILO_URL=https://custom.example.com\n');
  await assert.rejects(targets(), /PAQVILO_URL/);
  const selected = await targets({ portals: 'selected' });
  assert.equal(selected.initial.origin, 'https://custom.example.com');
  assert.equal(selected.targets.length, 1);
});

test('single-target configuration still allows one-off overrides with the all-portals browser profile setting', async () => {
  write('.env', 'PAQVILO_PORTALS=all\n');
  const cfg = await load({ url: 'https://custom.example.com', source: path.join(dir, 'portals', 'gamma') });
  assert.equal(cfg.portals, 'all');
  assert.equal(cfg.origin, 'https://custom.example.com');
  assert.equal(cfg.sourceDir, path.join(dir, 'portals', 'gamma'));
  const remembered = await load({}, { PAQVILO_URL: 'https://remembered.example.com', PAQVILO_SOURCE: 'portals/beta' });
  assert.equal(remembered.origin, 'https://remembered.example.com');
  assert.equal(remembered.sourceDir, path.join(dir, 'portals', 'beta'));
});

test('all portal mode rejects duplicate origins but defers unvisited source validation', async () => {
  write('paqvilo.config.local.yml', 'sites:\n  beta:\n    environments:\n      uat: https://ALPHA-DEV.example.com:443/another-path\n');
  await assert.rejects(targets({ portals: 'all' }), (error) => /Duplicate portal origin https:\/\/alpha-dev.example.com/.test(error.message) && /alpha @ dev/.test(error.message) && /beta @ uat/.test(error.message));
  assert.equal((await targets()).targets.length, 1, 'selected mode does not arm other origins');
  write('paqvilo.config.local.yml', 'sites:\n  beta:\n    source: nonexistent-extract\n');
  assert.equal((await targets({ portals: 'all' })).targets.length, 4, 'unused extracts do not prevent the working-day session');
  await assert.rejects(targets({ portals: 'all', site: 'beta' }), /source of site "beta".*does not look like a portal extract/);
  write('paqvilo.config.local.yml', 'sites:\n  empty:\n    source: portals/gamma\n');
  await assert.rejects(targets({ portals: 'all' }), /Site "empty" has no environments/);
});

test('catalogue chooses the default portal mode; personal and CLI choices still override it', async () => {
  write('paqvilo.config.local.yml', 'portals: all\n');
  assert.equal((await targets()).mode, 'all');
  assert.equal((await targets({ portals: 'selected' })).mode, 'selected');
  assert.equal((await targets({}, { PAQVILO_PORTALS: 'selected' })).mode, 'selected');
  write('paqvilo.config.local.yml', 'portals: typo\n');
  await assert.rejects(targets(), /portals must be/);
});

test('all portal mode does not silently replace an invalid initial site or environment', async () => {
  await assert.rejects(targets({ portals: 'all', site: 'missing' }), /Unknown site/);
  await assert.rejects(targets({ portals: 'all', env: 'missing' }), /Unknown environment/);
  write('.env', 'PAQVILO_SITE=missing\nPAQVILO_PORTALS=all\n');
  await assert.rejects(targets(), /Unknown site/);
});

test('browser channel and named profile follow CLI, shell, .env and YAML precedence', async () => {
  const base = await load();
  assert.equal(base.browser.profile, null);
  assert.equal(base.browser.userDataDir, null);
  assert.equal(base.browser.profileDirectory, null);
  write('paqvilo.config.local.yml', 'browser: { channel: chromium, profile: Team-Default, profileDir: profiles-base }');
  assert.equal((await load()).browser.profile, 'team-default');
  write('.env', 'PAQVILO_BROWSER=chrome\nPAQVILO_PROFILE=Personal-Work\n');
  const personal = await load();
  assert.equal(personal.browser.profile, 'personal-work');
  assert.equal(personal.browser.channel, 'chrome');
  const shell = { PAQVILO_BROWSER: 'msedge', PAQVILO_PROFILE: 'Shell_Profile' };
  assert.equal((await load({}, shell)).browser.profile, 'shell_profile');
  const explicit = await load({ browser: 'chromium', profile: 'CLI-Work' }, shell);
  assert.equal(explicit.browser.profile, 'cli-work');
  assert.equal(explicit.browser.channel, 'chromium');
  assert.equal(explicit.browser.profileDir, 'profiles-base', 'named identity does not replace the configured base directory');
});

test('external user-data paths resolve by their configuration layer and preserve profile directory spaces', async () => {
  write('paqvilo.config.local.yml', 'browser: { userDataDir: yaml-browser, profileDirectory: Default }');
  assert.equal((await load()).browser.userDataDir, path.join(dir, 'yaml-browser'));
  write('.env', 'PAQVILO_USER_DATA_DIR=personal-browser\nPAQVILO_PROFILE_DIRECTORY="Profile 1"\n');
  const personal = await load();
  assert.equal(personal.browser.userDataDir, path.join(dir, 'personal-browser'));
  assert.equal(personal.browser.profileDirectory, 'Profile 1');
  const shell = { PAQVILO_USER_DATA_DIR: 'shell-browser', PAQVILO_PROFILE_DIRECTORY: 'Profile 2' };
  assert.equal((await load({}, shell)).browser.userDataDir, path.join(dir, 'shell-browser'));
  const explicit = await load({ 'user-data-dir': 'command-browser', 'profile-directory': 'Profile 3' }, shell);
  assert.equal(explicit.browser.userDataDir, path.resolve('command-browser'));
  assert.equal(explicit.browser.profileDirectory, 'Profile 3');
  const absolute = path.join(dir, 'absolute-browser');
  assert.equal((await load({ 'user-data-dir': absolute })).browser.userDataDir, absolute);
});

test('profile selectors reject traversal, reserved names, controls and ambiguous settings', async () => {
  for (const profile of ['', '.', '..', '../outside', 'a/b', 'a\\b', 'has spaces', 'CON', 'lpt9', 'x'.repeat(65), 'bad\nname']) {
    await assert.rejects(load({ profile }), /browser.profile/, `profile ${JSON.stringify(profile)}`);
  }
  for (const child of ['', '.', '..', '../outside', 'a/b', 'a\\b', 'CON', 'NUL.txt', 'COM¹', 'Profile 1.', 'Profile 1 ', 'bad:name', 'bad?name', 'bad\u007fname', 'x'.repeat(256)]) {
    await assert.rejects(load({ 'user-data-dir': 'browser-root', 'profile-directory': child }), /browser.profileDirectory/, `child ${JSON.stringify(child)}`);
  }
  for (const root of ['', '   ', 'bad\u0000root', 'bad\nroot']) await assert.rejects(load({ 'user-data-dir': root }), /browser.userDataDir/);
  await assert.rejects(load({ 'profile-directory': 'Default' }), /requires browser.userDataDir/);
  await assert.rejects(load({ profile: 'work', 'user-data-dir': 'browser-root' }), /cannot be combined/);
  write('.env', 'PAQVILO_PROFILE=remembered\n');
  await assert.rejects(load({ 'user-data-dir': 'browser-root' }), /cannot be combined/, 'CLI does not silently clear a different stored selector');
  write('.env', 'PAQVILO_USER_DATA_DIR=remembered-root\n');
  await assert.rejects(load({ profile: 'work' }), /cannot be combined/);
  await assert.rejects(load({}, { PAQVILO_PROFILE_DIRECTORY: 'Profile 1 ' }), /browser.profileDirectory/, 'shell directory spelling is not silently trimmed');
  write('.env', 'PAQVILO_USER_DATA_DIR=remembered-root\nPAQVILO_PROFILE_DIRECTORY="Profile 1 "\n');
  await assert.rejects(load(), /browser.profileDirectory/, 'quoted .env directory spelling is not silently trimmed');
  write('.env', 'PAQVILO_PROFILE=" work "\n');
  await assert.rejects(load(), /browser.profile/, 'quoted profile names must satisfy the same validation as CLI names');
});

test('profile fields are schema checked and CDP attachment cannot ignore a resolved profile selection', async () => {
  for (const browser of [{ profile: 12 }, { profile: 'reserved space' }, { userDataDir: true }, { profileDirectory: ['Default'] }, { profileDirectory: '..' }]) {
    write('paqvilo.config.local.yml', JSON.stringify({ browser }));
    await assert.rejects(load(), /browser\./);
  }
  write('paqvilo.config.local.yml', 'browser: { cdpUrl: "http://127.0.0.1:9000" }');
  write('.env', 'PAQVILO_CDP_URL=http://127.0.0.1:9001\n');
  assert.equal((await load()).browser.cdpUrl, 'http://127.0.0.1:9001');
  assert.equal((await load({}, { PAQVILO_CDP_URL: 'http://127.0.0.1:9002' })).browser.cdpUrl, 'http://127.0.0.1:9002');
  assert.equal((await load({ 'cdp-url': 'ws://127.0.0.1:9003/devtools/browser/id' })).browser.cdpUrl, 'ws://127.0.0.1:9003/devtools/browser/id');
  for (const selector of [{ profile: 'work' }, { 'user-data-dir': 'browser-root' }, { 'user-data-dir': 'browser-root', 'profile-directory': 'Default' }]) {
    await assert.rejects(load(selector), /browser.cdpUrl.*cannot be combined/);
  }
  await assert.rejects(load({ 'cdp-url': 'https://user:secret@example.com' }), /credentials/);
});

test('all portal targets share resolved browser choices without sharing mutable settings', async () => {
  const result = await targets({ portals: 'all', browser: 'chrome', profile: 'Team_Work' });
  assert.ok(result.targets.every((cfg) => cfg.browser.channel === 'chrome' && cfg.browser.profile === 'team_work'));
  result.targets[0].browser.profile = 'changed-one';
  assert.ok(result.targets.slice(1).every((cfg) => cfg.browser.profile === 'team_work'));
  const again = await targets({ portals: 'all', 'user-data-dir': 'profiles-root', 'profile-directory': 'Profile 1' });
  assert.ok(again.targets.every((cfg) => cfg.browser.profile === null && cfg.browser.userDataDir === path.resolve('profiles-root') && cfg.browser.profileDirectory === 'Profile 1'));
  assert.equal((await load()).browser.profile, null, 'resolution does not mutate defaults or the catalogue');
});

test('Mirage settings resolve projects and data packs from the catalogue folder and Solution roots from the checkout', async () => {
  for (const site of ['alpha', 'beta']) fs.mkdirSync(path.join(dir, 'checkout', 'portals', site, 'web-files'), { recursive: true });
  write('paqvilo.config.local.yml', [
    'sourceRoot: checkout',
    'defaults:',
    '  mirage: { port: 0, preset: open-sandbox }',
    'sites:',
    '  alpha:',
    '    mirage:',
    '      project: mirage/alpha.project.yml',
    '      solutionRoots: [../solutions/Base, ../solutions/Business]',
    '      dataPacks: [packs/local/pack.mjs, { id: shared-pack, module: packs/shared/pack.mjs }]',
    '',
  ].join('\n'));
  assert.deepEqual((await load()).mirageConfig, {
    project: path.join(dir, 'mirage', 'alpha.project.yml'),
    solutionRoots: [path.join(dir, 'solutions', 'Base'), path.join(dir, 'solutions', 'Business')],
    solutionOrder: 'derived',
    dataPacks: [{ id: null, module: path.join(dir, 'packs', 'local', 'pack.mjs') }, { id: 'shared-pack', module: path.join(dir, 'packs', 'shared', 'pack.mjs') }],
    port: 0,
    preset: 'open-sandbox',
    observed: null,
  });
  assert.deepEqual((await load({ site: 'beta' })).mirageConfig, { project: null, solutionRoots: [], solutionOrder: 'derived', dataPacks: [], port: 0, preset: 'open-sandbox', observed: null }, 'defaults apply to every site');
  for (const site of ['alpha', 'beta']) fs.mkdirSync(path.join(dir, 'worktree', 'portals', site, 'web-files'), { recursive: true });
  assert.deepEqual((await load({ repo: path.join(dir, 'worktree') })).mirageConfig.solutionRoots, [path.join(dir, 'solutions', 'Base'), path.join(dir, 'solutions', 'Business')], 'sibling roots follow the selected checkout');
  write('paqvilo.config.local.yml', 'sourceRoot: checkout\ndefaults:\n  mirage: { port: 0, preset: open-sandbox }\nsites:\n  alpha:\n    mirage: null\n');
  assert.deepEqual((await load()).mirageConfig, { project: null, solutionRoots: [], solutionOrder: 'derived', dataPacks: [], port: null, preset: null, observed: null }, 'a personal null clears inherited settings');
  assert.equal((await load()).mirage, undefined, 'the resolved settings never collide with the Mirage-mode flag');
});

test('Mirage settings are schema checked', async () => {
  for (const text of [
    'defaults: { mirage: { unknown: 1 } }',
    'defaults: { mirage: { port: 70000 } }',
    'defaults: { mirage: { port: "8787" } }',
    'defaults: { mirage: [] }',
    'sites: { alpha: { mirage: { solutionRoots: ../solutions } } }',
    'sites: { alpha: { mirage: { solutionRoots: [1] } } }',
    'sites: { alpha: { mirage: { dataPacks: [{ id: Bad ID, module: pack.mjs }] } } }',
    'sites: { alpha: { mirage: { dataPacks: [{ path: pack.mjs }] } } }',
    'sites: { alpha: { mirage: { preset: "two words" } } }',
    'sites: { alpha: { mirage: { project: "" } } }',
  ]) {
    write('paqvilo.config.local.yml', text);
    await assert.rejects(load(), /mirage/, text);
  }
});
