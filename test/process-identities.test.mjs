import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { processIdentities, processIdentity, isAlive } from '../lense/commands/mirage.mjs';

// The process a non-administrator cannot open on this OS: System on Windows, init on POSIX.
const SYSTEM_PID = process.platform === 'win32' ? 4 : 1;

test('batched process identities match single reads for owned live and system processes', async (t) => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');process.stdin.resume()"], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.stdin.end();
    await closed;
  });
  await once(child.stdout, 'data');
  // Hold the child's PID throughout both observations: an exited PID can be reused between OS reads.
  const pids = [process.pid, child.pid, SYSTEM_PID];
  const single = new Map(pids.map((pid) => [pid, processIdentity(pid)]));
  // More than one PID takes the batched path; repeats and invalid PIDs are ignored as before.
  const batched = processIdentities([...pids, process.pid, 0, -1, 1.5]);
  assert.deepEqual([...batched.keys()], pids);
  assert.deepEqual(batched, single);
  assert.match(batched.get(process.pid), /\S/, 'a live process has a readable identity');
  assert.match(batched.get(child.pid), /\S/, 'an owned live child has a readable identity');
  assert.equal(isAlive(child.pid), true, 'the owned PID remains allocated through the observations');
});

function processPlatform(t, platform, execute) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const mock = t.mock.method(childProcess, 'spawnSync', execute);
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
}

for (const platform of ['win32', 'linux'])
  test(`${platform} identities return null for missing processes without assuming a dead PID stays unused`, (t) => {
    processPlatform(t, platform, () => ({ status: 1, stdout: '' }));
    if (platform === 'linux')
      t.mock.method(fs, 'readFileSync', () => {
        throw Object.assign(Error('Invented missing process'), { code: 'ENOENT' });
      });
    assert.equal(processIdentity(110), null);
    assert.deepEqual(
      processIdentities([110, 120]),
      new Map([
        [110, null],
        [120, null],
      ]),
    );
  });

test('Windows batching filters PIDs, retains unread identities and falls back only for omitted rows', (t) => {
  const calls = [];
  processPlatform(t, 'win32', (command, args, options) => {
    calls.push(args);
    assert.equal(command, 'powershell.exe');
    assert.equal(options.timeout, 15000);
    assert.equal(options.windowsHide, true);
    if (calls.length === 1) {
      assert.match(args.at(-1), /foreach \(\$id in 110,120,130\)/);
      assert.ok(!args.at(-1).includes('injected'));
      return { status: 0, signal: null, stdout: '110=1111\r\n120=\r\n999=9999\r\ninvalid output\r\n' };
    }
    assert.match(args.at(-1), /Get-Process -Id 130 /);
    return { status: 0, signal: null, stdout: '3333\r\n' };
  });
  const identities = processIdentities([110, 120, 130, 110, 0, -1, 1.5, '140;injected']);
  assert.deepEqual(
    identities,
    new Map([
      [110, '1111'],
      [120, null],
      [130, '3333'],
    ]),
  );
  assert.equal(calls.length, 2, 'only an omitted row needs a per-PID read');
});

for (const completes of [true, false])
  test(`Windows batched identity retries remain bounded when ${completes ? 'a later read succeeds' : 'all reads time out'}`, (t) => {
    let attempts = 0;
    processPlatform(t, 'win32', () => {
      attempts++;
      if (attempts === 3 && completes) return { status: 0, signal: null, stdout: '110=1111\n120=2222\n' };
      return { status: null, signal: null, error: Object.assign(Error('Invented timeout'), { code: 'ETIMEDOUT' }) };
    });
    assert.deepEqual(
      processIdentities([110, 120]),
      new Map([
        [110, completes ? '1111' : null],
        [120, completes ? '2222' : null],
      ]),
    );
    assert.equal(attempts, 3, 'an exhausted batch cannot launch more per-PID timeout retries');
  });

test('empty identity requests perform no process reads and one valid PID uses the single-reader path', (t) => {
  let calls = 0;
  processPlatform(t, 'win32', (_command, args) => {
    calls++;
    assert.match(args.at(-1), /^\(Get-Process -Id 110 /);
    return { status: 0, signal: null, stdout: '1111' };
  });
  assert.deepEqual(processIdentities([0, -1, NaN, Infinity, 1.5, '110']), new Map());
  assert.equal(processIdentity(-1), null);
  assert.equal(calls, 0);
  assert.deepEqual(processIdentities([110, 110, -1]), new Map([[110, '1111']]));
  assert.equal(calls, 1);
});

test('POSIX batching reads proc start times and uses ps for missing or inaccessible proc entries', (t) => {
  const calls = [];
  processPlatform(t, 'linux', (command, args, options) => {
    calls.push(args.at(-1));
    assert.equal(command, 'ps');
    assert.deepEqual(args.slice(0, -1), ['-o', 'lstart=', '-p']);
    assert.equal(options.timeout, 3000);
    return args.at(-1) === '120' ? { status: 0, stdout: ' Invented start time \n' } : { status: 1, stdout: '' };
  });
  const fields = Array.from({ length: 20 }, (_, index) => (index === 19 ? '7777' : '0'));
  t.mock.method(fs, 'readFileSync', (file, encoding) => {
    assert.equal(encoding, 'utf8');
    if (file === '/proc/110/stat') return `110 (invented ) worker name) ${fields.join(' ')}`;
    throw Object.assign(Error('Invented unread proc entry'), { code: file === '/proc/120/stat' ? 'ENOENT' : 'EACCES' });
  });
  assert.deepEqual(
    processIdentities([110, 120, 130, 110, 0]),
    new Map([
      [110, '7777'],
      [120, 'Invented start time'],
      [130, null],
    ]),
  );
  assert.deepEqual(calls, ['120', '130']);
});
