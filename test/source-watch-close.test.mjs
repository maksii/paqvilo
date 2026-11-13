// @test-kind contract: source and Git watchers close, and an accepted refresh drains, when the session shuts down.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import chokidar from 'chokidar';
import { watchSources } from '../lense/commands/dev.mjs';
import { createFixture } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

// A chokidar watcher double: it reports its roots until it is closed and delivers events only when a test emits them.
function fakeWatcher(roots) {
  const watcher = new EventEmitter();
  let open = true;
  watcher.getWatched = () => (open ? Object.fromEntries(roots.map((root) => [root, []])) : {});
  watcher.close = async () => {
    open = false;
  };
  return watcher;
}

// The repository watcher is the one created for a `.git` directory; the source watcher watches the extract.
const isGitRoot = (root) => root.split(/[\\/]/).includes('.git');

for (const repositoryFailure of [false, true]) {
  test(`source watcher drains its Git watcher and accepted refresh after close failures (${repositoryFailure ? 'multiple' : 'single'})`, async (t) => {
    const fixture = createFixture();
    ownedFixture(t).remove(() => fixture.cleanup());
    const sourceFailure = new Error('Invented source close failure');
    const gitFailure = new Error('Invented repository close failure');
    const watchers = { source: null, repository: null };
    const created = Promise.withResolvers(),
      repositoryClosed = Promise.withResolvers();
    t.mock.method(chokidar, 'watch', (roots) => {
      const role = roots.some(isGitRoot) ? 'repository' : 'source';
      const instance = fakeWatcher(roots);
      const entry = {
        instance,
        originalClose: instance.close,
        closes: 0,
        fail: role === 'source' || repositoryFailure,
      };
      watchers[role] = entry;
      if (watchers.source && watchers.repository) created.resolve();
      instance.close = async () => {
        await entry.originalClose();
        entry.closes++;
        if (role === 'repository') repositoryClosed.resolve();
        if (entry.fail) {
          entry.fail = false;
          throw role === 'source' ? sourceFailure : gitFailure;
        }
      };
      return instance;
    });
    let release;
    const acceptedRefresh = new Promise((resolve) => {
      release = resolve;
    });
    ownedFixture(t).add(async () => {
      release();
      for (const entry of Object.values(watchers)) await entry?.originalClose();
    });
    const session = Object.assign(new EventEmitter(), {
      cfg: {
        sourceDir: fixture.dir,
        origin: 'https://invented.invalid',
        site: {},
      },
      baseline: {
        available: true,
        spec: 'HEAD',
        commit: 'a'.repeat(40),
        checkForUpdate: async () => false,
      },
      refreshHead: async () => {},
      model: { webFiles: [] },
      rewriter: { unsupported: [] },
      refreshAsync: async () => {
        session.emit('accepted-refresh');
        await acceptedRefresh;
        return { ignored: true };
      },
      rel: (file) => path.relative(fixture.dir, file),
    });
    const watcher = watchSources(session, { pages: () => [] }, { reload: false, log: () => {}, baselinePollMs: 60000 });
    // The doubles report `ready` once the product has attached its listeners: the source watcher is created
    // synchronously by watchSources, the repository watcher after Git reports the repository directories.
    watchers.source.instance.emit('ready');
    await created.promise;
    watchers.repository.instance.emit('ready');
    await watcher.ready;
    const accepted = once(session, 'accepted-refresh');
    watchers.source.instance.emit('all', 'change', path.join(fixture.dir, 'web-files/app.js'));
    await accepted;
    let settled = false;
    const close = watcher.close().then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    // The repository watcher closes after the failed source close; only the held refresh remains.
    await repositoryClosed.promise;
    assert.equal(watchers.source.closes, 1);
    assert.equal(settled, false, 'close must await the accepted refresh even when source closing rejects');
    release();
    const failure = await close;
    if (repositoryFailure) {
      assert.ok(failure instanceof AggregateError);
      assert.deepEqual(failure.errors, [sourceFailure, gitFailure]);
    } else assert.equal(failure, sourceFailure, 'one exact original error is preserved');
    assert.equal(watchers.repository.closes, 1, 'repository watcher is closed after source-close failure');
    assert.deepEqual(Object.keys(watchers.repository.instance.getWatched()), []);
    await watcher.close();
    assert.equal(watchers.source.closes, 2, 'a failed shutdown can be retried');
    assert.equal(watchers.repository.closes, 2);
  });
}
