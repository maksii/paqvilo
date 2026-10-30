import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  ProviderError,
  createStorageRouter,
  storageSettings,
  validateKey,
  assertProvider,
} from '../lib/storage-provider.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';
import { azuriteDescriptor, create as createAzurite, preflight } from '../lib/storage-azurite.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function tempRoot(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'storage-router-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('router defaults: local routes, export web files and a missing cloud attachment route', async (t) => {
  const root = await tempRoot(t);
  const local = createLocalDiskStorage({ root: path.join(root, 'blobs') });
  ownedFixture(t).add(() => local.close());
  const router = createStorageRouter({ providers: { local } });
  assert.deepEqual(router.routes(), {
    dataverseFiles: 'local',
    annotations: 'local',
    portalWebFiles: 'export',
    sharepointDocuments: 'local',
  });
  const files = router.forRoute('dataverseFiles');
  await files.put('x/file', Buffer.from('routed'));
  assert.equal((await local.head('x/file')).size, 6);
  assert.equal(router.forRoute('annotations'), files, 'one guarded instance per provider');
  assert.equal(router.forRoute('portalWebFiles'), null);
  assert.throws(
    () => router.forRoute('portalCloudAttachments'),
    (e) =>
      e instanceof ProviderError &&
      e.code === 'Unsupported' &&
      e.status === 501 &&
      e.diagnostic === 'PROVIDER_ROUTE_MISSING' &&
      /providers\.routes\.portalCloudAttachments/.test(e.message),
  );
  assert.throws(
    () => router.forRoute('x_unknown'),
    (e) => e.diagnostic === 'PROVIDER_ROUTE_UNKNOWN',
  );
  const description = router.describe();
  assert.deepEqual(
    description.providers.map(({ id, level, ready, routes }) => ({ id, level, ready, routes })),
    [
      {
        id: 'local',
        level: 'behaviour',
        ready: true,
        routes: ['dataverseFiles', 'annotations', 'sharepointDocuments'],
      },
    ],
  );
});

test('router reports a declared but uncreated provider as not ready', () => {
  const config = storageSettings({
    storage: { blob: { kind: 'azurite', connectionString: 'env:PAQVILO_INVENTED_AZURITE' } },
    routes: { portalCloudAttachments: 'blob' },
  });
  const router = createStorageRouter({ config });
  assert.throws(
    () => router.forRoute('portalCloudAttachments'),
    (e) => e.code === 'Unavailable' && e.diagnostic === 'PROVIDER_NOT_READY' && e.provider === 'blob',
  );
  assert.deepEqual(
    router.describe().providers.find((p) => p.id === 'blob'),
    { id: 'blob', kind: 'azurite', ready: false, routes: ['portalCloudAttachments'] },
  );
  assert.throws(
    () =>
      createStorageRouter({
        config,
        providers: { blob: { descriptor: { id: 'other', kind: 'x', level: 'contract', operations: [] } } },
      }),
    /declares id 'other'/,
  );
});

test('storageSettings validates kinds, roots, secrets and routes', async (t) => {
  const stateDirectory = await tempRoot(t);
  const settings = storageSettings(
    {
      storage: {
        local: { kind: 'local-disk', root: 'blobs' },
        emulator: { kind: 'azurite', connectionString: 'env:PAQVILO_AZURITE_CONNECTION' },
        custom: { kind: 'pack:invented-pack/blob', options: { region: 'x' } },
      },
      routes: { portalCloudAttachments: 'emulator', annotations: 'custom' },
      messaging: { untouched: true },
    },
    'providers',
    { stateDirectory },
  );
  assert.equal(settings.storage.local.root, path.join(stateDirectory, 'blobs'));
  assert.deepEqual(settings.storage.emulator, {
    kind: 'azurite',
    connectionString: 'env:PAQVILO_AZURITE_CONNECTION',
    container: 'paqvilo',
    start: 'external',
  });
  assert.equal(settings.routes.annotations, 'custom');
  assert.equal(settings.routes.portalWebFiles, 'export');
  assert.deepEqual(settings.messaging, { untouched: true });

  const literal = 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=inventedSecretValue==';
  assert.throws(
    () => storageSettings({ storage: { emulator: { kind: 'azurite', connectionString: literal } } }),
    (e) => {
      assert.match(e.message, /env:NAME reference; literal connection strings are rejected/);
      assert.doesNotMatch(e.message, /inventedSecretValue|AccountKey/);
      return true;
    },
  );
  assert.throws(
    () =>
      storageSettings({ storage: { local: { kind: 'local-disk', root: '../outside' } } }, 'providers', {
        stateDirectory,
      }),
    /must resolve under the state directory/,
  );
  assert.throws(
    () =>
      storageSettings(
        { storage: { local: { kind: 'local-disk', root: path.parse(stateDirectory).root } } },
        'providers',
        { stateDirectory },
      ),
    /must resolve under the state directory/,
  );
  // Without a state directory (dry-run, offline preflight) the same rule checks the root and keeps none: in-memory storage.
  assert.deepEqual(storageSettings({ storage: { local: { kind: 'local-disk', root: 'blobs' } } }).storage.local, {
    kind: 'local-disk',
  });
  assert.throws(
    () => storageSettings({ storage: { local: { kind: 'local-disk', root: '../outside' } } }),
    /must resolve under the state directory/,
  );
  assert.throws(() => storageSettings({ routes: { x_route: 'local' } }), /Unknown providers.routes key 'x_route'/);
  assert.throws(() => storageSettings({ routes: { annotations: 'missing' } }), /unknown storage id 'missing'/);
  assert.throws(() => storageSettings({ routes: { annotations: 'export' } }), /cannot be export/);
  assert.throws(
    () => storageSettings({ storage: { blob: { kind: 's3' } } }),
    /kind must be local-disk, azurite or pack/,
  );
  assert.throws(
    () => storageSettings({ storage: { blob: { kind: 'local-disk', container: 'x' } } }),
    /Unknown providers.storage.blob key 'container'/,
  );
  assert.throws(() => storageSettings({ storage: { blob: { kind: 'azurite' } } }), /connectionString is required/);
  assert.throws(
    () => storageSettings({ storage: { blob: { kind: 'azurite', connectionString: 'env:X', start: 'docker' } } }),
    /start must be external/,
  );
  assert.throws(
    () => storageSettings({ storage: { blob: { kind: 'azurite', connectionString: 'env:X', container: 'Bad_Name' } } }),
    /container must be a Blob container name/,
  );
  assert.throws(() => storageSettings({ storage: { Bad: { kind: 'local-disk' } } }), /id 'Bad'/);
});

test('validateKey normalises case and refuses traversal', () => {
  assert.equal(validateKey('Files/X_Item/A.TXT'), 'files/x_item/a.txt');
  for (const key of ['a/../b', '/a', 'a\\b', 'a\0b', ''])
    assert.throws(
      () => validateKey(key),
      (e) => e.code === 'InvalidKey' && e.status === 400,
    );
  // Empty and . segments alias keys; a list prefix may end with the separator and nothing else.
  for (const key of ['a/./b', 'a//b', 'a/.', 'a/'])
    assert.throws(
      () => validateKey(key),
      (e) => e.code === 'InvalidKey',
    );
  assert.equal(validateKey('Files/X/', null, { prefix: true }), 'files/x/');
  assert.throws(
    () => validateKey('files//', null, { prefix: true }),
    (e) => e.code === 'InvalidKey',
  );
});

test('the azurite kind is contract until configured, and create() without a connection string answers Unavailable', async () => {
  assert.equal(azuriteDescriptor.level, 'contract');
  assert.equal(azuriteDescriptor.kind, 'azurite');
  assert.deepEqual(azuriteDescriptor.requires, ['external-process:azurite', 'secret:connectionString']);
  assert.deepEqual([...azuriteDescriptor.operations].sort(), ['commit', 'delete', 'get', 'head', 'list', 'put', 'sas']);
  assert.throws(() => assertProvider({ descriptor: azuriteDescriptor }), /declared operation 'put' is not a function/);
  const unconfigured = assertProvider(createAzurite({ id: 'blob', env: {} }));
  assert.equal(unconfigured.descriptor.level, 'contract');
  await assert.rejects(
    unconfigured.head('x'),
    (e) => e instanceof ProviderError && e.code === 'Unavailable' && e.status === 503,
  );
});

test('azurite preflight probes a loopback endpoint and reports a closed port', async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url);
    response.writeHead(200).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const up = await preflight({ blobEndpoint: `http://127.0.0.1:${port}/devstoreaccount1?sig=inventedSecret` });
  assert.equal(up.reachable, true);
  assert.equal(up.status, 200);
  assert.deepEqual(seen, ['/devstoreaccount1?restype=service&comp=properties']);
  assert.doesNotMatch(up.message, /inventedSecret/);

  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const down = await preflight({ blobEndpoint: `http://127.0.0.1:${closedPort}/devstoreaccount1`, timeoutMs: 1000 });
  assert.equal(down.reachable, false);
  assert.equal(down.status, null);
  assert.equal(down.diagnostic, 'PROVIDER_UNREACHABLE');
});

test('azurite preflight refuses a non-loopback endpoint without network', async (t) => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('network used');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const result = await preflight({ blobEndpoint: 'https://invented.blob.example.test/container' });
  assert.equal(result.reachable, false);
  assert.equal(result.diagnostic, 'PROVIDER_NOT_LOOPBACK');
  assert.equal(called, false);
  assert.equal((await preflight({ blobEndpoint: 'not a url' })).diagnostic, 'PROVIDER_ENDPOINT_INVALID');
});
