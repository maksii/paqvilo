import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { AssetCache } from '../lib/asset-cache.mjs';
import { inventedCrmFont } from './fixtures/crm-font.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const origin = 'https://portal.example.test';
const sourcePath = '/resource/powerappsportal/fonts/CRMMDL2.woff';
const targetPath = '/resource/powerappsportal/fonts/CRMMDL2.woff2';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, kind = 'woff') {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'platform-font-alias-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const cache = await new AssetCache({
    directory,
    origin,
    fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      return new Response(inventedCrmFont(kind), {
        headers: { 'content-type': kind === 'woff2' ? 'font/woff2' : 'font/woff' },
      });
    },
  }).init();
  return { cache, directory, calls };
}

test('explicit platform WOFF2 URL aliases checked WOFF bytes with truthful format after offline restart', async (t) => {
  const { cache, directory } = await fixture(t);
  const report = await cache.capturePublicAlias({ sourcePath, targetPath, requiredCodepoints: [0xe001] });
  assert.deepEqual(report.failures, []);
  const alias = report.captured.find((item) => item.path === targetPath);
  assert.equal(alias.finalPath, sourcePath);
  assert.equal(alias.contentType, 'font/woff');
  assert.equal(alias.fallback.sourceFormat, 'woff');
  const restored = await new AssetCache({
    directory,
    origin,
    fetchImpl: () => {
      throw Error('Offline alias must not fetch');
    },
  }).init();
  const served = await restored.get(targetPath);
  assert.equal(served.headers['content-type'], 'font/woff');
  assert.equal(served.headers['x-sim-asset-source-format'], 'woff');
  assert.equal(served.headers['x-sim-asset-fallback'], 'microsoft-public-cdn-font');
  assert.deepEqual(served.body, inventedCrmFont());
});

for (const [kind, code, requiredCodepoints] of [
  ['wrongFamily', 'ASSET_FONT_FAMILY', [0xe001]],
  ['woff', 'ASSET_FONT_GLYPH_COVERAGE', [0xe002]],
]) {
  test(`platform alias refuses ${code} without registering a target`, async (t) => {
    const { cache } = await fixture(t, kind);
    const report = await cache.capturePublicAlias({ sourcePath, targetPath, requiredCodepoints });
    assert.equal(report.failures[0].code, code);
    assert.equal(await cache.get(targetPath), null);
  });
}

test('finite alias routes refuse foreign source and target before any network request', async (t) => {
  const { cache, calls } = await fixture(t);
  for (const request of [
    { sourcePath: '/other/font.woff', targetPath },
    { sourcePath, targetPath: '/resource/powerappsportal/fonts/another.woff2' },
    { sourcePath, targetPath: 'https://foreign.example/font.woff2' },
  ]) {
    await assert.rejects(cache.capturePublicAlias(request), (error) => error.code === 'ASSET_FONT_ALIAS');
  }
  assert.deepEqual(calls, []);
});

test('an already captured native WOFF2 target wins without an alias or source request', async (t) => {
  const { cache, calls } = await fixture(t, 'woff2');
  const original = await cache.capturePublic([targetPath], { recursive: false });
  assert.deepEqual(original.failures, []);
  const before = calls.length;
  const report = await cache.capturePublicAlias({ sourcePath, targetPath, requiredCodepoints: [0xe001] });
  assert.equal(calls.length, before);
  assert.equal(report.captured.length, 0);
  assert.equal(report.retained[0].sha256, sha(inventedCrmFont('woff2')));
  const served = await cache.get(targetPath);
  assert.deepEqual(served.body, inventedCrmFont('woff2'));
  assert.equal(served.headers['content-type'], 'font/woff2');
  assert.equal(served.headers['x-sim-asset-fallback'], undefined);
});

test('a native capture completing after the initial target check still wins over the alias', async (t) => {
  const { cache } = await fixture(t);
  cache.fetchImpl = async (url) =>
    new Response(inventedCrmFont(new URL(url).pathname === targetPath ? 'woff2' : 'woff'), {
      headers: { 'content-type': new URL(url).pathname === targetPath ? 'font/woff2' : 'font/woff' },
    });
  const get = cache.get.bind(cache);
  let first = true;
  cache.get = async (...args) => {
    const result = await get(...args);
    if (first) {
      first = false;
      const captured = await cache.capturePublic([targetPath], { recursive: false });
      assert.deepEqual(captured.failures, []);
    }
    return result;
  };
  const report = await cache.capturePublicAlias({ sourcePath, targetPath, requiredCodepoints: [0xe001] });
  assert.equal(report.retained[0].sha256, sha(inventedCrmFont('woff2')));
  assert.deepEqual((await cache.get(targetPath)).body, inventedCrmFont('woff2'));
  assert.equal((await cache.get(targetPath)).headers['x-sim-asset-fallback'], undefined);
});

test('ordinary WOFF2 capture retains its strict MIME contract', async (t) => {
  const { cache } = await fixture(t);
  const report = await cache.capturePublic(['/resource/powerappsportal/fonts/ordinary.woff2'], { recursive: false });
  assert.equal(report.captured.length, 0);
  assert.deepEqual(
    report.failures.map((failure) => failure.code),
    ['ASSET_CONTENT_TYPE'],
  );
  assert.equal(await cache.get('/resource/powerappsportal/fonts/ordinary.woff2'), null);
});

test('cache reload rejects false source format and get rechecks font identity beyond a rewritten digest', async (t) => {
  const { cache, directory } = await fixture(t);
  await cache.capturePublicAlias({ sourcePath, targetPath, requiredCodepoints: [0xe001] });
  const file = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  const entry = manifest.assets.find((item) => item.path === targetPath);
  entry.fallback.sourceFormat = 'woff2';
  await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(new AssetCache({ directory, origin }).init(), (error) => error.code === 'ASSET_FONT_PROVENANCE');
  entry.fallback.sourceFormat = 'woff';
  const wrong = inventedCrmFont('wrongFamily');
  entry.sha256 = sha(wrong);
  entry.bytes = wrong.length;
  await fs.writeFile(path.join(directory, entry.sha256 + '.bin'), wrong);
  await fs.writeFile(file, JSON.stringify(manifest));
  const restored = await new AssetCache({ directory, origin }).init();
  await assert.rejects(restored.get(targetPath), (error) => error.code === 'ASSET_FONT_FAMILY');
});
