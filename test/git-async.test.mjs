import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { GitBaseline } from '../lense/git.mjs';
import { createFixture } from './fixture.mjs';

// Hold delivery after a real Git command has finished, so race order is deterministic.
function holdCommand(t, command) {
  const original = childProcess.execFile;
  let release;
  let reached;
  let held = false;
  let active = 0;
  let peak = 0;
  const commands = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  const mock = t.mock.method(childProcess, 'execFile', function (file, args, options, callback) {
    commands.push(args);
    active++;
    peak = Math.max(peak, active);
    return original.call(this, file, args, options, (err, stdout, stderr) => {
      const deliver = () => { active--; callback(err, stdout, stderr); };
      if (!held && args.includes(command)) {
        held = true;
        reached();
        gate.then(deliver);
      } else deliver();
    });
  });
  syncBuiltinESMExports();
  t.after(() => { release(); mock.mock.restore(); syncBuiltinESMExports(); });
  return { started, release, commands, get peak() { return peak; } };
}

test('async change scans preserve scoped edits, remove reversions and fully rescan a new baseline', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  const app = fx.file('web-files/app.js');
  const original = fx.read('web-files/app.js');
  assert.equal((await baseline.changedFilesAsync({ refreshRef: false })).size, 0);
  fx.write('web-files/app.js', 'edited');
  fx.write('web-files/pending.js', 'untracked');
  assert.equal((await baseline.changedFilesAsync()).size, 2);
  fx.write('web-files/app.js', original);
  const reverted = await baseline.changedFilesAsync({ files: [app] });
  assert.equal(reverted.has(app), false);
  assert.equal(reverted.has(fx.file('web-files/pending.js')), true);
  fx.write('web-files/[ab].js', 'literal');
  fx.write('web-files/a.js', 'unrelated');
  const literal = await baseline.changedFilesAsync({ files: [fx.file('web-files/[ab].js')] });
  assert.equal(literal.has(fx.file('web-files/[ab].js')), true);
  assert.equal(literal.has(fx.file('web-files/a.js')), false);
  fx.commit();
  fx.write('web-files/not-scoped.js', 'new since baseline changed');
  const moved = await baseline.changedFilesAsync({ files: [app] });
  assert.deepEqual([...moved], [fx.file('web-files/not-scoped.js')]);
  moved.clear();
  assert.equal((await baseline.changedFilesAsync({ files: [app] })).size, 1, 'returned sets are independent');
});

test('a delayed async result cannot overwrite a newer synchronous scan or commit', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  baseline.changedFiles({ refreshRef: false });
  fx.write('web-files/app.js', 'first edit');
  const hold = holdCommand(t, 'diff');
  const pending = baseline.changedFilesAsync({ files: [fx.file('web-files/app.js')], refreshRef: false });
  await hold.started;
  fx.commit();
  fx.write('web-files/newer.js', 'newer edit');
  const latest = baseline.changedFiles({ files: [fx.file('web-files/newer.js')] });
  const commit = baseline.commit;
  hold.release();
  assert.deepEqual(await pending, latest);
  assert.deepEqual(latest, new Set([fx.file('web-files/newer.js')]));
  assert.equal(baseline.commit, commit);
  assert.equal(baseline.show(fx.file('web-files/app.js')), 'first edit');
});

test('overlapping async save bursts keep pending paths and bound Git subprocess concurrency', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  baseline.changedFiles({ refreshRef: false });
  const hold = holdCommand(t, 'diff');
  fx.write('web-files/a.js', 'first');
  const first = baseline.changedFilesAsync({ files: [fx.file('web-files/a.js')], refreshRef: false });
  await hold.started;
  fx.write('web-files/b.js', 'second');
  const second = baseline.changedFilesAsync({ files: [fx.file('web-files/b.js')], refreshRef: false });
  fx.write('web-files/c.js', 'third');
  const third = baseline.changedFilesAsync({ files: [fx.file('web-files/c.js')], refreshRef: false });
  hold.release();
  const [, , latest] = await Promise.all([first, second, third]);
  assert.deepEqual(latest, new Set(['a', 'b', 'c'].map((name) => fx.file(`web-files/${name}.js`))));
  assert.equal(hold.commands.length, 4, 'the superseded queued middle save starts no Git commands');
  assert.ok(hold.peak <= 2, `at most two subprocesses, observed ${hold.peak}`);
  assert.deepEqual(baseline.changedFiles({ refreshRef: false }), latest);
});

test('a newer ref poll wins over a delayed async ref resolution', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  const oldCommit = baseline.commit;
  const hold = holdCommand(t, 'rev-parse');
  const pending = baseline.changedFilesAsync();
  await hold.started;
  fx.write('web-files/app.js', 'new committed baseline');
  fx.commit();
  assert.equal(await baseline.checkForUpdate(), true);
  const commit = baseline.commit;
  fx.write('web-files/after-commit.js', 'new edit');
  hold.release();
  assert.deepEqual(await pending, new Set([fx.file('web-files/after-commit.js')]));
  assert.notEqual(commit, oldCommit);
  assert.equal(baseline.commit, commit);
});

test('a ref change during async diff retries against the new immutable commit', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  baseline.changedFiles({ refreshRef: false });
  fx.write('web-files/app.js', 'committed during the scan');
  const hold = holdCommand(t, 'diff');
  const pending = baseline.changedFilesAsync({ files: [fx.file('web-files/app.js')], refreshRef: false });
  await hold.started;
  fx.commit();
  assert.equal(await baseline.checkForUpdate(), true);
  fx.write('web-files/after-poll.js', 'new edit');
  hold.release();
  assert.deepEqual(await pending, new Set([fx.file('web-files/after-poll.js')]));
  assert.equal(hold.commands.filter((args) => args.includes('diff')).length, 2);
});

test('a stale async ref failure cannot invalidate a recovered ref', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const git = (...args) => childProcess.execFileSync('git', args, { cwd: fx.dir, stdio: 'ignore', windowsHide: true });
  git('branch', 'deployed');
  const baseline = new GitBaseline(fx.dir, 'deployed');
  git('branch', '-D', 'deployed');
  const hold = holdCommand(t, 'rev-parse');
  const pending = baseline.changedFilesAsync();
  await hold.started;
  git('branch', 'deployed');
  await baseline.checkForUpdate();
  fx.write('web-files/recovered.js', 'new edit');
  hold.release();
  assert.deepEqual(await pending, new Set([fx.file('web-files/recovered.js')]));
  assert.equal(baseline.available, true);
  assert.equal(baseline.error, null);
});

test('repeated ref changes bound async scan retries and recover without exposing a stale snapshot', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  fx.write('web-files/app.js', 'initial uncommitted edit');
  assert.equal(baseline.changedFiles({ refreshRef: false }).has(fx.file('web-files/app.js')), true);
  const original = childProcess.execFile;
  let scans = 0;
  let commands = 0;
  const mock = t.mock.method(childProcess, 'execFile', function (file, args, options, callback) {
    commands++;
    return original.call(this, file, args, options, (err, stdout, stderr) => {
      if (!args.includes('diff') || scans >= 3) return callback(err, stdout, stderr);
      const scan = ++scans;
      void (async () => {
        fx.write('web-files/moving-baseline.js', `commit during scan ${scan}`);
        fx.commit();
        assert.equal(await baseline.checkForUpdate(), true);
        callback(err, stdout, stderr);
      })().catch((failure) => callback(failure));
    });
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });

  const result = await baseline.changedFilesAsync({ refreshRef: false });
  assert.equal(scans, 3);
  assert.equal(commands, 9, 'three bounded diff/list pairs and three intervening ref polls');
  assert.equal(result.size, 0);
  assert.equal(baseline.changedSnapshot, null);
  assert.equal(baseline.available, false);
  assert.match(baseline.error, /three consecutive change scans/);

  assert.equal(await baseline.checkForUpdate(), true, 'a subsequent poll restores the settled ref');
  fx.write('web-files/recovered.js', 'saved after Git activity settled');
  assert.deepEqual(await baseline.changedFilesAsync({ refreshRef: false }), new Set([fx.file('web-files/recovered.js')]));
  assert.equal(baseline.available, true);
  assert.equal(baseline.error, null);
});
