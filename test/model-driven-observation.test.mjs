// @test-kind contract: Paqvilo's own selection-evidence design: a locally rendered model-driven control names only the source files Mirage vouches it rendered from, never one the source index merely holds for its key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrivenObservationRuntime } from '../lense/model-driven-observation.mjs';

const scope = { documentId: 'doc', frameId: 'frame', uiEpoch: 1, sourceRevision: '1' };
const control = 'control:aa000000-0000-4000-8000-000000000001:x_budget:body',
  other = 'control:aa000000-0000-4000-8000-000000000001:x_name:body';
const ref = (id, componentKey) => ({ id, componentKey, ref: `${id}.xml`, currentState: 'available' });
const packet = (sourceRefs = []) => ({
  mode: 'local',
  scope,
  anchorGeneration: 3,
  facts: [{ dimension: 'owner', proof: 'mirage-registry', binding: { key: control } }],
  sourceKeys: [control],
  sourceRefs,
  availability: [],
});
const current = {
  validatedScope: scope,
  validatedAnchorGeneration: 3,
  sourceRefs: [ref('budget-form', control), ref('name-form', other)],
};

test('a local render without source files borrows none from the source index', () => {
  const { enrich } = modelDrivenObservationRuntime();
  // Mirage names no file for a component when it cannot vouch for its origin (a row the simulation changed, or metadata
  // read lazily). The index holds the imported file for the same key and cannot tell which: it lends nothing.
  for (const validation of [current, { sourceRefs: current.sourceRefs }]) {
    const result = enrich(packet(), validation);
    assert.deepEqual(result.facts[0].sourceRefIds, []);
    assert.deepEqual(result.sourceRefs, []);
  }
});

test('a local render that names its files keeps them and takes nothing more from the index', () => {
  const { enrich } = modelDrivenObservationRuntime();
  const rendered = { ...ref('budget-form', control), contentRevision: 'r1' };
  const result = enrich(packet([rendered]), {
    ...current,
    sourceRefs: [...current.sourceRefs, ref('budget-extra', control)],
  });
  assert.deepEqual(result.facts[0].sourceRefIds, ['budget-form']);
  assert.deepEqual(
    result.sourceRefs.map((item) => item.id),
    ['budget-form'],
  );
});
