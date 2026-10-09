import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { OverlaySession } from '../lense/session.mjs';
import { PortalModel, isSourceFile } from '../lense/portal-model.mjs';
import { GitBaseline, gitHead, gitDirectories } from '../lense/git.mjs';
import { watchSources, logHits } from '../lense/commands/dev.mjs';
import { createFixture, SITE } from './fixture.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', timeout: 30_000 }).trim();
function fixture(t) { const fx = createFixture(); t.after(() => fx.cleanup()); return fx; }
function session(fx) { return new OverlaySession({ sourceDir: fx.dir, site: structuredClone(SITE), origin: 'https://portal.example' }); }

test('scratch saves are ignored while new page code and missing asset payloads rebuild the index', async (t) => {
  const fx = fixture(t);
  fx.write('web-files/missing.webfile.yml', 'adx_name: missing\nadx_partialurl: missing.js\n');
  const s = session(fx);
  const load = t.mock.method(s.model, 'load');
  for (const rel of ['notes.txt', 'notes.yml', 'notes.xml', 'notes.tmp', 'web-pages/home/.#Home.webpage.custom_css.css', 'web-files/day.js___jb_tmp___']) {
    fx.write(rel, 'scratch');
    assert.equal((await s.refreshAsync([fx.file(rel)])).ignored, true, rel);
  }
  assert.equal(load.mock.callCount(), 0);
  assert.equal((await s.refreshAsync([fx.file('unwritten-note.txt')])).ignored, true, 'a missing asset payload must not break classification of absent paths');
  assert.equal(s.knownFiles.has(null), false);
  const rel = 'web-pages/home/content-pages/New.webpage.custom_javascript.js';
  fx.write(rel, 'window.newPageSource = true;');
  await s.refreshAsync([fx.file(rel)]);
  assert.equal(load.mock.callCount(), 1);
  assert.ok(s.rewriter.blocks.some((block) => block.file === fx.file(rel)));
});

test('path caching cannot retain a descendant after an ancestor is moved outside and replaced by a junction', (t) => {
  const fx = fixture(t);
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-outside-ancestor-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = fx.file('basic-forms/contact/Contact.basicform.custom_javascript.js');
  new PortalModel(fx.dir);
  assert.equal(isSourceFile(fx.dir, file), true);
  const parent = fx.file('basic-forms');
  const target = path.join(outside, 'moved');
  fs.renameSync(parent, target);
  fs.symlinkSync(target, parent, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(isSourceFile(fx.dir, file), false);
  assert.equal(new PortalModel(fx.dir).inlineSources.some((source) => source.file === file), false);
});

test('inactive classic roots exclude their language sources without hiding unrelated unresolvable edits', (t) => {
  const fx = fixture(t);
  fx.write('web-pages/home/Home.webpage.yml', fx.read('web-pages/home/Home.webpage.yml') + 'statecode: 1\n');
  fx.commit();
  const model = new PortalModel(fx.dir);
  assert.equal(model.inlineSources.some((source) => source.rel.includes('Home.en-US')), false);
  const s = session(fx);
  assert.deepEqual(s.rewriter.unsupported, [], 'untouched inactive sources are not deployment warnings');
  const css = fx.file('web-pages/home/content-pages/Home.en-US.webpage.custom_css.css');
  fx.write(s.rel(css), '.hero { color: blue; }');
  s.refresh([css]);
  assert.ok(s.rewriter.unsupported.some((entry) => entry.rel === s.rel(css) && /inactive/.test(entry.reason)), 'an edited inactive page must not silently disappear');
  const about = fx.file('web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js');
  fx.write(s.rel(about), 'window.unresolvableLocalEdit = true;');
  s.refresh([about]);
  assert.ok(s.rewriter.unsupported.some((entry) => entry.rel === s.rel(about) && /cannot be resolved/.test(entry.reason)));
});

test('Git awareness handles branches, detached HEAD and linked worktree directories', async (t) => {
  const fx = fixture(t);
  git(fx.dir, 'switch', '-c', 'day-session');
  const head = await gitHead(fx.dir);
  assert.equal(head.branch, 'day-session');
  assert.equal(head.detached, false);
  const dirs = await gitDirectories(fx.file('web-pages/home'));
  assert.equal(dirs.toplevel, fx.dir);
  assert.equal(dirs.gitDir, dirs.commonDir);
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-linked-awareness-')));
  const linked = path.join(parent, 'checkout');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(fx.dir, 'worktree', 'add', '--detach', linked, 'HEAD');
  const linkedDirs = await gitDirectories(linked);
  assert.notEqual(linkedDirs.gitDir, linkedDirs.commonDir);
  assert.equal(linkedDirs.commonDir, dirs.commonDir);
  assert.deepEqual(await gitHead(linked), { commit: head.commit, branch: null, detached: true });
  git(fx.dir, 'switch', '--detach');
  assert.equal((await gitHead(fx.dir)).detached, true);
});

test('repository watching notices a commit with a pinned baseline and polling still works when disabled', async (t) => {
  const fx = fixture(t);
  const s = session(fx);
  const initial = await s.refreshHead();
  s.baseline = new GitBaseline(fx.dir, initial.commit);
  const watcher = watchSources(s, { pages: () => [] }, { baselinePollMs: 60_000, log: () => {} });
  t.after(() => watcher.close());
  await watcher.ready;
  const updated = once(s, 'head', { signal: AbortSignal.timeout(10_000) });
  fx.write('web-files/app.js', 'window.committed = true;');
  fx.commit();
  const [head] = await updated;
  assert.notEqual(head.commit, initial.commit);
  assert.equal(s.baseline.commit, initial.commit, 'commit does not erase pinned patches');
  await watcher.close();
  const poll = watchSources(s, { pages: () => [] }, { gitWatch: false, baselinePollMs: 30, log: () => {} });
  t.after(() => poll.close());
  const renamed = once(s, 'head', { signal: AbortSignal.timeout(10_000) });
  git(fx.dir, 'switch', '-c', 'polling-still-aware');
  assert.equal((await renamed)[0].branch, 'polling-still-aware');
});

test('Pin HEAD waits for an in-flight save, retains source pauses, and preserves explicit refs', async (t) => {
  const fx = fixture(t);
  const s = session(fx);
  const initial = await s.refreshHead();
  s.cfg.site.markup = { ...s.cfg.site.markup, baseline: initial.commit, requestedBaseline: 'HEAD' };
  s.baseline = new GitBaseline(fx.dir, initial.commit);
  s.rewriter.baseline = s.baseline;
  s.disabled.add('web-files/app.js');
  const original = s.baseline.changedFilesAsync.bind(s.baseline);
  let release;
  let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  t.mock.method(s.baseline, 'changedFilesAsync', async (...args) => {
    const result = await original(...args); reached(); await gate; return result;
  });
  const about = 'web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js';
  fx.write(about, 'window.newCommit = true;');
  const saved = s.refreshAsync([fx.file(about)]);
  await started;
  fx.commit();
  const repinned = s.repinBaseline();
  release();
  await saved;
  const head = await repinned;
  assert.equal(s.baseline.commit, head.commit);
  assert.equal(s.changedFiles.size, 0);
  assert.ok(s.disabled.has('web-files/app.js'));
  assert.ok(s.rewriter.blocks.some((block) => block.text === 'window.newCommit = true;'));
  s.cfg.site.markup = { ...s.cfg.site.markup, requestedBaseline: 'origin/deployed' };
  await assert.rejects(s.repinBaseline(), /explicit baseline refs/);
  assert.equal(s.baseline.commit, head.commit);
});

test('navigation logging groups resources and shutdown releases timers and listeners', async () => {
  const s = Object.assign(new EventEmitter(), { cfg: { siteName: 'test', envName: 'loopback' } });
  const logs = [];
  const stop = logHits(s, (line) => logs.push(line), { verbose: false, settleMs: 5 });
  const page = {};
  s.emit('hit', { page, navigation: true, url: '/', sources: [], type: 'html' });
  for (let i = 0; i < 50; i++) s.emit('hit', { page, url: `/asset-${i}.js`, type: 'file', sources: [{ rel: `web-files/asset-${i}.js` }] });
  await sleep(15);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /test@loopback.*50 local files/);
  s.emit('hit', { page, type: 'file', url: '/late.js', sources: [{ rel: 'web-files/late.js' }] });
  stop();
  await sleep(15);
  assert.equal(logs.length, 1);
  assert.equal(s.listenerCount('hit') + s.listenerCount('fault'), 0);
});

test('Pin HEAD waits for the watcher\'s browser refresh before publishing its new baseline', async (t) => {
  const fx = fixture(t);
  const s = session(fx);
  let release;
  s.watchedRefresh = new Promise((resolve) => { release = resolve; });
  const previous = s.baseline;
  const pin = s.repinBaseline();
  await sleep(10);
  assert.equal(s.baseline, previous);
  release();
  await pin;
  assert.notEqual(s.baseline, previous);
});
