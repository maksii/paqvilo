// @test-kind contract: a Power Pages runtime whose startup fails after host composition closes the providers and owned resources it composed, and reports the startup failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
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

// A loopback port nothing listens on, found by binding an ephemeral one and releasing it.
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// True when nothing accepts a connection on the loopback port.
function connectionRefused(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error) => resolve(error.code === 'ECONNREFUSED'));
  });
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
  const port = await freePort();
  // The source watcher starts after the listener is open; its factory is the sourceWatcher test seam.
  await assert.rejects(
    createSimulator({
      sourceDir: dir,
      port,
      providers: { storage: { s1: { kind: 'pack:fx-pack/blob' } }, routes: { annotations: 's1' } },
      packs: [listingStoragePack(calls)],
      sourceWatcher: () => {
        throw new Error('Invented watcher failed.');
      },
    }),
    { message: 'Invented watcher failed.' },
  );
  assert.ok(calls.includes('provider closed'));
  assert.equal(await connectionRefused(port), true);
});
