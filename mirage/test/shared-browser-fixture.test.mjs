import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { adminPage } from '../test-browser/shared-browser.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('admin browser fixture owns application cleanup before context creation can fail', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-admin-ownership-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const hooks = [],
    calls = [];
  const owner = { after: (hook) => hooks.push(hook) };
  await assert.rejects(
    adminPage(
      owner,
      {
        newContext: async () => {
          throw new Error('invented context creation failure');
        },
      },
      { close: async () => calls.push('app') },
      directory,
    ),
    /context creation failure/,
  );
  for (const hook of hooks) await hook();
  assert.deepEqual(calls, ['app']);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('admin browser fixture still closes its application after a context close fails and retains owned files', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-admin-close-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const hooks = [],
    calls = [];
  const owner = { after: (hook) => hooks.push(hook) };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
  const context = {
    close: async () => {
      calls.push('context');
      throw new Error('invented context close failure');
    },
    newPage: async () => ({ setDefaultTimeout() {}, on() {} }),
  };
  await adminPage(owner, { newContext: async () => context }, { close: async () => calls.push('app') }, directory);
  await assert.rejects(hooks[0](), /context close failure/);
  assert.deepEqual(calls, ['context', 'app']);
  assert.equal((await fs.stat(directory)).isDirectory(), true, 'a failed close never deletes a possibly active root');
});
