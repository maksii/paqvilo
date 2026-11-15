// @test-kind contract: an inspector guard expires only through its scheduler
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startModelDrivenInspector } from '../lense/model-driven-inspector.mjs';
import { createModelDrivenOverlay } from '../lense/model-driven.mjs';

const origin = 'http://127.0.0.1:4010';

// A page with no browser behind it: every evaluate answers null, except the owned provider disposal, which is held
// until the test releases it. The context's CDP session answers each command the binding start-up reads.
const sessionReplies = {
  'Page.getFrameTree': { frameTree: { frame: { id: 'invented-frame' } } },
  'Page.addScriptToEvaluateOnNewDocument': { identifier: 'invented-script' },
  'Runtime.evaluate': {},
};
function heldPage(onDisposeRequested) {
  const page = new EventEmitter();
  const frame = {
    page: () => page,
    url: () => `${origin}/main.aspx`,
    evaluate: (fn) => {
      if (!String(fn).includes('provider.dispose()')) return Promise.resolve(null);
      onDisposeRequested();
      return new Promise(() => {});
    },
  };
  const session = Object.assign(new EventEmitter(), {
    send: async (method) => sessionReplies[method] ?? {},
    detach: async () => {},
  });
  Object.assign(page, {
    isClosed: () => false,
    url: () => `${origin}/main.aspx`,
    mainFrame: () => frame,
    frames: () => [frame],
    evaluate: frame.evaluate,
    context: () => ({ newCDPSession: async () => session }),
  });
  return page;
}

test('a cleanup call is abandoned only when the guard that the injected scheduler armed expires', async () => {
  const guards = [];
  let disposeIndex = -1;
  let resolveRequested;
  const requested = new Promise((resolve) => {
    resolveRequested = resolve;
  });
  const scheduleGuard = (expire, ms) => {
    const guard = { expire, ms, cancelled: false };
    guards.push(guard);
    return () => {
      guard.cancelled = true;
    };
  };
  const imported = {
    assets: new Map(),
    resources: [],
    layers: [{ dir: origin, documents: [] }],
    diagnostics: [],
  };
  const page = heldPage(() => {
    disposeIndex = guards.length;
    resolveRequested();
  });
  const inspector = await startModelDrivenInspector({
    page,
    overlay: createModelDrivenOverlay({ origin, imported }),
    cfg: { origin, stateDir: 'invented-state', sourceDir: 'invented-source', panel: false },
    imported,
    nativeReadGuardMs: 1000,
    scheduleGuard,
  });
  const closing = inspector.close();
  await requested;
  // The disposal is armed synchronously with its evaluate call, so its guard is the entry recorded at that index.
  const disposal = guards[disposeIndex];
  assert.ok(disposal, 'the disposal guard is armed through the injected scheduler');
  assert.equal(disposal.ms, 1000);
  assert.equal(
    inspector.snapshot().problems.some((item) => item.code === 'cleanup-timed-out'),
    false,
    'a pending disposal is not reported as abandoned before its guard expires',
  );
  disposal.expire();
  await closing;
  const problem = inspector.snapshot().problems.find((item) => item.code === 'cleanup-timed-out');
  assert.match(problem.text, /Owned provider disposal did not answer within 1000 ms/);
  assert.equal(
    guards.every((guard) => guard.cancelled),
    true,
    'every guard the inspector armed is cancelled once its operation has settled',
  );
});
