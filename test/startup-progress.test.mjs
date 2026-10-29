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
      JSON.stringify({ type: 'runtime-startup', phase: 'untrusted', elapsedMs: 40 }) +
      '\n',
  );
  const second = await readStartupPhases(file, first.cursor);
  assert.deepEqual(second.events, [{ phase: 'organization', elapsedMs: 30 }]);
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
  assert.equal(await waitForStartupPage(f.p, f.p.url(), { nativeModelDriven: true, timeout: 180, progress }), true);
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
