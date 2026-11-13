// @test-kind contract: owned page binding ownership of running callbacks is Paqvilo runtime behaviour, checked with a fake CDP session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOwnedPageBindings } from '../lense/owned-page-binding.mjs';

const ORIGIN = 'http://localhost:8123';
const MAIN_FRAME = 'main-frame';
const CLEANUP_METHODS = new Set([
  'Page.removeScriptToEvaluateOnNewDocument',
  'Runtime.evaluate',
  'Runtime.removeBinding',
  'detach',
]);
const ORDERED_AFTER_CALLBACK = new Set(['callback settled', 'Runtime.removeBinding', 'detach']);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeCdpSession extends EventEmitter {
  constructor(events) {
    super();
    this.events = events;
    this.channel = null;
    this.detached = deferred();
  }

  send(method, params = {}) {
    this.events.push(method);
    if (method === 'Runtime.addBinding') this.channel = params.name;
    if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: MAIN_FRAME } } });
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return Promise.resolve({ identifier: 'script-1' });
    return Promise.resolve({});
  }

  detach() {
    this.events.push('detach');
    this.detached.resolve();
    return Promise.resolve();
  }
}

class UnansweredReplySession extends FakeCdpSession {
  constructor(events) {
    super(events);
    this.replySent = deferred();
    this.abandon = null;
  }

  send(method, params) {
    if (method !== 'Runtime.callFunctionOn') return super.send(method, params);
    this.events.push(method);
    this.replySent.resolve();
    return new Promise((_, reject) => {
      this.abandon = reject;
    });
  }

  detach() {
    this.abandon?.(new Error('The session detached before the browser answered.'));
    return super.detach();
  }
}

class SilentReplySession extends FakeCdpSession {
  constructor(events) {
    super(events);
    this.replySent = deferred();
  }

  send(method, params) {
    if (method !== 'Runtime.callFunctionOn') return super.send(method, params);
    this.events.push(method);
    this.replySent.resolve();
    return new Promise(() => {});
  }
}

function fakePage(session) {
  return {
    context: () => ({ newCDPSession: async () => session }),
    isClosed: () => false,
    mainFrame: () => ({}),
  };
}

// Delivers one inspect call through the page binding, waits until its callback started, then starts closing the page.
// Returns the event count before close and the close promise, so the caller asserts what close did.
async function closeWhileInspectRuns(session, owned, events, started) {
  session.emit('Runtime.executionContextCreated', {
    context: { id: 7, origin: ORIGIN, auxData: { isDefault: true, frameId: MAIN_FRAME } },
  });
  session.emit('Runtime.bindingCalled', {
    name: session.channel,
    executionContextId: 7,
    payload: JSON.stringify({ id: 1, name: 'inspect', args: [] }),
  });
  await started.promise;
  const beforeClose = events.length;
  const closing = owned.close();
  // under mocked timers nothing can advance on its own: one turn lets a close that does not wait run past its wait
  await new Promise((resolve) => setImmediate(resolve));
  return { beforeClose, closing };
}

test('owned page close keeps cleanup and detach behind a running binding callback and aborts its signal first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const session = new FakeCdpSession(events);
  const started = deferred();
  const release = deferred();
  let observedSignal;
  const owned = await createOwnedPageBindings(fakePage(session), {
    origin: ORIGIN,
    bindings: {
      inspect({ signal }) {
        observedSignal = signal;
        started.resolve();
        return release.promise.then((value) => {
          events.push('callback settled');
          return value;
        });
      },
    },
  });
  const { beforeClose, closing } = await closeWhileInspectRuns(session, owned, events, started);
  assert.deepEqual(
    events.slice(beforeClose).filter((method) => CLEANUP_METHODS.has(method)),
    [],
    'close must not start removing the binding while the callback is running',
  );
  assert.equal(events.includes('detach'), false, 'close must not detach while the callback is running');
  assert.equal(observedSignal.aborted, true, 'close aborts the signal given to the running callback');
  release.resolve('reply');
  await closing;
  assert.deepEqual(
    events.filter((method) => ORDERED_AFTER_CALLBACK.has(method)),
    ['callback settled', 'Runtime.removeBinding', 'detach'],
  );
});

test('close does not wait for a reply the browser has not answered; detaching ends it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const session = new UnansweredReplySession(events);
  const owned = await createOwnedPageBindings(fakePage(session), {
    origin: ORIGIN,
    bindings: {
      inspect: () => 'reply',
    },
  });
  session.emit('Runtime.executionContextCreated', {
    context: { id: 7, origin: ORIGIN, auxData: { isDefault: true, frameId: MAIN_FRAME } },
  });
  session.emit('Runtime.bindingCalled', {
    name: session.channel,
    executionContextId: 7,
    payload: JSON.stringify({ id: 1, name: 'inspect', args: [] }),
  });
  await session.replySent.promise;
  await owned.close();
  assert.equal(events.includes('detach'), true, 'close completes without waiting for the unanswered reply');
});

test('owned page close waits at most one call timeout for a callback that never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const session = new FakeCdpSession(events);
  const started = deferred();
  const owned = await createOwnedPageBindings(fakePage(session), {
    origin: ORIGIN,
    callTimeout: 5000,
    bindings: {
      inspect() {
        started.resolve();
        return new Promise(() => {});
      },
    },
  });
  const { beforeClose, closing } = await closeWhileInspectRuns(session, owned, events, started);
  assert.deepEqual(
    events.slice(beforeClose).filter((method) => CLEANUP_METHODS.has(method)),
    [],
    'close must wait for the call timeout before removing the binding',
  );
  assert.equal(events.includes('detach'), false, 'close must not detach before the call timeout');
  t.mock.timers.tick(5000);
  await closing;
  assert.equal(events.includes('detach'), true, 'after the call timeout close completes its cleanup and detaches');
});

test('close gives up on a reply that even detaching does not end, at the call timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const session = new SilentReplySession(events);
  const owned = await createOwnedPageBindings(fakePage(session), {
    origin: ORIGIN,
    callTimeout: 5000,
    bindings: {
      inspect: () => 'reply',
    },
  });
  session.emit('Runtime.executionContextCreated', {
    context: { id: 7, origin: ORIGIN, auxData: { isDefault: true, frameId: MAIN_FRAME } },
  });
  session.emit('Runtime.bindingCalled', {
    name: session.channel,
    executionContextId: 7,
    payload: JSON.stringify({ id: 1, name: 'inspect', args: [] }),
  });
  await session.replySent.promise;
  const closing = owned.close();
  // the await after the tick reports a rejected close; this chain only records a completed one
  closing.then(() => events.push('closed')).catch(() => {});
  await session.detached.promise;
  assert.equal(events.includes('detach'), true, 'close detaches before waiting for the unanswered reply');
  // under mocked timers nothing can advance on its own: one turn lets a close that does not wait run past its wait
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    events.includes('closed'),
    false,
    'close waits for the call timeout for a reply that detaching did not end',
  );
  t.mock.timers.tick(5000);
  await closing;
  assert.equal(events.at(-1), 'closed', 'after the call timeout close completes without rejecting');
});

test('close gives up on a reply after one call timeout when the page has closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const session = new SilentReplySession(events);
  let closed = false;
  const owned = await createOwnedPageBindings(
    { ...fakePage(session), isClosed: () => closed },
    {
      origin: ORIGIN,
      callTimeout: 5000,
      bindings: {
        inspect: () => 'reply',
      },
    },
  );
  session.emit('Runtime.executionContextCreated', {
    context: { id: 7, origin: ORIGIN, auxData: { isDefault: true, frameId: MAIN_FRAME } },
  });
  session.emit('Runtime.bindingCalled', {
    name: session.channel,
    executionContextId: 7,
    payload: JSON.stringify({ id: 1, name: 'inspect', args: [] }),
  });
  await session.replySent.promise;
  closed = true;
  let finished = false;
  const closing = owned.close().then(() => {
    finished = true;
  });
  // under mocked timers nothing can advance on its own: one turn lets a close that does not wait run past its wait
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, 'close waits one call timeout for a reply on a page that has closed');
  t.mock.timers.tick(5000);
  await closing;
  assert.equal(events.includes('detach'), false, 'a closed page is not detached');
});
