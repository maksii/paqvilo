// @test-kind contract: baseline hook commands keep their quoting, report failure and return all of their output
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { runHook } from '../baseline-hooks.mjs';
import { ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';

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

test('a hook result holds all of its output, including output written after the hook process exited', async (t) => {
  // The grandchild the hook starts connects to this owner and ends itself after its output. If the test ends first, the
  // owner tells it to exit and waits for its connection to close, so it no longer runs in the directory removed below.
  const connections = new Set();
  const owner = net.createServer((socket) => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
  });
  ownedFixture(t).add(async () => {
    const ended = [...connections].map((socket) => {
      const closed = new Promise((resolve) => socket.once('close', resolve));
      socket.write('exit');
      return closed;
    });
    await Promise.all(ended);
    await new Promise((resolve) => owner.close(resolve));
  });
  await new Promise((resolve) => owner.listen(0, '127.0.0.1', resolve));
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-hook-output-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(directory));
  const grandchild =
    `const socket = require('node:net').connect(${owner.address().port}, '127.0.0.1');` +
    `socket.on('data', () => process.exit());socket.on('error', () => process.exit());` +
    `setTimeout(() => { console.log('last'); socket.end(); }, 500);`;
  // The hook exits at once; a process it started writes to the inherited output afterwards.
  const file = path.join(directory, 'hook.mjs');
  await fs.writeFile(
    file,
    `import { spawn } from 'node:child_process';
console.log('first');
spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: true, // a child that is not detached ends with the hook on Windows
  windowsHide: true,
}).unref();
`,
  );
  const result = await runHook(`"${process.execPath}" "${file}"`, { cwd: directory });
  assert.deepEqual(result.output.split(/\r?\n/).filter(Boolean), ['first', 'last']);
});
