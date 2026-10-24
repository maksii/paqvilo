import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import YAML from 'yaml';
import { SetupStore } from '../lense/setup/store.mjs';
import { createSetupHandler, startSetupServer } from '../lense/setup/server.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { createFixture } from './fixture.mjs';
import { prepareProject } from '../lense/project-scaffold.mjs';

async function work(t, prefix = 'paqvilo-setup-unit-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}
const minimal = {
  sourceRoot: '.',
  defaultSite: 'portal',
  sites: { portal: { source: '.', environments: { dev: 'http://127.0.0.1:8787' }, mirage: { port: 0 } } },
};
const set = (path, value) => ({ op: 'set', path, value });
async function edit(store, layer, operations) {
  const { revision } = await store.snapshot();
  return store.save({ revision, layer, operations });
}

test('setup projects expose standalone runtime configuration without portal or environment findings', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'organization.json');
  await fs.mkdir(path.join(directory, 'solution'));
  await fs.writeFile(path.join(directory, 'pack.mjs'), "throw new Error('setup must not import trusted modules');");
  const raw = {
    version: 2,
    runtime: { kind: 'model-driven', defaultApp: '11111111-2222-4333-8444-555555555555' },
    simulation: { level: 'dry-run' },
    solutions: [{ id: 'core', path: './solution' }],
    dataPacks: [{ id: 'seed', module: './pack.mjs' }],
    dataverse: { enabled: false },
  };
  await fs.writeFile(filename, JSON.stringify(raw));
  const store = new SetupStore({ directory, project: filename, processEnv: {} });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.findings, []);
  assert.deepEqual(snapshot.sites, []);
  assert.equal(snapshot.settings.runtime.defaultApp, raw.runtime.defaultApp);
  assert.equal(snapshot.settings.simulation.level, 'dry-run');
  assert.equal(snapshot.settings.dataverse.enabled, false);
  assert.deepEqual(snapshot.settings.solutions, [{ id: 'core', path: './solution' }]);
  assert.equal(snapshot.solutions[0].exists, true);
  const next = await edit(store, 'shared', [
    set(['simulation', 'level'], 'simulation'),
    set(['dataverse', 'enabled'], true),
  ]);
  assert.equal(next.settings.simulation.level, 'simulation');
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')).dataPacks, raw.dataPacks);
  await assert.rejects(edit(store, 'shared', [set(['simulation', 'level'], 'invalid')]), /simulation requires level/);
});

test('setup retains omitted legacy simulation and validates standalone missing pack paths', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'organization.json');
  await fs.writeFile(
    filename,
    JSON.stringify({
      version: 2,
      runtime: { kind: 'dataverse-api' },
      solutions: [],
      dataPacks: [{ id: 'seed', module: './missing.mjs' }],
    }),
  );
  const snapshot = await new SetupStore({ directory, project: filename, processEnv: {} }).snapshot();
  assert.equal(snapshot.settings.simulation, null);
  assert.equal(snapshot.settings.dataverse.enabled, true);
  assert.deepEqual(
    snapshot.findings.map((item) => item.code),
    ['missing-pack'],
  );
});

test('setup starts in an empty directory without using the bundled catalogue; creates and repairs configuration', async (t) => {
  const directory = await work(t),
    store = new SetupStore({ directory, processEnv: {} });
  const empty = await store.snapshot();
  assert.equal(empty.ready, false);
  assert.equal(empty.layers.shared.exists, false);
  assert.equal(empty.sites.length, 0);
  await store.save({ revision: empty.revision, layer: 'shared', text: YAML.stringify(minimal) });
  const filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, 'sites: [broken\n');
  const broken = await store.snapshot();
  assert.equal(broken.findings[0].code, 'configuration');
  assert.match(broken.layers.shared.text, /broken/);
  await store.save({ revision: broken.revision, layer: 'shared', text: YAML.stringify(minimal) });
  assert.equal((await store.snapshot()).sites[0].id, 'portal');
});

test('guided edits preserve siblings, comments, environment shorthand and mapping rules', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(
    filename,
    `# Team catalogue\nsourceRoot: .\ndefaultSite: portal\nsites:\n  portal:\n    source: .\n    # Keep scenario ownership\n    mirage:\n      port: 0\n      preset: starter\n    environments:\n      dev: http://127.0.0.1:8787\n      other:\n        url: http://127.0.0.1:8788\n        baseline: HEAD # Pin this per environment\n`,
  );
  const store = new SetupStore({ directory, processEnv: {} });
  await edit(store, 'shared', [
    set(['sites', 'portal', 'source'], './export'),
    set(['sites', 'portal', 'environments', 'dev', 'caution'], true),
    { op: 'set', path: ['sites', 'portal', 'routes'], yaml: '- url: /assets/**\n  dir: web-files\n' },
  ]);
  const text = await fs.readFile(filename, 'utf8'),
    parsed = YAML.parse(text);
  assert.match(text, /# Team catalogue/);
  assert.match(text, /# Keep scenario ownership/);
  assert.match(text, /# Pin this per environment/);
  assert.equal(parsed.sites.portal.mirage.preset, 'starter');
  assert.equal(parsed.sites.portal.environments.dev.url, 'http://127.0.0.1:8787');
  assert.equal(parsed.sites.portal.environments.dev.caution, true);
  assert.equal(parsed.sites.portal.routes[0].dir, 'web-files');
});

test('guided edits preserve untouched flow collections without undoing changed collection values', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'paqvilo.config.yml');
  const original =
    "sourceRoot: .\ndefaultSite: portal\nsites:\n  portal:\n    source: .\n    routes: [{url: /assets/**, dir: web-files}]\n    mirage:\n      port: 8787\n      solutionRoots: [./one, './two'] # keep authored collection spacing\n";
  await fs.writeFile(filename, original);
  const store = new SetupStore({ directory, processEnv: {} });
  await edit(store, 'shared', [set(['sites', 'portal', 'mirage', 'port'], 0)]);
  assert.equal(await fs.readFile(filename, 'utf8'), original.replace('port: 8787', 'port: 0'));
  await edit(store, 'shared', [set(['sites', 'portal', 'mirage', 'solutionRoots', 0], './updated')]);
  const updated = await fs.readFile(filename, 'utf8');
  assert.deepEqual(YAML.parse(updated).sites.portal.mirage.solutionRoots, ['./updated', './two']);
  assert.ok(updated.includes('routes: [{url: /assets/**, dir: web-files}]\n'));
  assert.ok(updated.includes("'./two'"));
  assert.ok(updated.includes('# keep authored collection spacing'));
});

test('schema failures, dangerous keys and concurrent edits leave original documents intact', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, YAML.stringify(minimal));
  const store = new SetupStore({ directory, processEnv: {} });
  const original = await fs.readFile(filename, 'utf8'),
    initial = await store.snapshot();
  for (const [operations, message] of [
    [[set(['browser', 'headless'], 'wrong')], /browser\.headless must be true or false/],
    [[set(['__proto__', 'polluted'], true)], /Invalid configuration field path/],
    [
      [set(['sites', 'portal', 'mirage', 'observed'], { loginPath: '/SignIn' })],
      /observed\.evidence must name the observation/,
    ],
    [[{ op: 'set', path: ['sites', 'portal', 'routes'], yaml: '[' }], /Flow sequence must end/],
  ]) {
    await assert.rejects(store.save({ revision: initial.revision, layer: 'shared', operations }), message);
    assert.equal(await fs.readFile(filename, 'utf8'), original);
  }
  await fs.writeFile(filename, original + '# external edit\n');
  await assert.rejects(
    store.save({ revision: initial.revision, layer: 'shared', operations: [set(['sourceRoot'], './other')] }),
    (error) => error.status === 409,
  );
  const next = await store.snapshot();
  await fs.writeFile(path.join(directory, '.env'), 'PAQVILO_BROWSER=msedge\n');
  await assert.rejects(
    store.save({ revision: next.revision, layer: 'shared', operations: [] }),
    (error) => error.status === 409,
  );
  assert.equal({}.polluted, undefined);
});

test('personal settings and shell choices show provenance without exposing unrelated .env credentials or discoveries', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, YAML.stringify(minimal));
  await fs.writeFile(path.join(directory, '.env'), 'PRIVATE_CREDENTIAL=never-return-this\nPAQVILO_BROWSER=chrome\n');
  await fs.mkdir(path.join(directory, '.paqvilo'));
  await fs.writeFile(path.join(directory, '.paqvilo/session-1.json'), '{"token":"never-return-discovery"}');
  const store = new SetupStore({ directory, processEnv: { PAQVILO_REPO: directory } });
  const before = await fs.readFile(filename, 'utf8');
  const result = await edit(store, 'personal', [
    set(['browser', 'channel'], 'chromium'),
    set(['sites', 'portal', 'source'], './personal'),
  ]);
  assert.equal(result.settings.effective.PAQVILO_BROWSER.origin, '.env');
  assert.equal(result.settings.effective.PAQVILO_REPO.origin, 'shell');
  assert.equal(result.settings.provenance.sites.portal.sourceDir, 'local config');
  assert.equal(await fs.readFile(filename, 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(result), /never-return/);
  assert.match(await fs.readFile(path.join(directory, '.gitignore'), 'utf8'), /\/paqvilo.config.local.yml/);
  await edit(store, 'personal', [{ op: 'delete', path: ['sites', 'portal', 'source'] }]);
  assert.equal((await store.snapshot()).sites[0].source, '.');
});

test('scaffold setup reports missing folders and packs without executing module code', async (t) => {
  const directory = await work(t);
  await prepareProject(directory, { name: 'sample' });
  await fs.writeFile(path.join(directory, 'pack/pack.mjs'), "throw new Error('must not run');\n");
  const snapshot = await new SetupStore({ directory, processEnv: {} }).snapshot();
  assert.equal(snapshot.sites.length, 1);
  assert.ok(snapshot.findings.some((item) => item.code === 'missing-source'));
  assert.ok(snapshot.findings.some((item) => item.code === 'placeholder-origin'));
  assert.equal(snapshot.sites[0].packs[0].exists, true);
});

test('standalone Mirage projects validate incrementally and retain JSON encoding', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'mirage.project.json');
  const store = new SetupStore({ directory, project: filename, processEnv: {} });
  let result = await store.snapshot();
  result = await store.save({
    revision: result.revision,
    layer: 'shared',
    text: JSON.stringify({
      version: 2,
      defaultPortal: 'sample',
      portals: [{ id: 'sample', path: './not-here' }],
      solutions: [],
      dataPacks: [{ id: 'demo', module: './missing.mjs' }],
    }),
  });
  assert.ok(result.findings.some((item) => item.code === 'missing-source'));
  assert.ok(result.findings.some((item) => item.code === 'missing-pack'));
  await edit(store, 'shared', [set(['portals', 0, 'path'], './export')]);
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).portals[0].path, './export');
  await assert.rejects(edit(store, 'shared', [set(['portals', 0, 'solutions'], ['unknown'])]), /unknown solution/);
  await assert.rejects(edit(store, 'personal', []), /available configuration layer/);
});

test('all-target readiness identifies origin and port collisions before a preview starts', async (t) => {
  const directory = await work(t),
    store = new SetupStore({ directory, processEnv: {} });
  const config = {
    ...minimal,
    portals: 'all',
    sites: {
      alpha: { ...minimal.sites.portal, mirage: { port: 8787 } },
      beta: { ...minimal.sites.portal, mirage: { port: 8787 } },
    },
  };
  const result = await store.save({
    revision: (await store.snapshot()).revision,
    layer: 'shared',
    text: YAML.stringify(config),
  });
  assert.ok(result.findings.some((item) => item.code === 'duplicate-origin'));
  assert.ok(result.findings.some((item) => item.code === 'duplicate-port'));
  const selected = await edit(store, 'shared', [set(['portals'], 'selected')]);
  assert.ok(!selected.findings.some((item) => item.code.startsWith('duplicate-')));
});

test('symlinked configuration writes are refused without modifying the destination', async (t) => {
  const directory = await work(t),
    actual = path.join(directory, 'actual.yml'),
    link = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(actual, YAML.stringify(minimal));
  try {
    await fs.symlink(actual, link);
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Host does not permit file symlinks');
      return;
    }
    throw error;
  }
  const store = new SetupStore({ directory, processEnv: {} });
  await assert.rejects(store.save({ layer: 'shared', revision: 'x', operations: [] }), /symbolic links/);
  assert.equal(await fs.readFile(actual, 'utf8'), YAML.stringify(minimal));
});

test('setup HTTP enforces Host, Origin, fetch metadata, CSRF, payload bounds and fixed routes', async (t) => {
  const directory = await work(t),
    server = await startSetupServer({ directory, processEnv: {} });
  ownedFixture(t).add(() => server.close());
  const base = new URL(server.url).origin;
  const status = await fetch(base + '/_setup/api/status').then((response) => response.json());
  assert.equal((await fetch(base + '/_setup/')).status, 200);
  assert.equal((await fetch(base + '/_setup/style.css')).status, 200);
  assert.equal((await fetch(base + '/_setup/api/files')).status, 404);
  assert.equal(
    (await fetch(base + '/_setup/api/status', { headers: { Origin: 'https://hostile.invalid' } })).status,
    403,
  );
  assert.equal((await fetch(base + '/_setup/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.get(base + '/_setup/api/status', { headers: { Host: 'hostile.invalid' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  const payload = { revision: status.revision, layer: 'shared', text: YAML.stringify(minimal) };
  const post = (headers) =>
    fetch(base + '/_setup/api/config', { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal((await post({ 'Content-Type': 'application/json', Origin: base })).status, 403);
  assert.equal((await post({ 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': status.csrf })).status, 403);
  assert.equal(
    (await post({ 'Content-Type': 'text/plain', Origin: base, 'X-Paqvilo-Setup-CSRF': status.csrf })).status,
    415,
  );
  assert.equal(
    (await post({ 'Content-Type': 'application/json', Origin: base, 'X-Paqvilo-Setup-CSRF': status.csrf })).status,
    200,
  );
  const tooLarge = await fetch(base + '/_setup/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, 'X-Paqvilo-Setup-CSRF': status.csrf },
    body: 'x'.repeat(512 * 1024 + 1),
  });
  assert.equal(tooLarge.status, 413);
});

test('unsafe configuration paths remain inspectable while writes stay disabled', async (t) => {
  const directory = await work(t);
  await fs.mkdir(path.join(directory, 'paqvilo.config.yml'));
  const server = await startSetupServer({ directory, processEnv: {} });
  ownedFixture(t).add(() => server.close());
  const response = await fetch(new URL('api/status', server.url));
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.canEdit, false);
  assert.equal(status.ready, false);
  assert.match(status.findings[0].message, /Repair the selected file path/);
});

test('Mirage serves setup independently from simulation identity/state and reports restart drift', async (t) => {
  const directory = await work(t),
    fixture = createFixture();
  ownedFixture(t).remove(() => fixture.cleanup());
  const filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, YAML.stringify({ ...minimal, sourceRoot: fixture.dir }));
  const simulator = await createSimulator({
    sourceDir: fixture.dir,
    watch: false,
    setup: { config: filename, processEnv: {} },
  });
  ownedFixture(t).add(() => simulator.close());
  const before = simulator.state();
  const response = await fetch(simulator.setupUrl);
  assert.equal(response.status, 200);
  const status = await fetch(simulator.url + '/_setup/api/status').then((res) => res.json());
  assert.equal(status.runtime.restartRequired, false);
  assert.equal(status.runtime.product, 'Mirage');
  const saved = await fetch(simulator.url + '/_setup/api/config', {
    method: 'POST',
    headers: { Origin: simulator.url, 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': status.csrf },
    body: JSON.stringify({
      layer: 'shared',
      revision: status.revision,
      operations: [set(['sites', 'portal', 'source'], './future-export')],
    }),
  }).then((res) => res.json());
  assert.equal(saved.runtime.restartRequired, true);
  assert.equal(saved.runtime.sourceDir, fixture.dir);
  assert.equal(simulator.portal.sourceDir, fixture.dir);
  assert.equal(simulator.state().revision, before.revision);
});

test('catalogue sessions edit linked project files as project:<site> layers with shared locking and revisions', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'paqvilo.config.yml'),
    projectFile = path.join(directory, 'apps', 'x-invented.project.yml');
  await fs.mkdir(path.dirname(projectFile));
  await fs.writeFile(
    projectFile,
    YAML.stringify({
      version: 2,
      runtime: { kind: 'model-driven' },
      solutions: [{ id: 'x-core', path: './missing-solution' }],
    }),
  );
  await fs.writeFile(
    filename,
    YAML.stringify({
      ...minimal,
      sites: { portal: { ...minimal.sites.portal, mirage: { port: 0, project: './apps/x-invented.project.yml' } } },
    }),
  );
  const store = new SetupStore({ directory, processEnv: {} });
  let snapshot = await store.snapshot();
  assert.deepEqual(Object.keys(snapshot.layers).sort(), ['personal', 'project:portal', 'shared']);
  assert.equal(snapshot.layers['project:portal'].file, projectFile);
  assert.equal(snapshot.layers['project:portal'].site, 'portal');
  const linked = snapshot.findings.find((item) => item.layer === 'project:portal');
  assert.deepEqual(
    [linked.code, linked.site, linked.section],
    ['missing-solution', 'portal', '#advanced'],
    'a linked project file is edited in the Settings file',
  );
  snapshot = await store.save({
    revision: snapshot.revision,
    layer: 'project:portal',
    operations: [set(['solutions', 0, 'path'], './solution'), set(['environmentVariables'], { x_InventedFlag: 'on' })],
  });
  assert.equal(YAML.parse(await fs.readFile(projectFile, 'utf8')).environmentVariables.x_InventedFlag, 'on');
  assert.ok(
    snapshot.findings.some((item) => item.layer === 'project:portal'),
    'solution folder still missing',
  );
  const original = await fs.readFile(projectFile, 'utf8');
  await assert.rejects(
    store.save({
      revision: snapshot.revision,
      layer: 'project:portal',
      operations: [set(['solutionOrder'], 'sideways')],
    }),
    /solutionOrder/,
  );
  assert.equal(await fs.readFile(projectFile, 'utf8'), original);
  await assert.rejects(
    store.save({ revision: snapshot.revision, layer: 'project:other', operations: [] }),
    /available configuration layer/,
  );
  await fs.writeFile(projectFile, original + '# external edit\n');
  await assert.rejects(
    store.save({ revision: snapshot.revision, layer: 'project:portal', operations: [set(['watch'], true)] }),
    (error) => error.status === 409,
  );
  assert.equal(await fs.readFile(projectFile, 'utf8'), original + '# external edit\n');
});

test('setup status carries stages, planned topology, templates, the settings catalogue, finding anchors and inherited defaults', async (t) => {
  const directory = await work(t);
  await fs.writeFile(
    path.join(directory, 'paqvilo.config.yml'),
    YAML.stringify({
      ...minimal,
      defaults: { mirage: { simulation: { level: 'dry-run' } } },
      sites: {
        portal: {
          ...minimal.sites.portal,
          source: './missing-export',
          mirage: { port: 0, dataPacks: [{ id: 'x-pack', module: './missing-pack.mjs' }] },
        },
      },
    }),
  );
  const server = await startSetupServer({ directory, processEnv: {} });
  ownedFixture(t).add(() => server.close());
  const status = await fetch(new URL('api/status', server.url)).then((response) => response.json());
  // Shown in this order: Project, What to run, Exported files, Sample data, Live environments, Test people, Outside services, Web API access, Start & check.
  assert.deepEqual(
    status.stages.map((item) => item.id),
    [1, 2, 3, 5, 4, 6, 8, 9, 10],
  );
  const stageOf = (id) => status.stages.find((item) => item.id === id);
  for (const stage of status.stages)
    assert.ok(
      ['done', 'next', 'optional', 'blocked'].includes(stage.status) &&
        stage.anchor.startsWith('#') &&
        Array.isArray(stage.findings),
      JSON.stringify(stage),
    );
  assert.deepEqual(
    status.stages.filter((item) => item.status === 'next').map((item) => item.id),
    [3],
  );
  assert.equal(stageOf(5).status, 'blocked');
  assert.deepEqual(stageOf(5).findings, ['missing-pack']);
  assert.equal(stageOf(2).status, 'done', 'what to run (with the inherited dry run) is set');
  assert.deepEqual(Object.fromEntries(status.findings.map((item) => [item.code, item.section])), {
    'missing-source': '#portals',
    'missing-pack': '#packs',
  });
  assert.deepEqual(status.sites[0].packs, [
    {
      id: 'x-pack',
      module: path.join(directory, 'missing-pack.mjs'),
      path: path.join(directory, 'missing-pack.mjs'),
      exists: false,
    },
  ]);
  assert.deepEqual(status.sites[0].inherited, { simulation: true });
  assert.equal(status.sites[0].authoredMirage.simulation, undefined);
  assert.ok(status.topology.nodes.some((item) => item.id === 'host:portal' && item.status === 'planned'));
  assert.ok(status.settingsCatalogue.some((item) => item.key === 'secrets' && item.redact));
  assert.deepEqual(
    status.templates.map((item) => item.id),
    ['power-pages', 'model-driven', 'dataverse-api', 'full-stack'],
  );
  assert.equal(status.docs.configuration.path, 'docs/configuration.md');
  assert.equal(status.runtime, null);
  const project = await new SetupStore({
    directory,
    project: path.join(directory, 'absent.project.yml'),
    processEnv: {},
  }).snapshot();
  assert.match(project.findings[0].message, /Create the project file above/);
  assert.equal(project.findings[0].section, '#overview', 'the finding points at the create form');
});

test('setup creates configuration from a template and serves own and shared assets by pattern', async (t) => {
  const directory = await work(t),
    server = await startSetupServer({ directory, processEnv: {} });
  ownedFixture(t).add(() => server.close());
  const base = new URL(server.url).origin,
    status = await fetch(base + '/_setup/api/status').then((response) => response.json());
  const post = (body) =>
    fetch(base + '/_setup/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Paqvilo-Setup-CSRF': status.csrf },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ layer: 'shared', revision: status.revision, template: 'unknown', values: {} })).status,
    400,
  );
  const created = await post({
    layer: 'shared',
    revision: status.revision,
    template: 'full-stack',
    values: { id: 'alpha', root: './exports/alpha' },
  }).then((response) => response.json());
  assert.deepEqual(
    [...new Set(created.findings.map((item) => item.code))].sort(),
    status.templates.find((item) => item.id === 'full-stack').expectedFindings.sort(),
  );
  assert.equal(
    YAML.parse(await fs.readFile(path.join(directory, 'paqvilo.config.yml'), 'utf8')).sites.alpha.source,
    './exports/alpha',
  );
  assert.equal(
    (await post({ layer: 'shared', revision: created.revision, template: 'power-pages', values: {} })).status,
    409,
  );
  for (const [asset, type] of [
    ['app.mjs', 'javascript'],
    ['style.css', 'css'],
    ['index.html', 'html'],
  ]) {
    const response = await fetch(`${base}/_setup/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type'), new RegExp(type));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  }
  for (const name of ['ui-kit.mjs', 'ui-kit.css', 'shell.css', 'help-content.mjs'])
    assert.equal((await fetch(`${base}/_setup/${name}`)).status, 200, name);
  for (const blocked of [
    '/_setup/missing.mjs',
    '/_setup/dashboard-view.mjs',
    '/_setup/%2e%2e/package.json',
    '/_setup/App.mjs',
    '/_setup/x.json',
    '/_setup/store.mjs',
    '/_setup/server.mjs',
    '/_setup/templates.mjs',
  ])
    assert.equal((await fetch(base + blocked)).status, 404, blocked);
});

test('restart drift follows the runtime identity and names the restart command', async (t) => {
  const directory = await work(t, 'paqvilo-setup-unit-quoted-~'),
    filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, YAML.stringify(minimal));
  const server = await startSetupServer({ directory, processEnv: {}, runtime: { product: 'Lense', site: 'portal' } });
  ownedFixture(t).add(() => server.close());
  const base = new URL(server.url).origin;
  let status = await fetch(base + '/_setup/api/status').then((response) => response.json());
  assert.equal(status.runtime.restartRequired, false);
  assert.equal(status.runtime.restartCommand, `npx paqvilo lense dev --config "${filename}" --site portal`);
  await fs.appendFile(path.join(directory, '.gitignore'), '/invented-output/\n');
  await fs.appendFile(filename, '# comment only\n');
  status = await fetch(base + '/_setup/api/status').then((response) => response.json());
  assert.equal(status.runtime.restartRequired, false);
  assert.equal(
    status.stages.find((item) => item.id === 10).status,
    'blocked',
    'the source folder is not an export yet',
  );
  await fs.writeFile(
    filename,
    YAML.stringify({
      ...minimal,
      sites: { portal: { ...minimal.sites.portal, mirage: { port: 0, simulation: { level: 'dry-run' } } } },
    }),
  );
  status = await fetch(base + '/_setup/api/status').then((response) => response.json());
  assert.equal(status.runtime.restartRequired, true);
  const projectFile = path.join(directory, 'mirage.project.yml');
  await fs.writeFile(projectFile, YAML.stringify({ version: 2, runtime: { kind: 'dataverse-api' }, solutions: [] }));
  const project = await startSetupServer({
    directory,
    project: projectFile,
    processEnv: {},
    runtime: { product: 'Mirage' },
  });
  ownedFixture(t).add(() => project.close());
  const projectStatus = await fetch(new URL('api/status', project.url)).then((response) => response.json());
  assert.match(projectStatus.runtime.restartCommand, /^npx paqvilo mirage serve --project .*mirage\.project\.yml"?$/);
  assert.equal(projectStatus.ready, true);
  assert.equal(projectStatus.stages.find((item) => item.id === 10).status, 'done');
});

test('linked project files outside the catalogue folder, under .paqvilo/ or not project documents are refused without text or save target', async (t) => {
  const directory = await work(t),
    outside = await work(t),
    filename = path.join(directory, 'paqvilo.config.yml');
  await fs.mkdir(path.join(directory, '.paqvilo'));
  await fs.writeFile(
    path.join(directory, '.paqvilo', 'session-77777777.json'),
    '{"version":1,"token":"never-return-discovery"}',
  );
  await fs.writeFile(path.join(outside, 'private.json'), '{"version":2,"secret":"outside-tree-value"}');
  await fs.writeFile(path.join(directory, 'notes.json'), '{"note":"never-return-notes"}');
  const site = (project) => ({
    source: '.',
    environments: { dev: 'http://127.0.0.1:8787' },
    mirage: { port: 0, project },
  });
  await fs.writeFile(
    filename,
    YAML.stringify({
      sourceRoot: '.',
      defaultSite: 'a',
      sites: {
        a: site('./.paqvilo/session-77777777.json'),
        b: site(path.join(outside, 'private.json')),
        c: site('./notes.json'),
        d: site('../escape.project.yml'),
      },
    }),
  );
  const server = await startSetupServer({ directory, processEnv: {} });
  ownedFixture(t).add(() => server.close());
  const base = new URL(server.url).origin,
    status = await fetch(base + '/_setup/api/status').then((response) => response.json());
  assert.doesNotMatch(JSON.stringify(status), /never-return|outside-tree-value/);
  assert.deepEqual(Object.keys(status.layers).sort(), ['personal', 'shared']);
  assert.deepEqual(
    Object.fromEntries(
      status.findings
        .filter((item) => item.code.startsWith('project-'))
        .map((item) => [item.site, [item.code, item.section]]),
    ),
    {
      a: ['project-outside', '#advanced'],
      b: ['project-outside', '#advanced'],
      c: ['project-invalid', '#advanced'],
      d: ['project-outside', '#advanced'],
    },
  );
  const post = (body) =>
    fetch(base + '/_setup/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Paqvilo-Setup-CSRF': status.csrf },
      body: JSON.stringify(body),
    });
  for (const layer of ['project:a', 'project:b', 'project:c']) {
    const response = await post({
      layer,
      revision: status.revision,
      text: 'version: 2\nruntime:\n  kind: model-driven\nsolutions: []\n',
    });
    assert.equal(response.status, 400, layer);
    assert.match((await response.json()).error.message, /available configuration layer/);
  }
  assert.match(await fs.readFile(path.join(outside, 'private.json'), 'utf8'), /outside-tree-value/);
  assert.match(
    await fs.readFile(path.join(directory, '.paqvilo', 'session-77777777.json'), 'utf8'),
    /never-return-discovery/,
  );
  const link = path.join(directory, 'linked');
  try {
    await fs.symlink(outside, link, 'junction');
  } catch {
    return t.diagnostic('symbolic links are unavailable here');
  }
  await fs.writeFile(
    path.join(outside, 'escape.project.yml'),
    'version: 2\nruntime:\n  kind: model-driven\nsolutions: []\nenvironmentVariables:\n  x_Escaped: never-return-link\n',
  );
  await fs.writeFile(
    filename,
    YAML.stringify({ sourceRoot: '.', defaultSite: 'e', sites: { e: site('./linked/escape.project.yml') } }),
  );
  const escaped = await new SetupStore({ directory, processEnv: {} }).snapshot();
  assert.doesNotMatch(JSON.stringify(escaped), /never-return-link/);
  assert.equal(escaped.layers['project:e'], undefined);
  assert.equal(
    escaped.findings.find((item) => item.site === 'e' && item.code.startsWith('project-'))?.code,
    'project-outside',
  );
});

test('the structured status carries secrets and connection settings as references only', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'paqvilo.config.yml'),
    projectFile = path.join(directory, 'alpha.project.yml');
  const secrets = {
    'invented-vault/api-key': { source: 'environment', variable: 'INVENTED_PRIVATE_VARIABLE' },
    'invented-vault/blob': { source: 'protected', protectedValue: 'SW52ZW50ZWRQcm90ZWN0ZWQ=' },
  };
  const connections = {
    'invented-http': {
      provider: 'http',
      settings: { rewrites: { 'https://api.example.test/': 'http://127.0.0.1:7071/private-rewrite/' } },
    },
  };
  await fs.writeFile(
    projectFile,
    YAML.stringify({ version: 2, runtime: { kind: 'model-driven' }, solutions: [], secrets, connections }),
  );
  await fs.writeFile(
    filename,
    YAML.stringify({
      ...minimal,
      defaults: { mirage: { secrets, connections } },
      sites: {
        portal: { ...minimal.sites.portal, mirage: { port: 0, secrets, connections, project: './alpha.project.yml' } },
      },
    }),
  );
  const status = await new SetupStore({ directory, processEnv: {} }).snapshot();
  const { layers, ...structured } = status;
  for (const text of [
    JSON.stringify(structured),
    JSON.stringify(Object.values(layers).map(({ text: verbatim, ...rest }) => rest)),
  ])
    assert.doesNotMatch(text, /INVENTED_PRIVATE_VARIABLE|SW52ZW50ZWRQcm90ZWN0ZWQ|private-rewrite/);
  const expected = { 'invented-vault/api-key': { kind: 'variable' }, 'invented-vault/blob': { kind: 'protected' } };
  for (const mirage of [
    status.sites[0].mirage,
    status.sites[0].authoredMirage,
    status.settings.defaults.mirage,
    layers['project:portal'].values,
  ]) {
    assert.deepEqual(mirage.secrets, expected);
    assert.deepEqual(mirage.connections['invented-http'], { provider: 'http', settings: ['rewrites'] });
  }
  assert.deepEqual(status.sites[0].effectiveMirage.secrets, expected);
  assert.match(layers.shared.text, /INVENTED_PRIVATE_VARIABLE/, 'the verbatim YAML editor keeps the document');
  const project = await new SetupStore({ directory, project: projectFile, processEnv: {} }).snapshot();
  assert.deepEqual(project.settings.mirage.secrets, expected);
  assert.deepEqual(project.layers.shared.values.secrets, expected);
});

test('setup status exposes every key the guided forms read and writes a new personal layer in block style', async (t) => {
  const directory = await work(t),
    filename = path.join(directory, 'paqvilo.config.yml'),
    projectFile = path.join(directory, 'apps', 'alpha.project.yml');
  await fs.mkdir(path.dirname(projectFile));
  await fs.writeFile(
    projectFile,
    'version: 2\nruntime:\n  kind: model-driven\nsolutions: []\n# flag comment\nenvironmentVariables:\n  x_InventedFlag: "on"\nlcid: 1036\n',
  );
  await fs.writeFile(
    filename,
    YAML.stringify({
      ...minimal,
      includeCaution: true,
      agent: { enabled: true },
      editor: 'code',
      sourceMaps: true,
      defaults: { mirage: { simulation: { level: 'dry-run' } } },
      sites: {
        portal: {
          ...minimal.sites.portal,
          webFiles: { enabled: true },
          inline: { enabled: false },
          markup: { enabled: true },
          mirage: { port: 0, project: './apps/alpha.project.yml' },
        },
      },
    }),
  );
  const store = new SetupStore({ directory, processEnv: {} });
  const status = await store.snapshot();
  assert.deepEqual(
    [
      status.settings.includeCaution,
      status.settings.agent,
      status.settings.editor,
      status.settings.sourceMaps,
      status.settings.defaults,
    ],
    [true, { enabled: true }, 'code', true, { mirage: { simulation: { level: 'dry-run' } } }],
  );
  assert.deepEqual(
    [status.sites[0].webFiles, status.sites[0].inline, status.sites[0].markup],
    [{ enabled: true }, { enabled: false }, { enabled: true }],
  );
  assert.deepEqual(status.layers['project:portal'].values.environmentVariables, { x_InventedFlag: 'on' });
  assert.equal(status.layers['project:portal'].values.lcid, 1036);
  const projectFileStandalone = path.join(directory, 'beta.project.yml');
  await fs.writeFile(
    projectFileStandalone,
    YAML.stringify({
      version: 2,
      defaultPortal: 'beta',
      portals: [{ id: 'beta', path: '.' }],
      references: [{ id: 'dev', origin: 'https://beta.example.test' }],
      presets: ['./pack.mjs'],
      lcid: 1033,
      watch: false,
      stateDirectory: '.paqvilo/beta',
    }),
  );
  const project = await new SetupStore({ directory, project: projectFileStandalone, processEnv: {} }).snapshot();
  assert.deepEqual(
    [
      project.settings.lcid,
      project.settings.watch,
      project.settings.stateDirectory,
      project.settings.references,
      project.settings.presets,
      project.settings.portals,
    ],
    [
      1033,
      false,
      '.paqvilo/beta',
      [{ id: 'dev', origin: 'https://beta.example.test' }],
      ['./pack.mjs'],
      [{ id: 'beta', path: '.' }],
    ],
  );
  await edit(store, 'personal', [set(['sites', 'portal', 'mirage', 'confinePortalPages'], true)]);
  const personal = await fs.readFile(path.join(directory, 'paqvilo.config.local.yml'), 'utf8');
  assert.doesNotMatch(personal, /[{}]/);
  assert.match(personal, /^sites:\n {2}portal:\n {4}mirage:\n {6}confinePortalPages: true\n$/);
});

test('restart drift names the running site and command, is unknown when the identity fails and covers Lense settings', async (t) => {
  const directory = await work(t, 'paqvilo-setup-unit-quoted-~'),
    filename = path.join(directory, 'paqvilo.config.yml');
  const two = {
    ...minimal,
    sites: {
      portal: minimal.sites.portal,
      beta: { source: '.', environments: { dev: 'http://127.0.0.1:8788' }, mirage: { port: 0 } },
    },
  };
  await fs.writeFile(filename, YAML.stringify(two));
  const store = new SetupStore({ directory, config: filename, processEnv: {} });
  const mirage = await createSetupHandler({
    store,
    site: 'beta',
    command: 'mirage serve',
    runtime: { product: 'Mirage' },
  });
  const first = await serve(t, mirage);
  ownedFixture(t).add(() => first.server.close());
  const status = await fetch(first.base + '/_setup/api/status').then((response) => response.json());
  assert.equal(status.runtime.site, 'beta');
  assert.equal(status.runtime.restartCommand, `npx paqvilo mirage serve --config "${filename}" --site beta`);
  assert.equal(status.commandArgs.site, '--site beta');
  assert.match(status.runtime.restartScope, /Mirage runtime/);
  const previous = process.env.MIRAGE_SETUP_RUNTIME;
  process.env.MIRAGE_SETUP_RUNTIME = JSON.stringify({ site: 'beta', command: 'mirage dev' });
  try {
    const launched = await createSetupHandler({ store, runtime: { product: 'Mirage' } });
    const { server, base } = await serve(t, launched);
    ownedFixture(t).add(() => server.close());
    const value = await fetch(base + '/_setup/api/status').then((response) => response.json());
    assert.match(value.runtime.restartCommand, /^npx paqvilo mirage dev --config .* --site beta$/);
  } finally {
    if (previous === undefined) delete process.env.MIRAGE_SETUP_RUNTIME;
    else process.env.MIRAGE_SETUP_RUNTIME = previous;
  }
  // A linked project that does not resolve makes the comparison unknown, never a silent false.
  await fs.writeFile(path.join(directory, 'alpha.project.yml'), 'version: 2\nportals: []\n');
  await fs.writeFile(
    filename,
    YAML.stringify({
      ...two,
      sites: { ...two.sites, beta: { ...two.sites.beta, mirage: { port: 0, project: './alpha.project.yml' } } },
    }),
  );
  const broken = await createSetupHandler({ store, site: 'beta', runtime: { product: 'Mirage' } });
  const { server, base } = await serve(t, broken);
  ownedFixture(t).add(() => server.close());
  let value = await fetch(base + '/_setup/api/status').then((response) => response.json());
  assert.equal(value.runtime.restartRequired, null);
  assert.match(value.runtime.restartReason, /^identity unavailable: .*portal source is required/);
  assert.notEqual(value.stages.find((item) => item.id === 10).status, 'done');
  assert.equal(
    value.findings.find((item) => item.layer === 'project:beta' && item.code === 'configuration').section,
    '#advanced',
  );
  // Lense compares the environments it loaded as well.
  await fs.writeFile(filename, YAML.stringify(two));
  const lense = await createSetupHandler({ store, runtime: { product: 'Lense', site: 'portal' } });
  const lenseServer = await serve(t, lense);
  ownedFixture(t).add(() => lenseServer.server.close());
  value = await fetch(lenseServer.base + '/_setup/api/status').then((response) => response.json());
  assert.equal(value.runtime.restartRequired, false);
  assert.match(value.runtime.restartCommand, /^npx paqvilo lense dev /);
  assert.match(value.runtime.restartScope, /environments/);
  await fs.writeFile(
    filename,
    YAML.stringify({
      ...two,
      sites: { ...two.sites, portal: { ...two.sites.portal, environments: { dev: 'http://127.0.0.1:9797' } } },
    }),
  );
  value = await fetch(lenseServer.base + '/_setup/api/status').then((response) => response.json());
  assert.equal(value.runtime.restartRequired, true);
  assert.deepEqual(
    value.stages.map((item) => item.anchor),
    [
      '#overview',
      '#runtime-configuration',
      '#portals',
      '#packs',
      '#environments',
      '#personas',
      '#providers',
      '#identity',
      '#guidance',
    ],
  );
});

async function serve(t, handler) {
  const server = http.createServer((req, res) => {
    handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server: {
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    },
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

test('a setup server of its own relays the running Mirage preview views read-only and never contacts a Lense portal', async (t) => {
  const directory = await work(t),
    requests = [];
  const preview = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ invented: req.url }));
  });
  await new Promise((resolve) => preview.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => preview.close(resolve)));
  const portalUrl = `http://127.0.0.1:${preview.address().port}`;
  const mirage = await startSetupServer({
    directory,
    processEnv: {},
    runtime: { product: 'Mirage', site: 'portal', portalUrl },
  });
  ownedFixture(t).add(() => mirage.close());
  assert.equal((await (await fetch(new URL('api/status', mirage.url))).json()).runtime.liveProxy, true);
  assert.deepEqual(await (await fetch(new URL('api/runtime/dashboard', mirage.url))).json(), {
    invented: '/_sim/api/dashboard',
  });
  assert.deepEqual(await (await fetch(new URL('api/runtime/preflight?requires=table%3Ax_item', mirage.url))).json(), {
    invented: '/_sim/api/preflight?requires=table%3Ax_item',
  });
  assert.equal(
    (await fetch(new URL('api/runtime/state', mirage.url))).status,
    404,
    'only the listed views are relayed',
  );
  assert.equal((await fetch(new URL('api/runtime/dashboard', mirage.url), { method: 'POST' })).status, 404, 'GET only');
  const lense = await startSetupServer({
    directory,
    processEnv: {},
    runtime: { product: 'Lense', site: 'portal', portalUrl },
  });
  ownedFixture(t).add(() => lense.close());
  assert.equal((await (await fetch(new URL('api/status', lense.url))).json()).runtime.liveProxy, false);
  assert.equal((await fetch(new URL('api/runtime/dashboard', lense.url))).status, 404);
  assert.deepEqual(
    requests,
    ['/_sim/api/dashboard', '/_sim/api/preflight?requires=table%3Ax_item'],
    'a Lense portal is never contacted',
  );
});
