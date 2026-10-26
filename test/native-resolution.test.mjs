import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readLocalFileSync } from '../lense/local-file.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { SITE, tempDirSync } from './fixture.mjs';
import { settleFileTimes } from '../mirage/test/support/file-times.mjs';

// A source folder reached through a path whose spelling differs from its canonical one: the other drive-letter
// case on Windows (the JavaScript realpath keeps the given case, native resolution and fs.promises.realpath
// return the canonical one), a symbolic link to the folder elsewhere.
function aliasedFolder(t) {
  const container = tempDirSync('paqvilo-native-resolution-');
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const real = path.join(container, 'source');
  fs.mkdirSync(real);
  if (process.platform === 'win32') {
    const drive = real[0];
    const other = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase();
    return { real, alias: other + real.slice(1) };
  }
  const alias = path.join(container, 'alias');
  fs.symlinkSync(real, alias, 'dir');
  return { real, alias };
}

test('synchronous local reads accept the canonical path the asynchronous resolver reports for an aliased source', async (t) => {
  const { real, alias } = aliasedFolder(t);
  fs.writeFileSync(path.join(real, 'file.txt'), 'invented bytes');
  const file = path.join(alias, 'file.txt');
  const expectedRealPath = await fs.promises.realpath(file);
  assert.notEqual(expectedRealPath, file, 'the fixture reaches the file through a non-canonical spelling');
  assert.equal(readLocalFileSync(file, { root: alias, expectedRealPath, encoding: 'utf8' }), 'invented bytes');
});

test('revalidation keeps sources the startup prefetch stamped through an aliased source folder', async (t) => {
  // The reuse assertion below concerns a file written moments ago.
  settleFileTimes(t);
  const { alias } = aliasedFolder(t);
  const file = path.join(alias, 'header.html');
  fs.writeFileSync(file, '<p>Local header</p>');
  const rewriter = await HtmlRewriter.create({
    model: {
      sourceDir: alias,
      inlineSources: [{ rel: 'header.html', file, kind: 'web-template', mode: 'markup' }],
    },
    site: SITE,
    baseline: { changedFiles: () => new Set([file]), show: () => '<p>Online header</p>' },
  });
  assert.equal(rewriter.rewrite('<p>Online header</p>', '/').html, '<p>Local header</p>');
  const read = fs.readFileSync;
  const reads = [];
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    reads.push(target);
    return read(target, ...args);
  });
  rewriter.refresh([], { revalidate: true });
  assert.deepEqual(reads, [], 'an unchanged prefetched source is not discarded and read again');
  assert.equal(rewriter.rewrite('<p>Online header</p>', '/').html, '<p>Local header</p>');
});
