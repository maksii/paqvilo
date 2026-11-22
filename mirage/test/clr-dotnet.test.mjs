// @test-kind contract: the .NET build inputs come from the SDK the toolchain chose, never a project's global.json pin
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dotnetBuildInputs, dotnetCompilerArguments, writeDotnetRuntimeConfig } from '../lib/clr-dotnet.mjs';

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
  // A project of the caller's pins another SDK; the probe must not run under it.
  const project = folder(t);
  fs.writeFileSync(path.join(project, 'global.json'), JSON.stringify({ sdk: { version: '8.0.100' } }));
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
  const cwd = process.cwd();
  process.chdir(project);
  t.after(() => process.chdir(cwd));
  const inputs = dotnetBuildInputs(toolchain, { run, cacheRoot: false });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].cwd, project, 'not the caller folder');
  assert.ok(calls[0].cwd.startsWith(os.tmpdir()), 'a private folder');
  assert.deepEqual(calls[0].globalJson, { sdk: { version: '10.0.404', rollForward: 'disable' } });
  assert.equal(inputs.csc, path.join(roslyn, 'bincore', 'csc.dll'));
  assert.deepEqual(inputs.compile, [reference]);
  assert.deepEqual(inputs.runtime, [portable], 'a runtimes/<rid>/ variant is for another platform');
  assert.equal(fs.existsSync(calls[0].cwd), false, 'the probe folder is removed');
  assert.deepEqual(dotnetCompilerArguments(inputs).slice(0, 4), ['exec', inputs.csc, '/noconfig', '/nostdlib+']);
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
