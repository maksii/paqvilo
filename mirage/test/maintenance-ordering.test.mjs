// @test-kind contract: maintenance refactors preserve synchronous route checks and transaction publication boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFlowRoutes } from '../lib/sim-flow-routes.mjs';
import { AssetCache } from '../lib/asset-cache.mjs';
import { mergeChanges } from '../lib/plugin-platform-messages.mjs';
import { appCatalogue } from '../lib/model-driven/catalogue.mjs';
import { DataStore } from '../lib/data.mjs';

// @test-kind contract: maintenance refactors preserve public data-store arguments and overridable metadata evaluation.
test('data-store update delegates positional options and raw input unchanged', () => {
  const values = Array.from({ length: 8 }, () => ({}));
  let received;
  const result = {};
  const store = {
    commitUpdateSteps(...args) {
      received = args;
      return result;
    },
    runRecordSteps(steps) {
      return steps;
    },
  };
  assert.equal(DataStore.prototype.commitUpdate.call(store, ...values), result);
  assert.deepEqual(received, values);
  for (let index = 0; index < values.length; index++) assert.equal(received[index], values[index]);
});

// @test-kind contract: the public plugin phase hook accepts the original positional frame and identity arguments.
test('data-store plugin phase retains positional frame identity', () => {
  const row = { sampleid: 'invented-id' },
    frame = {};
  const store = {};
  DataStore.prototype.afterPluginPhase.call(
    store,
    { logicalName: 'sample', idColumn: 'sampleid' },
    'delete',
    20,
    {},
    row,
    {},
    'invented-id',
    frame,
    undefined,
  );
  assert.equal(store.pluginFrames.get(row), frame);
});

// @test-kind contract: a virtual-column lookup repeats the metadata hook after checking explicit columns.
test('data-store virtual columns observe the second metadata read', () => {
  let reads = 0;
  const store = {
    resolveMapping: () => ({ logicalName: 'sample', idColumn: 'sampleid', schemaComplete: true }),
    fieldDefinitions: () => (++reads === 1 ? {} : { ownerid: { type: 'lookup' } }),
  };
  assert.equal(DataStore.prototype.columnStatus.call(store, 'sample', 'owneridname', {}), 'known');
  assert.equal(reads, 2);
});

// @test-kind contract: uniqueness metadata lookup of a present value retains its precedence even after another validation has failed.
test('data-store uniqueness resolves mapping before reporting another validation refusal of a present value', () => {
  const failure = new Error('invented mapping failure');
  const store = {
    resolveMapping() {
      throw failure;
    },
    applyRuleDefaults: DataStore.prototype.applyRuleDefaults,
    applyRuleSet: DataStore.prototype.applyRuleSet,
    validatePluginRule: DataStore.prototype.validatePluginRule,
  };
  assert.throws(
    () =>
      DataStore.prototype.applyRule.call(
        store,
        { validate: [{ field: 'code', pattern: '^z', unique: true }] },
        { code: 'a' },
        {},
        [],
        'sample',
      ),
    (error) => error === failure,
  );
  assert.throws(
    () =>
      DataStore.prototype.applyRule.call(
        store,
        { validate: [{ field: 'missing', required: true, unique: true }] },
        {},
        {},
        [],
        'sample',
      ),
    (error) => error.code === 'PluginValidation',
  );
});

// @test-kind contract: catalogue diagnostics retain precedence when one authored item has several invalid selectors.
test('navigation missing-view refusal follows a missing web resource refusal', () => {
  const catalogue = appCatalogue({
    metadata: {
      modelDrivenApps: [
        {
          id: 'invented-app',
          navigation: [
            {
              groups: [
                {
                  items: [
                    {
                      id: 'invented-page',
                      kind: 'webresource',
                      webresource: 'missing.html',
                      view: 'missing-view',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  assert.equal(
    catalogue.apps[0].navigation[0].groups[0].items[0].reason,
    'This page selects a view that is not imported for its table.',
  );
});

test('flow administration rejects missing CSRF before yielding to another microtask', async () => {
  const calls = [];
  const routes = createFlowRoutes({ api: {}, csrf: () => 'invented-csrf' });
  const pending = routes(
    { method: 'POST', headers: {} },
    {
      writeHead(status) {
        calls.push(status);
      },
      end(text) {
        calls.push(JSON.parse(text).error.code);
      },
    },
    new URL('http://127.0.0.1/_sim/api/flow-runs'),
  );
  assert.deepEqual(calls, [403, 'Forbidden']);
  assert.equal(await pending, true);
});

test('asset transaction starts manifest publication in the staged enumeration continuation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-transaction-timing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cache = new AssetCache({ directory });
  let publications = 0;
  cache.save = async () => {
    publications++;
  };
  const original = fs.readdir;
  let release, reached;
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fs.readdir = function (folder, ...args) {
    if (path.dirname(folder) === directory && path.basename(folder).startsWith('staging-')) {
      reached();
      return gate;
    }
    return Reflect.apply(original, this, [folder, ...args]);
  };
  try {
    const pending = cache.transaction(async () => ({ invented: true }));
    await ready;
    release([]);
    const observed = await new Promise((resolve) => queueMicrotask(() => resolve(publications)));
    assert.equal(observed, 1);
    assert.deepEqual(await pending, { invented: true });
  } finally {
    fs.readdir = original;
  }
});

// @test-kind contract: a maintenance extraction must retain null-excluding merge relationship matching.
test('merge does not move orphan children when a relationship source key is null', () => {
  const mapping = {
    logicalName: 'sample_parent',
    idColumn: 'sample_parentid',
    fields: {},
    relationships: { children: { many: true, entity: 'sample_child', from: 'optionalkey', to: 'parentkey' } },
  };
  const orphan = { sample_childid: '00000000-0000-0000-0000-000000000003', parentkey: null };
  const store = {
    resolveMapping: () => ({ logicalName: 'sample_child' }),
    tableRows: () => [orphan],
    fieldDefinition: () => undefined,
  };
  const result = mergeChanges(
    store,
    mapping,
    { sample_parentid: '00000000-0000-0000-0000-000000000001' },
    { sample_parentid: '00000000-0000-0000-0000-000000000002', optionalkey: null },
  );
  assert.deepEqual(result.children, []);
});
