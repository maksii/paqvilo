// @test-kind contract: one gesture-trace helper drives the three single-page clients
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGestureTrace } from '../lib/trace-gesture.js';

const PAGE = { traceId: 'trace-page', spanId: 'span-page' };

// A window that records its listeners, so a test can deliver the events a browser would.
function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, listener, capture) {
      listeners.set(type, [...(listeners.get(type) ?? []), { listener, capture }]);
    },
    dispatch(type, event) {
      for (const { listener } of listeners.get(type) ?? []) listener(event);
    },
    types: () => [...listeners.keys()].sort(),
  };
}

// The window and crypto globals the helper reads at call time, restored after the test.
function stubGlobals(t, { window, uuids = [] } = {}) {
  const saved = [
    ['window', Object.getOwnPropertyDescriptor(globalThis, 'window')],
    ['crypto', Object.getOwnPropertyDescriptor(globalThis, 'crypto')],
  ];
  let next = 0;
  if (window) Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true });
  else delete globalThis.window;
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => uuids[next++] ?? `uuid-${next}` },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  });
}

const answer = (traceId, spanId) => ({
  headers: new Headers({ 'x-trace-id': traceId, ...(spanId ? { 'x-sim-span-id': spanId } : {}) }),
});

test('before any gesture the calls carry the page headers', (t) => {
  stubGlobals(t, { window: fakeWindow() });
  const trace = createGestureTrace();
  assert.deepEqual(trace.headersFor(PAGE), { 'X-Trace-Id': 'trace-page', 'X-Sim-Parent-Trace': 'span-page' });
});

test('a trusted keydown starts an activity linked to the page span, and the answer parents its later calls', (t) => {
  const win = fakeWindow();
  stubGlobals(t, { window: win, uuids: ['gesture-1'] });
  const trace = createGestureTrace();
  assert.deepEqual(win.types(), ['keydown', 'pointerdown'], 'the helper listens for pointer and key gestures');
  win.dispatch('keydown', { isTrusted: true });
  assert.deepEqual(trace.headersFor(PAGE), { 'X-Trace-Id': 'gesture-1', 'X-Sim-Parent-Request': 'span-page' });
  assert.deepEqual(
    trace.headersFor(PAGE),
    { 'X-Trace-Id': 'gesture-1', 'X-Sim-Parent-Request': 'span-page' },
    'a call before the first answer keeps the activity without starting another',
  );
  trace.noteAnswer(answer('gesture-1', 'span-answer'));
  assert.deepEqual(trace.headersFor(PAGE), { 'X-Trace-Id': 'gesture-1', 'X-Sim-Parent-Trace': 'span-answer' });
});

test('an answer of another trace does not name the span of the activity', (t) => {
  const win = fakeWindow();
  stubGlobals(t, { window: win, uuids: ['gesture-1'] });
  const trace = createGestureTrace();
  win.dispatch('pointerdown', { isTrusted: true });
  trace.headersFor(PAGE);
  trace.noteAnswer(answer('other-trace', 'span-other'));
  assert.deepEqual(trace.headersFor(PAGE), { 'X-Trace-Id': 'gesture-1', 'X-Sim-Parent-Request': 'span-page' });
});

test('an untrusted event changes nothing', (t) => {
  const win = fakeWindow();
  stubGlobals(t, { window: win, uuids: ['gesture-1'] });
  const trace = createGestureTrace();
  win.dispatch('keydown', { isTrusted: false });
  win.dispatch('pointerdown', { isTrusted: false });
  assert.deepEqual(trace.headersFor(PAGE), { 'X-Trace-Id': 'trace-page', 'X-Sim-Parent-Trace': 'span-page' });
});

test('with only the page trace id a gesture keeps the page trace id and sends no parent header', (t) => {
  const win = fakeWindow();
  stubGlobals(t, { window: win, uuids: ['gesture-1'] });
  const trace = createGestureTrace();
  const traceOnly = { traceId: 'trace-page', spanId: '' };
  assert.deepEqual(trace.headersFor(traceOnly), { 'X-Trace-Id': 'trace-page' });
  win.dispatch('keydown', { isTrusted: true });
  assert.deepEqual(trace.headersFor(traceOnly), { 'X-Trace-Id': 'trace-page' });
  trace.noteAnswer(answer('trace-page', 'span-answer'));
  assert.deepEqual(trace.headersFor(traceOnly), { 'X-Trace-Id': 'trace-page' });
});

test('each page header that has a value is sent alone', (t) => {
  stubGlobals(t, { window: fakeWindow() });
  const trace = createGestureTrace();
  assert.deepEqual(trace.headersFor({ traceId: '', spanId: 'span-page' }), { 'X-Sim-Parent-Trace': 'span-page' });
  assert.deepEqual(trace.headersFor({ traceId: 'trace-page' }), { 'X-Trace-Id': 'trace-page' });
  assert.deepEqual(trace.headersFor({}), {});
});

test('reset returns to the page headers', (t) => {
  const win = fakeWindow();
  stubGlobals(t, { window: win, uuids: ['gesture-1'] });
  const trace = createGestureTrace();
  win.dispatch('keydown', { isTrusted: true });
  trace.headersFor(PAGE);
  trace.noteAnswer(answer('gesture-1', 'span-answer'));
  trace.reset();
  assert.deepEqual(trace.headersFor(PAGE), { 'X-Trace-Id': 'trace-page', 'X-Sim-Parent-Trace': 'span-page' });
});

test('without a window the helper listens to nothing and sends the page headers', (t) => {
  stubGlobals(t, { window: undefined });
  const trace = createGestureTrace();
  assert.deepEqual(trace.headersFor(PAGE), { 'X-Trace-Id': 'trace-page', 'X-Sim-Parent-Trace': 'span-page' });
});

test('the canvas player and model-driven client use the helper and carry no copy of its headers', async () => {
  for (const path of ['../lib/canvas-player.js', '../lib/model-driven/app.mjs']) {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(text, /createGestureTrace\(\)/, `${path} creates its trace through the helper`);
    assert.doesNotMatch(text, /X-Sim-Parent-Request|X-Sim-Parent-Trace/, `${path} names no trace header itself`);
  }
});

test('the code app client is one file: no static import, and it names no gesture logic of its own', async () => {
  const text = await readFile(new URL('../lib/code-apps-client.js', import.meta.url), 'utf8');
  assert.match(text, /createGestureTrace\(\)/, 'the client creates its trace through the helper the runtime serves');
  assert.ok(!/^\s*import\s/m.test(text), 'an app may serve the client as one URL, so it has no static import');
  assert.doesNotMatch(text, /X-Sim-Parent-Request/, 'the client names no gesture header itself');
});
