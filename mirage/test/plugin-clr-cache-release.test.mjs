// @test-kind contract: releasing a prepared CLR runtime removes its owned cache directory unless a live runtime shares it
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  buildClrRuntime,
  prepareClrRuntime,
  releaseClrRuntime,
  clrHostPoolStatus,
  closeClrHostPool,
  settleClrReleases,
  sharedClrRuntimePreparer,
} from '../lib/plugin-clr.mjs';
import { install } from '../lib/dataverse-customapi.mjs';
import { composeOrganizationHost } from '../lib/organization-host.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { releaseStaleUploadedRuntimes } from '../lib/plugin-uploaded.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const USER = '10000000-0000-4000-8000-000000000001';
const NOOP_SOURCE =
  'using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Noop:IPlugin{public void Execute(IServiceProvider p){}}}';

async function fixture(root) {
  const sdk = clrSdk(),
    source = path.join(root, 'Noop.cs');
  await fs.writeFile(source, NOOP_SOURCE);
  compileClr(source, path.join(root, 'Noop.dll'), { references: [sdk] });
  const cacheRoot = path.join(root, 'cache');
  const descriptor = () => ({
    trust: 'execute-local-assembly',
    root,
    assembly: 'Noop.dll',
    typeName: 'Invented.Noop',
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    cacheRoot,
    serviceProfile: { userId: USER, evidence: 'Invented grants', grants: [] },
    context: { initiatingUserId: USER, organizationId: USER, businessUnitId: USER },
  });
  return { cacheRoot, descriptor };
}

const runtimeDirectories = async (cacheRoot) => (await fs.readdir(cacheRoot)).filter((name) => name.startsWith('clr-'));

test('releasing each prepared runtime leaves no clr- cache directory behind', { skip: CLR_SKIP }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  try {
    const { cacheRoot, descriptor } = await fixture(root);
    for (let attempt = 0; attempt < 3; attempt++) await releaseClrRuntime(await prepareClrRuntime(descriptor()));
    assert.deepEqual(await runtimeDirectories(cacheRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test(
  'a runtime sharing its cache directory with a live runtime keeps it until that runtime is released',
  { skip: CLR_SKIP },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    try {
      const { cacheRoot, descriptor } = await fixture(root);
      const runtime = await prepareClrRuntime(descriptor());
      const sharing = { ...runtime };
      await releaseClrRuntime(runtime, { liveRuntimes: [sharing] });
      assert.deepEqual(await runtimeDirectories(cacheRoot), [path.basename(runtime.directory)]);
      await releaseClrRuntime(sharing);
      assert.deepEqual(await runtimeDirectories(cacheRoot), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);

test('a release never removes a directory outside the cache root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  try {
    const cacheRoot = path.join(root, 'cache');
    const outside = path.join(root, 'clr-outside-directory');
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.mkdir(outside);
    await releaseClrRuntime({ directory: outside, descriptor: { cacheRoot } });
    assert.deepEqual(
      (await fs.readdir(root)).toSorted((a, b) => a.localeCompare(b)),
      ['cache', 'clr-outside-directory'],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

const exists = (target) =>
  fs.access(target).then(
    () => true,
    () => false,
  );

test('a runtime whose host is not verified stopped keeps its cache directory until the host is verified stopped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  try {
    const cacheRoot = path.join(root, 'cache');
    const runtime = { directory: path.join(cacheRoot, 'clr-x'), descriptor: { cacheRoot } };
    await fs.mkdir(runtime.directory, { recursive: true });
    const notes = [];
    const diagnostic = (note) => notes.push(note);
    await releaseClrRuntime(runtime, { closeHostPool: () => ({ closed: 1, allAbsenceVerified: false }), diagnostic });
    assert.equal(await exists(runtime.directory), true, 'the directory is kept while the host is not verified stopped');
    assert.deepEqual(
      notes.map((note) => note.code),
      ['PLUGIN_CLR_CLEANUP'],
      'the kept directory is reported once',
    );
    await releaseClrRuntime(runtime, { closeHostPool: () => ({ closed: 1, allAbsenceVerified: true }), diagnostic });
    assert.equal(await exists(runtime.directory), false, 'the directory is removed once the host is verified stopped');
    assert.equal(notes.length, 1, 'the verified release reports nothing further');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test(
  'a release removes the cache directory once a process still running from it has ended',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const cacheRoot = path.join(root, 'cache');
    const runtime = { directory: path.join(cacheRoot, 'clr-x'), descriptor: { cacheRoot } };
    await fs.mkdir(runtime.directory, { recursive: true });
    const source = path.join(root, 'Held.cs'),
      executable = path.join(runtime.directory, 'Held.exe');
    // Windows refuses to delete the image of a running process: it holds the directory for a second after it starts.
    await fs.writeFile(
      source,
      'public static class Held{public static void Main(){System.Console.WriteLine("running");System.Threading.Thread.Sleep(1000);}}',
    );
    compileClr(source, executable, { target: 'exe' });
    const held = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const closed = new Promise((resolve) => held.once('close', resolve));
    ownedFixture(t).add(() => {
      held.kill();
      return closed;
    });
    await new Promise((resolve, reject) => {
      held.once('error', reject);
      held.stdout.once('data', resolve);
    });
    const notes = [];
    await releaseClrRuntime(runtime, {
      closeHostPool: () => ({ closed: 1, allAbsenceVerified: true }),
      diagnostic: (note) => notes.push(note),
    });
    // The informational held notice appears when the image stays locked for its threshold, which depends on how fast
    // the process is torn down and whether a scanner opens the fresh image; it reports no failure, so it may appear.
    assert.deepEqual(
      notes.filter((note) => note.code !== 'PLUGIN_CLR_CLEANUP_HELD'),
      [],
      'no cleanup failure is reported',
    );
    assert.equal(await exists(runtime.directory), false, 'the release waits for the image to be released');
  },
);

test('a runtime whose host is verified stopped releases its cache directory without a report', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  try {
    const cacheRoot = path.join(root, 'cache');
    const runtime = { directory: path.join(cacheRoot, 'clr-x'), descriptor: { cacheRoot } };
    await fs.mkdir(runtime.directory, { recursive: true });
    const notes = [];
    await releaseClrRuntime(runtime, {
      closeHostPool: () => ({ closed: 1, allAbsenceVerified: true }),
      diagnostic: (note) => notes.push(note),
    });
    assert.equal(await exists(runtime.directory), false, 'the verified release removes the directory');
    assert.deepEqual(notes, [], 'no cleanup is reported');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

// A removal a held file refuses until the test opens the gate: the first attempt fails as Windows fails it while another
// process holds a file, the second waits for the gate and then removes the directory.
function heldRemoval() {
  let open, retried;
  const gate = new Promise((resolve) => (open = resolve)),
    retrying = new Promise((resolve) => (retried = resolve));
  let attempts = 0;
  const removeDirectory = async (directory) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('Invented held file'), { code: 'EBUSY' });
    retried();
    await gate;
    return fs.rm(directory, { recursive: true, force: true });
  };
  return { removeDirectory, retrying, open, attempts: () => attempts };
}
const verifiedClose = () => ({ closed: 1, allAbsenceVerified: true });

test('a release whose removal a held file refuses lets other work run and settles once the removal succeeds', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const cacheRoot = path.join(root, 'cache');
  const runtime = { directory: path.join(cacheRoot, 'clr-x'), descriptor: { cacheRoot } };
  await fs.mkdir(runtime.directory, { recursive: true });
  const held = heldRemoval(),
    notes = [];
  let settled = false;
  const release = releaseClrRuntime(runtime, {
    closeHostPool: verifiedClose,
    diagnostic: (note) => notes.push(note),
    removeDirectory: held.removeDirectory,
  });
  release.then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'an event-loop turn completes while the removal is refused');
  await held.retrying;
  assert.equal(settled, false, 'the release waits for the removal it retries');
  assert.equal(await exists(runtime.directory), true, 'the directory stays until the held file is released');
  const closes = [];
  const again = releaseClrRuntime(runtime, {
    closeHostPool: (options) => closes.push(options) && verifiedClose(),
    removeDirectory: held.removeDirectory,
  });
  held.open();
  await Promise.all([release, again]);
  assert.deepEqual(closes, [], 'a second release of the directory joins the pending removal');
  assert.equal(held.attempts(), 2, 'the removal is attempted again once, after the refusal');
  assert.equal(await exists(runtime.directory), false, 'the release settles with the directory removed');
  assert.deepEqual(notes, [], 'no cleanup is reported');
});

test(
  'a runtime prepared again while its released directory is being removed gets a directory of its own',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const { descriptor } = await fixture(root);
    const prepare = sharedClrRuntimePreparer();
    const first = await prepare(descriptor());
    const held = heldRemoval();
    const release = releaseClrRuntime(first, { removeDirectory: held.removeDirectory });
    ownedFixture(t).add(() => {
      held.open();
      return release;
    });
    await held.retrying;
    const second = await prepare(descriptor());
    ownedFixture(t).add(() => releaseClrRuntime(second));
    assert.notEqual(second.directory, first.directory, 'the directory being removed is not used again');
    held.open();
    await release;
    assert.equal(await exists(first.directory), false, 'the released directory is removed');
    assert.equal(await exists(second.directory), true, 'the new runtime keeps its own directory');
  },
);

test('closing a backend closes an uploaded runtime through the backend closeHostPool', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const directory = path.join(root, 'clr-uploaded');
  await fs.mkdir(directory);
  const closed = [];
  const backend = await createOrganizationBackend({
    store: await new DataStore({ state: emptyState() }).init(),
    runtimes: new Map([
      ['uploaded-step', { uploaded: { assemblyId: 'invented' }, directory, descriptor: { cacheRoot: root } }],
    ]),
    closeHostPool: ({ runtime }) => closed.push(runtime.directory) && verifiedClose(),
  });
  ownedFixture(t).add(() => backend.close());
  await backend.close();
  assert.deepEqual(closed, [directory], 'the uploaded runtime host pool is closed by the backend closeHostPool');
  assert.equal(await exists(directory), false, 'its directory is removed once its hosts are verified stopped');
});

test(
  'a backend close waits for the removal its synchronous sweep started and no other backend close does',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const directory = path.join(root, 'clr-held'),
      source = path.join(root, 'Held.cs'),
      executable = path.join(directory, 'Held.exe');
    await fs.mkdir(directory);
    // Windows refuses to delete the image of a running process; this one runs until the test closes its input.
    await fs.writeFile(
      source,
      'public static class Held{public static void Main(){System.Console.WriteLine("running");System.Console.In.ReadToEnd();}}',
    );
    compileClr(source, executable, { target: 'exe' });
    const held = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = new Promise((resolve) => held.once('close', resolve));
    ownedFixture(t).add(() => {
      held.kill();
      return closed;
    });
    await new Promise((resolve, reject) => {
      held.once('error', reject);
      held.stdout.once('data', resolve);
    });
    const store = await new DataStore({ state: emptyState() }).init();
    const runtimes = new Map([
      [
        'uploaded-step',
        { uploaded: { assemblyId: 'invented', content: '' }, directory, descriptor: { cacheRoot: root } },
      ],
    ]);
    const owner = await createOrganizationBackend({ store, runtimes }),
      other = await createOrganizationBackend({ store: await new DataStore({ state: emptyState() }).init() });
    ownedFixture(t).add(() => Promise.all([owner.close(), other.close()]));
    // The catalogue sweep runs synchronously and cannot await the removal it starts: the step is gone.
    releaseStaleUploadedRuntimes(store, runtimes, []);
    assert.equal(runtimes.size, 0, 'the swept runtime leaves the map at once');
    let ownerClosed = false;
    const closing = owner.close().then(() => (ownerClosed = true));
    await other.close();
    assert.equal(ownerClosed, false, 'the owner close waits while the running image refuses the removal');
    assert.equal(await exists(directory), true, 'the directory stays while the image runs');
    held.stdin.end();
    await closing;
    assert.equal(await exists(directory), false, 'the owner close settles with the directory removed');
  },
);
const PREPARED_STEP = '40000000-0000-4000-8000-000000000001',
  CALLER_STEP = '40000000-0000-4000-8000-000000000002';
test(
  'closing a backend releases the runtimes it prepared and leaves a caller runtime in place',
  { skip: CLR_SKIP },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    let backend;
    try {
      const { descriptor } = await fixture(root);
      const callerRuntime = await prepareClrRuntime(descriptor());
      const stepOf = (id) => ({
        id,
        name: 'Invented release step',
        enabled: true,
        entity: 'gadget',
        message: 'Create',
        stage: 40,
        mode: 0,
        rank: 1,
        typeName: 'Invented.Noop',
        assemblyId: 'invented',
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
      });
      const runtimes = new Map([[CALLER_STEP, callerRuntime]]),
        descriptors = new Map([[PREPARED_STEP, descriptor()]]),
        overrides = Object.fromEntries(
          [PREPARED_STEP, CALLER_STEP].map((id) => ['plugin-step:' + id, { mode: 'clr' }]),
        );
      const items = pluginCatalogue({
        plugins: { steps: [stepOf(PREPARED_STEP), stepOf(CALLER_STEP)] },
        handlers: new Map(),
        runtimes,
        descriptors,
        overrides,
      });
      const store = await new DataStore({ state: emptyState() }).init();
      const pooledBefore = clrHostPoolStatus().length;
      backend = await createOrganizationBackend({
        store,
        items: () => items,
        handlers: new Map(),
        runtimes,
        descriptors,
      });
      const prepared = runtimes.get(PREPARED_STEP);
      assert.notEqual(prepared, callerRuntime);
      assert.equal(await exists(prepared.directory), true);
      await backend.close();
      assert.equal(await exists(prepared.directory), false, 'the prepared runtime cache is released on close');
      assert.equal(await exists(callerRuntime.directory), true, 'the caller runtime cache stays');
      assert.equal(clrHostPoolStatus().length, pooledBefore);
    } finally {
      await backend?.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);

const RELEASE_API = 'invented_Release',
  FIRST_STEP = '50000000-0000-4000-8000-000000000001',
  SECOND_STEP = '50000000-0000-4000-8000-000000000002';
const mainDescriptor = (root, stepId) => ({
  trust: 'execute-local-assembly',
  persistentHost: true,
  root,
  assembly: 'Noop.dll',
  typeName: 'Invented.Noop',
  sdkRoot: path.dirname(clrSdk()),
  sdkAssembly: path.basename(clrSdk()),
  cacheRoot: path.join(root, 'cache'),
  serviceProfile: { userId: USER, evidence: 'Invented custom API release', grants: [] },
  context: {
    initiatingUserId: USER,
    organizationId: USER,
    businessUnitId: USER,
    mainOperationStepId: stepId,
    mainOperationStepEvidence: 'Invented main-operation step witness',
  },
});
// A custom API whose main operation is the Noop plug-in: install maps and prepares its runtime, call runs it.
async function customApiHarness(root, { prepareRuntime } = {}) {
  await fixture(root);
  const state = emptyState();
  state.tables.customapi = [
    {
      customapiid: USER,
      uniquename: RELEASE_API,
      bindingtype: 0,
      isfunction: false,
      allowedcustomprocessingsteptype: 2,
      plugintypeid: USER,
    },
  ];
  state.tables.plugintype = [{ plugintypeid: USER, typename: 'Invented.Noop', pluginassemblyid: USER }];
  state.tables.pluginassembly = [{ pluginassemblyid: USER, name: 'Noop' }];
  state.tables.customapirequestparameter = [
    { customapirequestparameterid: USER, customapiid: USER, uniquename: 'Text', type: 10, isoptional: false },
  ];
  const store = new DataStore({ state });
  const operations = [],
    diagnostics = [];
  const api = {
    store,
    diagnostic: (entry) => diagnostics.push(entry),
    records: {},
    change: (fn) => fn(),
    principals: { privileges: () => new Map(), byId: (id) => (id === USER ? { systemuserid: USER } : null) },
    registry: {
      register: (op) => operations.push(op),
      has: (key) => operations.some((op) => op.name === key),
      find: (query) =>
        operations.find(
          (op) => op.name === query.name && op.kind === query.kind && op.binding === query.binding && !op.entity,
        ),
    },
  };
  const mainDescriptors = new Map([[USER, mainDescriptor(root, FIRST_STEP)]]),
    runtimes = new Map();
  await install(api, { handlers: new Map(), pluginRuntimes: mainDescriptors, runtimes, prepareRuntime }).ready;
  const call = () =>
    operations
      .find((op) => op.name === RELEASE_API)
      .handle({
        method: 'POST',
        url: new URL('http://127.0.0.1/api/data/v9.2/' + RELEASE_API),
        origin: 'http://127.0.0.1',
        version: 'v9.2',
        body: { Text: 'Release input' },
        params: {},
        headers: {},
        user: { systemuserid: USER },
      });
  return { api, call, runtimes, mainDescriptors, diagnostics };
}
const hostStops = (f, from = 0) =>
  f.diagnostics.filter((entry) => entry.code === 'PLUGIN_CLR_HOST_STOPPED').slice(from);
// A live pooled host keeps its cache directory locked, so the tests stop the hosts they left running before cleanup.
const closePools = (...maps) => {
  for (const map of maps) for (const runtime of map?.values() ?? []) closeClrHostPool({ runtime });
};

test(
  'replacing a custom API assembly releases the replaced runtime cache and its pooled host',
  { skip: CLR_SKIP },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    let f;
    try {
      f = await customApiHarness(root);
      await f.call();
      const replaced = f.runtimes.get(USER);
      const stopsBefore = hostStops(f).length;
      f.mainDescriptors.set(USER, mainDescriptor(root, SECOND_STEP));
      await f.call();
      // The call does not wait for the replaced directory's removal; the runtime map owns it.
      await settleClrReleases(f.runtimes);
      assert.equal(await exists(replaced.directory), false, 'the replaced runtime cache is released');
      assert.deepEqual(
        hostStops(f, stopsBefore).map((entry) => entry.absenceVerified),
        [true],
        'the replaced runtime pooled host is stopped',
      );
      assert.equal(await exists(f.runtimes.get(USER).directory), true, 'the replacement keeps its own cache');
    } finally {
      closePools(f?.runtimes);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);

test(
  'changing the custom API host configuration releases the replaced runtime cache and its pooled host',
  { skip: CLR_SKIP },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    let f;
    const reconfigured = new Map();
    try {
      f = await customApiHarness(root);
      await f.call();
      const replaced = f.runtimes.get(USER);
      const stopsBefore = hostStops(f).length;
      await install(f.api, { handlers: new Map(), pluginRuntimes: f.mainDescriptors, runtimes: reconfigured }).ready;
      await settleClrReleases(reconfigured);
      assert.equal(await exists(replaced.directory), false, 'the replaced runtime cache is released');
      assert.deepEqual(
        hostStops(f, stopsBefore).map((entry) => entry.absenceVerified),
        [true],
        'the replaced runtime pooled host is stopped',
      );
      assert.equal(await exists(reconfigured.get(USER).directory), true, 'the reconfigured runtime keeps its cache');
    } finally {
      closePools(f?.runtimes, reconfigured);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);

test(
  'a replacement that shares the replaced runtime directory keeps that directory for the replacement',
  { skip: CLR_SKIP },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    let f;
    try {
      f = await customApiHarness(root, { prepareRuntime: sharedClrRuntimePreparer() });
      await f.call();
      const shared = f.runtimes.get(USER);
      f.mainDescriptors.set(USER, mainDescriptor(root, SECOND_STEP));
      await f.call();
      assert.equal(f.runtimes.get(USER).directory, shared.directory, 'the same files prepare the same directory');
      assert.equal(await exists(shared.directory), true, 'the directory the replacement uses is kept');
    } finally {
      closePools(f?.runtimes);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);

test('a failing runtime pool close does not stop the other closes, and a second close retries only the failed one', async () => {
  const closed = [];
  let failFirst = true;
  const runtimes = new Map([
    ['first-step', { directory: 'first' }],
    ['second-step', { directory: 'second' }],
  ]);
  const backend = await createOrganizationBackend({
    store: await new DataStore({ state: emptyState() }).init(),
    runtimes,
    closeHostPool: ({ runtime }) => {
      closed.push(runtime.directory);
      if (runtime.directory === 'first' && failFirst) {
        failFirst = false;
        throw new Error('Invented busy host');
      }
    },
  });
  await assert.rejects(
    backend.close(),
    (error) => error instanceof AggregateError && error.errors.length === 1 && /Invented busy host/.test(error.message),
  );
  assert.deepEqual(closed, ['first', 'second'], 'every runtime is attempted after a failure');
  await backend.close();
  assert.deepEqual(closed, ['first', 'second', 'first'], 'the second close retries only the failed runtime');
  await backend.close();
  assert.deepEqual(closed, ['first', 'second', 'first'], 'a closed backend is not closed again');
});

test('a caller-mapped runtime is used as it is when a descriptor exists for its step', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  try {
    const directory = path.join(root, 'caller-clr-runtime');
    await fs.mkdir(directory);
    const callerRuntime = { directory, descriptor: { typeName: 'Invented.Caller' } };
    const runtimes = new Map([[FIRST_STEP, callerRuntime]]);
    const prepared = [];
    const backend = await createOrganizationBackend({
      store: await new DataStore({ state: emptyState() }).init(),
      items: () => [{ id: FIRST_STEP, mode: 'clr', clrAvailable: true }],
      runtimes,
      descriptors: new Map([[FIRST_STEP, { typeName: 'Invented.Noop' }]]),
      prepareRuntime: async (descriptor) => {
        prepared.push(descriptor);
        return { directory: path.join(root, 'prepared'), descriptor };
      },
    });
    assert.deepEqual(prepared, [], 'a mapped step is not prepared again');
    await backend.close();
    assert.equal(runtimes.get(FIRST_STEP), callerRuntime, 'the caller runtime stays mapped and usable');
    assert.equal(await exists(directory), true, 'the backend does not release the caller runtime directory');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test(
  'a runtime still mapped under another id keeps its directory and pooled host until no entry holds it',
  { skip: CLR_SKIP },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    let f;
    try {
      f = await customApiHarness(root);
      await f.call();
      const runtime = f.runtimes.get(USER);
      f.runtimes.set(SECOND_STEP, runtime);
      const stopsBefore = hostStops(f).length;
      const pooledBefore = clrHostPoolStatus().length;
      await releaseClrRuntime(runtime, { liveRuntimes: [runtime], diagnostic: f.api.diagnostic });
      assert.equal(await exists(runtime.directory), true, 'the directory of the runtime still mapped is kept');
      assert.equal(clrHostPoolStatus().length, pooledBefore, 'its pooled host keeps running');
      assert.deepEqual(hostStops(f, stopsBefore), [], 'no pooled host is stopped while the runtime is mapped');
      await releaseClrRuntime(runtime, { liveRuntimes: [], diagnostic: f.api.diagnostic });
      assert.equal(await exists(runtime.directory), false, 'the directory is removed once no entry holds the runtime');
      assert.deepEqual(
        hostStops(f, stopsBefore).map((entry) => entry.absenceVerified),
        [true],
        'the pooled host is stopped once no entry holds the runtime',
      );
    } finally {
      closePools(f?.runtimes);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);

// A build of the fixture assembly with an injected compiler run fails as `matches` expects and leaves no runtime directory.
async function buildFails(run, options, matches) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  try {
    const { cacheRoot, descriptor } = await fixture(root);
    const sdk = clrSdk();
    const files = {
      assembly: { bytes: await fs.readFile(path.join(root, 'Noop.dll')), path: path.join(root, 'Noop.dll') },
      sdk: { bytes: await fs.readFile(sdk), path: sdk },
    };
    assert.throws(() => buildClrRuntime(descriptor(), files, { compiler: 'invented-csc', ...options, run }), matches);
    assert.deepEqual(await runtimeDirectories(cacheRoot), [], 'the failed build leaves no runtime directory');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

test(
  'a compiler that does not exit is stopped at the compile guard and the build error names it',
  { skip: CLR_SKIP },
  async () => {
    const seen = [];
    // The injected run stands for a compiler the guard stopped: spawnSync reports ETIMEDOUT and no output.
    const run = (...call) => {
      seen.push(call[2].timeout);
      return {
        error: Object.assign(new Error('spawnSync invented-csc ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        status: null,
        stdout: '',
        stderr: '',
      };
    };
    await buildFails(
      run,
      { compileGuardMs: 2000 },
      (error) =>
        /did not exit within the 2000 ms guard/.test(error.message) &&
        error.message.includes('invented-csc') &&
        error.message.includes('compileGuardMs'),
    );
    assert.deepEqual(seen, [2000], 'the compile step runs once, under the compile guard');
  },
);

// @test-kind contract: a host compile that fails at the Windows path limit (csc CS1619) names the path length and the cause
test(
  'a compiler that fails at the Windows path limit is reported with the cache path length',
  { skip: CLR_SKIP },
  async () => {
    const outputs = [];
    // The injected run answers as csc did for a 250-character output path.
    const run = (compiler, args) => {
      outputs.push(args.find((arg) => arg.startsWith('/out:')).slice('/out:'.length));
      return {
        status: 1,
        stdout:
          "error CS1619: Cannot create temporary file '' -- The data area passed to a system call is too small. \r\n",
        stderr: '',
      };
    };
    await buildFails(
      run,
      {},
      (error) =>
        error.code === 'LocalPluginClrBuild' &&
        error.message ===
          "CLR host compilation failed: error CS1619: Cannot create temporary file '' -- The data area passed to a system call is too small. " +
            `The runtime cache path is ${outputs[0].length} characters long; the C# compiler fails near the Windows ` +
            '260-character path limit. Use a shorter project or cache path.',
    );
    assert.equal(outputs.length, 1, 'the compile step runs once');
  },
);

const HOST_STEP = '60000000-0000-4000-8000-000000000001',
  HOST_CALLER_STEP = '60000000-0000-4000-8000-000000000002';
const hostStep = (id) => ({
  id,
  name: 'Invented host step',
  enabled: true,
  entity: 'gadget',
  message: 'Create',
  stage: 40,
  mode: 0,
  rank: 1,
  typeName: 'Invented.Noop',
  assemblyId: 'invented',
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
});
// An organization host whose plug-in steps and CLR descriptors are invented; the steps take part in operation overrides.
async function clrOverrideHost(descriptors, diagnostic) {
  const store = await new DataStore({ state: emptyState() }).init();
  const steps = [hostStep(HOST_STEP), hostStep(HOST_CALLER_STEP)];
  return composeOrganizationHost({
    store,
    packs: [
      {
        id: 'invented-clr-host',
        name: 'Invented CLR host',
        description: 'Invented',
        matches: () => true,
        presets: () => ({}),
        pluginRuntimes: descriptors,
      },
    ],
    sources: { plugins: () => ({ steps }), workflows: () => [], layers: () => [] },
    sourcesKey: () => steps,
    overrides: () => store.state.simulator?.operations ?? null,
    diagnostic,
  });
}
const clrOverrides = (...ids) => Object.fromEntries(ids.map((id) => ['plugin-step:' + id, { mode: 'clr' }]));

test('a host close releases the CLR runtimes its operation overrides prepared', { skip: CLR_SKIP }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  let host;
  try {
    const { cacheRoot, descriptor } = await fixture(root);
    host = await clrOverrideHost({ [HOST_STEP]: descriptor() });
    await host.applyOperationOverrides(clrOverrides(HOST_STEP), () => {});
    assert.equal(await exists(host.runtimes.get(HOST_STEP).directory), true, 'the override prepared its runtime');
    await host.createBackend();
    await host.close();
    assert.deepEqual(await runtimeDirectories(cacheRoot), [], 'no runtime cache is left after the host closes');
  } finally {
    await host?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test(
  'a host close keeps the cache directory of a caller-mapped runtime and releases the override runtime',
  { skip: CLR_SKIP },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    let host;
    try {
      const { cacheRoot, descriptor } = await fixture(root);
      host = await clrOverrideHost({ [HOST_STEP]: descriptor() });
      const callerRuntime = await prepareClrRuntime(descriptor());
      host.runtimes.set(HOST_CALLER_STEP, callerRuntime);
      await host.applyOperationOverrides(clrOverrides(HOST_STEP, HOST_CALLER_STEP), () => {});
      assert.equal(host.runtimes.get(HOST_CALLER_STEP), callerRuntime, 'the caller runtime stays mapped');
      await host.createBackend();
      await host.close();
      assert.deepEqual(
        await runtimeDirectories(cacheRoot),
        [path.basename(callerRuntime.directory)],
        'only the caller runtime cache is left',
      );
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);

// A removal refused while the test's clock reads each of `times` in turn, then let through. The clock is read when the
// removal starts and after every refusal, so a refusal at times[i] is what the product sees.
function scriptedRemoval(times) {
  let clock = times[0],
    attempts = 0;
  const removeDirectory = async (directory) => {
    if (attempts < times.length) {
      clock = times[attempts++];
      throw Object.assign(new Error('Invented held file'), { code: 'EBUSY' });
    }
    return fs.rm(directory, { recursive: true, force: true });
  };
  return { removeDirectory, now: () => clock };
}
async function releaseScripted(t, times) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const cacheRoot = path.join(root, 'cache');
  const runtime = { directory: path.join(cacheRoot, 'clr-x'), descriptor: { cacheRoot } };
  await fs.mkdir(runtime.directory, { recursive: true });
  const notes = [];
  await releaseClrRuntime(runtime, {
    closeHostPool: verifiedClose,
    diagnostic: (note) => notes.push(note),
    ...scriptedRemoval(times),
  });
  assert.equal(await exists(runtime.directory), false, 'the release ends with the directory removed');
  return notes;
}

test('a removal refused for longer than the notice interval is reported once as held, then completes', async (t) => {
  const notes = await releaseScripted(t, [0, 1999, 2000, 2500, 90_000]);
  assert.deepEqual(
    notes.map((note) => note.code),
    ['PLUGIN_CLR_CLEANUP_HELD'],
    'one held notice for the directory, and no failure once it is removed',
  );
  assert.match(notes[0].message, /held by another process; removal is retried until the guard: clr-x$/);
});

test('a removal whose handles are released a few milliseconds late reports nothing', async (t) => {
  assert.deepEqual(await releaseScripted(t, [0, 5, 30]), []);
});

test('a diagnostic callback that throws never makes a release reject', async (t) => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  ownedFixture(t).add(() => process.off('unhandledRejection', onRejection));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const cacheRoot = path.join(root, 'cache');
  const runtime = { directory: path.join(cacheRoot, 'clr-x'), descriptor: { cacheRoot } };
  await fs.mkdir(runtime.directory, { recursive: true });
  const owner = new Map();
  const warned = new Promise((resolve) => process.once('warning', resolve));
  const release = releaseClrRuntime(runtime, {
    closeHostPool: verifiedClose,
    diagnostic: () => {
      throw new Error('Invented diagnostic failure');
    },
    removeDirectory: async () => {
      throw Object.assign(new Error('Invented refusal'), { code: 'EACCES' });
    },
    owner,
  });
  await release;
  await settleClrReleases(owner);
  assert.equal(await releaseClrRuntime(runtime), undefined, 'a later release of the failed directory resolves');
  assert.match((await warned).message, /Invented diagnostic failure/, 'the throwing callback is reported as a warning');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rejections, [], 'no release chain rejects');
});

test(
  'an operations-override change settles while its released directory is held, and the host close waits for it',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-release-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const { descriptor } = await fixture(root);
    let heldNoticed;
    const noticed = new Promise((resolve) => (heldNoticed = resolve));
    const host = await clrOverrideHost({ [HOST_STEP]: descriptor() }, (note) => {
      if (note.code === 'PLUGIN_CLR_CLEANUP_HELD') heldNoticed(note);
    });
    ownedFixture(t).add(() => host.close());
    await host.applyOperationOverrides(clrOverrides(HOST_STEP), () => {});
    const directory = host.runtimes.get(HOST_STEP).directory;
    // Another program runs from the runtime directory until the test closes its input: Windows refuses the removal.
    const source = path.join(root, 'Held.cs');
    await fs.writeFile(
      source,
      'public static class Held{public static void Main(){System.Console.WriteLine("running");System.Console.In.ReadToEnd();}}',
    );
    compileClr(source, path.join(directory, 'Held.exe'), { target: 'exe' });
    const held = spawn(path.join(directory, 'Held.exe'), [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let running = true;
    const closed = new Promise((resolve) =>
      held.once('close', () => {
        running = false;
        resolve();
      }),
    );
    ownedFixture(t).add(() => {
      held.kill();
      return closed;
    });
    await new Promise((resolve, reject) => {
      held.once('error', reject);
      held.stdout.once('data', resolve);
    });
    await host.applyOperationOverrides({}, () => {});
    assert.equal(host.runtimes.has(HOST_STEP), false, 'the override change released the runtime');
    assert.equal(running, true, 'the override change settled while the directory is still held');
    // `released` is set by the test itself just before it lets the holder go, so the order it records does not depend
    // on when the holder's exit is delivered.
    let released = false,
      closedAfterRelease = null;
    const closing = host.close().then(() => (closedAfterRelease = released));
    await noticed;
    assert.equal(closedAfterRelease, null, 'the close waits while the held directory is reported');
    released = true;
    held.stdin.end();
    await closing;
    assert.equal(closedAfterRelease, true, 'the close settles only after the holder was let go');
    assert.equal(await exists(directory), false, 'the close settles with the directory removed');
  },
);
