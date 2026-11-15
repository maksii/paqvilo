// @test-kind tooling: preserve caller-prepared CLR runtime identity and reject unsafe fixture mappings before backend setup
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { createPreparedClrRuntimePreparer } from './fixtures/prepared-clr-runtimes.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';

const identity = '10000000-0000-0000-0000-000000000001';
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paq-prepared-clr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}
function write(file, body = 'invented test bytes') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
function makeRuntime(root, name, { dependencies = [], autoProxy = false, rootAlias = false, sdkAlias = false } = {}) {
  const source = path.join(root, `${name}-source`);
  const sdkSource = path.join(root, `${name}-sdk`);
  const cache = path.join(root, `${name}-cache`);
  fs.mkdirSync(source);
  fs.mkdirSync(sdkSource);
  fs.mkdirSync(cache);
  const assemblySource = write(path.join(source, 'Plugin.dll'));
  const sdkPath = write(path.join(sdkSource, 'Microsoft.Xrm.Sdk.dll'));
  const dependencySources = dependencies.map((item) => write(path.join(source, item)));
  const proxy = autoProxy ? write(path.join(sdkSource, 'Microsoft.Crm.Sdk.Proxy.dll')) : null;
  const descriptor = {
    trust: 'execute-local-assembly',
    root: rootAlias ? alias(source, name) : source,
    assembly: 'Plugin.dll',
    typeName: `Invented.${name}`,
    sdkRoot: sdkAlias ? alias(sdkSource, name) : sdkSource,
    sdkAssembly: 'Microsoft.Xrm.Sdk.dll',
    cacheRoot: cache,
    ...(dependencies.length ? { dependencies } : {}),
    serviceProfile: { userId: identity, evidence: 'Invented fixture', grants: [] },
    context: {
      executionUserId: identity,
      initiatingUserId: identity,
      organizationId: identity,
      businessUnitId: identity,
    },
  };
  const directory = path.join(cache, `clr-${name}`);
  fs.mkdirSync(directory);
  const assembly = write(path.join(directory, 'Plugin.dll'));
  const sdk = write(path.join(directory, 'Microsoft.Xrm.Sdk.dll'));
  const dependencySnapshots = dependencySources.map((sourcePath) =>
    write(path.join(directory, path.basename(sourcePath))),
  );
  const proxySnapshot = proxy ? write(path.join(directory, 'Microsoft.Crm.Sdk.Proxy.dll')) : null;
  const executable = write(path.join(directory, 'paqvilo-plugin-host.exe'));
  const files = [
    { sourcePath: assemblySource, path: assembly, sha256: 'captured-assembly' },
    { sourcePath: sdkPath, path: sdk, sha256: 'captured-sdk' },
    ...dependencySources.map((sourcePath, index) => ({
      sourcePath,
      path: dependencySnapshots[index],
      sha256: `captured-dependency-${index}`,
    })),
    ...(proxy ? [{ sourcePath: proxy, path: proxySnapshot, sha256: 'captured-proxy' }] : []),
    { path: executable, sha256: 'captured-host' },
  ];
  const prepared = { descriptor, directory, assembly, executable, files, provenance: { preserved: name } };
  return { descriptor, prepared, source };
}
function alias(target, name) {
  const link = `${target}-alias-${name}`;
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}
const step = (id, typeName) => ({
  id,
  enabled: true,
  entity: 'x_item',
  message: 'Create',
  stage: 20,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName,
  assemblyId: 'invented',
});

async function attach(t, steps, runtimeById) {
  const store = new DataStore({ state: emptyState() });
  const result = await attachClrSteps(t, { store, steps, runtime: (entry) => runtimeById.get(entry.id) ?? null });
  return { store, ...result };
}

test('default preparation returns exact mapped runtimes, honors root aliases, and keeps retypes distinct', async (t) => {
  const root = temp(t);
  const one = makeRuntime(root, 'One', {
    dependencies: ['deps/Helper.dll'],
    autoProxy: true,
    rootAlias: true,
    sdkAlias: true,
  });
  const two = makeRuntime(root, 'Two');
  const retyped = { ...one.prepared, descriptor: { ...one.descriptor, typeName: 'Invented.Parent' } };
  const entries = [
    step('one', one.descriptor.typeName),
    step('again', one.descriptor.typeName),
    step('parent', retyped.descriptor.typeName),
    step('two', two.descriptor.typeName),
    step('js', 'Invented.Js'),
  ];
  const runtimeById = new Map([
    ['one', one.prepared],
    ['again', one.prepared],
    ['parent', retyped],
    ['two', two.prepared],
  ]);
  const before = structuredClone(one.prepared.files);
  const { store, runtimes, descriptors } = await attach(t, entries, runtimeById);
  assert.equal(runtimes.get('one'), one.prepared);
  assert.equal(runtimes.get('again'), one.prepared);
  assert.equal(runtimes.get('parent'), retyped);
  assert.notEqual(runtimes.get('one'), runtimes.get('parent'));
  assert.equal(runtimes.has('js'), false);
  assert.equal(descriptors.get('one'), one.descriptor);
  assert.deepEqual(one.prepared.files, before);
  assert.equal(typeof store.pluginPipeline, 'function');
});

test('same descriptor mapped to two runtimes rejects before backend side effects', async (t) => {
  const root = temp(t);
  const one = makeRuntime(root, 'Ambiguous');
  const other = makeRuntime(root, 'Other');
  const entries = [step('a', one.descriptor.typeName), step('b', one.descriptor.typeName)];
  const store = new DataStore({ state: emptyState() });
  await assert.rejects(
    attachClrSteps(t, {
      store,
      steps: entries,
      runtime: (entry) => (entry.id === 'a' ? one.prepared : { ...other.prepared, descriptor: one.descriptor }),
    }),
    /one descriptor object cannot identify different prepared runtime objects/,
  );
  assert.equal(store.scheduler, undefined);
  assert.equal(store.pluginPipeline, undefined);
});

test('malformed snapshots and unsafe source or cache paths reject before backend setup', async (t) => {
  const root = temp(t);
  const base = makeRuntime(root, 'Unsafe', { dependencies: ['deps/Actual.dll'] });
  write(path.join(base.source, 'deps/Expected.dll'));
  write(path.join(base.descriptor.sdkRoot, 'Other.Sdk.dll'));
  const otherCache = path.join(root, 'other-cache');
  fs.mkdirSync(otherCache);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  write(path.join(outside, 'Plugin.dll'));
  write(path.join(outside, 'Helper.dll'));
  fs.symlinkSync(outside, path.join(base.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const cases = [
    ['host missing', (runtime) => ({ ...runtime, files: runtime.files.slice(0, -1) }), base.descriptor],
    [
      'host extra',
      (runtime) => ({ ...runtime, files: [...runtime.files, { path: runtime.executable, sha256: 'extra' }] }),
      base.descriptor,
    ],
    [
      'host mismatch',
      (runtime) => ({ ...runtime, executable: path.join(runtime.directory, 'other.exe') }),
      base.descriptor,
    ],
    [
      'runtime assembly missing',
      (runtime) => {
        const { assembly, ...rest } = runtime;
        return rest;
      },
      base.descriptor,
    ],
    ['runtime assembly mismatch', (runtime) => ({ ...runtime, assembly: runtime.executable }), base.descriptor],
    [
      'wrong SDK source',
      (runtime) => runtime,
      { ...base.descriptor, sdkAssembly: 'Other.Sdk.dll' },
      /declared SDK source does not match captured file 1/,
    ],
    [
      'dependency source mismatch',
      (runtime) => runtime,
      { ...base.descriptor, dependencies: ['deps/Expected.dll'] },
      /declared dependency does not match the captured dependency sources/,
    ],
    [
      'cache/runtime parent mismatch',
      (runtime) => runtime,
      { ...base.descriptor, cacheRoot: otherCache },
      /declared cache root must be the physical parent/,
    ],
    ['assembly symlink escape', (runtime) => runtime, { ...base.descriptor, assembly: 'linked/Plugin.dll' }],
    ['dependency symlink escape', (runtime) => runtime, { ...base.descriptor, dependencies: ['linked/Helper.dll'] }],
    [
      'captured source symlink',
      (runtime) => ({
        ...runtime,
        files: runtime.files.map((file, index) =>
          index === 0 ? { ...file, sourcePath: path.join(base.source, 'linked', 'Plugin.dll') } : file,
        ),
      }),
      base.descriptor,
    ],
    ['cache alias', (runtime) => runtime, { ...base.descriptor, cacheRoot: alias(base.descriptor.cacheRoot, 'cache') }],
  ];
  for (const [label, mutateRuntime, descriptor, expectedError = /Invalid prepared CLR fixture mapping/] of cases) {
    const runtime = { ...mutateRuntime(base.prepared), descriptor };
    const store = new DataStore({ state: emptyState() });
    await assert.rejects(
      async () => attachClrSteps(t, { store, steps: [step('case', descriptor.typeName)], runtime: () => runtime }),
      expectedError,
      label,
    );
    assert.equal(store.scheduler, undefined, `${label}: scheduler remains untouched`);
    assert.equal(store.pluginPipeline, undefined, `${label}: pipeline remains untouched`);
  }
});

test('declared SDK proxy dependency is accepted without implicit duplicate inference', (t) => {
  const root = temp(t);
  const selected = makeRuntime(root, 'DeclaredProxy', { dependencies: ['Microsoft.Crm.Sdk.Proxy.dll'] });
  assert.equal(
    createPreparedClrRuntimePreparer(
      new Map([['step', selected.prepared]]),
      new Map([['step', selected.descriptor]]),
    )(selected.descriptor),
    selected.prepared,
  );
});

test('custom preparer remains authoritative for an unmapped step and exact descriptor lookup rejects clones', async (t) => {
  const root = temp(t);
  const selected = makeRuntime(root, 'Custom');
  const calls = [],
    runtimes = new Map(),
    descriptors = new Map([['custom', selected.descriptor]]),
    diagnostics = [];
  const items = pluginCatalogue({
    plugins: { steps: [step('custom', selected.descriptor.typeName)] },
    runtimes,
    descriptors,
    overrides: { 'plugin-step:custom': { mode: 'clr' } },
  });
  const backend = await createOrganizationBackend({
    store: new DataStore({ state: emptyState() }),
    items: () => items,
    runtimes,
    descriptors,
    diagnostic: (item) => diagnostics.push(item),
    prepareRuntime: (descriptor) => {
      calls.push(descriptor);
      return selected.prepared;
    },
  });
  ownedFixture(t).add(() => backend.close());
  assert.deepEqual(diagnostics, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], selected.descriptor);
  assert.equal(runtimes.get('custom'), selected.prepared);
  const exact = createPreparedClrRuntimePreparer(
    new Map([['step', selected.prepared]]),
    new Map([['step', selected.descriptor]]),
  );
  assert.equal(exact(selected.descriptor), selected.prepared);
  assert.throws(() => exact({ ...selected.descriptor }), /unknown descriptor object/);
});
