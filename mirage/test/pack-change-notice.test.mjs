// @test-kind contract: a data pack file saved after the runtime loaded its packs is reported once, with the advice to restart
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { packChangeNotice, watchPackFiles } from '../lib/pack-change-notice.mjs';

/** A stand-in for fs.watch: the test fires the events of each watched folder. */
function fakeWatch() {
  const folders = new Map();
  const watch = (folder, _options, listener) => {
    if (folder.includes('unwatchable')) throw new Error('invented watch failure');
    const watcher = Object.assign(new EventEmitter(), { closed: false, close: () => void (watcher.closed = true) });
    folders.set(folder, { listener, watcher });
    return watcher;
  };
  return { folders, watch };
}

test('each saved pack file is reported once; other files and unnamed events are not', () => {
  const { folders, watch } = fakeWatch();
  const packFolder = path.resolve('invented-project', 'pack');
  const otherFolder = path.resolve('invented-project', 'other-pack');
  const changed = [];
  const release = watchPackFiles(
    [
      path.join(packFolder, 'pack.mjs'),
      path.join(packFolder, 'second.mjs'),
      pathToFileURL(path.join(otherFolder, 'pack.mjs')).href,
      path.resolve('unwatchable', 'pack.mjs'),
      'a-bare-package-name',
      { id: 'a module object' },
    ],
    (file) => changed.push(file),
    { watch },
  );
  assert.deepEqual([...folders.keys()].sort(), [otherFolder, packFolder].sort(), 'one watch per folder');
  const { listener } = folders.get(packFolder);
  listener('change', 'plugins.mjs');
  listener('change', 'plugins.mjs');
  listener('rename', 'fixtures.json');
  listener('change', 'notes.md');
  listener('change', null);
  folders.get(otherFolder).listener('change', 'pack.mjs');
  assert.deepEqual(changed, [
    path.join(packFolder, 'plugins.mjs'),
    path.join(packFolder, 'fixtures.json'),
    path.join(otherFolder, 'pack.mjs'),
  ]);
  release();
  assert.ok([...folders.values()].every(({ watcher }) => watcher.closed));
});

test('the notice names the file and says a restart applies the change', () => {
  const file = path.resolve('invented-project', 'pack', 'plugins.mjs');
  assert.deepEqual(packChangeNotice(file), {
    code: 'PACK_FILE_CHANGED',
    severity: 'warning',
    file,
    message: `The data pack file ${file} changed after this runtime loaded its packs. Packs load at startup, so the runtime still runs the code it loaded: restart Mirage to use the change.`,
  });
});
