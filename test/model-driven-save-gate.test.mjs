// @test-kind contract: a model-driven save reloads the app only when the saved bytes differ from the last applied reload
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gatedReload, savedContentGate } from '../lense/commands/model-driven.mjs';
import { tempDirSync } from './fixture.mjs';

test('a save with the bytes the last reload applied is not reloaded again', async (t) => {
  const dir = tempDirSync('paqvilo-save-gate-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'form.json');
  const gate = savedContentGate();
  fs.writeFileSync(file, 'A');

  const first = await gate.take([file]);
  assert.equal(first.unchanged, false, 'the first save has no applied reload to match');
  first.commit();

  assert.equal((await gate.take([file])).unchanged, true, 'the same bytes were already applied');
});

test('a save that changes, removes or replaces a file is reloaded', async (t) => {
  const dir = tempDirSync('paqvilo-save-gate-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'form.json');
  const gate = savedContentGate();
  fs.writeFileSync(file, 'A');
  (await gate.take([file])).commit();

  fs.writeFileSync(file, 'B');
  const changed = await gate.take([file]);
  assert.equal(changed.unchanged, false, 'changed bytes are reloaded');
  assert.equal((await gate.take([file])).unchanged, false, 'an uncommitted read stays unapplied');
  changed.commit();

  fs.unlinkSync(file);
  const removed = await gate.take([file]);
  assert.equal(removed.unchanged, false, 'a removed file is reloaded');
  removed.commit();

  fs.mkdirSync(file);
  const replaced = await gate.take([file]);
  assert.equal(replaced.unchanged, false, 'a file replaced by a directory is reloaded');
});

test('bytes that change after they were read are reloaded at the next save', async (t) => {
  const dir = tempDirSync('paqvilo-save-gate-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'form.json');
  const gate = savedContentGate();
  fs.writeFileSync(file, 'A');

  const read = await gate.take([file]);
  fs.writeFileSync(file, 'B');
  read.commit();

  assert.equal((await gate.take([file])).unchanged, false, 'the applied A is not the current B');
});

test('a file saved again during the reload is reloaded at the next save even when it returns to the read bytes', async (t) => {
  const dir = tempDirSync('paqvilo-save-gate-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'form.json');
  const gate = savedContentGate();
  fs.writeFileSync(file, 'A');

  const read = await gate.take([file]);
  gate.touch(file);
  gate.touch(file);
  fs.writeFileSync(file, 'A');
  read.commit();

  assert.equal((await gate.take([file])).unchanged, false, 'a save during the import is not committed');
});

test('a reload that did not reload the app tab is not recorded as applied', async (t) => {
  const dir = tempDirSync('paqvilo-save-gate-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'form.json');
  const gate = savedContentGate();
  fs.writeFileSync(file, 'A');
  const saved = new Set();
  let reloads = 0;
  const task = gatedReload({
    saved,
    gate,
    reload: async () => {
      reloads += 1;
      return false;
    },
  });

  saved.add(file);
  await task();
  saved.add(file);
  await task();

  assert.equal(reloads, 2, 'the same bytes are reloaded again while the tab was not reloaded');
});

test('a failed reload keeps its files for the next save', async (t) => {
  const dir = tempDirSync('paqvilo-save-gate-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const applied = path.join(dir, 'applied.json');
  const changed = path.join(dir, 'changed.json');
  const gate = savedContentGate();
  fs.writeFileSync(applied, 'A');
  (await gate.take([applied])).commit();
  fs.writeFileSync(changed, 'B');

  const saved = new Set([changed]);
  let reloads = 0;
  const task = gatedReload({
    saved,
    gate,
    reload: async () => {
      reloads += 1;
      if (reloads === 1) throw new Error('transient reload failure');
      return true;
    },
  });

  await assert.rejects(task(), /transient reload failure/);
  assert.ok(saved.has(changed), 'the failed reload left its file to be saved again');
  await task();
  assert.equal(reloads, 2, 'the next save reloads the file whose reload failed');
});
