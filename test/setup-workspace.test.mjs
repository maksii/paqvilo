import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import YAML from 'yaml';
import { SetupStore } from '../lense/setup/store.mjs';
import { startSetupServer } from '../lense/setup/server.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { createFixture } from './fixture.mjs';
import { prepareProject } from '../lense/project-scaffold.mjs';

async function work(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-setup-unit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}
const minimal = { sourceRoot: '.', defaultSite: 'portal', sites: { portal: { source: '.', environments: { dev: 'http://127.0.0.1:8787' }, mirage: { port: 0 } } } };
const set = (path, value) => ({ op: 'set', path, value });
async function edit(store, layer, operations) { const { revision } = await store.snapshot(); return store.save({ revision, layer, operations }); }

test('setup starts in an empty directory without using the bundled catalogue; creates and repairs configuration', async t => {
  const directory = await work(t), store = new SetupStore({ directory, processEnv: {} });
  const empty = await store.snapshot();
  assert.equal(empty.ready, false); assert.equal(empty.layers.shared.exists, false); assert.equal(empty.sites.length, 0);
  await store.save({ revision: empty.revision, layer: 'shared', text: YAML.stringify(minimal) });
  const filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, 'sites: [broken\n');
  const broken = await store.snapshot();
  assert.equal(broken.findings[0].code, 'configuration');
  assert.match(broken.layers.shared.text, /broken/);
  await store.save({ revision: broken.revision, layer: 'shared', text: YAML.stringify(minimal) });
  assert.equal((await store.snapshot()).sites[0].id, 'portal');
});

test('guided edits preserve siblings, comments, environment shorthand and mapping rules', async t => {
  const directory = await work(t), filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, `# Team catalogue\nsourceRoot: .\ndefaultSite: portal\nsites:\n  portal:\n    source: .\n    # Keep scenario ownership\n    mirage:\n      port: 0\n      preset: starter\n    environments:\n      dev: http://127.0.0.1:8787\n      other:\n        url: http://127.0.0.1:8788\n        baseline: HEAD # Pin this per environment\n`);
  const store = new SetupStore({ directory, processEnv: {} });
  await edit(store, 'shared', [set(['sites', 'portal', 'source'], './export'), set(['sites', 'portal', 'environments', 'dev', 'caution'], true),
    { op: 'set', path: ['sites', 'portal', 'routes'], yaml: '- url: /assets/**\n  dir: web-files\n' }]);
  const text = await fs.readFile(filename, 'utf8'), parsed = YAML.parse(text);
  assert.match(text, /# Team catalogue/); assert.match(text, /# Keep scenario ownership/); assert.match(text, /# Pin this per environment/);
  assert.equal(parsed.sites.portal.mirage.preset, 'starter'); assert.equal(parsed.sites.portal.environments.dev.url, 'http://127.0.0.1:8787');
  assert.equal(parsed.sites.portal.environments.dev.caution, true); assert.equal(parsed.sites.portal.routes[0].dir, 'web-files');
});

test('schema failures, dangerous keys and concurrent edits leave original documents intact', async t => {
  const directory = await work(t), filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, YAML.stringify(minimal));
  const store = new SetupStore({ directory, processEnv: {} });
  const original = await fs.readFile(filename, 'utf8'), initial = await store.snapshot();
  for (const operations of [[set(['browser', 'headless'], 'wrong')], [set(['__proto__', 'polluted'], true)], [set(['sites', 'portal', 'mirage', 'observed'], { loginPath: '/SignIn' })], [{ op: 'set', path: ['sites', 'portal', 'routes'], yaml: '[' }]]) {
    await assert.rejects(store.save({ revision: initial.revision, layer: 'shared', operations }));
    assert.equal(await fs.readFile(filename, 'utf8'), original);
  }
  await fs.writeFile(filename, original + '# external edit\n');
  await assert.rejects(store.save({ revision: initial.revision, layer: 'shared', operations: [set(['sourceRoot'], './other')] }), error => error.status === 409);
  const next = await store.snapshot();
  await fs.writeFile(path.join(directory, '.env'), 'PAQVILO_BROWSER=msedge\n');
  await assert.rejects(store.save({ revision: next.revision, layer: 'shared', operations: [] }), error => error.status === 409);
  assert.equal(({}).polluted, undefined);
});

test('personal settings and shell choices show provenance without exposing unrelated .env credentials or discoveries', async t => {
  const directory = await work(t), filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, YAML.stringify(minimal));
  await fs.writeFile(path.join(directory, '.env'), 'PRIVATE_CREDENTIAL=never-return-this\nPAQVILO_BROWSER=chrome\n');
  await fs.mkdir(path.join(directory, '.paqvilo')); await fs.writeFile(path.join(directory, '.paqvilo/session-1.json'), '{"token":"never-return-discovery"}');
  const store = new SetupStore({ directory, processEnv: { PAQVILO_REPO: directory } });
  const before = await fs.readFile(filename, 'utf8');
  const result = await edit(store, 'personal', [set(['browser', 'channel'], 'chromium'), set(['sites', 'portal', 'source'], './personal')]);
  assert.equal(result.settings.effective.PAQVILO_BROWSER.origin, '.env');
  assert.equal(result.settings.effective.PAQVILO_REPO.origin, 'shell');
  assert.equal(result.settings.provenance.sites.portal.sourceDir, 'local config');
  assert.equal(await fs.readFile(filename, 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(result), /never-return/);
  assert.match(await fs.readFile(path.join(directory, '.gitignore'), 'utf8'), /\/paqvilo.config.local.yml/);
  await edit(store, 'personal', [{ op: 'delete', path: ['sites', 'portal', 'source'] }]);
  assert.equal((await store.snapshot()).sites[0].source, '.');
});

test('scaffold setup reports missing folders and packs without executing module code', async t => {
  const directory = await work(t); await prepareProject(directory, { name: 'sample' });
  await fs.writeFile(path.join(directory, 'pack/pack.mjs'), "throw new Error('must not run');\n");
  const snapshot = await new SetupStore({ directory, processEnv: {} }).snapshot();
  assert.equal(snapshot.sites.length, 1);
  assert.ok(snapshot.findings.some(item => item.code === 'missing-source'));
  assert.ok(snapshot.findings.some(item => item.code === 'placeholder-origin'));
  assert.equal(snapshot.sites[0].packs[0].exists, true);
});

test('standalone Mirage projects validate incrementally and retain JSON encoding', async t => {
  const directory = await work(t), filename = path.join(directory, 'mirage.project.json');
  const store = new SetupStore({ directory, project: filename, processEnv: {} });
  let result = await store.snapshot();
  result = await store.save({ revision: result.revision, layer: 'shared', text: JSON.stringify({ version: 2, defaultPortal: 'sample', portals: [{ id: 'sample', path: './not-here' }], solutions: [], dataPacks: [{ id: 'demo', module: './missing.mjs' }] }) });
  assert.ok(result.findings.some(item => item.code === 'missing-source'));
  assert.ok(result.findings.some(item => item.code === 'missing-pack'));
  await edit(store, 'shared', [set(['portals', 0, 'path'], './export')]);
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).portals[0].path, './export');
  await assert.rejects(edit(store, 'shared', [set(['portals', 0, 'solutions'], ['unknown'])]), /unknown solution/);
  await assert.rejects(edit(store, 'personal', []), /available configuration layer/);
});

test('all-target readiness identifies origin and port collisions before a preview starts', async t => {
  const directory = await work(t), store = new SetupStore({ directory, processEnv: {} });
  const config = { ...minimal, portals: 'all', sites: { alpha: { ...minimal.sites.portal, mirage: { port: 8787 } }, beta: { ...minimal.sites.portal, mirage: { port: 8787 } } } };
  const result = await store.save({ revision: (await store.snapshot()).revision, layer: 'shared', text: YAML.stringify(config) });
  assert.ok(result.findings.some(item => item.code === 'duplicate-origin'));
  assert.ok(result.findings.some(item => item.code === 'duplicate-port'));
  const selected = await edit(store, 'shared', [set(['portals'], 'selected')]);
  assert.ok(!selected.findings.some(item => item.code.startsWith('duplicate-')));
});

test('symlinked configuration writes are refused without modifying the destination', async t => {
  const directory = await work(t), actual = path.join(directory, 'actual.yml'), link = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(actual, YAML.stringify(minimal));
  try { await fs.symlink(actual, link); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit file symlinks'); return; } throw error; }
  const store = new SetupStore({ directory, processEnv: {} });
  await assert.rejects(store.save({ layer: 'shared', revision: 'x', operations: [] }), /symbolic links/);
  assert.equal(await fs.readFile(actual, 'utf8'), YAML.stringify(minimal));
});

test('setup HTTP enforces Host, Origin, fetch metadata, CSRF, payload bounds and fixed routes', async t => {
  const directory = await work(t), server = await startSetupServer({ directory, processEnv: {} });
  t.after(() => server.close());
  const base = new URL(server.url).origin;
  const status = await fetch(base + '/_setup/api/status').then(response => response.json());
  assert.equal((await fetch(base + '/_setup/')).status, 200);
  assert.equal((await fetch(base + '/_setup/style.css')).status, 200);
  assert.equal((await fetch(base + '/_setup/api/files')).status, 404);
  assert.equal((await fetch(base + '/_setup/api/status', { headers: { Origin: 'https://hostile.invalid' } })).status, 403);
  assert.equal((await fetch(base + '/_setup/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => { const req = http.get(base + '/_setup/api/status', { headers: { Host: 'hostile.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(wrongHost, 403);
  const payload = { revision: status.revision, layer: 'shared', text: YAML.stringify(minimal) };
  const post = headers => fetch(base + '/_setup/api/config', { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal((await post({ 'Content-Type': 'application/json', Origin: base })).status, 403);
  assert.equal((await post({ 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': status.csrf })).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain', Origin: base, 'X-Paqvilo-Setup-CSRF': status.csrf })).status, 415);
  assert.equal((await post({ 'Content-Type': 'application/json', Origin: base, 'X-Paqvilo-Setup-CSRF': status.csrf })).status, 200);
  const tooLarge = await fetch(base + '/_setup/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Paqvilo-Setup-CSRF': status.csrf }, body: 'x'.repeat(512 * 1024 + 1) });
  assert.equal(tooLarge.status, 413);
});

test('unsafe configuration paths remain inspectable while writes stay disabled', async t => {
  const directory = await work(t);
  await fs.mkdir(path.join(directory, 'paqvilo.config.yml'));
  const server = await startSetupServer({ directory, processEnv: {} }); t.after(() => server.close());
  const response = await fetch(new URL('api/status', server.url));
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.canEdit, false); assert.equal(status.ready, false);
  assert.match(status.findings[0].message, /Repair the selected file path/);
});

test('Mirage serves setup independently from simulation identity/state and reports restart drift', async t => {
  const directory = await work(t), fixture = createFixture(); t.after(() => fixture.cleanup());
  const filename = path.join(directory, 'paqvilo.config.yml');
  await fs.writeFile(filename, YAML.stringify({ ...minimal, sourceRoot: fixture.dir }));
  const simulator = await createSimulator({ sourceDir: fixture.dir, watch: false, setup: { config: filename, processEnv: {} } });
  t.after(() => simulator.close());
  const before = simulator.state();
  const response = await fetch(simulator.setupUrl); assert.equal(response.status, 200);
  const status = await fetch(simulator.url + '/_setup/api/status').then(res => res.json());
  assert.equal(status.runtime.restartRequired, false); assert.equal(status.runtime.product, 'Mirage');
  const saved = await fetch(simulator.url + '/_setup/api/config', { method: 'POST', headers: { Origin: simulator.url, 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': status.csrf }, body: JSON.stringify({ layer: 'shared', revision: status.revision, operations: [set(['sites', 'portal', 'source'], './future-export')] }) }).then(res => res.json());
  assert.equal(saved.runtime.restartRequired, true); assert.equal(saved.runtime.sourceDir, fixture.dir);
  assert.equal(simulator.portal.sourceDir, fixture.dir); assert.equal(simulator.state().revision, before.revision);
});
