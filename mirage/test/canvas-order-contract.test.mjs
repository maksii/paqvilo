// @test-kind contract: the Canvas inventory response retains callback and principal ordering at its existing async boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasHandler } from '../lib/canvas-http.mjs';

function responseGate() {
  const events = [];
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const response = {
    destroyed: false,
    headersSent: false,
    body: null,
    setHeader() {},
    writeHead(status) {
      events.push(this.destroyed ? 'head-after-close' : `head:${status}`);
      if (!this.destroyed) this.headersSent = true;
    },
    end(body) {
      events.push(this.destroyed ? 'end-after-close' : 'end');
      if (!this.destroyed) this.body = body;
    },
  };
  const close = () => {
    response.destroyed = true;
    events.push('close');
    resolveClosed();
  };
  return { response, events, close, closed };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('gate timed out')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function exercise({ active }) {
  const gate = responseGate();
  const source = {
    app: { name: 'Invented Canvas' },
    screens: [{ name: 'Home', controls: [] }],
    formulas: [],
    diagnostics: [],
  };
  const handler = createCanvasHandler({
    apps: () => [{ uniqueName: 'sample', source }],
    ...(active
      ? {
          runtime: {},
          principal: () => {
            queueMicrotask(() => queueMicrotask(gate.close));
            return null;
          },
        }
      : { diagnostic: () => queueMicrotask(gate.close) }),
  });
  const req = { method: 'GET', url: '/_apps/canvas/sample?view=inspect', headers: {} };
  assert.equal(handler(req, gate.response), true);
  await bounded(gate.closed);
  // Let any continuation queued by the same close finish before inspecting delivery.
  await Promise.resolve();
  await Promise.resolve();
  return gate;
}

test('inventory response is delivered before a diagnostic-triggered close', async () => {
  const gate = await exercise({ active: false });
  assert.deepEqual(gate.events.slice(0, 3), ['head:200', 'end', 'close']);
  assert.match(gate.response.body, /does not run canvas apps/);
});

test('headless response is delivered before close queued during principal resolution', async () => {
  const gate = await exercise({ active: true });
  assert.deepEqual(gate.events.slice(0, 3), ['head:200', 'end', 'close']);
  assert.match(gate.response.body, /Select a staff user/);
});

test('missing app responds before close queued by catalogue lookup', async () => {
  const gate = responseGate();
  const app = {
    get uniqueName() {
      queueMicrotask(() => queueMicrotask(gate.close));
      return 'other';
    },
  };
  const handler = createCanvasHandler({ apps: () => [app] });
  assert.equal(handler({ method: 'GET', url: '/_apps/canvas/missing?view=inspect', headers: {} }, gate.response), true);
  await gate.closed;
  assert.deepEqual(gate.events, ['head:404', 'end', 'close']);
  assert.notEqual(gate.response.body, null);
});
