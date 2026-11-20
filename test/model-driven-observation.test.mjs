// @test-kind contract: Paqvilo's own selection-evidence design: a locally rendered model-driven control gets its source files from the current source index by its exact component key.
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

test('a local render without source files takes the current index files of exactly its component', () => {
  const { enrich } = modelDrivenObservationRuntime();
  const result = enrich(packet(), current);
  assert.deepEqual(result.facts[0].sourceRefIds, ['budget-form'], 'the field gets its own file, not its neighbour');
  assert.deepEqual(
    result.sourceRefs.map((item) => [item.id, item.currentState]),
    [['budget-form', 'available']],
  );
  // Before the provenance call validates this selection the file is pending, not available.
  const pending = enrich(packet(), { sourceRefs: current.sourceRefs });
  assert.deepEqual(
    pending.sourceRefs.map((item) => [item.id, item.currentState]),
    [['budget-form', 'pending']],
  );
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
