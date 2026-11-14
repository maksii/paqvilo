// @test-kind contract: start-up page waits are Paqvilo CLI runtime behaviour, with hang guards and observed progress.
import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { startupProgress, waitForStartupPage, readStartupPhases } from '../lense/startup-progress.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { trackArmedTimers } from './helpers/startup-page.mjs';

const HANG_GUARD_MS = 120_000; // hang guard only: this step is expected to succeed

test('native model-driven dev emits startup before project configuration fails', async () => {
  const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        cli,
        'lense',
        'model-driven',
        'dev',
        '--project',
        path.join(os.tmpdir(), `paqvilo-missing-progress-${process.pid}-${Date.now()}.json`),
        '--url',
        'http://127.0.0.1:1234',
      ],
      { windowsHide: true },
    ),
    (error) => {
      assert.match(error.stderr.split(/\r?\n/)[0], /^startup\s+configuration.*0\.0s total/);
      assert.match(error.stderr, /paqvilo:/);
      return true;
    },
  );
});

test('runtime log progress is incremental and bounded without forwarding arbitrary log fields', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-startup-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'startup.log');
  await fs.writeFile(
    file,
    'x'.repeat(40000) +
      '\n' +
      JSON.stringify({ type: 'runtime-startup', phase: 'state-restore', elapsedMs: 20, secret: 'never-forward' }) +
      '\n' +
      '{"type":"runtime-startup",',
  );
  const first = await readStartupPhases(file);
  assert.deepEqual(first.events, [{ phase: 'state-restore', elapsedMs: 20 }]);
  await fs.appendFile(
    file,
    '"phase":"organization","elapsedMs":30}\n' +
      JSON.stringify({ type: 'runtime-startup', phase: 'runtime-module-load', elapsedMs: 0, secret: 'never-forward' }) +
      '\n' +
      JSON.stringify({ type: 'runtime-startup', phase: 'runtime-module-ready', elapsedMs: 31 }) +
      '\n' +
      JSON.stringify({ type: 'runtime-startup', phase: 'untrusted', elapsedMs: 40 }) +
      '\n',
  );
  const second = await readStartupPhases(file, first.cursor);
  assert.deepEqual(second.events, [
    { phase: 'organization', elapsedMs: 30 },
    { phase: 'runtime-module-load', elapsedMs: 0 },
    { phase: 'runtime-module-ready', elapsedMs: 31 },
  ]);
  assert.deepEqual((await readStartupPhases(file, second.cursor)).events, []);
});

test('cancelled process ownership checks do not launch Windows subprocess probes', async () => {
  const { processIdentityAsync } = await import('../lense/commands/mirage.mjs');
  assert.equal(await processIdentityAsync(process.pid, { signal: AbortSignal.abort() }), null);
});

test('startup diagnostics begin immediately and retain command-total across phases', () => {
  let time = 100;
  const lines = [],
    progress = startupProgress({ structured: true, now: () => time, write: (line) => lines.push(JSON.parse(line)) });
  assert.deepEqual(lines[0], {
    type: 'startup',
    status: 'started',
    phase: 'configuration',
    totalElapsedMs: 0,
    phaseElapsedMs: 0,
  });
  time += 61000;
  progress.phase('process ownership');
  time += 7000;
  progress.complete('runtime listening; application pending');
  assert.equal(lines[1].totalElapsedMs, 61000);
  assert.equal(lines[1].phaseElapsedMs, 0);
  assert.equal(lines[2].totalElapsedMs, 68000);
  assert.equal(lines[2].phaseElapsedMs, 7000);
  assert.equal(progress.elapsedMs, 68000);
  progress.phase('ignored');
  assert.equal(lines.length, 3);
});

test('slow startup phases emit heartbeats until closed, independently of phase changes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let time = 0;
  const lines = [],
    progress = startupProgress({ intervalMs: 10, now: () => time, write: (line) => lines.push(line) });
  const heartbeats = () => lines.filter((line) => line.endsWith('…'));
  time = 10;
  t.mock.timers.tick(10);
  progress.phase('process ownership');
  time = 30;
  t.mock.timers.tick(20);
  assert.deepEqual(heartbeats(), [
    'startup     configuration (0.0s total; 0.0s phase)…',
    'startup     process ownership (0.0s total; 0.0s phase)…',
    'startup     process ownership (0.0s total; 0.0s phase)…',
  ]);
  progress.fail('cancelled during discovery');
  const count = lines.length;
  t.mock.timers.tick(50);
  assert.equal(lines.length, count);
});

test('document navigation cannot complete model-driven startup before application and initial data readiness', async () => {
  let documentReady,
    applicationReady,
    finished = false;
  const navigation = new Promise((resolve) => {
    documentReady = resolve;
  });
  const application = new Promise((resolve) => {
    applicationReady = resolve;
  });
  const progress = startupProgress({ write() {} });
  const page = {
    on() {},
    off() {},
    goto: () => navigation,
    url: () => 'http://127.0.0.1:1234/main.aspx',
    waitForFunction: () => application,
    evaluate: async () => ({ state: 'ready' }),
  };
  const loading = waitForStartupPage(page, page.url(), { progress, modelDriven: true }).then((value) => {
    finished = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  documentReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(progress.events.at(-1).phase, 'application data');
  applicationReady();
  assert.equal(await loading, true);
  assert.equal(progress.events.at(-1).status, 'complete');
  assert.equal(progress.events.at(-1).detail, 'application and initial view usable');
});

test('startup surfaces application failures and qualifies sign-in redirects as intermediate document states', async () => {
  const page = {
    on() {},
    off() {},
    waitForLoadState: async () => {},
    goto: async () => {},
    url: () => 'http://127.0.0.1:1234/main.aspx',
    waitForFunction: async () => {},
    evaluate: async () => ({ state: 'error', message: 'Invented denied initial query' }),
  };
  await assert.rejects(
    waitForStartupPage(page, page.url(), { modelDriven: true }),
    /Application failed to load: Invented denied initial query/,
  );
  const progress = startupProgress({ write() {} });
  page.url = () => 'http://127.0.0.1:1234/signin';
  page.waitForFunction = () => assert.fail('A sign-in document is not a loaded app.');
  assert.equal(await waitForStartupPage(page, page.url(), { progress, modelDriven: true }), true);
  assert.match(progress.events.at(-1).detail, /sign-in and application readiness remain unverified/);
});

for (const phase of ['document', 'application'])
  test(`startup cancellation during ${phase} wait does not report a usable page`, async () => {
    let stop, release;
    const stopped = new Promise((resolve) => {
        stop = resolve;
      }),
      pending = new Promise((resolve) => {
        release = resolve;
      });
    const progress = startupProgress({ write() {} });
    const page = {
      on() {},
      off() {},
      goto: () => (phase === 'document' ? pending : Promise.resolve()),
      url: () => 'http://127.0.0.1:1234/main.aspx',
      waitForFunction: () => pending,
      evaluate: () => assert.fail('Cancelled startup must not evaluate readiness.'),
    };
    const loading = waitForStartupPage(page, page.url(), { progress, stopped, modelDriven: true });
    await new Promise((resolve) => setImmediate(resolve));
    stop();
    assert.equal(await loading, false);
    assert.equal(
      progress.events.some((event) => event.status === 'complete'),
      false,
    );
    progress.close();
    release();
  });

// Request settling polls every 50 ms until 100 ms pass without a pending request (lense/startup-progress.mjs).
// Mock time steps through each poll and lets its continuation schedule the next one.
const SETTLE_POLL_MS = 50;
async function elapse(t, ms) {
  for (let step = 0; step < ms; step += SETTLE_POLL_MS) {
    t.mock.timers.tick(SETTLE_POLL_MS);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
// A browser context of a persistent profile: `browser()` is null. Once `gone` is set, requests to the context fail, as
// they do after the browser has closed; the test emits the context's close event itself.
function contextFixture(p) {
  const fixture = { gone: false, context: new EventEmitter() };
  fixture.context.browser = () => null;
  fixture.context.cookies = async () => {
    if (fixture.gone) throw new Error('Target page, context or browser has been closed');
    return [];
  };
  p.context = () => fixture.context;
  return fixture;
}
function startupRequestFixture() {
  const frame = {},
    child = {},
    p = new EventEmitter();
  p.url = () => 'http://127.0.0.1/fixture';
  p.isClosed = () => false;
  p.waitForLoadState = async () => {};
  p.goto = async () => {};
  const request = (type, f = frame, nav = false) => ({
    resourceType: () => type,
    url: () => 'http://127.0.0.1:9/portal/fixture?token=invented-value',
    frame: () => {
      if (f === null) throw Error('Unknown worker frame');
      return f;
    },
    isNavigationRequest: () => nav,
  });
  const begin = (r) => {
    p.emit('request', r);
    return r;
  };
  const finish = (r) => p.emit('requestfinished', r);
  const commit = (f = frame) => p.emit('framenavigated', f);
  return { p, frame, child, request, begin, finish, commit };
}
test('committed replacement retires old orphan only, preserving current preloads and redirect chain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  f.p.goto = async () => {
    const first = f.begin(f.request('document', f.frame, true));
    f.commit();
    f.finish(first);
    f.begin(f.request('stylesheet'));
  };
  let done = false;
  const loading = waitForStartupPage(f.p, f.p.url(), { timeout: 2000 }).then((x) => {
    done = true;
    return x;
  });
  await elapse(t, SETTLE_POLL_MS);
  const redirect = f.begin(f.request('document', f.frame, true));
  f.finish(redirect);
  const current = f.begin(f.request('document', f.frame, true)),
    preload = f.begin(f.request('script'));
  f.commit();
  f.finish(current);
  await elapse(t, 500);
  assert.equal(done, false, 'current preload cannot be retired');
  f.finish(preload);
  await elapse(t, 150);
  assert.equal(await loading, true);
  assert.equal(f.p.listenerCount('framenavigated'), 0);
  assert.equal(f.p.listenerCount('framedetached'), 0);
});
test('same-document navigation retains pending current document requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  f.p.goto = async () => {
    const doc = f.begin(f.request('document', f.frame, true));
    f.commit();
    f.finish(doc);
    f.begin(f.request('fetch'));
    f.commit();
  };
  const rejected = assert.rejects(waitForStartupPage(f.p, f.p.url(), { timeout: 180 }), /did not settle/);
  await elapse(t, 200);
  await rejected;
});
test('detached child retirement retains live parent requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  let done = false;
  f.p.goto = async () => {
    const doc = f.begin(f.request('document', f.frame, true));
    f.commit();
    f.finish(doc);
    f.begin(f.request('fetch', f.child));
  };
  const loading = waitForStartupPage(f.p, f.p.url(), { timeout: 2000 }).then((x) => {
    done = true;
    return x;
  });
  await elapse(t, SETTLE_POLL_MS);
  const parent = f.begin(f.request('fetch'));
  f.p.emit('framedetached', f.child);
  await elapse(t, 500);
  assert.equal(done, false);
  f.finish(parent);
  await elapse(t, 150);
  assert.equal(await loading, true);
});
test('unknown frame ownership remains pending across committed navigations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  f.p.goto = async () => {
    const doc = f.begin(f.request('document', f.frame, true));
    f.commit();
    f.finish(doc);
    f.begin(f.request('fetch', null));
    const next = f.begin(f.request('document', f.frame, true));
    f.commit();
    f.finish(next);
  };
  const rejected = assert.rejects(waitForStartupPage(f.p, f.p.url(), { timeout: 180 }), /did not settle/);
  await elapse(t, 200);
  await rejected;
});

test('native model-driven navigation completes at load without mistaking a worker or background fetch for readiness', async () => {
  const f = startupRequestFixture();
  const progress = startupProgress({ write() {} });
  f.p.goto = async () => {
    f.begin(f.request('script'));
    f.begin(f.request('fetch'));
  };
  assert.equal(
    await waitForStartupPage(f.p, f.p.url(), { nativeModelDriven: true, timeout: HANG_GUARD_MS, progress }),
    true,
  );
  assert.match(
    progress.events.at(-1).detail,
    /background resources, sign-in and native application readiness remain unverified/,
  );
  assert.equal(f.p.listenerCount('request'), 0);
});

test('outer startup deadline cancels nested resource settling and retires all page listeners', async () => {
  const { startupDeadline } = await import('../lense/startup-deadline.mjs');
  const f = startupRequestFixture(),
    deadline = startupDeadline(1000),
    progress = startupProgress({ write() {} });
  f.p.goto = async () => {
    f.begin(f.request('fetch'));
  };
  const inner = waitForStartupPage(f.p, f.p.url(), { signal: deadline.signal, progress });
  const outer = deadline.wait(inner);
  deadline.abort();
  await assert.rejects(outer, (error) => error.code === 'startup_cancelled');
  assert.equal(await inner, false);
  assert.deepEqual(f.p.eventNames(), []);
  assert.equal(
    progress.events.some((event) => event.status === 'complete'),
    false,
  );
  deadline.close();
  progress.close();
});

const PAGE_EVENTS = ['request', 'requestfinished', 'requestfailed', 'framenavigated', 'framedetached'];
const pageListeners = (page) => PAGE_EVENTS.reduce((count, name) => count + page.listenerCount(name), 0);
test('initial requests that keep making progress settle after more than two minutes in total', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  let current;
  f.p.goto = async () => {
    current = f.begin(f.request('fetch'));
  };
  let settled = false;
  const loading = waitForStartupPage(f.p, f.p.url()).then((value) => {
    settled = true;
    return value;
  });
  // Every request starts or finishes within each 60 s window, so 400 s pass with progress throughout.
  for (let minute = 0; minute < 6; minute++) {
    await elapse(t, 60_000);
    const next = f.begin(f.request('fetch'));
    f.finish(current);
    current = next;
  }
  await elapse(t, 40_000);
  f.finish(current);
  await elapse(t, 150);
  assert.equal(settled, true, 'progress every 60 s must not trip the 120 s silence guard');
  assert.equal(await loading, true);
});

test('pending requests without progress fail with the silence guard, their count and hosts only', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  f.p.goto = async () => {
    f.begin(f.request('fetch'));
    f.begin(f.request('script'));
  };
  const rejected = assert.rejects(waitForStartupPage(f.p, f.p.url()), (error) => {
    assert.match(error.message, /120000 ms silence guard/);
    assert.match(error.message, /2 pending requests on 127\.0\.0\.1:9/);
    assert.match(error.message, /hang guard/);
    assert.doesNotMatch(error.message, /invented-value/, 'query values must not reach the message');
    return true;
  });
  // The silence window starts once the settle wait begins, so the guard fires just after 120 s of mocked time.
  await elapse(t, 121_000);
  await rejected;
});

test('progress that never ends fails with the cap guard at the total cap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  let current;
  f.p.goto = async () => {
    current = f.begin(f.request('fetch'));
  };
  const rejected = assert.rejects(waitForStartupPage(f.p, f.p.url(), { capMs: 300_000 }), (error) => {
    assert.match(error.message, /did not settle/);
    assert.match(error.message, /300000 ms cap guard/);
    assert.match(error.message, /1 pending request on 127\.0\.0\.1:9/);
    return true;
  });
  // Six 60 s windows each start a request and finish the previous one: progress never stops, the cap ends it.
  for (let minute = 0; minute < 6; minute++) {
    await elapse(t, 60_000);
    const next = f.begin(f.request('fetch'));
    f.finish(current);
    current = next;
  }
  await rejected;
});

test('a caller-supplied silence limit replaces the default', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  f.p.goto = async () => {
    f.begin(f.request('fetch'));
  };
  let outcome = null;
  const loading = waitForStartupPage(f.p, f.p.url(), { silenceMs: 1000 }).catch((error) => {
    outcome = error;
  });
  await elapse(t, 950);
  assert.equal(outcome, null, 'silence shorter than the caller limit must not fail the wait');
  await elapse(t, 150);
  assert.match(String(outcome?.message), /1000 ms silence guard/);
  await loading;
});

test('a completed start-up wait leaves no page listener and no armed timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timers = trackArmedTimers();
  try {
    const f = startupRequestFixture();
    const progress = startupProgress({ write() {} });
    let request;
    f.p.goto = async () => {
      request = f.begin(f.request('fetch'));
    };
    const loading = waitForStartupPage(f.p, f.p.url(), { progress });
    await elapse(t, 500);
    f.finish(request);
    await elapse(t, 150);
    assert.equal(await loading, true);
    progress.close();
    assert.equal(pageListeners(f.p), 0);
    assert.equal(timers.armed.size, 0);
  } finally {
    timers.restore();
  }
});

test('the silence guard retires its page listeners and timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timers = trackArmedTimers();
  try {
    const f = startupRequestFixture();
    f.p.goto = async () => {
      f.begin(f.request('fetch'));
    };
    const loading = waitForStartupPage(f.p, f.p.url()).catch((error) => error);
    await elapse(t, 121_000);
    assert.match(String((await loading).message), /120000 ms silence guard/);
    assert.equal(pageListeners(f.p), 0);
    assert.equal(timers.armed.size, 0);
  } finally {
    timers.restore();
  }
});

test('the cap guard retires its page listeners and timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timers = trackArmedTimers();
  try {
    const f = startupRequestFixture();
    f.p.goto = async () => {
      f.begin(f.request('fetch'));
    };
    const loading = waitForStartupPage(f.p, f.p.url(), { capMs: 1000, silenceMs: 600_000 }).catch((error) => error);
    await elapse(t, 1100);
    assert.match(String((await loading).message), /1000 ms cap guard/);
    assert.equal(pageListeners(f.p), 0);
    assert.equal(timers.armed.size, 0);
  } finally {
    timers.restore();
  }
});

test('a page closed during the settle wait resolves false while its context still answers, without an error or leftovers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timers = trackArmedTimers();
  try {
    const f = startupRequestFixture();
    let closed = false;
    f.p.isClosed = () => closed;
    // The page closes while its browser context stays open: a tab closed by a script, or by the user before the browser.
    contextFixture(f.p);
    f.p.goto = async () => {
      f.begin(f.request('fetch'));
    };
    const loading = waitForStartupPage(f.p, f.p.url()).catch((error) => error);
    await elapse(t, 500);
    closed = true;
    await elapse(t, 100);
    assert.equal(await loading, false);
    assert.equal(pageListeners(f.p), 0);
    assert.equal(timers.armed.size, 0);
  } finally {
    timers.restore();
  }
});

test('closing the browser during the wait is a stop: resolves false without the closed-page error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timers = trackArmedTimers();
  try {
    const f = startupRequestFixture();
    const browser = contextFixture(f.p);
    let closed = false;
    f.p.isClosed = () => closed;
    f.p.goto = async () => {
      f.begin(f.request('fetch'));
    };
    const loading = waitForStartupPage(f.p, f.p.url()).catch((error) => error);
    await elapse(t, 500);
    // The browser closes: its requests fail at once, and its close event follows on a later turn.
    closed = true;
    browser.gone = true;
    setImmediate(() => browser.context.emit('close'));
    await elapse(t, 100);
    assert.equal(await loading, false);
    assert.equal(pageListeners(f.p), 0);
    assert.equal(browser.context.listenerCount('close'), 0);
    assert.equal(timers.armed.size, 0);
  } finally {
    timers.restore();
  }
});

test('a page closed under an in-flight application wait is a stop while its context still answers', async () => {
  const f = startupRequestFixture();
  const browser = contextFixture(f.p);
  const url = 'http://127.0.0.1/main.aspx';
  f.p.url = () => url;
  let closed = false;
  f.p.isClosed = () => closed;
  let waiting, fail;
  const started = new Promise((resolve) => {
    waiting = resolve;
  });
  f.p.waitForFunction = () => {
    waiting();
    return new Promise((_, reject) => {
      fail = reject;
    });
  };
  const loading = waitForStartupPage(f.p, url, { modelDriven: true }).catch((error) => error);
  await started;
  // Playwright rejects the wait when the page closes, possibly before its context has answered or reported its close.
  closed = true;
  fail(new Error('page.waitForFunction: Target page, context or browser has been closed'));
  assert.equal(await loading, false);
  assert.equal(pageListeners(f.p), 0);
  assert.equal(browser.context.listenerCount('close'), 0);
});

test('a page closed after the start-up wait was cancelled resolves false', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timers = trackArmedTimers();
  try {
    const f = startupRequestFixture();
    let closed = false;
    f.p.isClosed = () => closed;
    const controller = new AbortController();
    f.p.goto = async () => {
      f.begin(f.request('fetch'));
    };
    const loading = waitForStartupPage(f.p, f.p.url(), { signal: controller.signal });
    await elapse(t, 500);
    controller.abort();
    closed = true;
    await elapse(t, 100);
    assert.equal(await loading, false);
    assert.equal(pageListeners(f.p), 0);
    assert.equal(timers.armed.size, 0);
  } finally {
    timers.restore();
  }
});

test('a guard that is not a positive duration is refused before the page is touched', async () => {
  const cases = [
    { guards: { silenceMs: Number.NaN }, message: 'silenceMs must be a positive number of milliseconds.' },
    { guards: { silenceMs: 0 }, message: 'silenceMs must be a positive number of milliseconds.' },
    { guards: { silenceMs: -1 }, message: 'silenceMs must be a positive number of milliseconds.' },
    { guards: { capMs: 0 }, message: 'capMs must be a positive number of milliseconds.' },
    { guards: { capMs: Number.NaN }, message: 'capMs must be a positive number of milliseconds.' },
  ];
  for (const { guards, message } of cases) {
    const f = startupRequestFixture();
    let navigated = false;
    f.p.goto = async () => {
      navigated = true;
    };
    await assert.rejects(waitForStartupPage(f.p, f.p.url(), guards), { message });
    assert.equal(navigated, false, `${message} must be refused before navigation`);
    assert.deepEqual(f.p.eventNames(), [], `${message} must be refused before any listener is attached`);
  }
});

test('the start-up wait takes --startup-timeout as its silence guard, and keeps the default without it', async () => {
  const { startupWaitOptions } = await import('../lense/startup-progress.mjs');
  const stopped = new Promise(() => {});
  assert.equal(startupWaitOptions({ 'startup-timeout': '1000' }, { stopped }).silenceMs, 1000);
  assert.equal(startupWaitOptions({}, { stopped }).silenceMs, undefined);
  assert.equal(startupWaitOptions({ 'startup-timeout': '1000' }, { stopped }).stopped, stopped);
  for (const file of [
    '../lense/commands/dev.mjs',
    '../lense/standalone-mirage.mjs',
    '../lense/commands/model-driven.mjs',
  ]) {
    assert.match(await fs.readFile(new URL(file, import.meta.url), 'utf8'), /startupWaitOptions\(args, \{/, file);
  }
});

test('the load wait gets only the cap left after the document navigation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  const capMs = 300_000;
  let loadTimeout;
  f.p.goto = async () => {
    // A document that arrives after 60 % of the cap leaves 40 % for the load wait.
    t.mock.timers.tick((capMs * 6) / 10);
  };
  f.p.waitForLoadState = async (state, options) => {
    loadTimeout = options.timeout;
  };
  assert.equal(await waitForStartupPage(f.p, f.p.url(), { capMs }), true);
  assert.ok(loadTimeout <= (capMs * 4) / 10, `the load wait was given ${loadTimeout} ms`);
});

test('a load wait that times out reports the cap guard and names the load step', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = startupRequestFixture();
  f.p.waitForLoadState = async () => {
    const timeout = new Error('page.waitForLoadState: Timeout 300000ms exceeded.');
    timeout.name = 'TimeoutError';
    throw timeout;
  };
  await assert.rejects(waitForStartupPage(f.p, f.p.url(), { capMs: 300_000 }), (error) => {
    assert.match(error.message, /Initial page load did not finish/);
    assert.match(error.message, /300000 ms cap guard/);
    assert.doesNotMatch(error.message, /exceeded/);
    return true;
  });
});
