// @test-kind security: an editor open is admitted only for a source the current selection still shows
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

test('an enclosing component definition opens only while the current selection still shows it as usable', async () => {
  const scope = { documentId: 'document-a', frameId: 'frame-a', uiEpoch: 1, sourceRevision: 'source-a' };
  const ref = { key: 'view-key', sourceRevision: 'source-a', contentRevision: 'content-a', status: 'exact' };
  const evidence = (refStatus) => ({
    version: 1,
    source: { status: 'unavailable', refs: [] },
    enclosing: [{ status: 'exact', component: { kind: 'view', key: 'view:a' }, refs: [{ ...ref, status: refStatus }] }],
  });
  let state;
  const document = { getElementById: () => ({ __px: { selectionState: () => state } }) };
  const page = {
    evaluate: async (read, argument) =>
      vm.runInNewContext('(' + read.toString() + ')(argument)', { document, argument }),
  };
  const body = {
    scope,
    anchorGeneration: 1,
    sourceKey: 'view-key',
    sourceRevision: 'source-a',
    contentRevision: 'content-a',
  };
  state = { scope, anchorGeneration: 1, identity: { evidence: evidence('exact') } };
  assert.equal(await selectionEvidenceCurrent(page, body), true);
  for (const refStatus of ['stale', 'conflicting', 'unavailable']) {
    state = { scope, anchorGeneration: 1, identity: { evidence: evidence(refStatus) } };
    assert.equal(await selectionEvidenceCurrent(page, body), false, refStatus);
  }
  state = { scope, anchorGeneration: 1, identity: { evidence: evidence('exact') } };
  assert.equal(await selectionEvidenceCurrent(page, { ...body, contentRevision: 'content-b' }), false);
});
