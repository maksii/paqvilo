// @test-kind contract: the model-driven start deadline is Paqvilo CLI runtime behaviour, checked with mocked clocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { startupDeadline } from '../lense/startup-deadline.mjs';
import { STARTUP_PAGE_CAP_MS } from '../lense/startup-progress.mjs';
import { trackArmedTimers } from './helpers/startup-page.mjs';

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
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason.code, 'startup_timeout');
  resolve({ context: 'owned connection' });
  await setImmediate();
  assert.equal(disposed, 1);
});

test('silence budget restarts at each phase and ends independently of session lifetime', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deadline = startupDeadline(1000);
  t.after(() => deadline.close());
  assert.equal(await deadline.wait(Promise.resolve('import')), 'import');
  t.mock.timers.tick(750);
  deadline.phase('initial assets');
  let resolve,
    failure = null;
  const wait = deadline.wait(
    new Promise((done) => {
      resolve = done;
    }),
  );
  wait.catch((error) => {
    failure = error;
  });
  // 1501 ms of mocked time have passed in total, but only 751 ms since the phase started: not yet silent.
  t.mock.timers.tick(751);
  await setImmediate();
  assert.equal(failure, null, 'the 750 ms before the phase must not count against the silence budget');
  t.mock.timers.tick(250);
  await assert.rejects(
    wait,
    (error) =>
      error.phase === 'initial assets' && error.guard === 'silence' && /1000 ms silence guard/.test(error.message),
  );
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
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason.code, 'startup_cancelled');
  await assert.rejects(wait, (error) => error.code === 'startup_cancelled');
  resolve();
  await setImmediate();
  deadline.close();
  assert.equal(disposed, 1);
  assert.equal(process.listenerCount('SIGINT'), listeners);
});

test('work abandoned by a deadline that has already ended keeps a rejection handler', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deadline = startupDeadline(1000);
  t.after(() => deadline.close());
  deadline.abort();
  let rejectWork;
  const work = new Promise((_, reject) => {
    rejectWork = reject;
  });
  const handlers = [];
  const then = work.then.bind(work);
  work.then = (onFulfilled, onRejected) => {
    handlers.push(typeof onRejected === 'function');
    return then(onFulfilled, onRejected);
  };
  await assert.rejects(deadline.wait(work), (error) => error.code === 'startup_cancelled');
  const handled = handlers.includes(true);
  // Without a handler this test process would also fail on the late rejection; the assertion below reports the defect.
  if (!handled) work.catch(() => {});
  rejectWork(new Error('invented late failure'));
  assert.ok(handled, 'the abandoned work has a rejection handler');
});

const PROGRESS_INTERVAL_MS = 60_000;
// Each interval moves the mocked clock forward and lets timer continuations run before the progress callback.
async function elapseIntervals(t, intervals, progress = () => {}) {
  for (let interval = 0; interval < intervals; interval++) {
    t.mock.timers.tick(PROGRESS_INTERVAL_MS);
    await setImmediate();
    progress(interval);
  }
}
function outcomeOf(promise) {
  const outcome = { state: 'pending', value: undefined, error: undefined };
  promise.then(
    (value) => {
      outcome.state = 'resolved';
      outcome.value = value;
    },
    (error) => {
      outcome.state = 'rejected';
      outcome.error = error;
    },
  );
  return outcome;
}

test('a model-driven start with progress every 60 s of mocked time succeeds however long the total is', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deadline = startupDeadline(120000);
  t.after(() => deadline.close());
  deadline.phase('page resources');
  let resolve;
  const outcome = outcomeOf(
    deadline.wait(
      new Promise((done) => {
        resolve = done;
      }),
    ),
  );
  await elapseIntervals(t, 6, () => deadline.progress());
  t.mock.timers.tick(40_000);
  await setImmediate();
  assert.equal(outcome.state, 'pending', 'progress every 60 s must not trip the 120 s silence guard');
  resolve('ready');
  await setImmediate();
  assert.equal(outcome.value, 'ready');
});

test('a silent model-driven start fails with the silence guard, the time waited and the last phase', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deadline = startupDeadline(1000);
  t.after(() => deadline.close());
  deadline.phase('interception and inspector setup');
  const rejected = assert.rejects(deadline.wait(new Promise(() => {})), (error) => {
    assert.equal(error.code, 'startup_timeout');
    assert.equal(error.guard, 'silence');
    assert.equal(error.phase, 'interception and inspector setup');
    assert.match(error.message, /made no progress for 1000 ms: the 1000 ms silence guard/);
    assert.match(error.message, /Last phase reached: interception and inspector setup\./);
    assert.match(error.message, /hang guard/);
    return true;
  });
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(deadline.signal.reason.guard, 'silence');
});

test('continuous progress reaches the absolute cap guard', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deadline = startupDeadline(120000);
  t.after(() => deadline.close());
  deadline.phase('source watcher setup');
  const rejected = assert.rejects(deadline.wait(new Promise(() => {})), (error) => {
    assert.equal(error.guard, 'cap');
    assert.match(error.message, new RegExp(`${STARTUP_PAGE_CAP_MS} ms cap guard after`));
    assert.match(error.message, /Last phase reached: source watcher setup\./);
    return true;
  });
  await elapseIntervals(t, 11, () => deadline.progress());
  await rejected;
  assert.equal(deadline.signal.reason.guard, 'cap');
});

test('page requests and a sign-in redirect count as progress until the deadline closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = new EventEmitter();
  const deadline = startupDeadline(120000);
  t.after(() => deadline.close());
  deadline.phase('first page');
  deadline.watchPage(page);
  let resolve;
  const outcome = outcomeOf(
    deadline.wait(
      new Promise((done) => {
        resolve = done;
      }),
    ),
  );
  await elapseIntervals(t, 6, (interval) => page.emit(interval % 2 ? 'request' : 'framenavigated'));
  t.mock.timers.tick(40_000);
  await setImmediate();
  assert.equal(outcome.state, 'pending');
  deadline.finish();
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('framenavigated'), 0);
  resolve('ready');
  await setImmediate();
  assert.equal(outcome.value, 'ready');
});

test('the start deadline leaves no armed timer or page listener after success, silence, cap, cancellation or close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timers = trackArmedTimers();
  try {
    const success = new EventEmitter();
    const finished = startupDeadline(1000);
    finished.watchPage(success);
    assert.equal(await finished.wait(Promise.resolve('ok')), 'ok');
    finished.finish();
    assert.equal(timers.armed.size, 0, 'success leaves no timer');
    assert.equal(success.listenerCount('request'), 0, 'success leaves no page listener');

    const silent = new EventEmitter();
    const silence = startupDeadline(1000);
    silence.watchPage(silent);
    const silenced = assert.rejects(silence.wait(new Promise(() => {})), { code: 'startup_timeout', guard: 'silence' });
    t.mock.timers.tick(1000);
    await silenced;
    assert.equal(timers.armed.size, 0, 'silence leaves no timer');
    assert.equal(silent.listenerCount('request'), 0, 'silence leaves no page listener');

    const capped = new EventEmitter();
    const cap = startupDeadline(120000);
    cap.watchPage(capped);
    const capRejected = assert.rejects(cap.wait(new Promise(() => {})), { code: 'startup_timeout', guard: 'cap' });
    await elapseIntervals(t, 10, () => cap.progress());
    t.mock.timers.tick(PROGRESS_INTERVAL_MS);
    await capRejected;
    assert.equal(timers.armed.size, 0, 'cap leaves no timer');
    assert.equal(capped.listenerCount('request'), 0, 'cap leaves no page listener');

    const cancelled = new EventEmitter();
    const cancel = startupDeadline(1000);
    cancel.watchPage(cancelled);
    const cancelRejected = assert.rejects(cancel.wait(new Promise(() => {})), { code: 'startup_cancelled' });
    cancel.abort();
    await cancelRejected;
    assert.equal(timers.armed.size, 0, 'cancellation leaves no timer');
    assert.equal(cancelled.listenerCount('request'), 0, 'cancellation leaves no page listener');

    const closed = new EventEmitter();
    const close = startupDeadline(1000);
    close.watchPage(closed);
    close.close();
    assert.equal(timers.armed.size, 0, 'close leaves no timer');
    assert.equal(closed.listenerCount('request'), 0, 'close leaves no page listener');
  } finally {
    timers.restore();
  }
});

test('settled does not wait for abandoned work that has nothing to dispose', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deadline = startupDeadline(1000);
  t.after(() => deadline.close());
  const wait = deadline.wait(new Promise(() => {}));
  deadline.abort();
  await assert.rejects(wait, (error) => error.code === 'startup_cancelled');
  assert.equal(await deadline.settled(), undefined);
});

test('late work after startup cancellation stays owned until its disposal settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deadline = startupDeadline(1000);
  t.after(() => deadline.close());
  let resolveLate;
  const late = new Promise((done) => {
    resolveLate = done;
  });
  let markStarted;
  const started = new Promise((done) => {
    markStarted = done;
  });
  let finishDisposal;
  const disposing = new Promise((done) => {
    finishDisposal = done;
  });
  const wait = deadline.wait(late, (value) => {
    markStarted(value);
    return disposing;
  });
  deadline.abort();
  await assert.rejects(wait, (error) => error.code === 'startup_cancelled');
  let drained = false;
  const settled = deadline.settled().then(() => {
    drained = true;
  });
  resolveLate('owned connection');
  assert.equal(await started, 'owned connection', 'the disposal has begun');
  assert.equal(drained, false, 'the owner must not report settled while the disposal is still running');
  finishDisposal();
  await settled;
  assert.equal(drained, true);
});
