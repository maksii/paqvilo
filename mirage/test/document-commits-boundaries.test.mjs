// @test-kind contract: late observer messages cannot assign retired document identities to replacements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeDocumentCommits } from '../lib/document-commits.mjs';

async function fixture(t) {
  const page = new EventEmitter(),
    cdp = new EventEmitter(),
    frame = {},
    bindings = new Map();
  const documents = [],
    ready = [],
    commits = [];
  let browserBinding;
  page.mainFrame = () => frame;
  page.frames = () => [];
  page.exposeBinding = async (name, callback) => bindings.set(name, callback);
  page.addInitScript = async () => {};
  cdp.send = async (method, values) => {
    if (method === 'Runtime.addBinding') browserBinding = values.name;
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'first' } } };
  };
  const stop = await observeDocumentCommits(page, cdp, {
    document: (_frame, token) => documents.push(token),
    ready: (_frame, token) => ready.push(token),
    commit: (_frame, token) => commits.push(token),
  });
  t.after(stop);
  const context = () =>
    cdp.emit('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true, frameId: 'frame' } } });
  const report = (token) =>
    cdp.emit('Runtime.bindingCalled', { name: browserBinding, payload: token, executionContextId: 1 });
  const bind = (token) => [...bindings.values()][0]({ frame }, token);
  const navigate = (loaderId) => cdp.emit('Page.frameNavigated', { frame: { id: 'frame', loaderId } });
  context();
  report('1-2-3-4');
  await bind('1-2-3-4');
  assert.deepEqual(ready, ['1-2-3-4']);
  return { cdp, context, report, bind, navigate, documents, ready, commits };
}

test('a document identity is retired once even if its replacement has no handshake', async (t) => {
  const f = await fixture(t);
  f.navigate('second');
  f.navigate('third');
  assert.deepEqual(f.commits, ['1-2-3-4']);
});

test('a committed replacement invalidates old reports before context destruction arrives', async (t) => {
  const f = await fixture(t);
  f.report('1-2-3-4');
  f.navigate('second');
  await f.bind('1-2-3-4');
  assert.deepEqual(f.ready, ['1-2-3-4']);
  assert.deepEqual(f.documents, ['1-2-3-4']);
});

for (const event of ['Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared']) {
  test(`a delayed frame binding cannot reuse identity after ${event}, including a reused context number`, async (t) => {
    const f = await fixture(t);
    // The CDP half of a repeated report arrives while the old context is alive.
    f.report('1-2-3-4');
    f.cdp.emit(event, { executionContextId: 1 });
    f.navigate('second');
    f.context();
    await f.bind('1-2-3-4');
    assert.deepEqual(f.ready, ['1-2-3-4'], 'the late old token must not establish the replacement document');
    assert.deepEqual(f.documents, ['1-2-3-4'], 'known retired contexts must not relabel early requests');
    f.report('5-6-7-8');
    await f.bind('5-6-7-8');
    assert.deepEqual(f.ready, ['1-2-3-4', '5-6-7-8']);
    f.navigate('third');
    assert.deepEqual(f.commits, ['1-2-3-4', '5-6-7-8']);
  });
}
