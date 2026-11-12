// @test-kind contract: an interrupted verification leaves no temporary sources behind, reports the interruption as a failure and releases the signal listeners it installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import { chromium } from 'playwright-core';
import verify, { abortOnInterrupt } from '../lense/commands/verify.mjs';
import { createFixture, SITE } from './fixture.mjs';

const SIGNALS = ['SIGINT', 'SIGTERM'];
const LOGIN_URL = 'http://127.0.0.1:1/sign-in';
const TARGET_URL = 'http://127.0.0.1:1/';

// Stands in for a browser object: the members a test names are answered, every other call resolves to nothing.
function stub(answers = {}) {
  return new Proxy(() => Promise.resolve(undefined), {
    get: (_, key) => {
      if (Object.hasOwn(answers, key)) return answers[key];
      if (key === Symbol.iterator) return function* empty() {};
      return key === 'then' || typeof key === 'symbol' ? undefined : stub();
    },
    apply: () => Promise.resolve(undefined),
  });
}

// Answers the frame-tree calls the browser module makes for the page it opens first.
function cdpFor(url) {
  const frameTree = {
    frameTree: { frame: { id: 'main-frame', loaderId: 'main-loader', url }, childFrames: [] },
  };
  return stub({
    send: async (method) => {
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 };
      return method === 'Page.getFrameTree' ? frameTree : stub();
    },
    detach: async () => {},
  });
}

// A headed browser whose only page stays on the identity provider, so verification reaches the sign-in wait.
function fakeContext() {
  const response = { status: () => 200, text: async () => '<!doctype html><title>Invented</title>' };
  const page = stub({ url: () => LOGIN_URL, goto: async () => response, isClosed: () => false });
  return stub({ pages: () => [page], newCDPSession: async () => cdpFor(LOGIN_URL), cookies: async () => [] });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Records the steps that start after the interrupt is raised; a run that stops at the interrupt starts none.
function interruptTrace(signal) {
  const trace = { raised: false, armed: false, started: [] };
  trace.raise = () => {
    trace.raised = true;
    process.emit(signal);
  };
  trace.step = (name) => {
    if (trace.raised) trace.started.push(name);
  };
  return trace;
}

// A headed browser on the portal's start page, reached without a sign-in. `at` names the step the interrupt lands in.
function portalContext(trace, browser, at, clock, marks) {
  const response = {
    // the first call after the settle pause reads the status of the navigation
    status: () => {
      trace.step('response status');
      return 200;
    },
    text: async () => {
      trace.step('document text');
      return '<!doctype html><title>Invented</title>';
    },
  };
  const page = stub({
    url: () => TARGET_URL,
    isClosed: () => false,
    goto: () => {
      trace.step('page goto');
      if (at !== 'goto') return Promise.resolve(response);
      const navigation = deferred();
      // the interrupt lands while the navigation is in flight; the navigation then completes on its own
      queueMicrotask(() => {
        trace.raise();
        navigation.resolve(response);
      });
      return navigation.promise;
    },
    // the settle pause is armed by the time this callback runs; the clock then passes its deadline
    waitForLoadState: async () => {
      if (at === 'wait')
        setImmediate(() => {
          trace.raise();
          clock.tick(1500);
        });
      else if (at === 'idle') setImmediate(() => clock.tick(1500));
    },
    // the diagnostics are captured right before the screenshot
    screenshot: async () => {
      marks.push('afterEdits capture');
    },
    evaluate: async (_fn, arg) => {
      // The dev panel removes its page UI with the session token alone when verification tears down; that is
      // cleanup, not a step of the run.
      if (Object.keys(arg ?? {}).join() === 'token') return undefined;
      trace.step('page evaluate');
      if (at !== 'until' || !trace.armed || trace.raised) return true;
      trace.raise();
      return null; // the wait it serves is still pending
    },
  });
  return stub({
    pages: () => [page],
    newCDPSession: async () => cdpFor(TARGET_URL),
    cookies: async () => [],
    close: async () => {
      browser.closed = true;
    },
  });
}

// Creates the fixture site and a state directory, both removed after the test, and the verify configuration for them.
function createVerifyConfig(t) {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-verify-interrupt-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return {
    configDir: stateDir,
    stateDir,
    sourceDir: fixture.dir,
    siteName: 'fixture',
    envName: 'local',
    origin: 'http://127.0.0.1:1',
    site: structuredClone(SITE),
    browser: {},
  };
}

// Starts verification on the portal page. `at` names the step the interrupt lands in; 'idle' raises nothing and
// holds the watcher's idle wait behind the `idle` promise. `finished` resolves to the run's record.
function startVerify(t, { at, signal = 'SIGINT', idle = Promise.resolve() }) {
  const cfg = createVerifyConfig(t);
  if (at === 'wait' || at === 'idle') t.mock.timers.enable({ apis: ['setTimeout'] });
  const trace = interruptTrace(signal);
  const browser = { launched: false, closed: false };
  const marks = [];
  const checksDone = deferred();
  const output = [];
  const logged = [];
  const rejections = [];
  const recordRejection = (reason) => rejections.push(reason);
  const listenersBefore = SIGNALS.map((name) => process.listenerCount(name));
  process.on('unhandledRejection', recordRejection);
  t.after(() => process.off('unhandledRejection', recordRejection));
  // watchSources assigns its own whenIdle to the watcher it creates; the run waits on the gated one instead
  const watch = chokidar.watch;
  t.mock.method(chokidar, 'watch', (...args) => {
    const instance = watch.apply(chokidar, args);
    Object.defineProperty(instance, 'whenIdle', {
      configurable: true,
      get: () => () => {
        marks.push('watcher idle wait');
        return idle;
      },
      set: () => {},
    });
    return instance;
  });
  const copy = fs.cpSync;
  if (at === 'copy')
    t.mock.method(fs, 'cpSync', (...args) => {
      trace.raise();
      return copy(...args);
    });
  t.mock.method(chromium, 'launchPersistentContext', () => {
    trace.step('browser launch');
    browser.launched = true;
    const context = portalContext(trace, browser, at, t.mock.timers, marks);
    if (at !== 'launch') return Promise.resolve(context);
    const launching = deferred();
    // the interrupt lands while the launch is in flight; the launch then finishes on its own
    queueMicrotask(() => {
      trace.raise();
      launching.resolve(context);
    });
    return launching.promise;
  });
  t.mock.method(console, 'log', (line) => output.push(line));
  t.mock.method(console, 'error', (line) => {
    const text = String(line);
    logged.push(text);
    if (text.includes('editing the copy')) trace.armed = true;
    if (at === 'check' && text.includes('page loads through the overlay')) trace.raise();
    if (text.includes('the dev panel lists the overrides')) checksDone.resolve();
  });

  const finished = (async () => {
    const result = await verify(cfg, { json: true, headed: true, 'sign-in-timeout': 3000 });
    // a rejection nothing handled is reported on the next turn of the event loop
    await new Promise((resolve) => setImmediate(resolve));
    return { result, report: JSON.parse(output[0]), logged, trace, browser, rejections, listenersBefore, marks };
  })();
  return { finished, checksDone, marks };
}

// Runs verification on the portal page and raises the interrupt in the step named by `at`.
async function interruptedRun(t, options) {
  const { finished } = startVerify(t, options);
  const outcome = await finished;
  assert.equal(outcome.result, 1);
  return outcome;
}

function assertInterrupted(outcome, { launched }) {
  const { report, logged, trace, browser, rejections, listenersBefore } = outcome;
  assert.deepEqual(trace.started, [], 'no step after the interrupt started');
  assert.equal(report.passed, false);
  assert.equal(report.errorCode, 'VERIFY_INTERRUPTED');
  assert.equal(report.cleanup.temporarySourceRemoved, true);
  const copied = logged.find((line) => line.startsWith('copying sources to '));
  assert.ok(copied, 'verification copied the sources before the interrupt');
  const tempSource = /^copying sources to (.+) \.\.\.$/.exec(copied)[1];
  assert.equal(fs.existsSync(path.dirname(tempSource)), false);
  assert.equal(browser.launched, launched);
  assert.equal(browser.closed, launched, 'a browser that was launched is closed');
  assert.deepEqual(
    SIGNALS.map((name) => process.listenerCount(name)),
    listenersBefore,
    'verification removes the signal listeners it installed',
  );
  assert.deepEqual(rejections, [], 'no rejection went unhandled');
}

test('an interrupted sign-in wait removes the temporary sources and reports the interruption', async (t) => {
  const cfg = createVerifyConfig(t);
  const signalsBefore = SIGNALS.map((signal) => process.listenerCount(signal));
  const context = fakeContext();
  let launchOptions;
  t.mock.method(chromium, 'launchPersistentContext', async (_root, options) => {
    launchOptions = options;
    return context;
  });
  const output = [];
  const logged = [];
  t.mock.method(console, 'log', (line) => output.push(line));
  t.mock.method(console, 'error', (line) => {
    logged.push(String(line));
    // The sign-in wait starts right after this line is logged; the interrupt arrives there.
    if (String(line).includes('please sign in')) process.emit('SIGINT');
  });

  // The short sign-in deadline only bounds the test if the interrupt is not delivered.
  assert.equal(await verify(cfg, { json: true, headed: true, 'sign-in-timeout': 3000 }), 1);

  const copied = logged.find((line) => line.startsWith('copying sources to '));
  assert.ok(copied, 'verification copied the sources before the browser step');
  const tempSource = /^copying sources to (.+) \.\.\.$/.exec(copied)[1];
  assert.equal(launchOptions.handleSIGINT, false);
  assert.equal(launchOptions.handleSIGTERM, false);
  const report = JSON.parse(output[0]);
  assert.equal(report.passed, false);
  assert.equal(report.errorCode, 'VERIFY_INTERRUPTED');
  assert.equal(report.cleanup.temporarySourceRemoved, true);
  assert.equal(fs.existsSync(path.dirname(tempSource)), false);
  assert.deepEqual(
    SIGNALS.map((signal) => process.listenerCount(signal)),
    signalsBefore,
    'verification removes the signal listeners it installed',
  );
});

test('an interrupt while the sources are copied stops the run before the browser launches', async (t) => {
  assertInterrupted(await interruptedRun(t, { at: 'copy' }), { launched: false });
});

test('an interrupt while the browser launches stops the run and closes the browser once it is up', async (t) => {
  assertInterrupted(await interruptedRun(t, { at: 'launch' }), { launched: true });
});

test('an interrupt while the first navigation is pending stops the run and closes the browser', async (t) => {
  assertInterrupted(await interruptedRun(t, { at: 'goto' }), { launched: true });
});

test('an interrupt during an ordinary wait stops the run instead of polling to its deadline', async (t) => {
  assertInterrupted(await interruptedRun(t, { at: 'until' }), { launched: true });
});

test('a SIGTERM during an ordinary wait stops the run the same way', async (t) => {
  assertInterrupted(await interruptedRun(t, { at: 'until', signal: 'SIGTERM' }), { launched: true });
});

test('an interrupt during the settle pause after the page loads ends the wait and arms no timer', async (t) => {
  const outcome = await interruptedRun(t, { at: 'wait' });
  assertInterrupted(outcome, { launched: true });
  // an armed timer would fire on this tick and start the step after the pause
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(outcome.trace.started, [], 'advancing the clock after the interrupt starts nothing');
});

test('the diagnostics after the edits are captured only once the watcher is idle', async (t) => {
  const idle = deferred();
  t.after(() => idle.resolve());
  const run = startVerify(t, { at: 'idle', idle: idle.promise });
  await run.checksDone.promise;
  await new Promise((resolve) => setImmediate(resolve));
  // a pause that is still armed would fire on this tick and capture the diagnostics before the watcher is idle
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(run.marks, ['watcher idle wait'], 'the capture waits while the watcher is busy');
  idle.resolve();
  const outcome = await run.finished;
  assert.deepEqual(outcome.marks, ['watcher idle wait', 'afterEdits capture']);
  assert.notEqual(outcome.report.diagnostics.afterEdits, null);
  assert.equal(outcome.report.cleanup.temporarySourceRemoved, true);
});

test('an interrupt raised between two checks stops at the next check', async (t) => {
  const outcome = await interruptedRun(t, { at: 'check' });
  assert.ok(!outcome.logged.some((line) => line.includes('nothing is overridden')), 'the next check group did not run');
  assertInterrupted(outcome, { launched: true });
});

test('the first interrupt aborts the run, the second is absorbed and the third forces the exit with its code', () => {
  const before = SIGNALS.map((signal) => process.listenerCount(signal));
  const controller = new AbortController();
  const lines = [];
  const exits = [];
  const remove = abortOnInterrupt(controller, {
    write: (line) => lines.push(line),
    exit: (code) => exits.push(code),
  });
  try {
    process.emit('SIGINT');
    assert.equal(controller.signal.aborted, true, 'the first interrupt aborts the run');
    assert.equal(controller.signal.reason.message, 'Verification was interrupted by SIGINT');
    process.emit('SIGINT');
    assert.deepEqual(exits, [], 'the second interrupt is absorbed');
    process.emit('SIGINT');
    assert.deepEqual(lines, ['Forced exit: cleanup did not finish.']);
    assert.deepEqual(exits, [130], 'the third interrupt exits with the SIGINT code');
  } finally {
    remove();
  }
  assert.deepEqual(
    SIGNALS.map((signal) => process.listenerCount(signal)),
    before,
    'the returned function removes the signal listeners',
  );
});
