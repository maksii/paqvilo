// @test-kind tooling: a browser launch completed after its loopback fixture ended is closed before it can create pages or outlive removed state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { listenLoopbackContext } from '../test-browser/helpers/owned-server.mjs';

test('late loopback browser acquisition closes its browser without creating a context after fixture cleanup', async (t) => {
  const launch = Promise.withResolvers(),
    started = Promise.withResolvers();
  const hooks = [];
  const fixture = { after: (hook) => hooks.push(hook), signal: new AbortController().signal };
  const server = new EventEmitter();
  server.listen = () => queueMicrotask(() => server.emit('listening'));
  server.address = () => ({ port: 12345 });
  server.closeAllConnections = () => {};
  server.close = (callback) => callback();
  let contexts = 0,
    closes = 0;
  t.mock.method(chromium, 'launch', () => {
    started.resolve();
    return launch.promise;
  });
  const pending = listenLoopbackContext(fixture, server);
  const rejected = assert.rejects(pending, /ended during launch.*late browser was closed/);
  await started.promise;
  for (const hook of hooks) await hook();
  launch.resolve({
    newContext() {
      contexts++;
      throw new Error('late context must not be created');
    },
    async close() {
      closes++;
    },
  });
  await rejected;
  assert.equal(contexts, 0);
  assert.equal(closes, 1);
});
