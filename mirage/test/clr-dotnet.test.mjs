// @test-kind contract: the .NET build inputs come from the SDK the toolchain chose, never a project's global.json pin
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  'the probe build leaves no process running: no pipe or socket of one stays in the temporary folder',
  {
    skip:
      CLR_SKIP ||
      (clrToolchain()?.kind !== 'dotnet' && 'the .NET Framework compiler on Windows starts no build server'),
  },
  (t) => {
    // A build server that outlives the build keeps its debugger pipes and diagnostics socket in the temporary folder
    // it was started with: the probe gets a folder of its own, in a process of its own.
    const temporary = folder(t);
    const script = `import { clrToolchain } from ${JSON.stringify(new URL('../lib/clr-toolchain.mjs', import.meta.url).href)};
import { dotnetBuildInputs } from ${JSON.stringify(new URL('../lib/clr-dotnet.mjs', import.meta.url).href)};
const inputs = dotnetBuildInputs(clrToolchain(), { cacheRoot: false });
console.log(JSON.stringify({ compile: inputs.compile.length, runtime: inputs.runtime.length }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TMPDIR: temporary },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const { compile, runtime } = JSON.parse(result.stdout);
    assert.ok(compile > 0 && runtime > 0, 'the probe resolved the reference and package assemblies');
    assert.deepEqual(
      fs.readdirSync(temporary).filter((name) => {
        const stat = fs.lstatSync(path.join(temporary, name));
        return stat.isFIFO() || stat.isSocket();
      }),
      [],
    );
  },
);
