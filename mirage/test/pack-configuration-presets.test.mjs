import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSimulator } from '../server.mjs';
import { DataStore } from '../lib/data.mjs';
import {
  configurationPresetDiagnostics,
  bootstrapPresetLibrary,
  compactBuiltinPresets,
  listPresets,
} from '../packs.mjs';
import { configurationPresetReport } from '../lib/experiment-presets.mjs';
import { fixture, initial } from './fixtures/platform-experiments.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('pack configuration presets are validated, traceable, immutable and opt-in with a dataset', async (t) => {
  const root = await makeTemporaryDirectory(join(tmpdir(), 'mirage-pack-config-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fixture(root);
  const pack = {
    id: 'synthetic',
    name: 'Synthetic',
    description: 'Invented pack',
    matches: () => true,
    presets: () => ({ sample: { name: 'Sample', tables: { item: [] }, configurationPreset: 'synthetic-enabled' } }),
    configurationPresets: [
      {
        id: 'synthetic-enabled',
        name: 'Enabled',
        description: 'Enables an invented feature',
        portalOverrides: { settings: { 'Feature/Example': 'True' }, snippets: { Greeting: 'Pack greeting' } },
      },
      { id: 'synthetic-disabled', name: 'Disabled', platformOverrides: { QueryLinkEntityLimit: 30 } },
      { id: 'synthetic-invalid', name: 'Invalid', portalOverrides: { snippets: { Greeting: { invalid: true } } } },
    ],
  };
  const validation = configurationPresetReport([pack]);
  assert.equal(validation.presets.length, 2);
  assert.match(validation.diagnostics[0].message, /synthetic.*\[2\].*string/);
  const app = await createSimulator({ sourceDir: root, initial: initial(), watch: false, packs: [pack] });
  ownedFixture(t).add(() => app.close());
  const csrf = (await fetch(app.url + '/__sim/api/state?summary=1').then((r) => r.json())).csrf;
  const call = async (path, body = {}, method = 'POST') => {
    const response = await fetch(app.url + '/__sim/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    return { status: response.status, result };
  };
  assert.equal(
    (await fetch(app.url + '/__sim/api/status').then((r) => r.json())).presets.find((p) => p.id === 'sample')
      .configurationPreset,
    'synthetic-enabled',
  );
  assert.equal(
    (await fetch(app.url + '/__sim/api/state?summary=1').then((r) => r.json())).config.presets.find(
      (p) => p.id === 'sample',
    ).configurationPreset,
    'synthetic-enabled',
  );
  assert.equal(
    (await fetch(app.url + '/__sim/api/presets').then((r) => r.json())).find((p) => p.id === 'sample')
      .configurationPreset,
    'synthetic-enabled',
  );
  const listed = await fetch(app.url + '/__sim/api/experiments').then((r) => r.json());
  assert.equal(listed.filter((p) => p.source === 'synthetic').length, 2);
  assert.ok(listed.find((p) => p.id === 'synthetic-enabled').readOnly);
  assert.equal((await call('/experiments', { id: 'synthetic-enabled', name: 'Collision' })).status, 409);
  assert.equal((await call('/experiments/synthetic-enabled', {}, 'DELETE')).status, 403);
  assert.equal((await call('/presets/sample/apply')).status, 200);
  assert.match(await fetch(app.url).then((r) => r.text()), /Source greeting/);
  assert.equal((await call('/presets/sample/apply', { applyConfiguration: true })).status, 200);
  assert.match(await fetch(app.url).then((r) => r.text()), /Pack greeting/);
  const status = await fetch(app.url + '/__sim/api/status').then((r) => r.json());
  assert.equal(status.activeConfigurationPreset.id, 'synthetic-enabled');
  assert.equal(status.activeConfigurationPreset.source, 'synthetic');
  assert.match(status.activeConfigurationPreset.digest, /^[a-f0-9]{64}$/);
  await fetch(app.url + '/_api/items');
  const audit = await fetch(app.url + '/__sim/api/audit/export').then((r) => r.json());
  assert.ok(audit.items.some((row) => row.activeConfigurationPreset?.id === 'synthetic-enabled'));
  assert.equal((await call('/experiments/source-defaults/apply')).status, 200);
  assert.match(await fetch(app.url).then((r) => r.text()), /Source greeting/);
  assert.ok(
    (await fetch(app.url + '/__sim/api/diagnostics').then((r) => r.json())).diagnostics.some(
      (row) => row.code === 'PACK_CONFIGURATION_PRESET_INVALID',
    ),
  );
});

const syntheticPack = () => ({
  id: 'synthetic',
  name: 'Synthetic',
  description: 'Invented pack',
  matches: () => true,
  presets: () => ({ sample: { name: 'Sample', tables: { item: [] }, configurationPreset: 'feature' } }),
  configurationPresets: [
    { id: 'feature', name: 'Feature', portalOverrides: { snippets: { Greeting: 'Pack greeting' } } },
  ],
});
test('configuration preflight reports invalid bodies and unresolved links without exposing values or loading lazy bodies', () => {
  const pack = syntheticPack();
  assert.deepEqual(configurationPresetDiagnostics(pack), []);
  const invalid = {
    ...pack,
    configurationPresets: [
      { id: 'feature', name: 'Feature', portalOverrides: { snippets: { Greeting: { privateValue: 'secret' } } } },
    ],
  };
  const report = configurationPresetDiagnostics(invalid);
  assert.ok(report.some((d) => d.code === 'PACK_CONFIGURATION_PRESET_INVALID'));
  assert.ok(report.some((d) => d.code === 'PACK_CONFIGURATION_PRESET_LINK_UNKNOWN'));
  assert.doesNotMatch(JSON.stringify(report), /secret/);
  assert.ok(
    configurationPresetDiagnostics({ ...pack, presets: () => ({ sample: { configurationPreset: 'missing' } }) }).some(
      (d) => d.code === 'PACK_CONFIGURATION_PRESET_LINK_UNKNOWN',
    ),
  );
  assert.ok(
    configurationPresetDiagnostics({
      ...pack,
      presets: () => ({ sample: { configurationPreset: { invalid: true } } }),
    }).some((d) => d.code === 'PACK_CONFIGURATION_PRESET_LINK_INVALID'),
  );
  assert.deepEqual(
    configurationPresetDiagnostics({
      ...pack,
      presets: () => ({
        sample: {
          configurationPreset: 'feature',
          load() {
            throw new Error('Must stay lazy');
          },
        },
      }),
    }),
    [],
  );
  const other = {
    ...pack,
    id: 'another',
    configurationPresets: [],
    presets: () => ({ another: { configurationPreset: 'feature' } }),
  };
  assert.deepEqual(configurationPresetDiagnostics([pack, other]), []);
  const lazy = {
    ...pack,
    presets: () => ({
      sample: {
        name: 'Lazy sample',
        configurationPreset: 'feature',
        load() {
          throw new Error('Must stay lazy');
        },
      },
    }),
  };
  const library = bootstrapPresetLibrary({ packs: [lazy] });
  const compact = compactBuiltinPresets(library, library);
  assert.equal(compact.sample.configurationPreset, 'feature');
  assert.equal(
    listPresets({ state: { presets: JSON.parse(JSON.stringify(compact)) }, library: {} }).find((p) => p.id === 'sample')
      .configurationPreset,
    'feature',
  );
});
test('startup applies a linked configuration only when explicitly selected', async (t) => {
  const root = await makeTemporaryDirectory(join(tmpdir(), 'mirage-start-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fixture(root);
  for (const apply of [false, true]) {
    const app = await createSimulator({
      sourceDir: root,
      initial: initial(),
      watch: false,
      packs: [syntheticPack()],
      preset: 'sample',
      presetConfiguration: apply ? 'apply' : 'data-only',
    });
    try {
      assert.equal(
        (await fetch(app.url + '/__sim/api/status').then((r) => r.json())).activeConfigurationPreset?.id ?? null,
        apply ? 'feature' : null,
      );
      assert.match(await fetch(app.url).then((r) => r.text()), apply ? /Pack greeting/ : /Source greeting/);
    } finally {
      await app.close();
    }
  }
  const pack = { ...syntheticPack(), presets: () => ({ sample: { name: 'Missing', configurationPreset: 'missing' } }) };
  await assert.rejects(
    createSimulator({
      sourceDir: root,
      initial: initial(),
      watch: false,
      packs: [pack],
      preset: 'sample',
      presetConfiguration: 'apply',
    }),
    /Configuration preset not found: missing/,
  );
  const file = join(root, 'invalid-start.json');
  await assert.rejects(
    createSimulator({
      sourceDir: root,
      stateFile: file,
      initial: initial(),
      watch: false,
      packs: [pack],
      preset: 'sample',
      presetConfiguration: 'apply',
    }),
    /Configuration preset not found: missing/,
  );
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const existing = await createSimulator({ sourceDir: root, stateFile: file, initial: initial(), watch: false });
  await existing.close();
  const before = await fs.readFile(file);
  await assert.rejects(
    createSimulator({
      sourceDir: root,
      stateFile: file,
      initial: initial(),
      watch: false,
      packs: [pack],
      preset: 'sample',
      presetConfiguration: 'apply',
    }),
    /Configuration preset not found: missing/,
  );
  assert.deepEqual(await fs.readFile(file), before);
});
test('a saved preset collision remains readable and removable after a pack upgrade', async (t) => {
  const root = await makeTemporaryDirectory(join(tmpdir(), 'mirage-config-collision-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fixture(root);
  const file = join(root, 'state.json');
  let app = await createSimulator({ sourceDir: root, stateFile: file, initial: initial(), watch: false });
  const call = async (path, body = {}, method = 'POST') => {
    const response = await fetch(app.url + '/__sim/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
      body: JSON.stringify(body),
    });
    return { status: response.status, result: await response.json() };
  };
  assert.equal((await call('/experiments', { id: 'feature', name: 'Saved feature' })).status, 201);
  await app.close();
  app = await createSimulator({
    sourceDir: root,
    stateFile: file,
    initial: initial(),
    watch: false,
    packs: [syntheticPack()],
  });
  ownedFixture(t).add(() => app.close());
  const listed = await fetch(app.url + '/__sim/api/experiments');
  assert.equal(listed.status, 200);
  assert.ok(
    (await listed.json()).some(
      (p) => p.id === 'feature' && p.shadowed && p.diagnostics[0].code === 'CONFIGURATION_PRESET_COLLISION',
    ),
  );
  assert.equal((await fetch(app.url + '/__sim/api/state')).status, 200);
  assert.equal((await call('/experiments', { id: 'feature', name: 'Duplicate' })).status, 409);
  assert.equal((await call('/experiments/source-defaults/apply')).status, 200);
  assert.equal((await call('/presets/sample/apply')).status, 200);
  assert.equal((await call('/experiments/feature', {}, 'DELETE')).status, 200);
  assert.equal((await call('/experiments/feature', {}, 'DELETE')).status, 403);
  assert.equal((await call('/experiments/feature/apply')).status, 200);
  assert.equal(
    (await fetch(app.url + '/__sim/api/diagnostics').then((r) => r.json())).diagnostics.some(
      (d) => d.code === 'CONFIGURATION_PRESET_COLLISION',
    ),
    false,
  );
});

test('a lazy data preset carries its declared configuration link into startup hydration', async (t) => {
  const root = await makeTemporaryDirectory(join(tmpdir(), 'mirage-lazy-start-config-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fixture(root);
  let calls = 0;
  const pack = {
    ...syntheticPack(),
    presets: () => ({
      sample: {
        name: 'Lazy sample',
        configurationPreset: 'feature',
        load() {
          calls++;
          return { tables: { item: [] } };
        },
      },
    }),
  };
  assert.deepEqual(configurationPresetDiagnostics(pack), []);
  assert.equal(calls, 0);
  const library = bootstrapPresetLibrary({ packs: [pack] });
  assert.equal(listPresets({ library }).find((p) => p.id === 'sample').configurationPreset, 'feature');
  assert.equal(calls, 0);
  const app = await createSimulator({
    sourceDir: root,
    initial: initial(),
    watch: false,
    packs: [pack],
    preset: 'sample',
    presetConfiguration: 'apply',
  });
  ownedFixture(t).add(() => app.close());
  assert.equal(
    (await fetch(app.url + '/__sim/api/status').then((r) => r.json())).activeConfigurationPreset.id,
    'feature',
  );
  assert.match(await fetch(app.url).then((r) => r.text()), /Pack greeting/);
  const file = join(root, 'contradictory.json');
  const contradictory = {
    ...pack,
    presets: () => ({
      sample: { configurationPreset: 'feature', load: () => ({ configurationPreset: 'source-defaults' }) },
    }),
  };
  await assert.rejects(
    createSimulator({
      sourceDir: root,
      stateFile: file,
      initial: initial(),
      watch: false,
      packs: [contradictory],
      preset: 'sample',
      presetConfiguration: 'apply',
    }),
    /configurationPreset does not match its lazy descriptor/,
  );
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('summary preset listings retain saved configuration links and builtin identity without bodies', async () => {
  const store = await new DataStore({
    state: {
      presets: {
        saved: {
          name: 'Saved',
          configurationPreset: 'feature',
          userConfigured: true,
          tables: { item: [{ name: 'body-only' }] },
        },
        unavailable: { name: 'Unavailable', builtin: true, builtinVersion: 1, configurationPreset: 'feature' },
      },
    },
  }).init();
  const summary = store.summary(),
    listed = listPresets({ state: summary });
  assert.equal(summary.presets.saved.tables, undefined);
  assert.equal(listed.find((p) => p.id === 'saved').configurationPreset, 'feature');
  assert.equal(listed.find((p) => p.id === 'unavailable').configurationPreset, 'feature');
  assert.equal(listed.find((p) => p.id === 'unavailable').unavailable, true);
});
