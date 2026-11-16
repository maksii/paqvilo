// @test-kind contract: a running process has an immutable own start identity; foreign PIDs, failed reads and cancellation retain their safety checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

async function identityFixture(t, execute, name) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const mock = t.mock.method(childProcess, 'spawnSync', execute);
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
  });
  return import(`../lense/process-identity.mjs?identity-fixture=${name}`);
}

test('own identity is reused across synchronous and asynchronous reads while foreign PID reuse stays visible', async (t) => {
  let reads = 0;
  const identity = await identityFixture(t, () => ({ status: 0, signal: null, stdout: `${++reads}\n` }), 'positive');
  const own = identity.processIdentity(process.pid);
  assert.equal(own, '1');
  assert.equal(identity.processIdentity(process.pid), own);
  assert.equal(await identity.processIdentityAsync(process.pid), own);
  assert.equal(reads, 1, 'a live process cannot acquire a different start identity');
  const foreign = process.pid + 1;
  assert.equal(identity.processIdentity(foreign), '2');
  assert.equal(identity.processIdentity(foreign), '3', 'another PID may have been reused and must be reread');
  assert.equal(await identity.processIdentityAsync(process.pid, { signal: AbortSignal.abort() }), null);
  assert.equal(reads, 3);
});

test('a failed own-identity read is never cached as proof of absence', async (t) => {
  let reads = 0;
  const identity = await identityFixture(
    t,
    () => {
      reads++;
      return reads === 1 ? { status: 1, signal: null, stdout: '' } : { status: 0, signal: null, stdout: '12345\n' };
    },
    'failure',
  );
  assert.equal(identity.processIdentity(process.pid), null);
  assert.equal(identity.processIdentity(process.pid), '12345');
  assert.equal(identity.processIdentity(process.pid), '12345');
  assert.equal(reads, 2);
});
