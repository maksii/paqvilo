// @test-kind tooling: a test file's cleanup ends the commands it left running and observes their exit before it removes their folder
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tempDirSync } from './fixture.mjs';
import { ownedChildren } from './helpers/owned-children.mjs';

test('a folder held by a running command and the process it started can be removed once the owner has ended them', async () => {
  const cwd = tempDirSync('paqvilo-owned-children-');
  const children = ownedChildren();
  // As the CLI entry point does: the command runs in a second process, and both keep `cwd` as working directory.
  const inner = "process.stdout.write('ready'); setInterval(() => {}, 1000);";
  // It forwards a termination signal to that process, as the entry point does.
  const outer = `const inner = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'inherit' }); process.on('SIGTERM', () => { inner.kill('SIGTERM'); process.exit(143); }); setInterval(() => {}, 1000);`;
  const child = children.own(
    spawn(process.execPath, ['-e', outer], { cwd, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true }),
  );
  await once(child.stdout, 'data');
  const finished = children.own(spawn(process.execPath, ['-e', ''], { cwd, stdio: 'ignore', windowsHide: true }));
  await once(finished, 'close');
  await children.end();
  assert.notEqual(child.exitCode ?? child.signalCode, null, 'the running command was ended');
  // One attempt: nothing may still hold the folder.
  fs.rmSync(cwd, { recursive: true });
  assert.equal(fs.existsSync(cwd), false);
  await children.end();
});

// @test-kind tooling: a test file's cleanup never signals a child whose exit it has observed
test('a child whose exit was observed is not signalled while its stream is held open', async () => {
  const sent = [];
  const children = ownedChildren({
    endTree: async (pid) => {
      sent.push(['tree', pid]);
    },
  });
  // The child starts a grandchild that inherits its stdout, prints the grandchild's PID and exits. The grandchild is
  // detached so that it outlives the child, which holds the stream open until the grandchild ends: the child's close
  // is still pending when its exit has been observed.
  const script = `const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: true }); console.log(String(g.pid)); g.unref();`;
  const child = children.own(
    spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true }),
  );
  const kill = child.kill.bind(child);
  child.kill = (...args) => {
    sent.push(['kill', child.pid]);
    return kill(...args);
  };
  const exited = once(child, 'exit');
  const [output] = await once(child.stdout, 'data');
  const grandchild = Number(String(output).trim());
  try {
    await exited;
    assert.notEqual(child.exitCode, null, 'the exit was observed');
    const ending = children.end();
    process.kill(grandchild);
    await ending;
    assert.deepEqual(sent, [], 'an exited child is not signalled');
  } finally {
    try {
      process.kill(grandchild);
    } catch {
      // Already ended by the test.
    }
  }
});
