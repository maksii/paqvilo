import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PortalModel } from '../lense/portal-model.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { createFixture, HOME_ID, ABOUT_ID } from './fixture.mjs';

test('async model startup matches synchronous indexing and bounds concurrent metadata reads', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  for (let i = 0; i < 40; i++) {
    fx.write(`web-files/extra-${i}.js`, String(i));
    fx.write(`web-files/extra-${i}.js.webfile.yml`, `adx_name: extra-${i}.js\nadx_partialurl: extra-${i}.js\nadx_parentpageid: ${HOME_ID}\n`);
  }
  const sync = new PortalModel(fx.dir);
  const original = fs.promises.readFile;
  let active = 0;
  let peak = 0;
  t.mock.method(fs.promises, 'readFile', async function (...args) {
    active++;
    peak = Math.max(peak, active);
    try { return await original.apply(this, args); } finally { active--; }
  });
  const asyncModel = await PortalModel.create(fx.dir);
  assert.ok(peak > 1 && peak <= 16, `bounded parallel reads, observed ${peak}`);
  assert.deepEqual([...asyncModel.pages], [...sync.pages]);
  assert.deepEqual(asyncModel.webFiles, sync.webFiles);
  assert.deepEqual(asyncModel.inlineSources, sync.inlineSources);
  assert.deepEqual(asyncModel.warnings, sync.warnings);
});

test('a metadata save during async prefetch cannot seed stale cache entries', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const target = fx.file('web-pages/about/About.webpage.yml');
  const original = fs.promises.readFile;
  let edited = false;
  t.mock.method(fs.promises, 'readFile', async function (file, ...args) {
    const text = await original.call(this, file, ...args);
    if (file === target && !edited) {
      edited = true;
      fs.writeFileSync(target, text.replace('about-us', 'changed-during-prefetch'));
    }
    return text;
  });
  const model = await PortalModel.create(fx.dir);
  assert.equal(edited, true);
  assert.equal(model.pagePath(ABOUT_ID), '/changed-during-prefetch');
});

test('metadata cache releases deleted files and does not reuse an atomic replacement', (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const file = fx.file('web-pages/about/About.webpage.yml');
  const model = new PortalModel(fx.dir);
  const original = fs.readFileSync(file, 'utf8');
  const stamp = fs.statSync(file);
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, original.replace('about-us', 'about-me'));
  fs.utimesSync(replacement, stamp.atime, stamp.mtime);
  fs.renameSync(replacement, file);
  model.load();
  assert.equal(model.pagePath(ABOUT_ID), '/about-me');
  fs.unlinkSync(file);
  model.load();
  assert.equal(model.yamlCache.has(file), false);
});

test('targeted Git changes preserve other edits and handle reversions, deletion and literal path names', (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  const app = fx.file('web-files/app.js');
  const original = fs.readFileSync(app, 'utf8');
  const untouched = fx.file('web-files/untracked.js');
  fx.write('web-files/app.js', original + '// edit');
  fx.write('web-files/untracked.js', 'pending');
  assert.ok(baseline.changedFiles({ refreshRef: false }).has(untouched));
  fx.write('web-files/app.js', original);
  const reverted = baseline.changedFiles({ files: [app] });
  assert.equal(reverted.has(app), false);
  assert.equal(reverted.has(untouched), true);
  const literal = fx.file('web-files/[ab].js');
  const other = fx.file('web-files/a.js');
  fx.write('web-files/[ab].js', 'literal');
  fx.write('web-files/a.js', 'other');
  const targeted = baseline.changedFiles({ files: [literal], refreshRef: false });
  assert.equal(targeted.has(literal), true);
  assert.equal(targeted.has(other), false, 'a literal path must not expand as a Git wildcard');
  fs.unlinkSync(untouched);
  assert.equal(baseline.changedFiles({ files: [untouched] }).has(untouched), false);
  assert.equal(baseline.changedFiles({ files: [fx.file('web-files')] }).has(other), true);
  const isolated = baseline.changedFiles({ files: [path.resolve(fx.dir, '..', 'outside.js')] });
  isolated.clear();
  assert.ok(baseline.changedFiles({ files: [path.resolve(fx.dir, '..', 'outside.js')] }).has(literal), 'returned sets do not mutate the internal snapshot');
});

test('baseline changes invalidate a targeted snapshot and stale async checks cannot revert a newer scan', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  baseline.changedFiles({ refreshRef: false });
  fx.write('web-files/app.js', 'first commit');
  fx.commit();
  const pending = baseline.checkForUpdate();
  fx.write('web-files/app.js', 'second commit');
  fx.commit();
  fx.write('web-files/not-in-scoped-save.js', 'new file after commit');
  const changed = baseline.changedFiles({ files: [fx.file('web-files/app.js')] });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.dir, encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(changed.has(fx.file('web-files/not-in-scoped-save.js')), true, 'new baseline forces a complete scan');
  await pending;
  assert.equal(baseline.commit, commit);
  assert.equal(baseline.show(fx.file('web-files/app.js')), 'second commit');
});

test('a scoped extract-root event forces a full scan even with Windows path casing differences', (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  assert.equal(baseline.changedFiles({ refreshRef: false }).size, 0);
  fx.write('web-files/app.js', 'changed since the previous complete snapshot');
  const root = process.platform === 'win32' ? fx.dir.toUpperCase() : path.join(fx.dir, '.');
  assert.equal(baseline.changedFiles({ files: [root], refreshRef: false }).has(fx.file('web-files/app.js')), true);
});
