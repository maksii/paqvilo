// @test-kind contract: a fresh CLR host starts from its runtime's verified host executable, never from a new copy per call, a changed executable is refused, and the call's snapshot holds no SDK copy
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { closeClrHostPool, executeClrPlugin, prepareClrRuntime, releaseClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr, strongNameKey } from './fixtures/clr-sdk.mjs';

const user = '10000000-0000-0000-0000-000000000001';

test(
  'fresh CLR calls start the runtime host executable itself; a changed one is refused',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-fresh-host-')));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const directory = path.join(root, 'runtime');
    await fs.mkdir(directory);
    const source = path.join(root, 'Protocol.cs'),
      executable = path.join(directory, 'Protocol.exe'),
      assembly = path.join(directory, 'Original.dll'),
      log = path.join(root, 'starts.log');
    // Every start logs the folder its executable runs from, then answers its one invocation.
    await fs.writeFile(
      source,
      String.raw`using System;public static class Protocol{public static void Main(){
System.IO.File.AppendAllText(Environment.GetEnvironmentVariable("INVENTED_STARTS_LOG"),AppDomain.CurrentDomain.BaseDirectory+"\n");
Console.ReadLine();Console.WriteLine("{\"kind\":\"result\"}");}}`,
    );
    compileClr(source, executable, { target: 'exe' });
    await fs.writeFile(assembly, 'invented assembly bytes');
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const runtime = {
      directory,
      assembly,
      executable,
      files: await Promise.all(
        [assembly, executable].map(async (file) => ({ path: file, sha256: hash(await fs.readFile(file)) })),
      ),
      allowedFiles: ['Original.dll', 'Protocol.exe'],
      descriptor: { typeName: 'Invented.Original' },
      provenance: { hostSourceSha256: hash(await fs.readFile(new URL('../lib/plugin-clr-host.cs', import.meta.url))) },
    };
    process.env.INVENTED_STARTS_LOG = log;
    t.after(() => delete process.env.INVENTED_STARTS_LOG);
    const notes = [];
    const call = () =>
      executeClrPlugin(runtime, {}, { store: {}, diagnostic: (note) => notes.push(note) }).executionMode;
    assert.deepEqual([call(), call()], ['fresh-host', 'fresh-host']);
    assert.deepEqual(
      (await fs.readFile(log, 'utf8')).split('\n').slice(0, -1),
      [directory + path.sep, directory + path.sep],
      'both hosts ran the verified runtime executable, not a new copy',
    );
    assert.deepEqual(
      (await fs.readdir(root)).filter((name) => name.startsWith('clr-')),
      [],
      'each call removes its own assembly snapshot',
    );
    // Both hosts are verified stopped, so nothing holds the executable any more.
    assert.deepEqual(
      notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED').map((note) => note.absenceVerified),
      [true, true],
    );
    // Windows can release the image of an exited process, or a scanner its own handle on the file, just after the exit
    // is reported; a write it refuses meanwhile is tried again (the runner's --test-timeout bounds a file never released).
    for (;;)
      try {
        await fs.appendFile(executable, 'changed bytes');
        break;
      } catch (cause) {
        if (!['EBUSY', 'EPERM'].includes(cause.code)) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    notes.length = 0;
    assert.throws(call, (error) => error.code === 'LocalPluginSourceChanged');
    assert.deepEqual(notes, [], 'a changed host executable starts no host');
  },
);

test(
  'a fresh CLR host loads the plug-in assembly from its snapshot and binds the SDK and dependencies from the runtime',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-fresh-load-'))),
      sdk = clrSdk(),
      proxy = path.join(path.dirname(sdk), 'Microsoft.Crm.Sdk.Proxy.dll');
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const library = async (name, code, options) => {
      await fs.writeFile(path.join(root, name + '.cs'), code);
      compileClr(path.join(root, name + '.cs'), path.join(root, name + '.dll'), options);
    };
    const where = (name) =>
      `namespace Invented{public static class ${name}{public static string Where(){return typeof(${name}).Assembly.Location;}}}`;
    await library('Plain', where('Plain'));
    await library('Signed', where('Signed'), { keyFile: strongNameKey(path.join(root, 'Signed.snk')) });
    await library(
      'Probe',
      'using System;using System.IO;using System.Linq;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Probe:IPlugin{public void Execute(IServiceProvider p){var t=(ITracingService)p.GetService(typeof(ITracingService));var self=typeof(Probe).Assembly.Location;' +
        't.Trace("snapshot "+String.Join(",",Directory.GetFiles(Path.GetDirectoryName(self)).Select(Path.GetFileName).OrderBy(n=>n)));t.Trace("plugin "+self);t.Trace("plain "+Plain.Where());t.Trace("signed "+Signed.Where());' +
        't.Trace("sdk "+typeof(IPlugin).Assembly.Location);t.Trace("proxy "+typeof(Microsoft.Crm.Sdk.Messages.WhoAmIRequest).Assembly.Location);}}}',
      { references: [sdk, proxy, path.join(root, 'Plain.dll'), path.join(root, 'Signed.dll')] },
    );
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Probe.dll',
      dependencies: ['Plain.dll', 'Signed.dll'],
      typeName: 'Invented.Probe',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented backend', grants: [] },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    ownedFixture(t).add(() => releaseClrRuntime(runtime));
    const notes = [];
    assert.equal(
      executeClrPlugin(runtime, {}, { store: {}, diagnostic: (note) => notes.push(note) }).executionMode,
      'fresh-host',
    );
    const traces = Object.fromEntries(
      notes.filter((note) => note.code === 'PLUGIN_CLR_TRACE').map((note) => note.message.split(' ')),
    );
    assert.equal(
      traces.snapshot,
      'Microsoft.Crm.Sdk.Proxy.dll,Plain.dll,Probe.dll,Signed.dll',
      'the snapshot holds the plug-in assembly and its dependencies, not the SDK',
    );
    assert.equal(path.basename(path.dirname(traces.plugin)).slice(0, 8), 'clr-run-', 'the plug-in runs from its copy');
    for (const name of ['plain', 'signed', 'sdk', 'proxy'])
      assert.equal(path.dirname(traces[name]), runtime.directory, name + ' binds from the verified runtime directory');
  },
);

// @test-kind contract: every call checks the SDK file in the runtime cache against its recorded hash before a host starts
for (const persistentHost of [false, true])
  test(
    `a ${persistentHost ? 'pooled' : 'fresh'} CLR call refuses an SDK file changed in the runtime cache before any host starts`,
    { skip: CLR_SKIP },
    async (t) => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-sdk-changed-'))),
        sdk = clrSdk();
      ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
      ownedFixture(t).add(() => closeClrHostPool());
      await fs.writeFile(
        path.join(root, 'Quiet.cs'),
        'namespace Invented{public sealed class Quiet:Microsoft.Xrm.Sdk.IPlugin{public void Execute(System.IServiceProvider p){}}}',
      );
      compileClr(path.join(root, 'Quiet.cs'), path.join(root, 'Quiet.dll'), { references: [sdk] });
      const runtime = await prepareClrRuntime({
        trust: 'execute-local-assembly',
        root,
        assembly: 'Quiet.dll',
        typeName: 'Invented.Quiet',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        persistentHost,
        serviceProfile: { userId: user, evidence: 'Invented backend', grants: [] },
        context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      });
      ownedFixture(t).add(() => releaseClrRuntime(runtime));
      const cached = runtime.files.find((file) => file.sha256 === runtime.provenance.sdkSha256);
      assert.equal(path.dirname(cached.path), runtime.directory, 'the SDK is a file of the runtime cache');
      await fs.appendFile(cached.path, Buffer.from([0]));
      const notes = [];
      // Refused by the per-call check of the runtime files, before a pooled session copies them.
      assert.throws(
        () => executeClrPlugin(runtime, {}, { store: {}, diagnostic: (note) => notes.push(note) }),
        (error) =>
          error.status === 409 &&
          error.code === 'LocalPluginSourceChanged' &&
          error.message === 'Trusted CLR bytes changed after preparation.',
      );
      assert.deepEqual(notes, [], 'no host started');
      assert.deepEqual(
        (await fs.readdir(path.dirname(runtime.directory))).filter((name) => /^clr-(run|pool)-/.test(name)),
        [],
        'no execution snapshot remains',
      );
    },
  );
