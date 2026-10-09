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
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    baseline: { available: true, spec: 'a'.repeat(40), commit: 'a'.repeat(40), checkForUpdate: () => assert.fail('immutable baselines need no idle ref checks') },
    model: { webFiles: [] }, rewriter: { unsupported: [] }, refresh: () => {}, rel: (f) => path.relative(dir, f),
  });
  const watcher = watchSources(session, { pages: () => [] }, { baselinePollMs: 20, log: () => {} });
  t.after(async () => { await watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await watcher.ready;
  await sleep(120);
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
    model: { webFiles: [] }, rewriter: { unsupported: [] }, refresh: () => {}, rel: (f) => path.relative(dir, f),
  });
  const events = [];
  session.on('refreshed', (event) => events.push(...event.files));
  const watcher = watchSources(session, { pages: () => [] }, { log: () => {} });
  try {
    await watcher.ready;
    const refreshed = once(session, 'refreshed', { signal: AbortSignal.timeout(5000) });
    fs.writeFileSync(file, '// saved\n');
    await refreshed;
    fs.writeFileSync(ignoredFile, '{"saved":true}');
    await sleep(400);
    assert.deepEqual(events, [file]);
  } finally {
    await watcher.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('saves in quick succession never start a reload while another is under way', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-watch-')));
  const file = path.join(dir, 'script.js');
  fs.writeFileSync(file, '// 0\n');

  let running = 0;
  let overlapped = false;
  let reloads = 0;
  const page = {
    isClosed: () => false,
    url: () => 'https://portal.example.com/',
    // a reload takes far longer than the gap between the saves
    goto: async () => {
      if (++running > 1) overlapped = true;
      reloads++;
      await sleep(400);
      running--;
    },
  };
  const context = { pages: () => [page] };
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    model: { webFiles: [] },
    rewriter: { unsupported: [] },
    refresh: () => {},
    rel: (f) => path.relative(dir, f),
  });
  const seen = [];
  session.on('refreshed', ({ files }) => seen.push(...files));

  const watcher = watchSources(session, context, { log: () => {} });
  await new Promise((resolve) => watcher.on('ready', resolve));
  try {
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(file, `// ${i}\n`);
      await sleep(250);
    }
    await sleep(1500);
    assert.equal(overlapped, false, 'two reloads ran at the same time');
    assert.ok(reloads >= 2, 'the saves that arrived during a reload must still be shown');
    assert.ok(seen.every((f) => f === file));
    // and it settles: no reload keeps running or re-arming itself
    const settled = reloads;
    await sleep(700);
    assert.equal(reloads, settled);
    assert.equal(running, 0);
  } finally {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closing the watcher cancels queued saves and prevents reload after shutdown', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-watch-close-')));
  let refreshes = 0;
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    model: { webFiles: [] },
    rewriter: { unsupported: [] },
    refresh: () => { refreshes++; },
    rel: (f) => path.relative(dir, f),
  });
  const watcher = watchSources(session, { pages: () => [] }, { log: () => {} });
  try {
    await new Promise((resolve) => watcher.on('ready', resolve));
    watcher.emit('all', 'change', path.join(dir, 'script.js'));
    await watcher.close();
    await sleep(250);
    assert.equal(refreshes, 0);
    await watcher.close();
  } finally {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher shutdown does not wait for a stalled browser navigation or emit a late refresh', { timeout: 5000 }, async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-stalled-refresh-')));
  let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} }, model: { webFiles: [] },
    rewriter: { unsupported: [] }, refresh: () => {}, rel: (file) => path.relative(dir, file),
  });
  const page = { isClosed: () => false, url: () => session.cfg.origin, goto: () => { reached(); return new Promise(() => {}); } };
  const watcher = watchSources(session, { pages: () => [page] }, { log: () => {} });
  t.after(async () => { await watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  session.on('refreshed', () => assert.fail('no refreshed event after shutdown'));
  await watcher.ready;
  watcher.emit('all', 'change', path.join(dir, 'script.js'));
  await started;
  const idle = watcher.whenIdle();
  await watcher.close();
  await idle;
});

test('an explicit route file outside the source directory is watched', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-watch-route-')));
  const sourceDir = path.join(dir, 'source');
  const file = path.join(dir, 'external.js');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(file, '// before');
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir, origin: 'https://portal.example.com', site: { routes: [{ url: '/external.js', file: '../external.js' }] } },
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
      session.once('refreshed', (event) => { clearTimeout(timer); resolve(event); });
    });
    fs.writeFileSync(file, '// after');
    assert.deepEqual((await seen).files, [file]);
  } finally {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('online comparisons are lazy, deduplicated, bounded, and aborted on shutdown', async () => {
  const session = Object.assign(new EventEmitter(), { cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' }, onlineState: new Map() });
  const active = [];
  const compare = (_origin, entry, { signal }) => new Promise((resolve) => active.push({ entry, signal, resolve }));
  const stop = trackOnlineState(session, { compare, concurrency: 2 });
  const hit = (n) => session.emit('hit', { type: 'file', url: `/file${n}.js`, sources: [{ rel: `file${n}.js` }] });
  try {
    assert.equal(active.length, 0);
    hit(1); hit(1); hit(2); hit(3);
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
  const session = Object.assign(new EventEmitter(), { cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' }, onlineState: new Map() });
  const active = [];
  const signals = [];
  const stop = trackOnlineState(session, { compare: (_origin, _entry, { signal }) => new Promise((resolve) => { active.push(resolve); signals.push(signal); }), concurrency: 2 });
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
  const context = { pages: () => [{ isClosed: () => false, url: () => session.cfg.origin, goto: async () => { reloads++; } }] };
  const watcher = watchSources(session, context, { baselinePollMs: 20, log: () => {} });
  try {
    const seen = new Promise((resolve) => session.once('refreshed', resolve));
    const event = await seen;
    assert.deepEqual(refreshed, [[]]);
    assert.equal(reloads, 1);
    assert.equal(event.baselineChanged, true);
    assert.equal(event.how, 'reload');
    await watcher.close();
    const previousCalls = calls;
    await sleep(100);
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
  let finishTracking;
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: dir, origin: 'https://portal.example.com', site: {} },
    model: { webFiles: [{ file, url: '/site.css' }] }, rewriter: { unsupported: [] },
    refresh: (_files, options) => { assert.equal(options.deferChangeTracking, true); order.push('prepared'); return { changeTrackingDeferred: true }; },
    refreshChangeTracking: () => { order.push('tracking'); return new Promise((resolve) => { finishTracking = () => { order.push('tracked'); resolve({ baselineChanged: false }); }; }); },
    rel: (f) => path.relative(dir, f),
  });
  const page = { isClosed: () => false, url: () => session.cfg.origin, evaluate: async () => { order.push('css'); return { links: 1, styles: 0 }; }, goto: async () => assert.fail('CSS should swap without navigation') };
  const watcher = watchSources(session, { pages: () => [page] }, { log: () => {} });
  try {
    await watcher.ready;
    const refreshed = new Promise((resolve) => session.once('refreshed', resolve));
    watcher.emit('all', 'change', file);
    await sleep(180);
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
  const session = Object.assign(new EventEmitter(), { cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' }, onlineState: new Map() });
  const jobs = [];
  const stop = trackOnlineState(session, { concurrency: 1, maxEntries: 3, compare: (_origin, entry, { signal }) => new Promise((resolve) => jobs.push({ entry, signal, resolve })) });
  const hit = (n) => session.emit('hit', { type: 'file', url: `/file${n}.js`, sources: [{ rel: `file${n}.js` }] });
  try {
    hit(1); await sleep(0);
    hit(2); hit(3); hit(4);
    assert.equal(jobs[0].signal.aborted, true);
    jobs[0].resolve({ state: 'same' }); await sleep(0);
    assert.equal(session.onlineState.has('/file1.js'), false);
    for (let index = 1; index < 4; index++) { jobs[index].resolve({ state: 'different' }); await sleep(0); }
    assert.deepEqual([...session.onlineState.keys()], ['/file2.js', '/file3.js', '/file4.js']);
    hit(2); hit(5); await sleep(0);
    assert.equal(session.onlineState.has('/file3.js'), false);
    jobs[4].resolve({ state: 'same' }); await sleep(0);
    assert.deepEqual([...session.onlineState.keys()].sort(), ['/file2.js', '/file4.js', '/file5.js']);
    stop();
    assert.equal(session.onlineState.size, 0);
  } finally { stop(); for (const job of jobs) job.resolve({ state: 'same' }); }
});

test('metadata remapping aborts old-file comparisons and removes URLs that no longer resolve', async () => {
  const files = new Map([['/app.js', path.resolve('old.js')]]);
  const session = Object.assign(new EventEmitter(), {
    cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' }, onlineState: new Map(),
    resolver: { resolve: (url) => files.has(url) ? { file: files.get(url) } : null },
  });
  const jobs = [];
  const stop = trackOnlineState(session, { concurrency: 1, compare: (_origin, entry, { signal }) => new Promise((resolve) => jobs.push({ entry, signal, resolve })) });
  try {
    session.emit('hit', { type: 'file', url: '/app.js', sources: [{ rel: 'old.js' }] }); await sleep(0);
    files.set('/app.js', path.resolve('new.js'));
    session.emit('refreshed', { files: [path.resolve('app.webfile.yml')] });
    assert.equal(jobs[0].signal.aborted, true);
    jobs[0].resolve({ state: 'same' }); await sleep(0);
    assert.equal(session.onlineState.has('/app.js'), false);
    assert.equal(jobs[1].entry.file, path.resolve('new.js'));
    jobs[1].resolve({ state: 'different' }); await sleep(0);
    assert.equal(session.onlineState.get('/app.js'), 'different');
    files.delete('/app.js');
    session.emit('refreshed', { files: [path.resolve('app.webfile.yml')] });
    assert.equal(session.onlineState.has('/app.js'), false);
  } finally { stop(); for (const job of jobs) job.resolve({ state: 'same' }); }
});

test('save bursts keep one superseding comparison per resource and retry unreachable state after TTL', async () => {
  const session = Object.assign(new EventEmitter(), { cfg: { sourceDir: process.cwd(), origin: 'https://portal.example.com' }, onlineState: new Map() });
  const jobs = [];
  const stop = trackOnlineState(session, { concurrency: 2, maxAgeMs: 30, compare: (_origin, entry, { signal }) => new Promise((resolve) => jobs.push({ entry, signal, resolve })) });
  const hit = () => session.emit('hit', { type: 'file', url: '/app.js', sources: [{ rel: 'app.js' }] });
  try {
    hit(); await sleep(0);
    for (let i = 0; i < 20; i++) session.emit('refreshed', { files: [path.resolve('app.js')] });
    assert.equal(jobs[0].signal.aborted, true);
    assert.equal(jobs.length, 1);
    jobs[0].resolve({ state: 'same' }); await sleep(0);
    assert.equal(jobs.length, 2);
    jobs[1].resolve({ state: 'unreachable' }); await sleep(0);
    hit(); await sleep(0);
    assert.equal(jobs.length, 2, 'a failed request still observes the retry interval');
    await sleep(40); hit(); await sleep(0);
    assert.equal(jobs.length, 3);
    jobs[2].resolve({ state: 'same' }); await sleep(0);
    assert.equal(session.onlineState.get('/app.js'), 'same');
  } finally { stop(); for (const job of jobs) job.resolve({ state: 'same' }); }
});
