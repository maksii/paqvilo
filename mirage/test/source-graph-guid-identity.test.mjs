// Inventory nodes are found by canonical id as well as by name (Task 13): a Solution MissingDependency that names a role, a
// dashboard and a canvas app by GUID only is satisfied by a selected layer that provides them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { inventoryRecord } from '../lib/solution-inventory.mjs';

const ROLE = '77777777-7777-4777-8777-777777777771', DASH = '77777777-7777-4777-8777-777777777772', APP = '77777777-7777-4777-8777-777777777773';
const scan = (ids = true) => ({
  diagnostics: [],
  layers: [
    { index: 0, name: 'fx_base', dir: 'C:/fx/base', solution: { version: '1.0.0.0', missingDependencies: [] } },
    { index: 1, name: 'fx_app', dir: 'C:/fx/app', manifestFile: 'C:/fx/app/Other/Solution.xml', solution: { version: '1.0.0.0', missingDependencies: [
      { required: { type: 20, id: ROLE, displayName: 'Fx Role' }, dependent: { type: 300, schemaName: 'fx_app' } },
      { required: { type: 60, id: DASH }, dependent: { type: 300, schemaName: 'fx_app' } },
      { required: { type: 300, id: APP }, dependent: { type: 60, id: DASH } },
    ] } },
  ],
  inventory: [
    inventoryRecord({ component: 'role', id: ids ? `{${ROLE.toUpperCase()}}` : null, name: 'Fx Role', layer: 0, solution: 'fx_base', source: 'C:/fx/base/Roles/Fx Role.xml', privileges: [] }),
    inventoryRecord({ component: 'dashboard', id: ids ? DASH : null, name: 'Fx Dashboard', layer: 0, solution: 'fx_base', source: 'C:/fx/base/Dashboards/d.xml' }),
    inventoryRecord({ component: 'canvasapp', id: ids ? APP : null, name: 'fx_canvas_1a2b3', layer: 0, solution: 'fx_base', source: 'C:/fx/base/CanvasApps/fx.meta.xml' }),
  ],
});

test('a GUID-only missing dependency resolves through the provided component id', () => {
  const rows = buildSourceGraph({ scan: scan() }).requirements().filter(row => row.layer === 'fx_app');
  assert.deepEqual(rows.map(row => [row.id, row.status]), [
    [`canvasapp:${APP}`, 'satisfied'], [`dashboard:${DASH}`, 'satisfied'], [`role:${ROLE}`, 'satisfied']]);
  assert.ok(!rows.some(row => row.reason === 'SOLUTION_MISSING_DEPENDENCY'));
});

test('an inventory dependency named by GUID resolves, in any case and with braces', () => {
  const graph = buildSourceGraph({ scan: scan() });
  assert.equal(graph.resolve('role', `{${ROLE.toUpperCase()}}`)?.id, 'role:fx role');
  assert.equal(graph.resolve('role', 'Fx Role')?.id, 'role:fx role');
  assert.equal(graph.resolve('dashboard', ROLE), null, 'aliases are per component kind');
});

test('aliases leave node ids and the fingerprint unchanged; without ids the dependencies stay missing', () => {
  const withIds = buildSourceGraph({ scan: scan() }), withoutIds = buildSourceGraph({ scan: scan(false) });
  assert.deepEqual([...withIds.nodes.keys()], [...withoutIds.nodes.keys()]);
  assert.equal(withIds.fingerprint, withoutIds.fingerprint);
  assert.equal(withoutIds.requirements().filter(row => row.reason === 'SOLUTION_MISSING_DEPENDENCY').length, 3);
});
