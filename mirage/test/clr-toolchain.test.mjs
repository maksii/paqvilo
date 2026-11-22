// @test-kind contract: the plug-in host toolchain is the .NET Framework on Windows and the csc.exe of the found Mono elsewhere
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clrHostCommand, clrToolchain } from '../lib/clr-toolchain.mjs';

test('Windows compiles with the .NET Framework 4 compiler and runs the host executable itself', () => {
  const toolchain = clrToolchain({ platform: 'win32', env: { WINDIR: 'D:\\Windows' } });
  assert.equal(toolchain.runtime, '.NET Framework');
  assert.equal(toolchain.compiler, path.join('D:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'));
  assert.deepEqual(toolchain.compilerArguments, []);
  assert.equal(toolchain.launcher, null);
  assert.deepEqual(clrHostCommand(null, 'host.exe', ['--parent', '7']), ['host.exe', ['--parent', '7']]);
});

test(
  'macOS and Linux use the mono on PATH with the csc.exe of the same installation',
  { skip: process.platform === 'win32' && 'POSIX executable modes' },
  (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-clr-toolchain-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // A Homebrew-like layout: the PATH entry links to the versioned installation, and csc.exe sits under its lib/.
    const bin = path.join(root, 'Cellar/mono/6.14.1/bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'mono'), '#!/bin/sh\n', { mode: 0o755 });
    const csc = path.join(root, 'Cellar/mono/6.14.1/lib/mono/4.5/csc.exe');
    fs.mkdirSync(path.dirname(csc), { recursive: true });
    fs.writeFileSync(csc, '');
    const linked = path.join(root, 'bin');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(bin, 'mono'), path.join(linked, 'mono'));
    // Another tool's csc on PATH (Chicken Scheme installs one) is not the compiler.
    fs.writeFileSync(path.join(linked, 'csc'), '#!/bin/sh\n', { mode: 0o755 });

    const toolchain = clrToolchain({ platform: 'darwin', env: { PATH: linked }, folders: [] });
    assert.deepEqual(toolchain, {
      runtime: 'Mono',
      compiler: path.join(bin, 'mono'),
      compilerArguments: [csc],
      launcher: path.join(bin, 'mono'),
    });
    assert.deepEqual(clrHostCommand(toolchain.launcher, 'host.exe', ['--persistent']), [
      path.join(bin, 'mono'),
      ['host.exe', '--persistent'],
    ]);

    // The standard install folders are searched after PATH.
    assert.equal(
      clrToolchain({ platform: 'linux', env: { PATH: '' }, folders: [linked] })?.launcher,
      path.join(bin, 'mono'),
    );
    // A mono without its csc.exe is no toolchain.
    fs.rmSync(csc);
    assert.equal(clrToolchain({ platform: 'linux', env: { PATH: linked }, folders: [] }), null);
  },
);

test('no toolchain is reported when no mono is installed', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'paq-clr-none-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(clrToolchain({ platform: 'darwin', env: { PATH: empty }, folders: [] }), null);
  assert.equal(clrToolchain({ platform: 'linux', env: {}, folders: [empty] }), null);
});
