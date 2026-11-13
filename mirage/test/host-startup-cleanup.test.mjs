// @test-kind contract: a Power Pages runtime whose startup fails after host composition closes the providers and owned resources it composed, and reports the startup failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// A pack whose storage provider owns a resource; each close is recorded (or fails, when failClose is set).
function storagePack(calls, { failClose = false } = {}) {
  return {
    id: 'fx-pack',
    name: 'Invented',
    description: 'Invented startup cleanup pack',
    matches: () => true,
    presets: () => ({}),
    storageProviders: {
      blob: ({ id, own }) => {
        own({
          close: () => {
            calls.push('owned resource closed');
          },
        });
        return {
          descriptor: { id, kind: 'pack:fx-pack/blob', level: 'contract', operations: [] },
          put: async () => ({}),
          get: async () => null,
          delete: async () => {},
          list: async () => [],
          close: () => {
            calls.push('provider closed');
            if (failClose) throw new Error('Invented provider close failed.');
          },
        };
      },
    },
  };
}

// The message of an error and of every error an aggregate error holds.
const messagesOf = (error) => [error.message, ...(error.errors ?? []).flatMap(messagesOf)];

// A runtime over a website with one home page, whose startup selects a preset that does not exist (fails after composition).
async function failingStartup(t, options) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'host-startup-cleanup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented');
  await fs.writeFile(
    path.join(dir, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  );
  return createSimulator({
    sourceDir: dir,
    port: 0,
    watch: false,
    providers: { storage: { s1: { kind: 'pack:fx-pack/blob' } }, routes: { annotations: 's1' } },
    preset: 'no-such-preset',
    presetConfiguration: 'apply',
    ...options,
  });
}

test('a startup that fails after host composition closes the composed providers and owned resources', async (t) => {
  const calls = [];
  await assert.rejects(failingStartup(t, { packs: [storagePack(calls)] }), { message: 'Preset not found.' });
  assert.deepEqual(
    calls.toSorted((a, b) => a.localeCompare(b)),
    ['owned resource closed', 'provider closed'],
  );
});

test('a failure while closing after a failed startup keeps the startup error and lists the close failure', async (t) => {
  const calls = [];
  const failure = await failingStartup(t, { packs: [storagePack(calls, { failClose: true })] }).catch((error) => error);
  assert.equal(failure.message, 'Preset not found.');
  // The host reports its failed close steps as an aggregate; the provider's own message is in it.
  assert.ok(failure.cleanupErrors.length > 0);
  assert.ok(failure.cleanupErrors.flatMap(messagesOf).includes('Invented provider close failed.'));
  assert.ok(calls.includes('owned resource closed'));
});

// The storage pack with every operation declared, so the startup reads the provider's listing.
function listingStoragePack(calls) {
  const pack = storagePack(calls);
  const blob = pack.storageProviders.blob;
  pack.storageProviders.blob = (context) => {
    const provider = blob(context);
    return {
      ...provider,
      descriptor: { ...provider.descriptor, operations: ['put', 'get', 'delete', 'list'] },
      list: async () => ({ items: [] }),
    };
  };
  return pack;
}

test('a startup that fails after the listener opens closes the listener and the composed providers', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'host-startup-cleanup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented');
  await fs.writeFile(
    path.join(dir, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  );
  const calls = [];
  let listener = null;
  // The source watcher starts after the listener is open; its factory is the sourceWatcher test seam, which receives
  // the bound HTTP server in its context and records it.
  await assert.rejects(
    createSimulator({
      sourceDir: dir,
      port: 0,
      providers: { storage: { s1: { kind: 'pack:fx-pack/blob' } }, routes: { annotations: 's1' } },
      packs: [listingStoragePack(calls)],
      sourceWatcher: (roots, options, context) => {
        listener = context?.server;
        throw new Error('Invented watcher failed.');
      },
    }),
    { message: 'Invented watcher failed.' },
  );
  assert.ok(calls.includes('provider closed'));
  assert.equal(listener?.listening, false);
});

// A started runtime over a website with one home page, closed and cleaned up when the test ends.
async function startHomeSimulator(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'host-startup-cleanup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented');
  await fs.writeFile(
    path.join(dir, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  );
  const sim = await createSimulator({ sourceDir: dir, port: 0, watch: false });
  t.after(() => sim.close());
  return sim;
}

test('a listener error after start-up is recorded as a diagnostic and does not end the runtime', async (t) => {
  const sim = await startHomeSimulator(t);
  // An accept failure under file-descriptor exhaustion arrives as an error event on the started portal listener.
  sim.server.emit('error', Object.assign(new Error('Invented accept failure'), { code: 'EMFILE' }));
  const response = await fetch(`${sim.adminOrigin}/__sim/api/diagnostics`);
  assert.equal(response.status, 200);
  const { diagnostics } = await response.json();
  const found = diagnostics.find((item) => item.code === 'LISTENER_ERROR');
  assert.equal(found?.listener, 'portal');
  assert.equal(found?.message, 'Invented accept failure');
  // A persistent accept failure reports again on every loop turn; the repeat is not recorded again.
  sim.server.emit('error', Object.assign(new Error('Invented accept failure'), { code: 'EMFILE' }));
  const repeated = await (await fetch(`${sim.adminOrigin}/__sim/api/diagnostics`)).json();
  assert.equal(repeated.diagnostics.filter((item) => item.code === 'LISTENER_ERROR').length, 1);
  assert.equal(sim.server.listening, true);
});

test('an error on the administration or apps listener is recorded once and does not end the process', async (t) => {
  const sim = await startHomeSimulator(t);
  for (const listener of [sim.adminServer, sim.appsServer]) {
    listener.emit('error', Object.assign(new Error('Invented accept failure'), { code: 'EMFILE' }));
    listener.emit('error', Object.assign(new Error('Invented accept failure'), { code: 'EMFILE' }));
  }
  const { diagnostics } = await (await fetch(`${sim.adminOrigin}/__sim/api/diagnostics`)).json();
  const found = diagnostics.filter((item) => item.code === 'LISTENER_ERROR');
  assert.deepEqual(
    found.map((item) => item.listener),
    ['admin', 'apps'],
  );
  assert.ok(found.every((item) => item.message === 'Invented accept failure'));
  assert.equal(sim.adminServer.listening, true);
  assert.equal(sim.appsServer.listening, true);
});
