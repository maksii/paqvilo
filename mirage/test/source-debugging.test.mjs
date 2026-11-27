// @test-kind contract: Mirage's own source-map and original-byte debugging settings and budgets
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sourceDebugFixture } from './fixtures/source-debugging.mjs';
import { createSimulator } from '../api.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { parseSetting, runtimeOptions, runtimeIdentity } from '../lib/config-keys.mjs';
import { runWithSourceDebugging, debugScript } from '../lib/source-debug.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { fileSourceMapEstimate } from '../../lense/source-map.mjs';
import { SCENARIO_HANG_GUARD_MS } from '../../test/helpers/bounded-command.mjs';

test('debug metadata policy stays isolated across concurrent runtime requests', async () => {
  const original = 'window.invented = true;';
  await Promise.all(
    [false, true].map((enabled) =>
      runWithSourceDebugging(enabled, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        const result = debugScript(original, fileURLToPath(new URL('../lib/source-debug.mjs', import.meta.url)));
        assert.equal(result.includes('sourceURL='), enabled);
        assert.equal(result.includes('sourceMappingURL='), enabled);
      }),
    ),
  );
});

test('sourceMaps validates settings, propagates all scopes and invalidates runtime reuse', () => {
  assert.equal(parseSetting('sourceMaps', false), false);
  assert.throws(() => parseSetting('sourceMaps', 'false'), /true or false/);
  for (const scope of ['project', 'portal', 'catalogue'])
    assert.equal(runtimeOptions({ [scope]: { sourceMaps: false } }).sourceMaps, false);
  assert.notDeepEqual(runtimeIdentity({ sourceMaps: true }), runtimeIdentity({ sourceMaps: false }));
});

// Hang guard only: it drives a runtime, the CLI or child processes through this file's fixtures; on a loaded slow host that is slow, not hung.
test(
  'portal and model-driven assets expose file-backed maps or original bytes when explicitly disabled',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    for (const sourceMaps of [true, false]) {
      await t.test(String(sourceMaps), { timeout: SCENARIO_HANG_GUARD_MS }, async (t) => {
        const { root, runtime, script, style, resources } = await sourceDebugFixture(t, { sourceMaps });
        const html = await fetch(runtime.url).then((response) => response.text());
        assert.equal(
          html.includes('sourceURL='),
          sourceMaps,
          'inline template debugger trailers follow the same policy',
        );
        assert.equal(html.includes('sourceMappingURL='), sourceMaps);
        for (const [route, source, original] of [
          ['/debug.js', 'portal/web-files/debug.js', script],
          ['/debug.css', 'portal/web-files/debug.css', style],
          [resources.find((item) => item.name === 'x_/debug.js').url, 'solution/WebResources/debug.js', script],
          [resources.find((item) => item.name === 'x_/debug.css').url, 'solution/WebResources/debug.css', style],
        ]) {
          const response = await fetch(runtime.url + route);
          assert.equal(response.status, 200, route);
          const body = await response.text();
          if (!sourceMaps) assert.equal(body, original, route);
          else {
            const encoded = /sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/.exec(
              body,
            )?.[1];
            assert.ok(encoded, route);
            const map = JSON.parse(Buffer.from(encoded, 'base64').toString());
            assert.deepEqual(map.sources, [pathToFileURL(await fs.realpath(path.join(root, source))).href]);
            assert.deepEqual(map.sourcesContent, [original]);
          }
          assert.equal((await fetch(runtime.url + route, { method: 'HEAD' })).status, 200);
        }
      });
    }
  },
);

test('service worker script requests retain authored bytes and independent validators', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-worker-assets-'));
  const owned = ownedFixture(t);
  owned.remove(() => fs.rm(root, { recursive: true, force: true }));
  const source = 'self.addEventListener("activate", () => {});\n';
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented worker site',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /',
    'sitesetting.yml': 'adx_name: HTTP/Service-Worker-Allowed\nadx_value: /workers/',
    'publishingstate.yml': 'adx_publishingstateid: draft\nadx_name: Draft\nadx_isvisible: false',
    'worker.js.webfile.yml':
      'adx_webfileid: worker\nadx_name: Worker\nadx_parentpageid: home\nadx_partialurl: worker.js',
    'preview.js.webfile.yml':
      'adx_webfileid: preview\nadx_name: Preview worker\nadx_parentpageid: home\nadx_partialurl: preview.js\nadx_publishingstateid: draft',
    'worker.js': source,
    'preview.js': source,
  };
  for (const [file, contents] of Object.entries(files)) await fs.writeFile(path.join(root, file), contents);
  const app = await createSimulator({ sourceDir: root, sourceMaps: true, watch: false, requirePortalSource: true });
  owned.add(() => app.close());
  const url = `${app.url}/worker.js`;
  const debug = await fetch(url);
  assert.match(await debug.text(), /sourceMappingURL=/);
  const debugEtag = debug.headers.get('etag');
  const workerHeaders = { 'service-worker': 'script', 'if-none-match': debugEtag };
  const worker = await fetch(url, { headers: workerHeaders });
  assert.equal(worker.status, 200);
  assert.equal(await worker.text(), source);
  assert.notEqual(worker.headers.get('etag'), debugEtag);
  assert.match(worker.headers.get('content-type'), /^application\/javascript\b/);
  assert.equal(worker.headers.get('service-worker-allowed'), '/workers/');
  assert.equal(worker.headers.get('cache-control'), debug.headers.get('cache-control'));
  assert.equal(worker.headers.get('vary'), 'Accept-Encoding, Service-Worker');
  assert.equal(debug.headers.get('vary'), worker.headers.get('vary'));
  const cached = await fetch(url, {
    headers: { ...workerHeaders, 'if-none-match': worker.headers.get('etag') },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('vary'), worker.headers.get('vary'));
  const unpublished = await fetch(`${app.url}/preview.js`, { headers: workerHeaders, redirect: 'manual' });
  assert.equal(unpublished.status, 302);
  await unpublished.arrayBuffer();
});

// Hang guard only: it drives a runtime, the CLI or child processes through this file's fixtures; on a loaded slow host that is slow, not hung.
test(
  'oversized generated model-driven maps are omitted before allocation and source reload restores debugging',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const { root, runtime, resources, script } = await sourceDebugFixture(t);
    const file = path.join(root, 'solution/WebResources/debug.js');
    const route = runtime.url + resources.find((item) => item.name === 'x_/debug.js').url;
    const original = '\n'.repeat(2 * 1024 * 1024);
    await fs.writeFile(file, original);
    await runtime.reload();
    assert.equal(await fetch(route).then((response) => response.text()), original);
    assert.ok(runtime.state().diagnostics.some((item) => item.code === 'MODEL_SOURCE_MAP_LIMIT'));
    const mapped = script + '\n//# sourceMappingURL=data:application/json;base64,e30=\n';
    await fs.writeFile(file, mapped);
    await runtime.reload();
    assert.equal(await fetch(route).then((response) => response.text()), mapped, 'authored maps remain authoritative');
    await fs.writeFile(file, script);
    await runtime.reload();
    assert.match(await fetch(route).then((response) => response.text()), /sourceMappingURL=/);
  },
);

test('standalone model-driven resources also honor original-byte mode', async (t) => {
  const { runtime, resources, script } = await sourceDebugFixture(t, {
    runtime: { kind: 'model-driven' },
    simulation: { level: 'dry-run' },
    sourceMaps: false,
    sourceDir: undefined,
  });
  const route = resources.find((item) => item.name === 'x_/debug.js').url;
  assert.equal(await fetch(runtime.url + route).then((response) => response.text()), script);
});

test('model-driven map budgets aggregate across assets, cache refusals and reset with the source catalogue', async () => {
  const data = Buffer.from('window.invented = true;');
  const asset = (name) => ({ name, data, file: path.resolve(name), mime: 'text/javascript' });
  let assets = new Map([
    ['/_apps/resources/first', asset('first.js')],
    ['/_apps/resources/other', asset('other.js')],
  ]);
  const diagnostics = [];
  const handler = createModelDrivenHandler({
    clientAssets: () => assets,
    diagnostic: (entry) => diagnostics.push(entry),
    sourceMapLimits: { totalBytes: fileSourceMapEstimate(data.toString(), assets.values().next().value.file) },
  });
  const get = async (name) => {
    const response = {
      setHeader() {},
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler(
      { method: 'GET', headers: { host: '127.0.0.1:8100' } },
      response,
      new URL(`http://127.0.0.1:8100/_apps/resources/${name}`),
    );
    assert.equal(response.status, 200);
    return response.body.toString();
  };
  assert.match(await get('first'), /sourceMappingURL=/);
  assert.equal(await get('other'), data.toString());
  assert.equal(await get('other'), data.toString());
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['MODEL_SOURCE_MAP_LIMIT'],
  );
  assets = new Map([['/_apps/resources/other', asset('other.js')]]);
  assert.match(await get('other'), /sourceMappingURL=/);
});
