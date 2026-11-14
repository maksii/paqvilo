import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDataset } from '../lib/data-generation.mjs';
import { applyExperiment } from '../lib/experiment-presets.mjs';
import { createSimulationPersistence } from '../lib/simulation-persistence.mjs';

for (const [name, apply] of [
  ['dataset merge', (state) => mergeDataset(state, {}).state],
  ['configuration preset', (state) => applyExperiment(state, { id: 'source-defaults', name: 'Source defaults' })],
  [
    'simulation persistence',
    async (state) => (await createSimulationPersistence({ settings: { level: 'dry-run' } })).load(state),
  ],
]) {
  test(`${name} detaches bulk state without a complete native serialization buffer`, async () => {
    const rows = Array.from({ length: 100000 }, (_, i) => ({ widgetid: String(i), name: 'Invented ' + i }));
    const state = {
      mappings: { widget: { idColumn: 'widgetid' }, other: { idColumn: 'widgetid' } },
      tables: { widget: rows, other: [rows[0]] },
      permissions: [],
      simulator: {},
    };
    const native = globalThis.structuredClone;
    let output;
    try {
      globalThis.structuredClone = (value, ...options) => {
        if (value?.tables?.widget?.length >= 100000) throw new Error('Whole-state native serialization is unavailable');
        return native(value, ...options);
      };
      output = await apply(state);
    } finally {
      globalThis.structuredClone = native;
    }
    assert.equal(output.tables.widget.length, 100000);
    assert.equal(output.tables.widget.at(-1).widgetid, '99999');
    assert.equal(output.tables.widget[0], output.tables.other[0]);
    assert.notEqual(output.tables.widget[0], rows[0]);
    output.tables.widget[0].name = 'Changed';
    assert.equal(rows[0].name, 'Invented 0');
  });
}
