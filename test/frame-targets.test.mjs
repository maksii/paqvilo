// @test-kind contract: Lense's out-of-process frame watch (lense/frame-targets.mjs) on a scripted DevTools session: non-flat child commands and events, a frame always resumed, other targets left alone
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchFrameTargets } from '../lense/frame-targets.mjs';

// A parent session that records what it is sent and answers each child command through receivedMessageFromTarget.
function parentSession({ answer = () => ({}) } = {}) {
  const session = new EventEmitter();
  session.sent = [];
  session.send = async (method, params) => {
    session.sent.push({ method, params });
    if (method === 'Target.sendMessageToTarget') {
      const message = JSON.parse(params.message);
      session.sent.at(-1).child = message;
      const result = answer(message);
      queueMicrotask(() =>
        session.emit('Target.receivedMessageFromTarget', {
          sessionId: params.sessionId,
          message: JSON.stringify(result?.error ? { id: message.id, error: result.error } : { id: message.id, result }),
        }),
      );
    }
    return {};
  };
  return session;
}
const childCommands = (session, sessionId) =>
  session.sent.filter((item) => item.params?.sessionId === sessionId && item.child).map((item) => item.child.method);
const frameInfo = { type: 'iframe', targetId: 'frame-target', url: '' };

test('a frame target is instrumented through its non-flat session, then resumed', async () => {
  const parent = parentSession();
  const seen = [];
  let resolveDone;
  const done = new Promise((resolve) => (resolveDone = resolve));
  await watchFrameTargets(parent, async (child, info) => {
    seen.push(info.targetId);
    const tree = await child.send('Page.getFrameTree');
    assert.deepEqual(tree, {});
    // An event of the child target reaches the child session only.
    const events = [];
    child.on('Fetch.requestPaused', (params) => events.push(params.requestId));
    parent.emit('Target.receivedMessageFromTarget', {
      sessionId: 'child-1',
      message: JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId: 'r1' } }),
    });
    parent.emit('Target.receivedMessageFromTarget', {
      sessionId: 'other',
      message: JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId: 'r2' } }),
    });
    assert.deepEqual(events, ['r1']);
    resolveDone();
  });
  assert.deepEqual(parent.sent[0], {
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: false },
  });
  parent.emit('Target.attachedToTarget', { sessionId: 'child-1', targetInfo: frameInfo, waitingForDebugger: true });
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['frame-target']);
  // Set up first, run last.
  assert.deepEqual(childCommands(parent, 'child-1'), ['Page.getFrameTree', 'Runtime.runIfWaitingForDebugger']);
});

test('a frame is resumed when its setup fails, and the failure is reported', async () => {
  const parent = parentSession({
    answer: (message) => (message.method === 'Fetch.enable' ? { error: { message: 'refused' } } : {}),
  });
  const errors = [];
  let resumed;
  const ran = new Promise((resolve) => (resumed = resolve));
  const send = parent.send;
  parent.send = async (method, params) => {
    const answer = await send(method, params);
    if (
      method === 'Target.sendMessageToTarget' &&
      JSON.parse(params.message).method === 'Runtime.runIfWaitingForDebugger'
    )
      resumed();
    return answer;
  };
  await watchFrameTargets(
    parent,
    async (child) => {
      await child.send('Fetch.enable', {});
    },
    { onError: (error) => errors.push(error.message) },
  );
  parent.emit('Target.attachedToTarget', { sessionId: 'child-2', targetInfo: frameInfo, waitingForDebugger: true });
  await ran;
  assert.deepEqual(errors, ['refused']);
});

test('a target that is not a frame is resumed and left; a detached frame session rejects its commands', async () => {
  const parent = parentSession();
  let child;
  const attached = new Promise((resolve) =>
    watchFrameTargets(parent, async (session) => {
      child = session;
      resolve();
    }),
  );
  parent.emit('Target.attachedToTarget', {
    sessionId: 'worker-1',
    targetInfo: { type: 'worker', targetId: 'worker' },
    waitingForDebugger: true,
  });
  parent.emit('Target.attachedToTarget', { sessionId: 'child-3', targetInfo: frameInfo, waitingForDebugger: false });
  await attached;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(childCommands(parent, 'worker-1'), ['Runtime.runIfWaitingForDebugger']);
  assert.ok(
    parent.sent.some((item) => item.method === 'Target.detachFromTarget' && item.params.sessionId === 'worker-1'),
  );
  // A frame that was not waiting is not asked to run.
  assert.deepEqual(childCommands(parent, 'child-3'), []);
  parent.emit('Target.detachedFromTarget', { sessionId: 'child-3' });
  assert.equal(child.closed, true);
  await assert.rejects(child.send('Page.enable'), /detached/);
});
