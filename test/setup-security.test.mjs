import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldMarkers } from '../lense/project-check.mjs';
import { SetupStore } from '../lense/setup/store.mjs';

function work(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-setup-security-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('scaffold marker inspection rejects a file replaced after its descriptor is opened', (t) => {
  const directory = work(t),
    file = path.join(directory, 'README.md'),
    replacement = path.join(directory, 'replacement');
  fs.writeFileSync(file, 'TODO(paqvilo-init): original');
  fs.writeFileSync(replacement, 'TODO(paqvilo-init): replacement');
  const inode = fs.statSync(file, { bigint: true }).ino;
  const original = fs.fstatSync;
  let swapped = false;
  t.mock.method(fs, 'fstatSync', (descriptor, options) => {
    const stat = original(descriptor, options);
    if (!swapped && stat.ino === inode) {
      swapped = true;
      fs.renameSync(file, file + '.old');
      fs.renameSync(replacement, file);
    }
    return stat;
  });
  // Filesystem metadata visibility decides which check observes the swap first.
  // Both checks must refuse the result; neither original nor replacement markers may escape.
  assert.throws(() => scaffoldMarkers(directory), /^Error: Local file changed (?:before|during) reading$/);
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'TODO(paqvilo-init): replacement');
  assert.equal(fs.readFileSync(file + '.old', 'utf8'), 'TODO(paqvilo-init): original');
});

test('setup configuration inspection rejects a path swap and preserves its existing read limit', async (t) => {
  const directory = work(t),
    file = path.join(directory, 'paqvilo.config.yml'),
    replacement = path.join(directory, 'replacement');
  fs.writeFileSync(file, 'sites: {}\n');
  fs.writeFileSync(replacement, 'sites: { replaced: {} }\n');
  const target = await fs.promises.realpath(file);
  const original = fs.promises.open;
  let swapped = false;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await original(...args);
    if (args[0] === target && !swapped) {
      const stat = handle.stat.bind(handle);
      handle.stat = async (...statArgs) => {
        const info = await stat(...statArgs);
        if (!swapped) {
          swapped = true;
          await fs.promises.rename(file, file + '.old');
          await fs.promises.rename(replacement, file);
        }
        return info;
      };
    }
    return handle;
  });
  await assert.rejects(
    new SetupStore({ directory, processEnv: {} }).snapshot(),
    /^Error: Local file changed (?:before|during) reading$/,
  );
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'sites: { replaced: {} }\n');
  assert.equal(fs.readFileSync(file + '.old', 'utf8'), 'sites: {}\n');
});

test('oversized scaffold documents stay ignored and oversized setup documents return 413', async (t) => {
  const directory = work(t);
  fs.writeFileSync(path.join(directory, 'large.md'), 'TODO(paqvilo-init): ' + 'x'.repeat(1024 * 1024));
  assert.deepEqual(scaffoldMarkers(directory), []);
  fs.writeFileSync(path.join(directory, 'paqvilo.config.yml'), 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(
    new SetupStore({ directory, processEnv: {} }).snapshot(),
    (error) => error.status === 413 && /256 KiB/.test(error.message),
  );
});
