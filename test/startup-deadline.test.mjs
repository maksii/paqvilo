import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { startupDeadline } from '../lense/startup-deadline.mjs';

test('startup deadline names the blocked phase and disposes late browser ownership exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deadline = startupDeadline(1000);
  t.after(() => deadline.close());
  deadline.phase('browser attachment');
  let resolve,
    disposed = 0;
  const wait = deadline.wait(
    new Promise((done) => {
      resolve = done;
    }),
    () => {
      disposed++;
    },
  );
  const rejected = assert.rejects(
    wait,
    (error) => error.code === 'startup_timeout' && error.phase === 'browser attachment',
  );
  t.mock.timers.tick(1001);
  await rejected;
  resolve({ context: 'owned connection' });
  await setImmediate();
  assert.equal(disposed, 1);
});

test('startup budget includes earlier phases and ends independently of session lifetime', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deadline = startupDeadline(1000);
  t.after(() => deadline.close());
  assert.equal(await deadline.wait(Promise.resolve('import')), 'import');
  t.mock.timers.tick(750);
  deadline.phase('initial assets');
  let resolve;
  const wait = deadline.wait(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const rejected = assert.rejects(wait, /initial assets/);
  t.mock.timers.tick(251);
  await rejected;
  resolve();
  const ready = startupDeadline(1000);
  ready.finish();
  t.mock.timers.tick(5000);
  assert.equal(await ready.wait(Promise.resolve('session')), 'session');
});

test('startup cancellation releases late work and removes signal listeners', async () => {
  const listeners = process.listenerCount('SIGINT');
  const deadline = startupDeadline();
  let resolve,
    disposed = 0;
  const wait = deadline.wait(
    new Promise((done) => {
      resolve = done;
    }),
    () => {
      disposed++;
    },
  );
  deadline.abort();
  await assert.rejects(wait, (error) => error.code === 'startup_cancelled');
  resolve();
  await setImmediate();
  deadline.close();
  assert.equal(disposed, 1);
  assert.equal(process.listenerCount('SIGINT'), listeners);
});
