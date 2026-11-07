import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runHook } from '../baseline-hooks.mjs';

test('baseline hooks retain quoted script paths, spaces, Unicode and persona argument boundaries', async (t) => {
  // The child reports its working directory as the OS resolves it (8.3 aliases and symlinked temp roots expanded).
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'baseline hook path ')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'hook script.mjs');
  await fs.writeFile(file, 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))');
  const result = await runHook(`"${process.execPath}" "${file}" "first argument" "Київ & second" "{persona}"`, {
    cwd: directory,
    persona: 'role with spaces',
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.output), {
    cwd: directory,
    args: ['first argument', 'Київ & second', 'role with spaces'],
  });
  assert.doesNotMatch(result.output, /DEP0190/);
});

test('baseline hooks preserve explicit failure and reject a blank command clearly', async () => {
  assert.deepEqual(await runHook(null), { skipped: true });
  await assert.rejects(runHook('   '), /Hook command is empty/);
  await assert.rejects(runHook(`"${process.execPath}" -e "process.exit(7)"`), /Hook failed \(7\)/);
});
