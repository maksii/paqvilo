// @test-kind contract+security: setup and resource-map APIs preserve callback order and linked-project path confinement.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SetupStore } from '../lense/setup/store.mjs';
import { readModelDrivenResourceMap } from '../lense/model-driven.mjs';
import { OverlaySession } from '../lense/session.mjs';

async function temp(t, label) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), label));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// @test-kind contract: setup save starts its revision recheck before a later validation callback
test('setup save starts its revision recheck before a later validation callback', async (t) => {
  const directory = await temp(t, 'paqvilo-save-order-');
  const events = [];
  let revision = 'original';
  class FakeStore extends SetupStore {
    files() {
      events.push('files:' + revision);
      return Promise.resolve({ revision, shared: 'original', personal: null, projects: {} });
    }
    validate() {
      events.push('validate');
      queueMicrotask(() =>
        queueMicrotask(() => {
          revision = 'changed';
          events.push('changed');
        }),
      );
      return Promise.resolve({});
    }
    snapshot() {
      events.push('snapshot');
      return Promise.resolve({ ok: true });
    }
  }
  const store = new FakeStore({ directory, processEnv: {} });
  assert.deepEqual(await store.save({ layer: 'shared', revision: 'original', text: 'name: example\n' }), { ok: true });
  assert.deepEqual(events.slice(0, 4), ['files:original', 'validate', 'files:original', 'changed']);
  assert.equal(await fs.readFile(path.join(directory, 'paqvilo.config.yml'), 'utf8'), 'name: example\n');
});

// @test-kind contract: setup snapshot starts findings before a later portals callback
test('setup snapshot starts findings before a later portals callback', async () => {
  const events = [];
  const valid = {
    defaultPortal: '',
    runtime: { kind: 'model-driven' },
    solutionRoots: [],
    solutions: [],
    dataPacks: [],
    get portals() {
      events.push('portals');
      queueMicrotask(() => queueMicrotask(() => events.push('marker')));
      return [];
    },
  };
  class FakeStore extends SetupStore {
    files() {
      return Promise.resolve({ shared: '{}', personal: null, projects: {}, refused: {}, revision: 'r' });
    }
    validate() {
      return Promise.resolve(valid);
    }
  }
  const store = new FakeStore({ directory: os.tmpdir(), project: 'fixture.json', processEnv: {} });
  Object.defineProperty(store, 'kind', {
    configurable: true,
    get() {
      events.push('kind');
      return 'project';
    },
  });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.settings.runtime.kind, 'model-driven');
  assert.ok(!snapshot.findings.some((entry) => entry.code === 'configuration'));
  const portalsIndex = events.indexOf('portals');
  assert.ok(portalsIndex >= 0);
  const afterPortals = events.slice(portalsIndex);
  const kindIndex = afterPortals.indexOf('kind');
  const markerIndex = afterPortals.indexOf('marker');
  assert.ok(kindIndex >= 0);
  assert.ok(markerIndex >= 0);
  assert.ok(kindIndex < markerIndex);
});

// @test-kind contract: resource map reads a later asset before a no-sidecar entry yields
test('resource map reads a later asset before a no-sidecar entry yields', async (t) => {
  const directory = await temp(t, 'paqvilo-resource-map-order-');
  const script = path.join(directory, 'bundle.js');
  await fs.writeFile(script, '');
  await fs.writeFile(
    path.join(directory, 'bundle.map'),
    JSON.stringify({ version: 3, sources: ['bundle.js'], names: [], mappings: '' }),
  );
  const file = path.join(directory, 'resources.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      resources: [
        { path: '/first.js', resource: 'first' },
        { path: '/bundle.js', resource: 'bundle', sourceMap: { path: '/bundle.js.map', file: 'bundle.map' } },
      ],
    }),
  );
  const events = [];
  let mime = 'application/javascript';
  const asset = {
    get name() {
      events.push('name');
      queueMicrotask(() => {
        mime = 'text/plain';
        events.push('changed');
      });
      return 'bundle';
    },
    get file() {
      events.push('file');
      return script;
    },
    get mime() {
      events.push('mime:' + mime);
      return mime;
    },
  };
  const result = await readModelDrivenResourceMap(file, { assets: new Map([['key', asset]]) });
  assert.ok(result[1].sourceMap);
  assert.equal(result[1].sourceMapDiagnostic, undefined);
  const mimeIndex = events.indexOf('mime:application/javascript');
  const changedIndex = events.indexOf('changed');
  assert.ok(mimeIndex >= 0);
  assert.ok(changedIndex >= 0);
  assert.ok(mimeIndex < changedIndex);
});

// @test-kind contract: setup linked-project refusals preserve caller directory getter ordering
test('setup linked-project refusals preserve caller directory getter ordering', async (t) => {
  const directory = await temp(t, 'paqvilo-linked-order-');
  const events = [];
  let active = false,
    scheduled = false;
  class FakeStore extends SetupStore {
    linkedProjects() {
      active = true;
      return { first: path.resolve(directory, '..', 'outside-1'), second: path.resolve(directory, '..', 'outside-2') };
    }
  }
  const store = new FakeStore({ directory, processEnv: {} });
  Object.defineProperty(store, 'directory', {
    configurable: true,
    get() {
      if (active) {
        events.push('directory');
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(() => events.push('marker'));
        }
      }
      return directory;
    },
  });
  const result = await store.files();
  assert.deepEqual(events.slice(0, 3), ['directory', 'directory', 'marker']);
  assert.deepEqual(Object.keys(result.refused), ['first', 'second']);
  assert.ok(Object.values(result.refused).every((item) => item.code === 'project-outside'));
});

// @test-kind contract: overlay route reports a rejected upstream fallback before the later marker
test('overlay route reports a rejected upstream fallback before the later marker', async () => {
  const events = [],
    sentinel = new Error('fallback rejected');
  const model = { inlineSources: [], webFiles: [], inactiveSources: [] };
  const cfg = { sourceDir: os.tmpdir(), origin: 'http://127.0.0.1', site: { scope: 'all' }, mirage: {} };
  const session = new OverlaySession(cfg, {
    model,
    baseline: { available: false },
    changedFiles: new Set(),
    disabled: new Set(),
    rewriter: {},
  });
  session.on('fault', (error) => {
    assert.strictEqual(error, sentinel);
    events.push('fault');
  });
  let fallbacks = 0;
  const request = { url: () => cfg.origin + '/safe', method: () => 'GET', resourceType: () => 'fetch' };
  const route = {
    request: () => request,
    fallback() {
      if (++fallbacks !== 1) {
        events.push('recovery');
        return Promise.resolve();
      }
      let i = 0;
      const tick = () =>
        queueMicrotask(() => {
          events.push('tick' + ++i);
          if (i < 20) tick();
        });
      tick();
      return Promise.reject(sentinel);
    },
  };
  await session.route(route);
  for (let i = 0; i < 22; i++) await Promise.resolve();
  assert.equal(fallbacks, 2);
  assert.deepEqual(events.slice(0, 5), ['tick1', 'tick2', 'tick3', 'fault', 'recovery']);
});
