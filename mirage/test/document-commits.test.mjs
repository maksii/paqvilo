import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeDocumentCommits } from '../lib/document-commits.mjs';

for (const first of ['frame', 'cdp']) {
  test(`document readiness joins both identity channels (${first} first) without delaying early request labels`, async () => {
    const page = new EventEmitter(),
      cdp = new EventEmitter(),
      frame = {},
      bindings = new Map(),
      documents = [],
      ready = [],
      commits = [];
    let browserBinding;
    page.mainFrame = () => frame;
    page.frames = () => [];
    page.exposeBinding = async (name, callback) => bindings.set(name, callback);
    page.addInitScript = async () => {};
    cdp.send = async (method, value) => {
      if (method === 'Runtime.addBinding') browserBinding = value.name;
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'first' } } };
    };
    const dispose = await observeDocumentCommits(page, cdp, {
      document: (owner, token) => documents.push({ frame: owner, token }),
      ready: (owner, token) => ready.push({ frame: owner, token }),
      commit: (owner, token) => commits.push({ frame: owner, token }),
    });
    try {
      const reportFrame = [...bindings.values()][0],
        token = '1-2-3-4',
        frameReport = () => reportFrame({ frame }, token),
        cdpReport = () =>
          cdp.emit('Runtime.bindingCalled', { name: browserBinding, payload: token, executionContextId: 1 });
      cdp.emit('Runtime.executionContextCreated', {
        context: { id: 1, auxData: { isDefault: true, frameId: 'frame' } },
      });
      await (first === 'frame' ? frameReport() : cdpReport());
      assert.deepEqual(ready, [], 'one channel alone cannot announce document readiness');
      if (first === 'frame')
        assert.deepEqual(documents, [{ frame, token }], 'requests retain their identity while CDP is attaching');
      await (first === 'frame' ? cdpReport() : frameReport());
      assert.deepEqual(documents, [{ frame, token }]);
      assert.deepEqual(ready, [{ frame, token }]);
      cdp.emit('Page.frameNavigated', { frame: { id: 'frame', loaderId: 'second' } });
      assert.deepEqual(commits, [{ frame, token }], 'a ready document can immediately be retired');
    } finally {
      dispose();
    }
  });
}

for (const initial of ['', 'current-loader']) {
  test(`OOPIF readiness waits for its own ${initial ? 'current' : 'empty'} baseline despite the parent tree's historical loader`, async () => {
    const page = new EventEmitter(),
      main = new EventEmitter(),
      child = new EventEmitter(),
      mainFrame = {},
      frame = { isDetached: () => false },
      bindings = new Map(),
      documents = [],
      ready = [],
      commits = [];
    const installed = Promise.withResolvers(),
      baseline = Promise.withResolvers(),
      attached = Promise.withResolvers();
    let browserBinding;
    page.mainFrame = () => mainFrame;
    page.frames = () => [];
    page.exposeBinding = async (name, callback) => bindings.set(name, callback);
    page.addInitScript = async () => {};
    page.context = () => ({ newCDPSession: async () => child });
    frame.evaluate = async () => attached.resolve();
    child.detach = async () => {};
    main.send = async (method) => {
      if (method === 'Page.getFrameTree')
        return {
          frameTree: {
            frame: { id: 'main', loaderId: 'main-loader' },
            childFrames: [{ frame: { id: 'child', loaderId: 'pre-swap-loader' } }],
          },
        };
    };
    child.send = async (method, value) => {
      if (method === 'Runtime.addBinding') {
        browserBinding = value.name;
        installed.resolve();
      }
      if (method === 'Page.getFrameTree') return baseline.promise;
    };
    const dispose = await observeDocumentCommits(page, main, {
      document: (owner, token) => documents.push({ frame: owner, token }),
      ready: (owner, token) => ready.push({ frame: owner, token }),
      commit: (owner, token) => commits.push({ frame: owner, token }),
    });
    try {
      page.emit('frameattached', frame);
      await installed.promise;
      const token = '5-6-7-8';
      await [...bindings.values()][0]({ frame }, token);
      child.emit('Runtime.executionContextCreated', {
        context: { id: 2, auxData: { isDefault: true, frameId: 'child' } },
      });
      child.emit('Runtime.bindingCalled', { name: browserBinding, payload: token, executionContextId: 2 });
      assert.deepEqual(documents, [{ frame, token }]);
      assert.deepEqual(ready, [], 'paired identity alone does not establish the initial loader');
      baseline.resolve({ frameTree: { frame: { id: 'child', loaderId: initial } } });
      await attached.promise;
      assert.deepEqual(commits, [], 'the initial target snapshot cannot retire its own current document');
      if (!initial) {
        assert.deepEqual(ready, [], 'an empty loader cannot retire the document on its next navigation');
        child.emit('Page.frameNavigated', { frame: { id: 'child' } });
        assert.deepEqual(ready, [], 'a missing loader cannot establish document readiness either');
        child.emit('Page.frameNavigated', { frame: { id: 'child', loaderId: 'initial' } });
      }
      assert.deepEqual(ready, [{ frame, token }]);
      child.emit('Page.frameNavigated', { frame: { id: 'child', loaderId: 'replacement' } });
      assert.deepEqual(commits, [{ frame, token }]);
    } finally {
      baseline.resolve({ frameTree: { frame: { id: 'child', loaderId: 'initial' } } });
      dispose();
    }
  });
}
