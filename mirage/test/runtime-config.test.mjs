import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_KINDS, runtimeSettings, runtimeCapabilities } from '../lib/runtime-config.mjs';
import { createCapabilityRegistry } from '../lib/capability-registry.mjs';
import { resolveProjectConfig } from '../lib/project-config.mjs';
import { appCatalogue } from '../lib/model-driven/catalogue.mjs';

const APP = '77777777-7777-4777-8777-777777777777';
test('runtime profiles preserve portal defaults and validate explicit standalone choices', () => {
  assert.deepEqual(runtimeSettings(), { kind: 'power-pages' });
  assert.equal(runtimeSettings({ kind: 'model-driven', defaultApp: APP }).defaultApp, APP);
  assert.throws(() => runtimeSettings({ kind: 'unknown' }), /kind/);
  assert.throws(() => runtimeSettings({ kind: 'model-driven', defaultApp: 'unknown' }), /GUID/);
  assert.throws(() => runtimeSettings({ kind: 'dataverse-api', defaultApp: APP }), /model-driven/);
});
test('solution-only project configuration does not require or invent a portal', async () => {
  const project = await resolveProjectConfig({ version: 2, runtime: { kind: 'model-driven' }, solutions: [] }, 'invented.project.json', { checkSources: false });
  assert.deepEqual(project.portals, []); assert.equal(project.defaultPortal, null);
  const localized = await resolveProjectConfig({ version: 2, runtime: { kind: 'model-driven' }, solutions: [], dataverse: { localeId: 1036 } }, 'invented.project.json', { checkSources: false });
  assert.equal(localized.lcid, 1036);
  const retained = await resolveProjectConfig({ version: 2, runtime: { kind: 'model-driven' }, portals: [{ id: 'future', path: './not-installed-export' }], defaultPortal: 'future' }, 'invented.project.json');
  assert.equal(retained.portals[0].id, 'future'); assert.equal(retained.defaultPortal, 'future');
  await assert.rejects(resolveProjectConfig({ version: 2, solutions: [] }, 'invented.project.json', { checkSources: false }), /portal source/);
});
test('solution catalogue has no Power Pages provider and chooses an imported default', () => {
  const input = { metadata: { modelDrivenApps: [{ id: APP, uniqueName: 'x_workspace', name: 'Workspace', components: [{ type: 1, entity: 'x_item' }] }] },
    mappings: { x_item: { idColumn: 'x_itemid', nameColumn: 'x_name', fields: { x_name: { type: 'text' } } } } };
  const result = appCatalogue(input);
  assert.equal(result.apps.length, 1); assert.equal(result.defaultApp, APP);
  assert.deepEqual(Object.keys(result.tables), ['x_item']);
  assert.equal(appCatalogue().defaultApp, null);
  assert.throws(() => appCatalogue({ ...input, defaultApp: '88888888-8888-4888-8888-888888888888' }), /not imported/);
});
test('the legacy capability summary is booleans only', () => {
  for (const kind of RUNTIME_KINDS) {
    const registry = createCapabilityRegistry({ runtime: { kind } });
    registry.add({ name: 'setup', kind: 'host-surface', level: 'behaviour' });
    for (const summary of [runtimeCapabilities({ kind }), registry.summary()])
      for (const [key, value] of Object.entries(summary)) assert.equal(typeof value, 'boolean', `${kind} ${key}`);
  }
});
