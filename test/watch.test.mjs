import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { watchSources, trackOnlineState } from '../lense/commands/dev.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a pinned session baseline avoids idle Git polling while source saves still refresh', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pinned-watch-')));
  const file = path.join(dir, 'script.js');
  fs.writeFileSync(file, '// initial\n');
  // The smallest layout Git accepts as a repository, so the watcher follows its HEAD.
  fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git', 'refs'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  // The watcher logs and swallows baseline-check errors, so count calls instead of throwing in one.
  let baselineChecks = 0,
    headChecks = 0;
  const repository = new EventEmitter();
  const polled = once(repository, 'polled', { signal: AbortSignal.timeout(5000) });
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    baseline: {
      available: true,
      spec: 'a'.repeat(40),
      commit: 'a'.repeat(40),
      checkForUpdate: async () => {
        baselineChecks++;
        return false;
      },
    },
    refreshHead: async () => {
      if (++headChecks === 2) repository.emit('polled');
    },
    model: { webFiles: [] },
    rewriter: { unsupported: [] },
    refresh: () => {},
    rel: (f) => path.relative(dir, f),
  });
  const watcher = watchSources(session, { pages: () => [] }, { baselinePollMs: 20, log: () => {} });
  t.after(async () => {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await watcher.ready;
  // A repository check asks for a ref update right after refreshing HEAD, and the next check
  // starts only once the previous one finished: a second HEAD refresh follows a complete check.
  await polled;
  assert.equal(baselineChecks, 0, 'immutable baselines need no idle ref checks');
  const refreshed = once(session, 'refreshed', { signal: AbortSignal.timeout(5000) });
  fs.writeFileSync(file, '// next save\n');
  const [event] = await refreshed;
  assert.deepEqual(event.files, [file]);
});

test('an explicitly selected extract under .paqvilo is watched while its generated children stay ignored', async () => {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-parent-')));
  const dir = path.join(parent, '.paqvilo', 'source');
  const file = path.join(dir, 'script.js');
  fs.mkdirSync(path.join(dir, '.paqvilo'), { recursive: true });
  fs.writeFileSync(file, '// baseline\n');
  const ignoredFile = path.join(dir, '.paqvilo', 'state.json');
  fs.writeFileSync(ignoredFile, '{}');
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    model: { webFiles: [] },
    rewriter: { unsupported: [] },
    refresh: () => {},
    rel: (f) => path.relative(dir, f),
  });
  const events = [];
  session.on('refreshed', (event) => events.push(...event.files));
  const watcher = watchSources(session, { pages: () => [] }, { log: () => {} });
  try {
    await watcher.ready;
    const refreshed = once(session, 'refreshed', { signal: AbortSignal.timeout(5000) });
    fs.writeFileSync(file, '// saved\n');
    await refreshed;
    // A later real save proves the watcher already processed the ignored write before it.
    const next = once(session, 'refreshed', { signal: AbortSignal.timeout(5000) });
    fs.writeFileSync(ignoredFile, '{"saved":true}');
    fs.writeFileSync(file, '// saved again\n');
    await next;
    assert.deepEqual(events, [file, file]);
  } finally {
    await watcher.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('saves during a reload are shown by one following reload, never an overlapping one', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-watch-')));
  const file = path.join(dir, 'script.js');
  fs.writeFileSync(file, '// 0\n');
  const signal = () => ({ signal: AbortSignal.timeout(5000) });
  let running = 0,
    overlapped = false;
  const gotos = new EventEmitter(),
    releases = [];
  // Each reload stays in flight until the test releases it.
  const page = {
    isClosed: () => false,
    url: () => 'https://portal.example.com/',
    goto: async () => {
      if (++running > 1) overlapped = true;
      await new Promise((resolve) => {
        releases.push(resolve);
        gotos.emit('goto');
      });
      running--;
    },
  };
  let prepared = 0;
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    model: { webFiles: [] },
    rewriter: { unsupported: [] },
    refresh: () => {
      prepared++;
    },
    rel: (f) => path.relative(dir, f),
  });
  const seen = [];
  session.on('refreshed', ({ files }) => seen.push(files));
  const watcher = watchSources(session, { pages: () => [page] }, { log: () => {} });
  t.after(async () => {
    releases.forEach((release) => release());
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await watcher.ready;
  const first = once(gotos, 'goto', signal());
  fs.writeFileSync(file, '// 1\n');
  await first;
  // Two saves arrive during the first reload. Their debounce runs on the mock clock, so it fires
  // while that reload is still in flight. The window has no await: no I/O or real timer runs in it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  watcher.emit('all', 'change', file);
  watcher.emit('all', 'change', file);
  t.mock.timers.runAll();
  t.mock.timers.reset();
  // A reload starts by preparing the session synchronously, so a second one would show here at once.
  assert.equal(prepared, 1, 'the save debounce must not start a reload while one is in flight');
  assert.equal(releases.length, 1);
  const second = once(gotos, 'goto', signal());
  releases[0]();
  await second;
  releases[1]();
  await watcher.whenIdle(5000);
  assert.equal(overlapped, false, 'two reloads ran at the same time');
  assert.equal(releases.length, 2, 'both saves made during the first reload share the next one');
  assert.deepEqual(seen, [[file], [file]]);
  assert.equal(prepared, 2);
  assert.equal(running, 0);
});

test('closing the watcher cancels queued saves and prevents reload after shutdown', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-watch-close-')));
  let refreshes = 0;
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    model: { webFiles: [] },
    rewriter: { unsupported: [] },
    refresh: () => {
      refreshes++;
    },
    rel: (f) => path.relative(dir, f),
  });
  const watcher = watchSources(session, { pages: () => [] }, { log: () => {} });
  try {
    await new Promise((resolve) => watcher.on('ready', resolve));
    // The queued save's debounce runs on the mock clock; running every pending timer after
    // close shows that nothing left behind refreshes. The window has no await.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    watcher.emit('all', 'change', path.join(dir, 'script.js'));
    const closing = watcher.close();
    t.mock.timers.runAll();
    t.mock.timers.reset();
    await closing;
    assert.equal(refreshes, 0);
    await watcher.close();
  } finally {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'watcher shutdown does not wait for a stalled browser navigation or emit a late refresh',
  { timeout: 5000 },
  async (t) => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-stalled-refresh-')));
    let reached;
    const started = new Promise((resolve) => {
      reached = resolve;
    });
    const session = Object.assign(new EventEmitter(), {
      cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
      model: { webFiles: [] },
      rewriter: { unsupported: [] },
      refresh: () => {},
      rel: (file) => path.relative(dir, file),
    });
    const page = {
      isClosed: () => false,
      url: () => session.cfg.origin,
      goto: () => {
        reached();
        return new Promise(() => {});
      },
    };
    const watcher = watchSources(session, { pages: () => [page] }, { log: () => {} });
    t.after(async () => {
      await watcher.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    session.on('refreshed', () => assert.fail('no refreshed event after shutdown'));
    await watcher.ready;
    watcher.emit('all', 'change', path.join(dir, 'script.js'));
    await started;
    const idle = watcher.whenIdle();
    await watcher.close();
    await idle;
  },
);

test('an explicit route file outside the source directory is watched', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-watch-route-')));
  const sourceDir = path.join(dir, 'source');
  const file = path.join(dir, 'external.js');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(file, '// before');
  const session = Object.assign(new EventEmitter(), {
    cfg: {
      sourceDir,
      origin: 'https://portal.example.com',
      site: { routes: [{ url: '/external.js', file: '../external.js' }] },
    },
    model: { webFiles: [] },
    rewriter: { unsupported: [] },
    refresh: () => {},
    rel: (f) => path.relative(sourceDir, f),
  });
  const watcher = watchSources(session, { pages: () => [] }, { log: () => {} });
  try {
    await new Promise((resolve) => watcher.on('ready', resolve));
    const seen = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('external route save was missed')), 3000);
      session.once('refreshed', (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
    fs.writeFileSync(file, '// after');
    assert.deepEqual((await seen).files, [file]);
  } finally {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('online comparisons are lazy, deduplicated, bounded, and aborted on shutdown', async () => {
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' },
    onlineState: new Map(),
  });
  const active = [];
  const compare = (_origin, entry, { signal }) => new Promise((resolve) => active.push({ entry, signal, resolve }));
  const stop = trackOnlineState(session, { compare, concurrency: 2 });
  const hit = (n) => session.emit('hit', { type: 'file', url: `/file${n}.js`, sources: [{ rel: `file${n}.js` }] });
  try {
    assert.equal(active.length, 0);
    hit(1);
    hit(1);
    hit(2);
    hit(3);
    await sleep(0);
    assert.equal(active.length, 2);
    active[0].resolve({ state: 'same' });
    await sleep(0);
    assert.equal(active.length, 3);
    assert.equal(session.onlineState.get('/file1.js'), 'same');
    stop();
    assert.ok(active.slice(1).every((item) => item.signal.aborted));
    active.slice(1).forEach((item) => item.resolve({ state: 'different' }));
    await sleep(0);
    assert.equal(session.onlineState.has('/file2.js'), false);
  } finally {
    stop();
    active.forEach((item) => item.resolve({ state: 'same' }));
  }
});

test('a comparison started before a save cannot overwrite the current version', async () => {
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' },
    onlineState: new Map(),
  });
  const active = [];
  const signals = [];
  const stop = trackOnlineState(session, {
    compare: (_origin, _entry, { signal }) =>
      new Promise((resolve) => {
        active.push(resolve);
        signals.push(signal);
      }),
    concurrency: 2,
  });
  try {
    session.emit('hit', { type: 'file', url: '/app.js', sources: [{ rel: 'app.js' }] });
    await sleep(0);
    session.emit('refreshed', { files: [path.resolve('app.js')] });
    await sleep(0);
    assert.equal(signals[0].aborted, true);
    assert.equal(active.length, 1, 'the replacement waits for the canceled request to settle');
    active[0]({ state: 'same' });
    await sleep(0);
    assert.equal(session.onlineState.has('/app.js'), false);
    active[1]({ state: 'different' });
    await sleep(0);
    assert.equal(session.onlineState.get('/app.js'), 'different');
  } finally {
    stop();
    active.forEach((resolve) => resolve({ state: 'same' }));
  }
});

test('a baseline commit change refreshes the model and reloads even without source edits', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-watch-ref-')));
  let calls = 0;
  let reloads = 0;
  const refreshed = [];
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    baseline: { spec: 'HEAD', checkForUpdate: async () => ++calls === 1 },
    model: { webFiles: [] },
    rewriter: { unsupported: [] },
    refresh: (files) => refreshed.push(files),
    rel: (f) => path.relative(dir, f),
  });
  const context = {
    pages: () => [
      {
        isClosed: () => false,
        url: () => session.cfg.origin,
        goto: async () => {
          reloads++;
        },
      },
    ],
  };
  const baselinePollMs = 20;
  const watcher = watchSources(session, context, { baselinePollMs, log: () => {} });
  try {
    const seen = new Promise((resolve) => session.once('refreshed', resolve));
    const event = await seen;
    assert.deepEqual(refreshed, [[]]);
    assert.equal(reloads, 1);
    assert.equal(event.baselineChanged, true);
    assert.equal(event.how, 'reload');
    await watcher.close();
    const previousCalls = calls;
    // No event marks a poll that does not happen: five poll periods would expose a surviving
    // interval. The interval starts after an asynchronous Git probe, so it cannot be mocked here.
    await sleep(5 * baselinePollMs);
    assert.equal(calls, previousCalls);
    assert.equal(reloads, 1);
  } finally {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('web CSS reaches the browser before deferred Git tracking completes', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-watch-fast-css-')));
  const file = path.join(dir, 'site.css');
  fs.writeFileSync(file, 'body { color: red; }');
  const order = [];
  let finishTracking, trackingStarted;
  const tracking = new Promise((resolve) => {
    trackingStarted = resolve;
  });
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    model: { webFiles: [{ file, url: '/site.css' }] },
    rewriter: { unsupported: [] },
    refresh: (_files, options) => {
      assert.equal(options.deferChangeTracking, true);
      order.push('prepared');
      return { changeTrackingDeferred: true };
    },
    refreshChangeTracking: () => {
      order.push('tracking');
      trackingStarted();
      return new Promise((resolve) => {
        finishTracking = () => {
          order.push('tracked');
          resolve({ baselineChanged: false });
        };
      });
    },
    rel: (f) => path.relative(dir, f),
  });
  const page = {
    isClosed: () => false,
    url: () => session.cfg.origin,
    evaluate: async () => {
      order.push('css');
      return { links: 1, styles: 0 };
    },
    goto: async () => assert.fail('CSS should swap without navigation'),
  };
  const watcher = watchSources(session, { pages: () => [page] }, { log: () => {} });
  try {
    await watcher.ready;
    const refreshed = new Promise((resolve) => session.once('refreshed', resolve));
    watcher.emit('all', 'change', file);
    await tracking;
    assert.deepEqual(order, ['prepared', 'css', 'tracking']);
    finishTracking();
    const event = await refreshed;
    assert.equal(event.how, 'css');
    assert.deepEqual(order, ['prepared', 'css', 'tracking', 'tracked']);
  } finally {
    finishTracking?.();
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('comparison history evicts least-recently-used entries and never publishes an evicted job', async () => {
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' },
    onlineState: new Map(),
  });
  const jobs = [];
  const stop = trackOnlineState(session, {
    concurrency: 1,
    maxEntries: 3,
    compare: (_origin, entry, { signal }) => new Promise((resolve) => jobs.push({ entry, signal, resolve })),
  });
  const hit = (n) => session.emit('hit', { type: 'file', url: `/file${n}.js`, sources: [{ rel: `file${n}.js` }] });
  try {
    hit(1);
    await sleep(0);
    hit(2);
    hit(3);
    hit(4);
    assert.equal(jobs[0].signal.aborted, true);
    jobs[0].resolve({ state: 'same' });
    await sleep(0);
    assert.equal(session.onlineState.has('/file1.js'), false);
    for (let index = 1; index < 4; index++) {
      jobs[index].resolve({ state: 'different' });
      await sleep(0);
    }
    assert.deepEqual([...session.onlineState.keys()], ['/file2.js', '/file3.js', '/file4.js']);
    hit(2);
    hit(5);
    await sleep(0);
    assert.equal(session.onlineState.has('/file3.js'), false);
    jobs[4].resolve({ state: 'same' });
    await sleep(0);
    assert.deepEqual([...session.onlineState.keys()].sort(), ['/file2.js', '/file4.js', '/file5.js']);
    stop();
    assert.equal(session.onlineState.size, 0);
  } finally {
    stop();
    for (const job of jobs) job.resolve({ state: 'same' });
  }
});

test('metadata remapping aborts old-file comparisons and removes URLs that no longer resolve', async () => {
  const files = new Map([['/app.js', path.resolve('old.js')]]);
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' },
    onlineState: new Map(),
    resolver: { resolve: (url) => (files.has(url) ? { file: files.get(url) } : null) },
  });
  const jobs = [];
  const stop = trackOnlineState(session, {
    concurrency: 1,
    compare: (_origin, entry, { signal }) => new Promise((resolve) => jobs.push({ entry, signal, resolve })),
  });
  try {
    session.emit('hit', { type: 'file', url: '/app.js', sources: [{ rel: 'old.js' }] });
    await sleep(0);
    files.set('/app.js', path.resolve('new.js'));
    session.emit('refreshed', { files: [path.resolve('app.webfile.yml')] });
    assert.equal(jobs[0].signal.aborted, true);
    jobs[0].resolve({ state: 'same' });
    await sleep(0);
    assert.equal(session.onlineState.has('/app.js'), false);
    assert.equal(jobs[1].entry.file, path.resolve('new.js'));
    jobs[1].resolve({ state: 'different' });
    await sleep(0);
    assert.equal(session.onlineState.get('/app.js'), 'different');
    files.delete('/app.js');
    session.emit('refreshed', { files: [path.resolve('app.webfile.yml')] });
    assert.equal(session.onlineState.has('/app.js'), false);
  } finally {
    stop();
    for (const job of jobs) job.resolve({ state: 'same' });
  }
});

test('save bursts keep one superseding comparison per resource and retry unreachable state after TTL', async (t) => {
  // The result age is read from Date.now(); a mock clock keeps a slow turn from expiring it early.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const maxAgeMs = 30;
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' },
    onlineState: new Map(),
  });
  const jobs = [];
  const stop = trackOnlineState(session, {
    concurrency: 2,
    maxAgeMs,
    compare: (_origin, entry, { signal }) => new Promise((resolve) => jobs.push({ entry, signal, resolve })),
  });
  const hit = () => session.emit('hit', { type: 'file', url: '/app.js', sources: [{ rel: 'app.js' }] });
  try {
    hit();
    await sleep(0);
    for (let i = 0; i < 20; i++) session.emit('refreshed', { files: [path.resolve('app.js')] });
    assert.equal(jobs[0].signal.aborted, true);
    assert.equal(jobs.length, 1);
    jobs[0].resolve({ state: 'same' });
    await sleep(0);
    assert.equal(jobs.length, 2);
    jobs[1].resolve({ state: 'unreachable' });
    await sleep(0);
    hit();
    await sleep(0);
    assert.equal(jobs.length, 2, 'a failed request still observes the retry interval');
    t.mock.timers.tick(maxAgeMs);
    hit();
    await sleep(0);
    assert.equal(jobs.length, 3);
    jobs[2].resolve({ state: 'same' });
    await sleep(0);
    assert.equal(session.onlineState.get('/app.js'), 'same');
  } finally {
    stop();
    for (const job of jobs) job.resolve({ state: 'same' });
  }
});
