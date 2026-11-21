// @test-kind contract: Paqvilo's operating-system process identity reads for owned, live, missing and system processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { processIdentity, processIdentityAsync, isAlive } from '../lense/process-identity.mjs';

// The process a non-administrator cannot open on this OS: System on Windows, init on POSIX.
const SYSTEM_PID = process.platform === 'win32' ? 4 : 1;

test('awaited process identities match synchronous reads for owned live and system processes', async (t) => {
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
  for (const pid of [process.pid, child.pid, SYSTEM_PID])
    assert.equal(await processIdentityAsync(pid), processIdentity(pid), `pid ${pid}`);
  assert.match(processIdentity(process.pid), /\S/, 'a live process has a readable identity');
  assert.match(processIdentity(child.pid), /\S/, 'an owned live child has a readable identity');
  assert.equal(isAlive(child.pid), true, 'the owned PID remains allocated through the observations');
});

function processPlatform(t, platform, { spawnSync, execFile }) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const mocks = [
    t.mock.method(childProcess, 'spawnSync', spawnSync ?? (() => assert.fail('no synchronous helper is expected'))),
    t.mock.method(childProcess, 'execFile', execFile ?? (() => assert.fail('no awaited helper is expected'))),
  ];
  syncBuiltinESMExports();
  t.after(() => {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  });
}

for (const platform of ['win32', 'linux'])
  test(`${platform} identities return null for missing processes without assuming a dead PID stays unused`, async (t) => {
    processPlatform(t, platform, {
      spawnSync: () => ({ status: 1, stdout: '' }),
      execFile: (_file, _args, _options, done) => done(Object.assign(Error('Invented exit'), { code: 1 }), ''),
    });
    if (platform === 'linux') {
      const missing = () => {
        throw Object.assign(Error('Invented missing process'), { code: 'ENOENT' });
      };
      t.mock.method(fs, 'readFileSync', missing);
      t.mock.method(fs.promises, 'readFile', async () => missing());
    }
    assert.equal(processIdentity(110), null);
    assert.equal(await processIdentityAsync(110), null);
  });

test('a Windows identity read is one PowerShell start without a time limit, and an unread helper reads nothing', async (t) => {
  const calls = [];
  let outcome = { status: 0, signal: null, stdout: '1111\r\n' };
  processPlatform(t, 'win32', {
    spawnSync(command, args, options) {
      calls.push(args.at(-1));
      assert.equal(command, 'powershell.exe');
      // A loaded host answers late: a read given up on elapsed time would report a running process as unread.
      assert.equal(options.timeout, undefined);
      assert.equal(options.windowsHide, true);
      return outcome;
    },
    execFile(command, args, options, done) {
      calls.push(args.at(-1));
      assert.equal(command, 'powershell.exe');
      assert.equal(options.timeout, undefined);
      done(null, '2222\r\n');
    },
  });
  assert.equal(processIdentity(110), '1111');
  assert.equal(await processIdentityAsync(120), '2222');
  assert.match(calls[0], /^\(Get-Process -Id 110 /);
  assert.match(calls[1], /^\(Get-Process -Id 120 /);
  // A helper that did not run reads nothing, and is not started again.
  outcome = { status: null, signal: null, error: Object.assign(Error('Invented failure'), { code: 'ENOENT' }) };
  assert.equal(processIdentity(130), null);
  assert.equal(calls.length, 3);
});

test('an invalid PID or an aborted signal starts no helper', async (t) => {
  processPlatform(t, 'win32', {});
  for (const pid of [0, -1, NaN, Infinity, 1.5, '110', '140;injected']) {
    assert.equal(processIdentity(pid), null);
    assert.equal(await processIdentityAsync(pid), null);
  }
  assert.equal(await processIdentityAsync(110, { signal: AbortSignal.abort() }), null);
});

test('POSIX reads proc start times and uses ps, without a time limit, for missing or inaccessible proc entries', (t) => {
  const calls = [];
  processPlatform(t, 'linux', {
    spawnSync(command, args, options) {
      calls.push(args.at(-1));
      assert.equal(command, 'ps');
      assert.deepEqual(args.slice(0, -1), ['-o', 'lstart=', '-p']);
      assert.equal(options.timeout, undefined);
      return args.at(-1) === '120' ? { status: 0, stdout: ' Invented start time \n' } : { status: 1, stdout: '' };
    },
  });
  const fields = Array.from({ length: 20 }, (_, index) => (index === 19 ? '7777' : '0'));
  t.mock.method(fs, 'readFileSync', (file, encoding) => {
    assert.equal(encoding, 'utf8');
    if (file === '/proc/110/stat') return `110 (invented ) worker name) ${fields.join(' ')}`;
    throw Object.assign(Error('Invented unread proc entry'), { code: file === '/proc/120/stat' ? 'ENOENT' : 'EACCES' });
  });
  assert.equal(processIdentity(110), '7777');
  assert.equal(processIdentity(120), 'Invented start time');
  assert.equal(processIdentity(130), null);
  assert.deepEqual(calls, ['120', '130']);
});
