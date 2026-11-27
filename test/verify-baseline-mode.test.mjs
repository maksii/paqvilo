// @test-kind contract: the verification repository reports a staged mode change as changed against its baseline on every platform, so the changed-only overlay serves the file locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GitBaseline } from '../lense/git.mjs';
import { commitVerificationBaseline, stageVerificationMode } from '../lense/commands/verify.mjs';
import { tempDirSync } from './fixture.mjs';

test('a mode change staged in the verification copy is a change against its baseline, whatever the file system keeps', async (t) => {
  const dir = tempDirSync('paqvilo-verify-mode-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const font = path.join(dir, 'web-files', 'invented.woff2');
  const bundle = path.join(dir, 'Controls', 'inv_Invented.Widget', 'bundle.js');
  fs.mkdirSync(path.dirname(font), { recursive: true });
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  const bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3]);
  fs.writeFileSync(font, bytes);
  fs.writeFileSync(bundle, 'window.inventedWidget = "local";\n');
  // An export copied from a file system with executable bits may already mark a file executable (a no-op on Windows).
  fs.chmodSync(bundle, 0o755);
  commitVerificationBaseline(dir);

  const baseline = await GitBaseline.create(dir, 'HEAD');
  assert.equal(baseline.available, true);
  assert.deepEqual([...baseline.changedFiles()], []);

  stageVerificationMode(dir, font);
  stageVerificationMode(dir, bundle);
  // The worktree-to-commit comparison the overlay's change tracking runs, full and scoped to the saved paths.
  assert.deepEqual([...baseline.changedFiles()].sort(), [bundle, font].sort());
  assert.deepEqual([...(await baseline.changedFilesAsync({ files: [font, bundle] }))].sort(), [bundle, font].sort());
  assert.deepEqual(fs.readFileSync(font), bytes);
});
