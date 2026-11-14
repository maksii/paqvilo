// @test-kind security: a CLR host given only its parent PID binds the live process that created it and refuses another live process or an exited one (exit 74)
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const user = '10000000-0000-0000-0000-000000000001';
// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_GUARD_MS = 170_000;

async function bareRuntime(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-parent-binding-'))),
    sdk = clrSdk();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await fs.writeFile(path.join(root, 'Original.dll'), 'invented assembly');
  const runtime = await prepareClrRuntime({
    trust: 'execute-local-assembly',
    root,
    assembly: 'Original.dll',
    typeName: 'Invented.Original',
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    cacheRoot: path.join(root, 'cache'),
    serviceProfile: { userId: user, evidence: 'Invented backend', grants: [] },
    context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
  });
  return { root, runtime };
}
const run = (file, args) =>
  spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout: CLI_HANG_GUARD_MS, input: '' });
// The holder starts a process that exits at once and keeps a handle to it, so its PID cannot be reused, then starts the
// host with that PID (`named`: and its start time), closes the host's input and returns the host's exit code.
async function exitedParentHost(root, runtime, named) {
  const source = path.join(root, 'Holder.cs'),
    holder = path.join(root, 'Holder.exe');
  await fs.writeFile(
    source,
    'using System.Diagnostics;public static class Holder{static ProcessStartInfo Start(string file,string args){return new ProcessStartInfo(file,args){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true};}' +
      'public static int Main(string[] args){using(var gone=Process.Start(Start(args[0],"--process-start 0"))){gone.WaitForExit();' +
      'var parent="--parent "+gone.Id+(args.Length>1?" --parent-start "+gone.StartTime.ToUniversalTime().Ticks:"");' +
      'using(var host=Process.Start(Start(args[0],parent))){host.StandardInput.Close();host.WaitForExit();return host.ExitCode;}}}}',
  );
  compileClr(source, holder, { target: 'exe' });
  return run(holder, named ? [runtime.executable, 'named'] : [runtime.executable]);
}

test(
  'a CLR host bound by PID alone accepts its live parent and refuses an exited one',
  { skip: CLR_SKIP },
  async (t) => {
    const { root, runtime } = await bareRuntime(t);
    // This process created the host: the host binds it, reads its closed input and ends normally.
    assert.equal(run(runtime.executable, ['--parent', String(process.pid)]).status, 0, 'a live older parent binds');
    // The holder, not the exited process, created the host, so the creator check refuses it.
    const exited = await exitedParentHost(root, runtime, false);
    assert.equal(exited.status, 74, exited.stderr || exited.error?.message || 'an exited parent is refused');
  },
);

test('a CLR host bound by PID and start time refuses a parent that has exited', { skip: CLR_SKIP }, async (t) => {
  const { root, runtime } = await bareRuntime(t);
  // The PID and start time name the exited process exactly; it is refused because it is no longer running.
  const exited = await exitedParentHost(root, runtime, true);
  assert.equal(exited.status, 74, exited.stderr || exited.error?.message || 'an exited named parent is refused');
});

test('a CLR host bound by PID alone refuses a live process that did not create it', { skip: CLR_SKIP }, async (t) => {
  const { runtime } = await bareRuntime(t);
  // Started and alive before the host, so it is older than the host, but the host is created by this process.
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { windowsHide: true, stdio: 'ignore' });
  const exited = once(sleeper, 'exit');
  ownedFixture(t).add(async () => {
    sleeper.kill();
    await exited;
  });
  await once(sleeper, 'spawn');
  const refused = run(runtime.executable, ['--parent', String(sleeper.pid)]);
  assert.equal(refused.status, 74, refused.error?.message || 'a live process that did not create the host is refused');
});
