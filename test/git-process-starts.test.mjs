// @test-kind contract: how many Git processes a save starts in a dev session, and that the baseline stays the one Git names after every repository change.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { OverlaySession } from '../lense/session.mjs';
import { GitBaseline, gitDirectories, gitMarkerExists } from '../lense/git.mjs';
import { watchSources } from '../lense/commands/dev.mjs';
import { createFixture, SITE, tempDirSync } from './fixture.mjs';
import { SCENARIO_HANG_GUARD_MS } from './helpers/bounded-command.mjs';

const APP = 'web-files/app.js';
const CSS = 'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css';
const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner
// The test's own Git commands. No hooks and no detached maintenance: a detached child would outlive the test.
const GIT_SETTINGS = ['core.autocrlf=false', 'core.hooksPath=', 'commit.gpgsign=false', 'maintenance.auto=false']
  .concat([
    'gc.auto=0',
    'core.longpaths=true',
    'user.name=test',
    'user.email=test@localhost',
    'advice.detachedHead=false',
  ])
  .flatMap((setting) => ['-c', setting]);
const nativeRunGit = childProcess.execFileSync;
let activeGitTimings = null;
function runGit(...args) {
  const end = activeGitTimings?.start('oracle');
  try {
    return nativeRunGit(...args);
  } finally {
    end?.();
  }
}
function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return runGit('git', [...GIT_SETTINGS, ...args], {
    cwd,
    env,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: CLI_HANG_GUARD_MS,
  }).trim();
}
/** The commit Git resolves `rev` to right now, or null when Git answers that it names none. */
function resolved(cwd, ...args) {
  try {
    return git(cwd, ...args);
  } catch (error) {
    if (Number.isInteger(error.status)) return null;
    throw error;
  }
}
const commitOf = (cwd, ref) => resolved(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);

function fixture(t) {
  const fx = createFixture();
  ownedFixture(t).remove(() => fx.cleanup());
  return fx;
}

/** Records the Git subcommand of every Git process the product starts, synchronous or not. */
function gitStarts(t, timings) {
  const started = [];
  let marked = 0;
  const subcommand = (args) => args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c');
  const mocks = ['execFile', 'execFileSync'].map((name) => {
    const original = childProcess[name];
    return t.mock.method(childProcess, name, function (file, args, ...rest) {
      if (file === 'git') started.push(subcommand(args));
      if (file !== 'git' || !timings) return original.call(this, file, args, ...rest);
      const end = timings.start(name === 'execFile' ? 'async' : 'sync');
      if (name === 'execFileSync') {
        try {
          return original.call(this, file, args, ...rest);
        } finally {
          end();
        }
      }
      try {
        const child = original.call(this, file, args, ...rest);
        child.once('close', end);
        child.once('error', end);
        return child;
      } catch (error) {
        end();
        throw error;
      }
    });
  });
  syncBuiltinESMExports();
  t.after(() => {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    /** The Git processes `work` starts. */
    async during(work) {
      const from = started.length;
      await work();
      return started.slice(from);
    },
    /** Marks the moment `since()` counts from. */
    mark() {
      marked = started.length;
    },
    /** The Git processes started since the last mark. */
    since: () => started.slice(marked),
  };
}

/** Fixed labels and elapsed times only: no Git arguments, paths, environment, output or errors. */
function gitPhaseTimings(t) {
  const allowed = new Set([
    'fixture',
    'initial baselines',
    'commit on the working branch',
    'branch moved to HEAD',
    'packed branch moved back',
    'tag shadows the branch',
    'branch deleted',
    'branch recreated',
    'complete',
  ]);
  const began = performance.now();
  const calls = [];
  const phases = [];
  let phase = 'fixture';
  let reported = false;
  const rounded = (value) => Math.round(value * 1000) / 1000;
  const timing = {
    phase(label) {
      phase = allowed.has(label) ? label : 'other';
      phases.push({ phase, elapsedMs: rounded(performance.now() - began) });
    },
    start(mode) {
      mode = ['oracle', 'sync', 'async'].includes(mode) ? mode : 'other';
      const call = { phase, mode, startedMs: performance.now(), endedMs: null };
      calls.push(call);
      return () => {
        call.endedMs ??= performance.now();
      };
    },
    report() {
      if (reported) return;
      reported = true;
      const now = performance.now();
      t.diagnostic(
        JSON.stringify({
          kind: 'git-baseline-phase-timings',
          elapsedMs: rounded(now - began),
          phase,
          callsStarted: calls.length,
          callsCompleted: calls.filter((call) => call.endedMs !== null).length,
          phases,
          calls: calls.map((call) => ({
            phase: call.phase,
            mode: call.mode,
            completed: call.endedMs !== null,
            elapsedMs: rounded((call.endedMs ?? now) - call.startedMs),
          })),
        }),
      );
    },
  };
  // A timeout may abandon the body before its finally runs. Publish before fixture cleanup in that case too.
  t.after(() => {
    if (activeGitTimings === timing) activeGitTimings = null;
    timing.report();
  });
  return timing;
}

/** A promise with its resolve function. */
function gate() {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

// The source watcher reconciles when its file watch is ready and follows the repository once Git has named it; the
// two are independent, so either can come first. Each order is held by a gate here: whichever comes first, the
// baseline commit is resolved once after the repository is followed and its tree is listed once, by the first save.
for (const reconcileFirst of [true, false])
  test(`a save in a watched dev session starts one Git process once the repository is known (${
    reconcileFirst ? 'reconciled before' : 'reconciled after'
  } the repository is followed)`, async (t) => {
    const fx = fixture(t);
    const cfg = { sourceDir: fx.dir, site: structuredClone(SITE), origin: 'https://portal.example' };
    const s = await OverlaySession.create(cfg);
    const original = fx.read(CSS);
    const repository = await gitDirectories(fx.dir); // before the recorder: this lookup is the test's own
    const starts = gitStarts(t);
    const located = gate();
    const reconciled = gate();
    const follow = s.followRepository.bind(s);
    t.mock.method(s, 'followRepository', (directories) => {
      const followNow = () => {
        starts.mark();
        follow(directories);
        located.open(directories);
      };
      if (reconcileFirst) reconciled.opened.then(followNow);
      else followNow();
    });
    const reconcile = s.reconcile.bind(s);
    t.mock.method(s, 'reconcile', () => {
      const reconcileNow = () => reconciled.open(reconcile());
      if (reconcileFirst) reconcileNow();
      else located.opened.then(reconcileNow);
    });
    // No repository watcher and no poll: every Git process counted below belongs to the reconcile or the save.
    const watcher = watchSources(
      s,
      { pages: () => [] },
      { gitWatch: false, baselinePollMs: 2 ** 31 - 1, log: () => {} },
    );
    ownedFixture(t).add(() => watcher.close());
    await watcher.ready;
    assert.deepEqual(await located.opened, repository);
    await reconciled.opened;
    const save = (rel, text) => async () => {
      const refreshed = once(s, 'refreshed');
      fx.write(rel, text);
      await refreshed;
    };
    const recolour = (shade) => original.replace('color: red', `color: rgb(${shade}, 2, 3)`);
    // The first save reads the facts that later saves reuse: the paths of the baseline tree, and the baseline commit
    // unless the reconcile already resolved it after the repository was followed.
    const first = await starts.during(save(CSS, recolour(1)));
    assert.deepEqual(
      first.filter((name) => name !== 'cat-file').sort(),
      reconcileFirst ? ['diff', 'ls-tree', 'rev-parse'] : ['diff', 'ls-tree'],
    );
    const facts = starts.since().filter((name) => name === 'rev-parse' || name === 'ls-tree');
    assert.deepEqual(facts.sort(), ['ls-tree', 'rev-parse'], 'each fact is read once after the repository is followed');
    for (let shade = 2; shade <= 4; shade++)
      assert.deepEqual(
        await starts.during(save(CSS, recolour(shade))),
        ['diff'],
        `save ${shade} of a file of the baseline commit compares it with one Git process`,
      );
    assert.ok(s.changedFiles.has(fx.file(CSS)));
    // A file the baseline commit does not have can be untracked or ignored: that takes the untracked listing too.
    const added = await starts.during(save('web-files/added.js', 'window.added = true;'));
    assert.deepEqual(added.filter((name) => name !== 'cat-file').sort(), ['diff', 'ls-files']);
    assert.ok(s.changedFiles.has(fx.file('web-files/added.js')));
    // A commit moves HEAD: the next save asks Git for the commit again.
    fx.commit();
    const afterCommit = await starts.during(save(CSS, recolour(9)));
    assert.ok(afterCommit.includes('rev-parse'), `the moved ref is resolved again: ${afterCommit}`);
    assert.equal(s.baseline.commit, commitOf(fx.dir, 'HEAD'));
    assert.deepEqual([...s.changedFiles], [fx.file(CSS)]);
  });

test('HEAD awareness asks Git only when the repository shows a change', async (t) => {
  const fx = fixture(t);
  const s = new OverlaySession({ sourceDir: fx.dir, site: structuredClone(SITE), origin: 'https://portal.example' });
  s.followRepository(await gitDirectories(fx.dir));
  const starts = gitStarts(t);
  const branch = git(fx.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  assert.deepEqual(await starts.during(() => s.refreshHead()), ['rev-parse'], 'the first read has no known state');
  assert.deepEqual(await starts.during(() => s.refreshHead()), []);
  const heads = [];
  s.on('head', (head) => heads.push(head));
  const moved = async (change, expected) => {
    change();
    assert.deepEqual(await starts.during(() => s.refreshHead()), ['rev-parse']);
    assert.deepEqual(await starts.during(() => s.refreshHead()), []);
    assert.equal(s.head.commit, commitOf(fx.dir, 'HEAD'));
    assert.equal(s.head.branch, expected);
  };
  await moved(() => {
    fx.write(APP, 'window.committed = 1;');
    fx.commit();
  }, branch);
  await moved(() => git(fx.dir, 'switch', '-q', '-c', 'topic'), 'topic');
  await moved(() => git(fx.dir, 'checkout', '-q', '--detach', 'HEAD'), null);
  await moved(() => git(fx.dir, 'switch', '-q', branch), branch);
  // Packing moves the branch out of its loose file without moving the branch.
  await moved(() => git(fx.dir, 'pack-refs', '--all'), branch);
  // A tag of the same short name makes the branch name ambiguous, which Git shows in the name it reports.
  await moved(() => git(fx.dir, 'tag', branch), `heads/${branch}`);
  assert.equal(heads.length, 5, 'packing refs moves neither the commit nor the branch');
});

/**
 * A baseline that follows its repository. After each change of the repository `moved` runs the scan of a save and
 * compares the baseline with the commit Git names at that moment.
 */
async function followedBaseline(dir, spec, file, oracle = () => commitOf(dir, spec)) {
  const baseline = new GitBaseline(dir, spec);
  baseline.followRepository(await gitDirectories(dir));
  await baseline.changedFilesAsync();
  const moved = async (step) => {
    await baseline.changedFilesAsync({ files: [file] });
    const commit = oracle();
    assert.equal(baseline.available, commit !== null, `${step}: availability`);
    assert.equal(baseline.commit, commit, `${step}: baseline commit`);
  };
  return { baseline, moved };
}

// Hang guard only: one scenario of dozens of Git processes, one after another, over one repository.
test(
  'a followed HEAD baseline is the commit Git names after every way HEAD can move',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const fx = fixture(t);
    const app = fx.file(APP);
    const branch = git(fx.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    const { baseline, moved } = await followedBaseline(fx.dir, 'HEAD', app);
    const starts = gitStarts(t);
    const commit = (text) => {
      fx.write(APP, text);
      fx.commit();
    };
    await moved('start');
    assert.deepEqual(await starts.during(() => baseline.changedFilesAsync({ files: [app] })), ['diff']);
    commit('window.edited = 1;');
    await moved('commit');
    git(fx.dir, 'switch', '-q', '-c', 'topic');
    commit('window.edited = 2;');
    await moved('commit on a new branch');
    git(fx.dir, 'switch', '-q', branch);
    await moved('checkout of the first branch');
    git(fx.dir, 'checkout', '-q', '--detach', 'topic');
    await moved('detached HEAD');
    git(fx.dir, 'switch', '-q', branch);
    git(fx.dir, 'pack-refs', '--all');
    await moved('packed refs');
    git(fx.dir, 'merge', '-q', '--ff-only', 'topic');
    await moved('fast-forward of a packed branch');
    git(fx.dir, 'reset', '-q', '--hard', 'HEAD~1');
    await moved('hard reset');
    git(fx.dir, 'update-ref', '-d', `refs/heads/${branch}`);
    await moved('branch deleted (unborn HEAD)');
    assert.equal(baseline.available, false);
    git(fx.dir, 'update-ref', `refs/heads/${branch}`, 'topic');
    await moved('branch recreated');
    assert.equal(baseline.available, true);
    // The first save after the baseline moved lists the paths of the new commit once; the next is one process again.
    const scoped = () => baseline.changedFilesAsync({ files: [app] });
    assert.deepEqual((await starts.during(scoped)).sort(), ['diff', 'ls-tree']);
    assert.deepEqual(await starts.during(scoped), ['diff']);
  },
);

// Hang guard only: it drives a runtime, the CLI or child processes through this file's fixtures; on a loaded slow host that is slow, not hung.
test(
  'scoped scans of a followed baseline list what a full Git scan lists for index and work tree changes',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const fx = fixture(t);
    const app = fx.file(APP);
    const original = fx.read(APP);
    const baseline = new GitBaseline(fx.dir, 'HEAD');
    baseline.followRepository(await gitDirectories(fx.dir));
    await baseline.changedFilesAsync();
    // The oracle is pinned to the same commit and scans everything with both Git listings each time.
    const oracle = new GitBaseline(fx.dir, baseline.commit);
    const starts = gitStarts(t);
    const same = async (step, files, commands) => {
      let seen;
      const started = await starts.during(async () => {
        seen = await baseline.changedFilesAsync({ files });
      });
      assert.deepEqual([...seen].sort(), [...oracle.changedFiles({ refreshRef: false })].sort(), step);
      if (commands) assert.deepEqual(started.sort(), commands, `${step}: Git processes`);
      return seen;
    };
    fx.write(APP, 'window.edited = 1;');
    assert.ok((await same('edit', [app], ['diff', 'ls-tree'])).has(app));
    git(fx.dir, 'stash', '-q');
    assert.equal((await same('stash', [app], ['diff'])).has(app), false);
    git(fx.dir, 'stash', 'pop', '-q');
    git(fx.dir, 'add', APP);
    assert.ok((await same('staged edit', [app], ['diff'])).has(app));
    git(fx.dir, 'rm', '-q', '--cached', APP);
    assert.ok((await same('a file of the commit that left the index', [app], ['diff'])).has(app));
    fx.write(APP, original);
    git(fx.dir, 'add', APP);
    assert.equal((await same('staged back to the committed text', [app], ['diff'])).has(app), false);
    const staged = fx.file('web-files/staged-new.js');
    fx.write('web-files/staged-new.js', 'new');
    git(fx.dir, 'add', 'web-files/staged-new.js');
    assert.ok((await same('new file in the index', [staged], ['diff', 'ls-files'])).has(staged));
    const ignored = fx.file('web-files/ignored.js');
    fs.writeFileSync(path.join(fx.dir, '.gitignore'), 'web-files/ignored.js\n');
    fx.write('web-files/ignored.js', 'ignored');
    assert.equal((await same('ignored new file', [ignored, path.join(fx.dir, '.gitignore')])).has(ignored), false);
    // A file of the commit replaced by a folder: what is saved below it is untracked.
    fs.rmSync(app);
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'inner.js'), 'inner');
    assert.ok((await same('file replaced by a folder', [app], ['diff', 'ls-files'])).has(path.join(app, 'inner.js')));
    fs.rmSync(app, { recursive: true });
    fx.write(APP, original);
    assert.equal((await same('folder replaced by the file', [app], ['diff'])).has(app), false);
  },
);

/** Drain independent reads before any rejection can let fixture cleanup or the next mutation start. */
async function readBaselinesTogether(pending) {
  const results = await Promise.allSettled(pending);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}

// Hang guard only: it drives a runtime, the CLI or child processes through this file's fixtures; on a loaded slow host that is slow, not hung.
test(
  'followed branch, tag and merge-base baselines move with their refs and with HEAD',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const timings = gitPhaseTimings(t);
    activeGitTimings = timings;
    const starts = gitStarts(t, timings);
    try {
      const fx = fixture(t);
      const app = fx.file(APP);
      git(fx.dir, 'branch', 'deployed');
      timings.phase('initial baselines');
      const [named, forked] = await readBaselinesTogether([
        followedBaseline(fx.dir, 'deployed', app),
        followedBaseline(fx.dir, 'merge-base:deployed', app, () => resolved(fx.dir, 'merge-base', 'HEAD', 'deployed')),
      ]);
      const both = async (step) => {
        timings.phase(step);
        await readBaselinesTogether([named.moved(step), forked.moved(step)]);
      };
      const commit = (text) => {
        fx.write(APP, text);
        fx.commit();
      };
      timings.phase('commit on the working branch');
      commit('window.local = 1;');
      await both('commit on the working branch');
      assert.deepEqual(await starts.during(() => named.baseline.changedFilesAsync({ files: [app] })), ['diff']);
      assert.deepEqual(await starts.during(() => forked.baseline.changedFilesAsync({ files: [app] })), ['diff']);
      timings.phase('branch moved to HEAD');
      git(fx.dir, 'branch', '-f', 'deployed', 'HEAD');
      await both('branch moved to HEAD');
      timings.phase('packed branch moved back');
      git(fx.dir, 'pack-refs', '--all');
      commit('window.local = 2;');
      git(fx.dir, 'branch', '-f', 'deployed', 'HEAD~1');
      await both('packed branch moved back');
      // A tag of the same name wins over the branch: Git resolves refs/tags before refs/heads.
      timings.phase('tag shadows the branch');
      git(fx.dir, 'tag', 'deployed', 'HEAD');
      await both('tag shadows the branch');
      assert.equal(named.baseline.commit, commitOf(fx.dir, 'HEAD'));
      timings.phase('branch deleted');
      git(fx.dir, 'tag', '-d', 'deployed');
      git(fx.dir, 'branch', '-D', 'deployed');
      await both('branch deleted');
      assert.equal(named.baseline.available, false);
      timings.phase('branch recreated');
      git(fx.dir, 'branch', 'deployed', 'HEAD');
      await both('branch recreated');
      assert.equal(named.baseline.available, true);
      timings.phase('complete');
    } finally {
      if (activeGitTimings === timings) activeGitTimings = null;
      timings.report();
    }
  },
);

test('a relative revision is resolved by Git on every scan and a full commit id never again', async (t) => {
  const fx = fixture(t);
  const app = fx.file(APP);
  fx.write(APP, 'window.local = 1;');
  fx.commit();
  const relative = await followedBaseline(fx.dir, 'HEAD~1', app);
  const pinned = await followedBaseline(fx.dir, commitOf(fx.dir, 'HEAD'), app);
  const unfollowed = new GitBaseline(fx.dir, pinned.baseline.commit);
  const starts = gitStarts(t);
  fx.write(APP, 'window.local = 2;');
  fx.commit();
  await relative.moved('relative revision after a commit');
  await pinned.moved('pinned after a commit');
  // Revision syntax is Git's to resolve; a full commit id names its commit for good.
  assert.ok((await starts.during(() => relative.baseline.changedFilesAsync({ files: [app] }))).includes('rev-parse'));
  assert.deepEqual(await starts.during(() => pinned.baseline.changedFilesAsync({ files: [app] })), ['diff']);
  assert.deepEqual(
    await starts.during(() => unfollowed.changedFilesAsync()),
    ['diff', 'ls-files'],
    'a pinned baseline is not resolved again, with or without a known repository',
  );
});

test('a followed baseline in a linked worktree moves with that worktree only', async (t) => {
  const fx = fixture(t);
  const linked = path.join(path.dirname(fx.dir), 'linked');
  git(fx.dir, 'worktree', 'add', '-q', '-b', 'linked', linked);
  const app = path.join(linked, APP);
  const { baseline, moved } = await followedBaseline(linked, 'HEAD', app);
  const starts = gitStarts(t);
  fs.writeFileSync(app, 'window.linked = 1;');
  git(linked, 'commit', '-q', '-am', 'linked');
  await moved('commit in the worktree');
  fx.write(APP, 'window.main = 1;');
  fx.commit();
  await moved('commit in the main checkout');
  assert.deepEqual(await starts.during(() => baseline.changedFilesAsync({ files: [app] })), ['diff']);
  git(linked, 'checkout', '-q', '--detach', 'HEAD~1');
  await moved('detached worktree');
});

test('a folder outside Git is not asked about again until a .git entry appears', async (t) => {
  const dir = tempDirSync('pp-no-git-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.mkdirSync(path.join(dir, 'web-files'));
  const app = path.join(dir, APP);
  fs.writeFileSync(app, 'window.unpacked = true;');
  const baseline = new GitBaseline(dir, 'HEAD');
  const directories = await gitDirectories(dir);
  baseline.followRepository(directories);
  const starts = gitStarts(t);
  // A temporary folder below somebody's repository is in that repository: only a folder in none shows this.
  if (!gitMarkerExists(dir)) {
    assert.equal(directories, null);
    assert.deepEqual(await starts.during(() => baseline.changedFilesAsync({ files: [app] })), []);
    assert.deepEqual(await starts.during(() => baseline.changedFiles({ files: [app] })), []);
    assert.deepEqual(await starts.during(() => baseline.checkForUpdate()), [], 'the watcher poll asks nothing either');
    assert.equal(baseline.available, false);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  fs.writeFileSync(app, 'window.unpacked = "edited";');
  assert.deepEqual([...(await baseline.changedFilesAsync({ files: [app] }))], [app]);
  assert.equal(baseline.available, true);
  assert.equal(baseline.commit, commitOf(dir, 'HEAD'));
});

// @test-kind contract: a symbolic HEAD with trailing whitespace is followed as a symbolic ref, without asking Git again
test('a symbolic HEAD with trailing whitespace is followed to its branch like one written by Git', async (t) => {
  const fx = fixture(t);
  const app = fx.file(APP);
  const branch = git(fx.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const { baseline, moved } = await followedBaseline(fx.dir, 'HEAD', app);
  const starts = gitStarts(t);
  fs.writeFileSync(
    path.resolve(fx.dir, git(fx.dir, 'rev-parse', '--git-path', 'HEAD').trim()),
    `ref: refs/heads/${branch}   \n`,
  );
  await moved('HEAD rewritten with trailing whitespace');
  assert.deepEqual(await starts.during(() => baseline.changedFilesAsync({ files: [app] })), ['diff']);
  fx.write(APP, 'window.edited = 3;');
  fx.commit();
  await moved('commit on the followed branch');
});
