import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sourceDebugFixture } from './fixtures/source-debugging.mjs';
import { parseSetting, runtimeOptions, runtimeIdentity } from '../lib/config-keys.mjs';
import { runWithSourceDebugging, debugScript } from '../lib/source-debug.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { fileSourceMapEstimate } from '../../lense/source-map.mjs';

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

test('portal and model-driven assets expose file-backed maps or original bytes when explicitly disabled', async (t) => {
  for (const sourceMaps of [true, false]) {
    await t.test(String(sourceMaps), async (t) => {
      const { root, runtime, script, style, resources } = await sourceDebugFixture(t, { sourceMaps });
      const html = await fetch(runtime.url).then((response) => response.text());
      assert.equal(html.includes('sourceURL='), sourceMaps, 'inline template debugger trailers follow the same policy');
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
          assert.deepEqual(map.sources, [pathToFileURL(path.join(root, source)).href]);
          assert.deepEqual(map.sourcesContent, [original]);
        }
        assert.equal((await fetch(runtime.url + route, { method: 'HEAD' })).status, 200);
      }
    });
  }
});

test('oversized generated model-driven maps are omitted before allocation and source reload restores debugging', async (t) => {
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
});

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
