// @test-kind contract: Paqvilo's own compile cache: one published artefact per input set, whichever build finishes first
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync as writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileCached, compileCacheKey } from '../lib/compile-cache.mjs';
import { buildClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function workspace(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-compile-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const folder = async (name) => {
    await fs.mkdir(path.join(root, name), { recursive: true });
    return path.join(root, name);
  };
  return { root, folder, cache: path.join(root, 'cache') };
}
const entries = async (cache) => (await fs.readdir(cache)).sort((left, right) => left.localeCompare(right));

test('two builds of the same inputs that overlap publish one artefact and both callers get it', async (t) => {
  const { folder, cache } = await workspace(t);
  const key = compileCacheKey(['invented', 'source']),
    first = await folder('first'),
    second = await folder('second');
  let starts = 0,
    overlapped;
  // The second build starts and finishes while the first compiler is still running: the first then finds the entry taken.
  const build = (bytes, during) => (scratch) => {
    starts++;
    during?.();
    writeSync(path.join(scratch, 'Out.dll'), bytes);
    return { built: bytes };
  };
  const outer = compileCached({
    root: cache,
    key,
    files: ['Out.dll'],
    into: first,
    build: build('slow build', () => {
      overlapped = compileCached({ root: cache, key, files: ['Out.dll'], into: second, build: build('fast build') });
    }),
  });
  assert.equal(starts, 2, 'both overlapping callers started their compiler');
  assert.deepEqual(overlapped, { meta: { built: 'fast build' }, hit: false });
  assert.deepEqual(outer, { meta: { built: 'fast build' }, hit: true }, 'the later finisher takes the published entry');
  assert.deepEqual(await entries(cache), [key], 'one entry and no private build folder remain');
  assert.equal(await fs.readFile(path.join(first, 'Out.dll'), 'utf8'), 'fast build');
  assert.equal(await fs.readFile(path.join(second, 'Out.dll'), 'utf8'), 'fast build');

  const third = await folder('third');
  const again = compileCached({ root: cache, key, files: ['Out.dll'], into: third, build: build('never') });
  assert.deepEqual(again, { meta: { built: 'fast build' }, hit: true });
  assert.equal(starts, 2, 'a published entry starts no compiler');
  assert.equal(await fs.readFile(path.join(third, 'Out.dll'), 'utf8'), 'fast build');
});

test('a failed build publishes nothing, leaves no private folder and is compiled again', async (t) => {
  const { folder, cache } = await workspace(t);
  const key = compileCacheKey(['invented', 'failing']),
    into = await folder('out');
  let starts = 0;
  const failing = (scratch) => {
    starts++;
    writeSync(path.join(scratch, 'Out.dll'), 'partial');
    throw new Error('invented compiler error');
  };
  for (let attempt = 0; attempt < 2; attempt++)
    assert.throws(
      () => compileCached({ root: cache, key, files: ['Out.dll'], into, build: failing }),
      /invented compiler error/,
    );
  assert.equal(starts, 2);
  assert.deepEqual(await entries(cache), []);
  assert.deepEqual(await fs.readdir(into), [], 'no partial output reaches the caller');
});

test('without a usable cache folder the build runs straight into the caller folder', async (t) => {
  const { root, folder } = await workspace(t);
  const into = await folder('out'),
    blocked = path.join(root, 'not-a-folder');
  await fs.writeFile(blocked, 'a file where the cache folder would be');
  const build = (scratch) => writeSync(path.join(scratch, 'Out.dll'), 'direct');
  for (const cache of [blocked, false]) {
    assert.deepEqual(compileCached({ root: cache, key: 'k', files: ['Out.dll'], into, build }), {
      meta: undefined,
      hit: false,
    });
    assert.equal(await fs.readFile(path.join(into, 'Out.dll'), 'utf8'), 'direct');
  }
});

test('cache keys separate their parts', () => {
  assert.notEqual(compileCacheKey(['ab', 'c']), compileCacheKey(['a', 'bc']));
  assert.notEqual(compileCacheKey(['a', '']), compileCacheKey(['a']));
  assert.equal(compileCacheKey(['a', Buffer.from('b')]), compileCacheKey(['a', 'b']));
});

// A compiler start that writes the /out: file it was asked for and reports success.
function countingCompiler() {
  const calls = [];
  const run = (file, args) => {
    calls.push(args);
    writeSync(args.find((argument) => argument.startsWith('/out:')).slice(5), 'compiled ' + calls.length);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('a C# fixture is compiled once per source, output name, target and reference content', async (t) => {
  const { root, folder, cache } = await workspace(t);
  const source = path.join(root, 'Invented.cs'),
    reference = path.join(root, 'Reference.dll'),
    out = await folder('out'),
    other = await folder('other');
  await fs.writeFile(source, 'class Invented {}');
  await fs.writeFile(reference, 'reference one');
  const compiler = countingCompiler(),
    options = { references: [reference, 'System.Core.dll'], run: compiler.run, cache };
  compileClr(source, path.join(out, 'Invented.dll'), options);
  compileClr(source, path.join(other, 'Invented.dll'), options);
  assert.equal(compiler.calls.length, 1, 'the same inputs in another folder start no compiler');
  assert.equal(await fs.readFile(path.join(other, 'Invented.dll'), 'utf8'), 'compiled 1');
  compileClr(source, path.join(out, 'Renamed.dll'), options);
  assert.equal(compiler.calls.length, 2, 'the output name is the assembly identity');
  compileClr(source, path.join(out, 'Invented.dll'), { ...options, target: 'exe' });
  assert.equal(compiler.calls.length, 3);
  await fs.writeFile(reference, 'reference two');
  compileClr(source, path.join(out, 'Invented.dll'), options);
  assert.equal(compiler.calls.length, 4, 'changed reference bytes compile again');
  await fs.writeFile(source, 'class Invented { int changed; }');
  compileClr(source, path.join(out, 'Invented.dll'), options);
  assert.equal(compiler.calls.length, 5, 'changed source compiles again');
  assert.equal(await fs.readFile(path.join(out, 'Invented.dll'), 'utf8'), 'compiled 5');
  // A strong-name key is generated per run, so a build with one starts the compiler every time and caches nothing.
  const cached = await entries(cache),
    keyed = { ...options, keyFile: path.join(root, 'Invented.snk') };
  await fs.writeFile(keyed.keyFile, 'key bytes');
  compileClr(source, path.join(out, 'Invented.dll'), keyed);
  compileClr(source, path.join(out, 'Invented.dll'), keyed);
  assert.equal(compiler.calls.length, 7, 'two builds with the same strong-name key start the compiler twice');
  assert.deepEqual(await entries(cache), cached, 'and publish no cache entry');
});

test(
  'overlapping preparations of one assembly compile the plug-in host into one cached artefact and both succeed',
  { skip: CLR_SKIP },
  async (t) => {
    const { root, cache } = await workspace(t);
    const sdk = clrSdk(),
      assemblyFile = path.join(root, 'Noop.dll');
    await fs.writeFile(path.join(root, 'Noop.cs'), 'class Noop {}');
    compileClr(path.join(root, 'Noop.cs'), assemblyFile, { cache });
    const fixtureEntries = await entries(cache);
    const user = '10000000-0000-4000-8000-000000000001';
    const descriptor = {
      trust: 'execute-local-assembly',
      root,
      assembly: 'Noop.dll',
      typeName: 'Noop',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'runtimes'),
      serviceProfile: { userId: user, evidence: 'Invented grants', grants: [] },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    };
    const files = {
      assembly: { bytes: await fs.readFile(assemblyFile), path: assemblyFile },
      sdk: { bytes: await fs.readFile(sdk), path: sdk },
    };
    const compiler = countingCompiler();
    let nested;
    // The second preparation runs to completion while the first one's compiler is still running.
    const run = (file, args, options) => {
      if (!compiler.calls.length) {
        compiler.calls.push(args);
        nested = buildClrRuntime(descriptor, files, { run: compiler.run, compileCache: cache });
        writeSync(args.find((argument) => argument.startsWith('/out:')).slice(5), 'compiled late');
        return { status: 0, stdout: '', stderr: '' };
      }
      return compiler.run(file, args, options);
    };
    const first = buildClrRuntime(descriptor, files, { run, compileCache: cache });
    assert.equal(compiler.calls.length, 2, 'each overlapping preparation started the compiler once');
    const hostEntries = (await entries(cache)).filter((name) => !fixtureEntries.includes(name));
    assert.equal(hostEntries.length, 1, 'one host artefact is published and no private build folder remains');
    assert.notEqual(first.directory, nested.directory, 'each preparation owns its runtime directory');
    for (const runtime of [first, nested])
      assert.equal(await fs.readFile(runtime.executable, 'utf8'), 'compiled 2', 'both run the published host');
    const third = buildClrRuntime(descriptor, files, { run: compiler.run, compileCache: cache });
    assert.equal(compiler.calls.length, 2, 'a later preparation of the same host starts no compiler');
    assert.equal(third.provenance.contextInterfaceVersion, first.provenance.contextInterfaceVersion);
    assert.equal(await fs.readFile(third.executable, 'utf8'), 'compiled 2');
  },
);
