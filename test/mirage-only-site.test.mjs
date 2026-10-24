// A catalogue site from the setup `model-driven` template (no portal export, no environment) is a Mirage-only site:
// init --check, lense list/doctor and mirage init accept it, and portals=all leaves it out of the Lense targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../lense/setup/templates.mjs';
import { loadDevTargets, mirageOnlySite, loadCatalogue } from '../lense/config.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !/^GIT_/i.test(key)));
const run = (...args) => withProcessSlot(() => new Promise((resolve) => execFile(process.execPath, [cli, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }))));

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-only-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  fs.mkdirSync(path.join(dir, 'solutions', 'x_core', 'Other'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'solutions', 'x_core', 'Other', 'Solution.xml'), '<ImportExportXml><SolutionManifest><UniqueName>InventedCore</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>');
  const catalogue = renderTemplate('catalogue', 'model-driven', { id: 'org', root: './solutions/x_core' });
  const file = path.join(dir, 'paqvilo.config.json');
  fs.writeFileSync(file, JSON.stringify(catalogue, null, 2));
  return { dir, file };
}

test('the model-driven template site needs no portal export and no environment', async (t) => {
  const { file } = fixture(t);
  assert.equal(mirageOnlySite(loadCatalogue({ config: file }).sites.org), true);
  // The commands only read the catalogue, so they run concurrently.
  const [check, list, doctor, init] = await Promise.all([
    run('init', path.dirname(file), '--check', '--config', file, '--json'),
    run('lense', 'list', '--config', file, '--json'),
    run('lense', 'doctor', '--config', file, '--all', '--mirage', '--json'),
    run('mirage', 'init', '--config', file, '--site', 'org', '--json'),
  ]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.deepEqual(JSON.parse(check.stdout).todo, []);
  assert.equal(list.status, 0, list.stdout + list.stderr);
  const listed = JSON.parse(list.stdout);
  assert.equal(listed.ok, true);
  assert.equal(listed.sites[0].mirageOnly, true);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  const report = JSON.parse(doctor.stdout).reports[0];
  assert.equal(report.runtime, 'model-driven');
  assert.equal(report.mirage.ready, true);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.deepEqual(JSON.parse(init.stdout).writesFiles, []);
});

test('portals=all keeps a Mirage-only site out of the Lense targets', async (t) => {
  const { dir, file } = fixture(t);
  fs.mkdirSync(path.join(dir, 'portal', 'web-pages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'portal', 'web-files'), { recursive: true });
  const catalogue = JSON.parse(fs.readFileSync(file, 'utf8'));
  catalogue.portals = 'all';
  catalogue.sites.portal = { source: './portal', environments: { local: 'http://127.0.0.1:9' } };
  fs.writeFileSync(file, JSON.stringify(catalogue));
  const { targets, initial } = await loadDevTargets({ config: file }, env);
  assert.deepEqual(targets.map(target => target.siteName), ['portal']);
  assert.equal(initial.siteName, 'portal');
  await assert.rejects(() => loadDevTargets({ config: file, site: 'org', portals: 'selected' }, env), error => error.code === 'mirage_only_site');
});

test('portals=all with only Mirage-only sites: list succeeds and names them, the Lense targets refuse', async (t) => {
  const { file } = fixture(t);
  const catalogue = JSON.parse(fs.readFileSync(file, 'utf8'));
  catalogue.portals = 'all';
  fs.writeFileSync(file, JSON.stringify(catalogue));
  await assert.rejects(() => loadDevTargets({ config: file }, env), error => error.code === 'mirage_only_site' && /\(org\)/.test(error.message));
  const list = await run('lense', 'list', '--config', file, '--json');
  assert.equal(list.status, 0, list.stdout + list.stderr);
  const listed = JSON.parse(list.stdout);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.sites.map(site => [site.name, site.mirageOnly]), [['org', true]]);
});
