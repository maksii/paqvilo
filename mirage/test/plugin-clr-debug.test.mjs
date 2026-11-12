// @test-kind contract: original CLR source debugging explicitly gates construction and snapshots declared symbols without changing default execution
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  prepareClrRuntime,
  sharedClrRuntimePreparer,
  pluginRuntimeDescriptors,
  validateClrDescriptor,
  executeClrPlugin,
} from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { editorFiles } from '../../lense/project-editor.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';

// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_GUARD_MS = 170_000;

const user = '10000000-0000-0000-0000-000000000001';
const debugStep = '10000000-0000-0000-0000-000000000002';
const descriptor = (root) => ({
  trust: 'execute-local-assembly',
  root,
  assembly: 'Original.dll',
  typeName: 'Invented.Original',
  sdkRoot: root,
  sdkAssembly: 'Sdk.dll',
  cacheRoot: path.join(root, 'cache'),
  context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
  serviceProfile: { userId: user, evidence: 'Invented debugger fixture with no SDK calls', grants: [] },
});

// @test-kind contract+security: debugger mode is explicit and symbol paths cannot escape the trusted project root
test('debugging requires explicit opt-in and declared portable symbol paths; editor generates standard CLR attach', () => {
  const base = descriptor(os.tmpdir());
  assert.equal(validateClrDescriptor(base).debug, undefined);
  assert.throws(() => validateClrDescriptor({ ...base, debug: 'true' }), /Boolean/);
  assert.throws(() => validateClrDescriptor({ ...base, debug: true }), /matching PDB/);
  assert.equal(validateClrDescriptor({ ...base, defaultMode: 'clr' }).defaultMode, 'clr');
  assert.equal(validateClrDescriptor({ ...base, defaultMode: 'placeholder' }).defaultMode, 'placeholder');
  for (const defaultMode of [true, false, 'handler', 'disabled', 'CLR', null])
    assert.throws(() => validateClrDescriptor({ ...base, defaultMode }), /defaultMode/);
  for (const symbols of [
    ['../Original.pdb'],
    ['/Original.pdb'],
    ['a/../Original.pdb'],
    ['Original.dll'],
    ['C:Original.pdb'],
    ['a//Original.pdb'],
  ])
    assert.throws(() => validateClrDescriptor({ ...base, symbols }), /confined relative PDB/);
  assert.equal(validateClrDescriptor({ ...base, debug: true, symbols: ['Original.pdb'] }).debug, true);
  const files = editorFiles({
    name: 'invented',
    sites: [],
    browser: 'msedge',
    sourceRoot: '${workspaceFolder}',
    scripts: {},
  });
  const launch = JSON.parse(files['.vscode/launch.json']).configurations.find((item) => item.type === 'clr');
  assert.deepEqual(launch, {
    name: 'Invented: Mirage plug-in: attach .NET Framework',
    type: 'clr',
    request: 'attach',
    processId: '${command:pickProcess}',
    justMyCode: true,
    requireExactSource: true,
  });
  assert.deepEqual(JSON.parse(files['.vscode/extensions.json']).recommendations, ['ms-dotnettools.csharp']);
  const normal = { ...base, debug: false };
  const descriptors = pluginRuntimeDescriptors([
    {
      id: 'invented',
      pluginRuntimes: {
        [user]: normal,
        [debugStep]: { ...base, debug: true, symbols: ['Original.pdb'] },
      },
    },
  ]);
  assert.deepEqual(descriptors.get(user).symbols, ['Original.pdb']);
  assert.deepEqual(descriptors.get(debugStep).symbols, ['Original.pdb']);
  assert.equal(normal.symbols, undefined, 'collecting shared symbols does not mutate the project pack');
});

// @test-kind contract+security: a project can explicitly select its trusted original DLL on cold starts without enabling discovered or mismatched types
test('source CLR default is exact-type opt-in and explicit local overrides retain precedence', () => {
  const step = {
    id: debugStep,
    typeName: 'Invented.Original',
    enabled: true,
    message: 'Create',
    entity: 'x_item',
    stage: 20,
    rank: 1,
    mode: 0,
    images: [],
  };
  const catalogue = (declared, overrides = {}, handlers = new Map()) =>
    pluginCatalogue({
      plugins: { steps: [step] },
      descriptors: new Map(declared ? [[debugStep, declared]] : []),
      overrides,
      handlers,
    })[0];
  const base = descriptor(os.tmpdir());
  assert.equal(catalogue().mode, 'placeholder');
  assert.equal(catalogue(base).mode, 'placeholder');
  assert.equal(catalogue({ ...base, defaultMode: 'placeholder' }).mode, 'placeholder');
  const enabled = { ...base, defaultMode: 'clr' };
  assert.equal(catalogue(enabled).defaultMode, 'clr');
  assert.equal(catalogue(enabled).mode, 'clr');
  assert.equal(catalogue({ ...enabled, typeName: 'Invented.Other' }).mode, 'placeholder');
  for (const mode of ['disabled', 'mock', 'placeholder'])
    assert.equal(catalogue(enabled, { [`plugin-step:${debugStep}`]: { mode } }).mode, mode);
  assert.equal(catalogue(enabled, {}, new Map([[debugStep, () => {}]])).mode, 'handler');
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-debug-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const sdk = clrSdk();
  const source = path.join(root, 'Original.cs');
  await fs.writeFile(
    source,
    'using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Original:IPlugin{public void Execute(IServiceProvider p){((ITracingService)p.GetService(typeof(ITracingService))).Trace("original-executed");}}}',
  );
  compileClr(source, path.join(root, 'Original.dll'), { references: [sdk] });
  // Symbol contents are opaque outside source debugging. This fixture tests confinement and immutability, not symbol binding.
  await fs.writeFile(path.join(root, 'Original.pdb'), 'BSJBinvented-symbol-snapshot');
  return {
    root,
    descriptor: {
      ...descriptor(root),
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      symbols: ['Original.pdb'],
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    },
  };
}

test('declared symbols reach the immutable execution copy and changes fail closed', { skip: CLR_SKIP }, async (t) => {
  const fx = await fixture(t);
  const runtime = await prepareClrRuntime(fx.descriptor);
  const symbols = runtime.files.find((file) => path.basename(file.path) === 'Original.pdb');
  assert.ok(symbols?.sourcePath);
  assert.equal(await fs.readFile(symbols.path, 'utf8'), 'BSJBinvented-symbol-snapshot');
  const notes = [];
  executeClrPlugin(runtime, {}, { diagnostic: (note) => notes.push(note) });
  assert.ok(notes.some((note) => note.code === 'PLUGIN_CLR_TRACE' && note.message === 'original-executed'));
  await fs.writeFile(path.join(fx.root, 'Original.pdb'), 'modified symbols');
  assert.throws(() => executeClrPlugin(runtime, {}, {}), /changed after preparation/);
  await fs.writeFile(path.join(fx.root, 'Original.pdb'), 'Microsoft C/C++ MSF 7.00');
  await assert.rejects(prepareClrRuntime({ ...fx.descriptor, debug: true }), /portable PDB/);
});

test(
  'rebuilding edited original C# loads changed behavior in a newly prepared runtime',
  { skip: CLR_SKIP },
  async (t) => {
    const fx = await fixture(t);
    const first = await prepareClrRuntime(fx.descriptor);
    const traces = (runtime) => {
      const notes = [];
      executeClrPlugin(runtime, {}, { diagnostic: (note) => notes.push(note) });
      return notes.filter((note) => note.code === 'PLUGIN_CLR_TRACE').map((note) => note.message);
    };
    assert.deepEqual(traces(first), ['original-executed']);
    const source = path.join(fx.root, 'Original.cs');
    await fs.writeFile(
      source,
      (await fs.readFile(source, 'utf8')).replace('original-executed', 'edited-source-executed'),
    );
    compileClr(source, path.join(fx.root, 'Original.dll'), { references: [clrSdk()] });
    assert.throws(() => executeClrPlugin(first, {}, {}), /changed after preparation/);
    const rebuilt = await prepareClrRuntime(fx.descriptor);
    assert.notEqual(rebuilt.directory, first.directory, 'the rebuilt bytes get their own execution snapshot');
    assert.deepEqual(traces(rebuilt), ['edited-source-executed']);
  },
);

test(
  'normal and debugging steps share an assembly host; the gate waits beyond the ordinary budget and an orphan still exits',
  { skip: CLR_SKIP },
  async (t) => {
    const fx = await fixture(t);
    const prepare = sharedClrRuntimePreparer();
    const descriptors = pluginRuntimeDescriptors([
      {
        id: 'invented',
        pluginRuntimes: {
          [user]: { ...fx.descriptor, symbols: undefined, debug: false },
          [debugStep]: { ...fx.descriptor, debug: true, timeoutMs: 100 },
        },
      },
    ]);
    const normal = await prepare(descriptors.get(user));
    const runtime = await prepare(descriptors.get(debugStep));
    assert.equal(runtime.directory, normal.directory, 'debug is an invocation setting, not a separate assembly domain');
    assert.equal(normal.descriptor.debug, false);
    assert.equal(runtime.descriptor.debug, true);
    const runtimeFile = path.join(fx.root, 'runtime.json');
    await fs.writeFile(runtimeFile, JSON.stringify({ normal, runtime }));
    const script = path.join(fx.root, 'invoke.mjs');
    await fs.writeFile(
      script,
      `import fs from 'node:fs';import {executeClrPlugin} from ${JSON.stringify(new URL('../lib/plugin-clr.mjs', import.meta.url).href)};const {normal,runtime}=JSON.parse(fs.readFileSync(${JSON.stringify(runtimeFile)}));const options={diagnostic:note=>console.log(JSON.stringify(note))};executeClrPlugin(normal,{},options);executeClrPlugin(runtime,{},options);console.log('UNEXPECTED_COMPLETION');`,
    );
    const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let hostPid;
    t.after(() => {
      // The owned parent's watcher tears down its CLR host. A numeric host PID may already have been reused.
      child.kill();
    });
    let output = '';
    const gated = new Promise((resolve, reject) => {
      // The production parent-incarnation probe has its own startup limit; the ordinary warmup has its own budget.
      const timer = setTimeout(
        () => reject(new Error('CLR debug gate was not observed')),
        30_000 + ORDINARY_CLR_TIMEOUT_MS + 1000,
      );
      child.stdout.on('data', (data) => {
        output += data;
        for (const line of output.split('\n')) {
          try {
            const note = JSON.parse(line);
            if (note.code === 'PLUGIN_CLR_DEBUG_WAIT') {
              hostPid = note.pid;
              clearTimeout(timer);
              resolve();
            }
          } catch {
            /* Partial line. */
          }
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Debug parent exited before the gate'));
      });
    });
    child.stderr.resume();
    await gated;
    const incarnation = () => {
      const probe = spawnSync(runtime.executable, ['--process-start', String(hostPid)], {
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: CLI_HANG_GUARD_MS,
      });
      return probe.status === 0 ? probe.stdout.trim() : null;
    };
    const hostStarted = incarnation();
    assert.match(hostStarted ?? '', /^\d+$/, 'capture the exact host incarnation before killing its owner');
    // Time is the behavior under test: this invocation must remain gated past its ordinary 100 ms budget.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(child.exitCode, null);
    assert.equal(output.match(/original-executed/g)?.length, 1, 'only the normal warmup executed original code');
    assert.equal(output.match(/PLUGIN_CLR_HOST_STARTED/g)?.length, 1, 'debugging reused the normal step host');
    assert.ok(!output.includes('UNEXPECTED_COMPLETION'));
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    let absent = false;
    for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
      if (incarnation() !== hostStarted) {
        absent = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(absent, true, 'the exact owned CLR host exits when its parent dies, including at the debugger gate');
  },
);
