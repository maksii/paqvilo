// @test-kind contract: the .NET build inputs come from the SDK the toolchain chose, never a project's global.json pin
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dotnetBuildInputs, dotnetCompile, writeDotnetRuntimeConfig } from '../lib/clr-dotnet.mjs';
import { clrToolchain } from '../lib/clr-toolchain.mjs';
import { CLR_SKIP } from './fixtures/clr-sdk.mjs';

function folder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-clr-dotnet-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the probe builds in its private folder pinned to the chosen SDK and keeps only portable package assemblies', (t) => {
  const root = folder(t);
  const file = (name) => {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
    return full;
  };
  const roslyn = path.join(root, 'sdk/10.0.404/Roslyn');
  file('sdk/10.0.404/Roslyn/bincore/csc.dll');
  const reference = file('packs/ref/net10.0/System.Runtime.dll');
  const portable = file('nuget/system.security.cryptography.pkcs/lib/net10.0/System.Security.Cryptography.Pkcs.dll');
  const windowsOnly = file(
    'nuget/system.security.cryptography.pkcs/runtimes/win/lib/net10.0/System.Security.Cryptography.Pkcs.dll',
  );
  const calls = [];
  // The caller's folder may hold a global.json pinning another SDK: the probe runs in its own folder, pinned.
  const run = (command, args, options) => {
    const out = args.find((argument) => argument.startsWith('-p:PaqviloOut=')).slice('-p:PaqviloOut='.length);
    calls.push({
      command,
      args,
      cwd: options.cwd,
      globalJson: JSON.parse(fs.readFileSync(path.join(options.cwd, 'global.json'), 'utf8')),
    });
    fs.writeFileSync(path.join(out, 'roslyn.txt'), roslyn + '\n');
    fs.writeFileSync(path.join(out, 'compile.txt'), reference + '\n');
    fs.writeFileSync(path.join(out, 'runtime.txt'), [portable, windowsOnly].join('\n') + '\n');
    return { status: 0, stdout: '', stderr: '' };
  };
  const toolchain = { dotnet: '/usr/share/dotnet/dotnet', sdkVersion: '10.0.404' };
  const inputs = dotnetBuildInputs(toolchain, { run, cacheRoot: false });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].cwd, process.cwd(), 'not the caller folder');
  assert.ok(calls[0].cwd.startsWith(os.tmpdir()), 'a private folder');
  assert.deepEqual(calls[0].globalJson, { sdk: { version: '10.0.404', rollForward: 'disable' } });
  assert.deepEqual(calls[0].args.slice(0, 3), ['msbuild', calls[0].args[1], '-restore']);
  for (const argument of ['-nodeReuse:false', '-p:UseSharedCompilation=false'])
    assert.ok(calls[0].args.includes(argument), argument + ': no build process outlives the probe');
  assert.equal(inputs.csc, path.join(roslyn, 'bincore', 'csc.dll'));
  assert.deepEqual(inputs.compile, [reference]);
  assert.deepEqual(inputs.runtime, [portable], 'a runtimes/<rid>/ variant is for another platform');
  assert.equal(fs.existsSync(calls[0].cwd), false, 'the probe folder is removed');
  const [command, compile] = dotnetCompile(toolchain, inputs, {
    out: 'Host.exe',
    target: 'exe',
    sources: ['Host.cs'],
    references: ['Sdk.dll'],
    defines: ['PAQVILO_CORECLR'],
    run: (file, args) => [file, args],
  });
  assert.equal(command, toolchain.dotnet);
  assert.deepEqual(
    compile.slice(0, 4),
    ['exec', inputs.csc, '/noconfig', '/nostdlib+'],
    'the SDK compiler, no csc.rsp',
  );
  for (const argument of [
    '/target:exe',
    '/define:PAQVILO_CORECLR',
    '/out:Host.exe',
    '/reference:' + reference,
    '/reference:Sdk.dll',
  ])
    assert.ok(compile.includes(argument), argument);
  assert.equal(compile.at(-1), 'Host.cs');
});

test('a failed restore names the packages it needs and the last lines of the build output', (t) => {
  const run = () => ({
    status: 1,
    stdout: 'error NU1101: Unable to find package System.ServiceModel.Primitives',
    stderr: '',
  });
  assert.throws(
    () => dotnetBuildInputs({ dotnet: 'dotnet', sdkVersion: '10.0.100' }, { run, cacheRoot: false }),
    /System\.ServiceModel\.Primitives 10\.1\.0 from NuGet[\s\S]*NU1101/,
  );
  const host = path.join(folder(t), 'paqvilo-plugin-host.exe');
  const config = JSON.parse(fs.readFileSync(writeDotnetRuntimeConfig(host), 'utf8'));
  assert.deepEqual(config.runtimeOptions.framework, { name: 'Microsoft.NETCore.App', version: '10.0.0' });
  assert.equal(config.runtimeOptions.rollForward, 'Major', 'any later .NET runs the host');
  assert.throws(
    () => writeDotnetRuntimeConfig(host),
    { code: 'EEXIST' },
    'an existing configuration is never replaced',
  );
});

test(
  'the probe build leaves no process running',
  {
    skip:
      CLR_SKIP ||
      (clrToolchain()?.kind !== 'dotnet' && 'the .NET Framework compiler on Windows starts no build server') ||
      (process.platform !== 'linux' && 'the processes a build left are found through /proc'),
  },
  () => {
    // Every process the build starts inherits its environment, a build server that outlives it included: the build
    // runs with a variable of its own, and afterwards no process may carry it. The temporary folder and the NuGet
    // folders stay the shared ones (NuGet keeps its locks between processes in the temporary folder).
    const mark = 'PAQVILO_PROBE_TEST_' + randomUUID().replaceAll('-', '');
    const run = (command, args, options) =>
      spawnSync(command, args, { ...options, env: { ...options.env, [mark]: '1' } });
    const inputs = dotnetBuildInputs(clrToolchain(), { run, cacheRoot: false });
    assert.ok(inputs.compile.length > 0 && inputs.runtime.length > 0, 'the probe resolved the assemblies');
    const left = fs
      .readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .flatMap((pid) => {
        try {
          const marked = fs
            .readFileSync(`/proc/${pid}/environ`, 'utf8')
            .split('\0')
            .includes(mark + '=1');
          return marked ? [fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, 3).join(' ')] : [];
        } catch {
          // Gone meanwhile, or another account's process.
          return [];
        }
      });
    assert.deepEqual(left, [], 'no process of the build is still running');
  },
);
