import test from 'node:test';
import assert from 'node:assert/strict';
import { tlsTools } from './tls-tools-fixture.mjs';

function commands(available) {
  const calls = [];
  return {
    calls,
    run(command, args, options) {
      calls.push([command, args]);
      assert.equal(options.windowsHide, true);
      const stdout = available.get(command);
      return stdout === undefined ? { status: 1, stdout: '' } : { status: 0, stdout };
    },
  };
}

test('TLS tools prefer working PATH clients and never consult Git when OpenSSL runs', () => {
  const fixture = commands(
    new Map([
      ['python3', 'Python 3.13.9'],
      ['openssl', 'OpenSSL 3.5.4'],
    ]),
  );
  assert.deepEqual(tlsTools({ platform: 'win32', required: true, run: fixture.run }), {
    python: 'python3',
    openssl: 'openssl',
  });
  assert.equal(
    fixture.calls.some(([command]) => command === 'git'),
    false,
  );
});

test('TLS tools use Git for Windows bundled OpenSSL when it is absent from PATH', () => {
  const bundled = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
  const fixture = commands(
    new Map([
      ['py', 'Python 3.13.9'],
      ['git', 'C:/Program Files/Git/mingw64/libexec/git-core\n'],
      [bundled, 'OpenSSL 3.5.4'],
    ]),
  );
  assert.deepEqual(tlsTools({ platform: 'win32', required: true, run: fixture.run }), {
    python: 'py',
    openssl: bundled,
  });
  assert.deepEqual(fixture.calls.find(([command]) => command === 'git')[1], ['--exec-path']);
  assert.ok(fixture.calls.some(([command]) => command === bundled));
});

test('optional missing TLS clients remain explicit unavailable values, while required clients fail closed', () => {
  const missing = commands(new Map());
  assert.deepEqual(tlsTools({ platform: 'win32', required: false, run: missing.run }), { python: null, openssl: null });
  assert.throws(() => tlsTools({ platform: 'win32', required: true, run: missing.run }), /Python, OpenSSL/);
  const noOpenSsl = commands(new Map([['python', 'Python 3.13.9']]));
  assert.throws(() => tlsTools({ platform: 'linux', required: true, run: noOpenSsl.run }), /OpenSSL/);
  assert.equal(
    noOpenSsl.calls.some(([command]) => command === 'git'),
    false,
  );
  const noPython = commands(new Map([['openssl', 'OpenSSL 3.5.4']]));
  assert.throws(() => tlsTools({ platform: 'linux', required: true, run: noPython.run }), /Python/);
});
