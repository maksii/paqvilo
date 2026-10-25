import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModelDrivenOverlay, readModelDrivenResourceMap } from '../lense/model-driven.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-sidecar-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(root, 'bundle.js'),
    config = path.join(root, 'mapping.json');
  const compiled = 'globalThis.sidecarProof = 42;\n//# sourceMappingURL=bundle.js.map';
  const imported = {
    resources: [{ name: 'demo_bundle.js' }],
    diagnostics: [],
    assets: new Map([
      ['bundle', { name: 'demo_bundle.js', file, data: Buffer.from(compiled), mime: 'text/javascript' }],
    ]),
  };
  const map = {
    version: 3,
    sources: ['src/original.js'],
    sourcesContent: ['globalThis.sidecarProof = 42;'],
    names: [],
    mappings: 'AAAA',
  };
  const write = async (sourceMap = { path: '/WebResources/bundle.js.map', file: 'bundle.js.map' }) => {
    await fs.writeFile(
      config,
      JSON.stringify({
        version: 1,
        resources: [{ path: '/WebResources/demo_bundle.js', resource: 'demo_bundle.js', sourceMap }],
      }),
    );
    return readModelDrivenResourceMap(config, { assets: imported.assets });
  };
  await fs.writeFile(file, compiled);
  await fs.writeFile(path.join(root, 'bundle.js.map'), JSON.stringify(map));
  return { root, imported, map, write };
}

async function request(overlay, pathname, method = 'GET') {
  let response;
  await overlay.handle({
    request: () => ({
      url: () => `http://127.0.0.1:3210${pathname}`,
      method: () => method,
      resourceType: () => 'other',
    }),
    fallback: async () => {},
    fulfill: async (value) => {
      response = value;
    },
  });
  return response;
}

test('explicit sidecars serve only the admitted map, retain embedded original sources and separate coverage', async (t) => {
  const { imported, map, write } = await fixture(t);
  const overlay = createModelDrivenOverlay({ origin: 'http://127.0.0.1:3210', imported, mappings: await write() });
  assert.match(
    (await request(overlay, '/WebResources/demo_bundle.js')).body.toString(),
    /sourceMappingURL=\/WebResources\/bundle.js.map/,
  );
  assert.deepEqual(JSON.parse((await request(overlay, '/WebResources/bundle.js.map')).body), map);
  assert.equal((await request(overlay, '/WebResources/bundle.js.map', 'HEAD')).body.length, 0);
  assert.equal(await request(overlay, '/WebResources/src/original.js'), undefined);
  assert.equal(overlay.report().applied, 1);
  assert.equal(overlay.report().resources.length, 1);
  assert.equal(overlay.report().debuggerMaps.length, 1);
});

test('sidecar directives preserve executable literals resembling source-map comments byte for byte', async (t) => {
  const { imported, write } = await fixture(t);
  const asset = [...imported.assets.values()][0];
  asset.data = Buffer.from(
    'globalThis.literal = "//# sourceMappingURL=looks-like-a-comment";\nglobalThis.block = "/*# sourceMappingURL=another */";',
  );
  const overlay = createModelDrivenOverlay({ origin: 'http://127.0.0.1:3210', imported, mappings: await write() });
  const served = (await request(overlay, '/WebResources/demo_bundle.js')).body;
  assert.equal(served.subarray(0, asset.data.length).toString(), asset.data.toString());
});

test('missing, malformed, oversized and unsafe map contents keep the compiled script executable with diagnostics', async (t) => {
  const { root, imported, map, write } = await fixture(t);
  for (const content of [
    '{broken',
    JSON.stringify({ ...map, sources: ['https://foreign.invalid/code.js'] }),
    JSON.stringify({ ...map, sources: ['../escape.js'] }),
    JSON.stringify({ ...map, sources: ['%2e%2e/escape.js'] }),
    JSON.stringify({ ...map, sources: ['https%3a%2f%2fforeign.invalid/code.js'] }),
    JSON.stringify({ ...map, sources: ['bad%escape'] }),
    ...['???', 'gggg', 'AA', 'AAAAA', 'ACAA', 'AAAA,'].map((mappings) => JSON.stringify({ ...map, mappings })),
    JSON.stringify({ ...map, sourceRoot: 'https://foreign.invalid/' }),
    ' '.repeat(16 * 1024 * 1024 + 1),
    null,
  ]) {
    if (content === null) await fs.rm(path.join(root, 'bundle.js.map'));
    else await fs.writeFile(path.join(root, 'bundle.js.map'), content);
    const overlay = createModelDrivenOverlay({ origin: 'http://127.0.0.1:3210', imported, mappings: await write() });
    assert.equal(overlay.report().debuggerMaps.length, 0);
    assert.equal(overlay.report().diagnostics[0].code, 'MODEL_SOURCE_MAP_INVALID');
    assert.match((await request(overlay, '/WebResources/demo_bundle.js')).body.toString(), /sidecarProof = 42/);
    assert.equal(JSON.stringify(overlay.report()).includes(root), false);
  }
});

test('sidecar configuration rejects source escapes and foreign routes; valid maps obey exact budgets and inline maps stay unchanged', async (t) => {
  const { root, imported, write } = await fixture(t);
  for (const file of [
    '../escape.map',
    '/absolute.map',
    'https://foreign.invalid/x',
    'a\\b.map',
    '%2e%2e/escape.map',
    'bad%escape.map',
  ])
    await assert.rejects(write({ file, path: '/safe.map' }), /confined file/);
  await assert.rejects(write({ file: 'bundle.js.map', path: '//foreign.invalid/map' }), /origin-relative/);
  const mappings = await write(),
    bytes = mappings[0].sourceMap.data.length;
  const duplicateFile = path.join(root, 'duplicate.json');
  const duplicate = {
    path: '/WebResources/demo_bundle.js',
    resource: 'demo_bundle.js',
    sourceMap: { path: '/first.map', file: 'bundle.js.map' },
  };
  await fs.writeFile(
    duplicateFile,
    JSON.stringify({
      version: 1,
      resources: [
        duplicate,
        { ...duplicate, path: '/other.js', sourceMap: { path: '/other.map', file: 'bundle.js.map' } },
      ],
    }),
  );
  await assert.rejects(readModelDrivenResourceMap(duplicateFile, { assets: imported.assets }), /only one source-map/);
  for (const [totalBytes, count] of [
    [bytes - 1, 0],
    [bytes, 1],
  ]) {
    const overlay = createModelDrivenOverlay({
      origin: 'http://127.0.0.1:3210',
      imported,
      mappings,
      sourceMapLimits: { totalBytes },
    });
    assert.equal(overlay.report().debuggerMaps.length, count);
  }
  const smallAsset = createModelDrivenOverlay({
    origin: 'http://127.0.0.1:3210',
    imported,
    mappings,
    sourceMapLimits: { assetBytes: bytes - 1 },
  });
  assert.equal(smallAsset.report().debuggerMaps.length, 0);
  assert.equal(smallAsset.report().diagnostics[0].code, 'MODEL_SOURCE_MAP_LIMIT');
  const asset = [...imported.assets.values()][0];
  asset.data = Buffer.from('globalThis.sidecarProof=42;\n//# sourceMappingURL=data:application/json;base64,e30=');
  const inline = createModelDrivenOverlay({ origin: 'http://127.0.0.1:3210', imported, mappings });
  assert.equal(inline.report().debuggerMaps.length, 0);
  assert.deepEqual((await request(inline, '/WebResources/demo_bundle.js')).body, asset.data);
});
