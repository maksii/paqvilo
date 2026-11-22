// @test-kind contract: the plug-in host toolchain is the .NET Framework on Windows and a .NET 10+ SDK on macOS and Linux
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clrHostCommand,
  clrHostEnvironment,
  clrToolchain,
  DOTNET_MIN_MAJOR,
  removeClrHostLeftovers,
} from '../lib/clr-toolchain.mjs';

test('an ended .NET host loses exactly its own debugger pipes and diagnostics socket', (t) => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-clr-leftovers-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const own = ['clr-debug-pipe-712-689-in', 'clr-debug-pipe-712-689-out', 'dotnet-diagnostic-712-689-socket'];
  // Hosts whose process id only shares digits with this one, and files that merely look alike.
  const others = [
    'clr-debug-pipe-7123-689-in',
    'clr-debug-pipe-1712-689-out',
    'dotnet-diagnostic-71-2689-socket',
    'clr-debug-pipe-712-689-in.txt',
    'clr-debug-pipe-712-notes-in',
    'notes-712.txt',
  ];
  for (const name of [...own, ...others]) fs.writeFileSync(path.join(folder, name), '');
  removeClrHostLeftovers(null, 712, { TMPDIR: folder });
  removeClrHostLeftovers('/usr/bin/dotnet', undefined, { TMPDIR: folder });
  assert.deepEqual(fs.readdirSync(folder).sort(), [...own, ...others].sort(), 'no .NET host, or none started');
  removeClrHostLeftovers('/usr/bin/dotnet', 712, { TMPDIR: folder });
  assert.deepEqual(fs.readdirSync(folder).sort(), [...others].sort());
  assert.doesNotThrow(() => removeClrHostLeftovers('/usr/bin/dotnet', 712, { TMPDIR: path.join(folder, 'absent') }));
});

test('Windows compiles with the .NET Framework 4 compiler and runs the host executable itself', () => {
  const toolchain = clrToolchain({ platform: 'win32', env: { WINDIR: 'D:\\Windows' } });
  assert.equal(toolchain.kind, 'netfx');
  assert.equal(toolchain.compiler, path.join('D:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'));
  assert.equal(toolchain.launcher, null);
  assert.deepEqual(clrHostCommand(null, 'host.exe', ['--parent', '7']), ['host.exe', ['--parent', '7']]);
  const env = { PATH: '/bin', TZ: 'Europe/Kyiv' };
  assert.equal(clrHostEnvironment(null, env), env, 'the .NET Framework host pins UTC itself');
});

/** A dotnet root with an executable dotnet and SDK folders holding the C# compiler, as the installers lay it out. */
function dotnetRoot(t, versions) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-clr-toolchain-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'dotnet'), '#!/bin/sh\n', { mode: 0o755 });
  for (const version of versions) {
    const roslyn = path.join(root, 'sdk', version, 'Roslyn', 'bincore');
    fs.mkdirSync(roslyn, { recursive: true });
    fs.writeFileSync(path.join(roslyn, 'csc.dll'), '');
  }
  return root;
}

test(
  'macOS and Linux use the newest .NET SDK of the supported major versions, found through a PATH link',
  { skip: process.platform === 'win32' && 'POSIX executable modes' },
  (t) => {
    const root = dotnetRoot(t, ['9.0.300', '10.0.100-rc.2.25502.107', '10.0.100', '11.0.100-preview.1', '10.0.204']);
    // A distribution package links /usr/bin/dotnet (here a PATH folder) into its root.
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(root, 'dotnet'), path.join(bin, 'dotnet'));
    for (const platform of ['darwin', 'linux']) {
      const toolchain = clrToolchain({ platform, env: { PATH: ['relative/bin', bin].join(':') }, folders: [] });
      assert.equal(toolchain.kind, 'dotnet', platform);
      assert.equal(toolchain.dotnet, path.join(root, 'dotnet'), 'the link is followed to its root');
      // Releases sort above their own previews and older releases: 11.0.100-preview.1 is newer than 10.0.204.
      assert.equal(toolchain.sdkVersion, '11.0.100-preview.1');
      assert.equal(toolchain.launcher, toolchain.dotnet);
    }
    const env = clrHostEnvironment('/usr/bin/dotnet', { PATH: '/bin', TZ: 'Europe/Kyiv' });
    assert.equal(env.TZ, 'UTC', 'the .NET host runs in the sandbox UTC zone');
    assert.equal(env.PATH, '/bin');
    assert.deepEqual(clrHostCommand('/usr/bin/dotnet', '/cache/host.exe', ['--parent', '7']), [
      '/usr/bin/dotnet',
      ['/cache/host.exe', '--parent', '7'],
    ]);
  },
);

test(
  'DOTNET_ROOT and the standard install folders are searched, and an SDK older than the supported one is not used',
  { skip: process.platform === 'win32' && 'POSIX executable modes' },
  (t) => {
    const current = dotnetRoot(t, [`${DOTNET_MIN_MAJOR}.0.100`]);
    const old = dotnetRoot(t, [`${DOTNET_MIN_MAJOR - 1}.0.300`]);
    assert.equal(
      clrToolchain({ platform: 'linux', env: { DOTNET_ROOT: current }, folders: [] }).dotnet,
      path.join(current, 'dotnet'),
    );
    assert.equal(
      clrToolchain({ platform: 'linux', env: {}, folders: [current] }).sdkVersion,
      `${DOTNET_MIN_MAJOR}.0.100`,
    );
    // Only an older SDK: none, so Mirage reports the CLR host as unavailable and suggests mocks.
    assert.equal(clrToolchain({ platform: 'darwin', env: { DOTNET_ROOT: old }, folders: [old] }), null);
    // A root whose SDK lacks the compiler (a runtime-only install with a stray folder) is not used either.
    fs.rmSync(path.join(current, 'sdk', `${DOTNET_MIN_MAJOR}.0.100`, 'Roslyn'), { recursive: true });
    assert.equal(clrToolchain({ platform: 'linux', env: {}, folders: [current] }), null);
  },
);
