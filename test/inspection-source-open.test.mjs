import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { selectionEvidenceCurrent } from '../lense/inspection-source-open.mjs';

test('selected-source opening rejects an obsolete frame, document, epoch, source or anchor', async () => {
  const scope = { documentId: 'document-a', frameId: 'frame-a', uiEpoch: 1, sourceRevision: 'source-a' };
  let state = { scope, anchorGeneration: 4, identity: { evidence: { version: 1 } } };
  const document = { getElementById: () => ({ __px: { selectionState: () => state } }) };
  const page = {
    evaluate: async (read, argument) =>
      vm.runInNewContext('(' + read.toString() + ')(argument)', { document, argument }),
  };
  assert.equal(await selectionEvidenceCurrent(page, { scope, anchorGeneration: 4 }), true);
  for (const changed of [
    { documentId: 'document-b' },
    { frameId: 'frame-b' },
    { uiEpoch: 2 },
    { sourceRevision: 'source-b' },
  ]) {
    state = { ...state, scope: { ...scope, ...changed } };
    assert.equal(await selectionEvidenceCurrent(page, { scope, anchorGeneration: 4 }), false);
  }
  state = { ...state, scope, anchorGeneration: 5 };
  assert.equal(await selectionEvidenceCurrent(page, { scope, anchorGeneration: 4 }), false);
  state = { ...state, anchorGeneration: 4, identity: null };
  assert.equal(await selectionEvidenceCurrent(page, { scope, anchorGeneration: 4 }), false);
});

test('a paused or closed inspection target cannot stall or authorize an editor action', async () => {
  const body = { scope: { documentId: 'a', frameId: 'top', uiEpoch: 1, sourceRevision: 'a' }, anchorGeneration: 0 };
  assert.equal(await selectionEvidenceCurrent({ evaluate: () => new Promise(() => {}) }, body, { timeout: 10 }), false);
  assert.equal(await selectionEvidenceCurrent({ isClosed: () => true }, body), false);
  assert.equal(
    await selectionEvidenceCurrent(
      {
        evaluate: async () => {
          throw Error('target unavailable');
        },
      },
      body,
    ),
    false,
  );
  assert.equal(await selectionEvidenceCurrent(null, { scope: { ...body.scope, uiEpoch: 'invalid' } }), false);
  for (const anchorGeneration of [undefined, -1, '0', Infinity])
    assert.equal(await selectionEvidenceCurrent({ evaluate: async () => true }, { ...body, anchorGeneration }), false);
});
