// Provider readiness (RA1-03, RA1-05): an instantiated storage provider or message bus is satisfied only when its optional
// preflight() answers { ready: true } within 2 s; without preflight() it is declared (placeholder), never satisfied, offline
// and live. preflight({ packs }) reads module paths as createSimulator does. Invented packs and ids; loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { preflight } from '../lib/capability-report.mjs';
import { assertProvider, preflightProvider } from '../lib/storage-provider.mjs';
import { createMemoryStorage } from '../lib/storage-memory.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';

const MEMORY = new URL('../lib/storage-memory.mjs', import.meta.url).href;

async function fixture(t, packSource) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'solution', 'Other'), { recursive: true });
  await fs.writeFile(path.join(root, 'solution', 'Other', 'Solution.xml'), '<ImportExportXml><SolutionManifest><UniqueName>InventedReadiness</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>');
  await fs.writeFile(path.join(root, 'pack.mjs'), packSource);
  return { runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, simulation: { level: 'dry-run' },
    packs: [path.join(root, 'pack.mjs')], dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    providers: { storage: { remote: { kind: 'pack:fx-ready/blob' } }, messaging: { relay: { kind: 'pack:fx-ready/bus' } } } };
}

const PACK = (storage, bus) => `import { createMemoryStorage } from '${MEMORY}';
export default { id: 'fx-ready', name: 'Invented', description: 'Invented', matches: () => true, presets: () => ({}),
  storageProviders: { blob: ({ id }) => { const provider = createMemoryStorage({ id }); ${storage} return provider; } },
  messageProviders: { bus: () => ({ descriptor: { id: 'relay', kind: 'invented' }, send: async () => {} ${bus} }) } };`;

const row = (report, id) => report.requirements.find(item => item.id === id);

async function bothReports(options) {
  const offline = await preflight({ ...options, env: {} });
  const sim = await createSimulator({ ...options, port: 0, watch: false });
  try { return { offline, live: await sim.preflight() }; } finally { await sim.close(); }
}

test('an instantiated provider without preflight() is declared (placeholder) offline and live, never satisfied', async t => {
  const options = await fixture(t, PACK('delete provider.preflight;', ''));
  for (const report of Object.values(await bothReports(options))) {
    for (const id of ['provider:storage/remote', 'provider:messaging/relay']) {
      assert.equal(row(report, id).status, 'placeholder', id);
      assert.deepEqual(row(report, id).resolution, { by: 'declared' });
      assert.match(row(report, id).message, /declares no preflight\(\)/);
    }
  }
});

test('preflight() answers decide: ready is satisfied, not ready is missing with the reason (offline and live)', async t => {
  const options = await fixture(t, PACK("provider.preflight = async () => ({ ready: false, reason: 'invented backend refused' });",
    ", preflight: async () => ({ ready: true })"));
  for (const report of Object.values(await bothReports(options))) {
    assert.equal(row(report, 'provider:storage/remote').status, 'missing');
    assert.match(row(report, 'provider:storage/remote').message, /invented backend refused/);
    assert.equal(row(report, 'provider:messaging/relay').status, 'satisfied');
    assert.equal(row(report, 'provider:storage/local').status, 'satisfied', 'the core local provider implements preflight()');
  }
});

test('preflight({ packs }) loads module paths like createSimulator', async t => {
  const options = await fixture(t, PACK('', ''));
  const report = await preflight({ ...options, env: {} });
  assert.equal(row(report, 'provider:storage/remote').status, 'satisfied', 'the pack named by path supplied the provider');
});

test('preflightProvider is bounded and the contract checks its shape', async t => {
  assert.equal(await preflightProvider({}), null);
  const hung = await preflightProvider({ preflight: () => new Promise(() => {}) }, { timeoutMs: 20 });
  assert.equal(hung.ready, false);
  assert.match(hung.reason, /within 20 ms/);
  assert.deepEqual(await preflightProvider({ preflight: () => { throw new Error('invented throw'); } }), { ready: false, reason: 'invented throw' });
  const memory = createMemoryStorage({ id: 'fx-memory' });
  assert.deepEqual(await preflightProvider(memory), { ready: true, reason: null });
  assert.throws(() => assertProvider(Object.assign(createMemoryStorage({ id: 'fx-bad' }), { preflight: true })), /preflight must be a function/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-preflight-disk-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const disk = createLocalDiskStorage({ root: path.join(root, 'blobs'), id: 'fx-disk' });
  assert.deepEqual(await preflightProvider(disk), { ready: true, reason: null });
  await disk.close();
  assert.equal((await preflightProvider(disk)).ready, false);
});

test('the offline preflight accepts a local-disk root the running host accepts (one root rule)', async (t) => {
  const options = { ...await fixture(t, PACK('', '')), simulation: { level: 'simulation' }, providers: { storage: { local: { kind: 'local-disk', root: 'blobs' } } } };
  const offline = await preflight({ ...options, env: {} });
  assert.ok(offline.requirements.length > 0);
  await assert.rejects(() => preflight({ ...options, providers: { storage: { local: { kind: 'local-disk', root: '../outside' } } }, env: {} }), /must resolve under the state directory/);
  // An absolute root under the state directory, which the running host accepts, passes the offline preflight too.
  const absolute = path.join(options.projectRoot, '.paqvilo', 'mirage', 'blobs');
  assert.ok((await preflight({ ...options, providers: { storage: { local: { kind: 'local-disk', root: absolute } } }, env: {} })).requirements.length > 0);
});
