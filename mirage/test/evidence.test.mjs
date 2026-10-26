import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  stateFingerprint,
  observedEvidence,
  sourceFingerprint,
  cachedSourceFingerprint,
  implementationSourceFingerprint,
  cachedImplementationSourceFingerprint,
  implementationEvidence,
} from '../lib/evidence.mjs';

test('implementation hashes ignore only generated SDK directories and retain authored and mapped assemblies', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-sdk-fingerprint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = [
    'test-sdk/Gate/obj/apphost.exe',
    'test-sdk/Gate/bin/Gate.dll',
    'test-sdk/Gate/Program.cs',
    'plugins/bin/Plugin.dll',
    'obj/runtime.mjs',
    'lib/handler.mjs',
  ];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), 'first');
  }
  let implementation = await implementationSourceFingerprint(root);
  let source = await sourceFingerprint(root);
  assert.equal(await cachedImplementationSourceFingerprint(root), implementation);
  assert.equal(await cachedSourceFingerprint(root), source);
  for (const file of files) {
    await fs.writeFile(path.join(root, file), 'second');
    const next = await cachedImplementationSourceFingerprint(root);
    assert.equal(next, await implementationSourceFingerprint(root));
    if (file.startsWith('test-sdk/') && /\/(bin|obj)\//.test(file)) assert.equal(next, implementation, file);
    else assert.notEqual(next, implementation, file);
    const nextSource = await cachedSourceFingerprint(root);
    assert.notEqual(nextSource, source, `generic export hash must retain ${file}`);
    assert.equal(nextSource, await sourceFingerprint(root));
    implementation = next;
    source = nextSource;
  }
  await fs.rm(path.join(root, 'test-sdk/Gate/obj'), { recursive: true });
  assert.equal(
    await cachedImplementationSourceFingerprint(root),
    implementation,
    'generated directory removal is irrelevant',
  );
  await fs.writeFile(path.join(root, 'test-sdk/Gate/New.cs'), 'authored');
  assert.notEqual(
    await cachedImplementationSourceFingerprint(root),
    implementation,
    'new SDK source invalidates evidence',
  );
});

test('cached fingerprints tolerate files and directories removed at their read gates without hiding other errors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-fingerprint-removal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalStat = fs.stat,
    originalReaddir = fs.readdir;
  t.after(() => {
    fs.stat = originalStat;
    fs.readdir = originalReaddir;
  });
  for (const fingerprint of [cachedSourceFingerprint, cachedImplementationSourceFingerprint]) {
    const file = path.join(root, 'gone.mjs');
    await fs.writeFile(file, 'owned source');
    fs.stat = async function (name, ...args) {
      if (name === file) {
        await fs.unlink(file);
        fs.stat = originalStat;
      }
      return Reflect.apply(originalStat, this, [name, ...args]);
    };
    assert.equal(
      await fingerprint(root),
      await sourceFingerprint(root),
      'a file removed after directory discovery is absent from both hashes',
    );
    const directory = path.join(root, 'gone');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'source.mjs'), 'owned source');
    fs.readdir = async function (name, ...args) {
      if (name === directory) {
        await fs.rm(directory, { recursive: true });
        fs.readdir = originalReaddir;
      }
      return Reflect.apply(originalReaddir, this, [name, ...args]);
    };
    assert.equal(
      await fingerprint(root),
      await sourceFingerprint(root),
      'a directory removed before traversal is absent from both hashes',
    );
  }
  fs.readdir = async function (name, ...args) {
    if (name === root) throw Object.assign(Error('Access denied'), { code: 'EACCES' });
    return Reflect.apply(originalReaddir, this, [name, ...args]);
  };
  await assert.rejects(cachedSourceFingerprint(root), { code: 'EACCES' });
});

test(
  'fresh startup seeds the complete implementation fingerprint cache and state reads still detect source edits',
  { timeout: 60000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-fingerprint-startup-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const toolkit = fileURLToPath(new URL('../../', import.meta.url));
    const runtime = path.join(directory, 'mirage');
    await fs.mkdir(runtime);
    const target = path.join(runtime, 'server.mjs');
    await fs.copyFile(path.join(toolkit, 'mirage/server.mjs'), target);
    await fs.copyFile(path.join(toolkit, 'package.json'), path.join(directory, 'package.json'));
    for (const entry of await fs.readdir(path.join(toolkit, 'mirage'), { withFileTypes: true })) {
      if (entry.name === 'server.mjs' || entry.name === '.paqvilo') continue;
      if (entry.isDirectory())
        await fs.symlink(
          path.join(toolkit, 'mirage', entry.name),
          path.join(runtime, entry.name),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      else if (entry.isFile())
        await fs.copyFile(path.join(toolkit, 'mirage', entry.name), path.join(runtime, entry.name));
    }
    for (const [link, actual] of [
      [path.join(directory, 'lense'), path.join(toolkit, 'lense')],
      [path.join(directory, 'node_modules'), path.join(toolkit, 'node_modules')],
    ])
      await fs.symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
    const source = path.join(directory, 'portal');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'website.yml'), 'adx_websiteid: fixture\nadx_name: Fingerprint fixture');
    const program = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {pathToFileURL} from 'node:url';
    const target=process.env.PAQ_TEST_SERVER_FILE;
    const read=fs.readFile; let reads=0;
    fs.readFile=async function(file,...args){if(typeof file==='string'&&path.resolve(file)===target)reads++;return Reflect.apply(read,this,[file,...args]);};
    const {createSimulator}=await import(pathToFileURL(target));
    const atImport=reads;
    const simulator=await createSimulator({sourceDir:process.env.PAQ_TEST_PORTAL,stateFile:process.env.PAQ_TEST_STATE,port:0,watch:false,dataverse:{enabled:false}});
    try {
      const state=async()=>{const response=await fetch(simulator.url+'/__sim/api/state?summary=1');if(!response.ok)throw Error('State '+response.status);return response.json();};
      const first=await state(),afterFirst=reads;
      const second=await state(),afterSecond=reads;
      await fs.appendFile(target,'\\n// owned source change\\n');
      const changed=await state();
      console.log(JSON.stringify({atImport,afterFirst,afterSecond,afterChange:reads,first:first.status,second:second.status,changed:changed.status}));
    } finally {await simulator.close();}
  `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      cwd: directory,
      env: {
        ...process.env,
        PAQ_TEST_SERVER_FILE: target,
        PAQ_TEST_PORTAL: source,
        PAQ_TEST_STATE: path.join(directory, 'state.json'),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, errors);
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.ok(result.atImport >= 1);
    assert.equal(
      result.afterFirst,
      result.atImport,
      'the first state read must not hash unchanged implementation bytes again',
    );
    assert.equal(result.afterSecond, result.atImport, 'warm state reads retain the same complete fingerprint');
    assert.equal(result.afterChange, result.atImport + 1, 'an authored source edit invalidates the cached bytes');
    assert.equal(result.first.implementationChanged, false);
    assert.equal(result.second.implementationChanged, false);
    assert.equal(result.changed.implementationChanged, true);
    assert.equal(result.changed.loadedImplementationFingerprint, result.first.loadedImplementationFingerprint);
    assert.notEqual(result.changed.implementationFingerprint, result.first.implementationFingerprint);
  },
);

test('fresh Mirage startup tolerates an exclusively locked SDK build product', { timeout: 60000 }, async (t) => {
  const sdkRoot = fileURLToPath(new URL('../test-sdk/', import.meta.url));
  const owned = await fs.mkdtemp(path.join(sdkRoot, 'fingerprint-lock-'));
  const generated = path.join(owned, 'obj', 'apphost.exe');
  await fs.mkdir(path.dirname(generated));
  await fs.writeFile(generated, 'owned SDK build product');
  let locker;
  t.after(async () => {
    if (locker && locker.exitCode === null) {
      const exited = once(locker, 'exit');
      locker.kill();
      await exited;
    }
    await fs.rm(owned, { recursive: true, force: true });
  });
  if (process.platform === 'win32') {
    locker = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$f=[System.IO.File]::Open($env:PAQVILO_TEST_LOCK,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try { [Console]::WriteLine("LOCKED"); [Console]::In.ReadLine() | Out-Null } finally { $f.Dispose() }',
      ],
      { env: { ...process.env, PAQVILO_TEST_LOCK: generated }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const [ready] = await once(locker.stdout, 'data');
    assert.match(ready.toString(), /LOCKED/);
    await assert.rejects(sourceFingerprint(fileURLToPath(new URL('../', import.meta.url))), { code: 'EBUSY' });
  }
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)}); console.log("MIRAGE_IMPORTED")`,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (value) => {
    stdout += value;
  });
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.match(stdout, /MIRAGE_IMPORTED/);
});

test('cached implementation fingerprints match full hashes and follow same-size edits, additions and removals', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-cached-fingerprint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'admin'));
  await fs.writeFile(path.join(root, 'admin', 'app.mjs'), 'export const version = 1;');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'ignored');
  const first = await cachedSourceFingerprint(root);
  assert.equal(first, await sourceFingerprint(root));
  assert.equal(await cachedSourceFingerprint(root), first, 'unchanged files reuse the digest');
  // Back-to-back same-size writes usually share one file-time tick (Linux coarse clocks): each must still be seen.
  let edited = first;
  for (const version of [2, 3, 4, 5]) {
    await fs.writeFile(path.join(root, 'admin', 'app.mjs'), `export const version = ${version};`);
    const next = await cachedSourceFingerprint(root);
    assert.notEqual(next, edited, `a same-size edit to version ${version} invalidates the cached digest`);
    assert.equal(next, await sourceFingerprint(root));
    edited = next;
  }
  await fs.writeFile(path.join(root, 'admin', 'style.css'), 'body{}');
  const added = await cachedSourceFingerprint(root);
  assert.notEqual(added, edited);
  assert.equal(added, await sourceFingerprint(root));
  await fs.rm(path.join(root, 'admin', 'style.css'));
  assert.equal(await cachedSourceFingerprint(root), edited);
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'still ignored');
  assert.equal(await cachedSourceFingerprint(root), edited, 'excluded folders stay excluded');
});

test('a file removed during the walk is left out and another read failure rejects the hash', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-fingerprint-reads-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // More files than reads run at a time, so a failure arrives while later reads are still in flight.
  for (let n = 0; n < 80; n++) await fs.writeFile(path.join(root, `file-${String(n).padStart(2, '0')}.txt`), `${n}`);
  const removed = path.join(root, 'file-07.txt');
  await fs.rm(removed);
  const withoutRemoved = await sourceFingerprint(root);
  await fs.writeFile(removed, '7');
  const read = fs.readFile;
  const failing = (files, code) =>
    t.mock.method(fs, 'readFile', (target, ...rest) =>
      files.includes(target) ? Promise.reject(Object.assign(new Error(code), { code })) : read(target, ...rest),
    );
  failing([removed], 'ENOENT');
  assert.equal(await sourceFingerprint(root), withoutRemoved, 'a file gone before its read is not hashed');
  t.mock.restoreAll();
  // The second failure is still in flight when the first rejects the hash: it must not surface as an unhandled rejection.
  failing([path.join(root, 'file-03.txt'), path.join(root, 'file-05.txt')], 'EBUSY');
  await assert.rejects(sourceFingerprint(root), { code: 'EBUSY' });
});

test('cached implementation fingerprints skip a file removed while the signature walk runs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-cached-removal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'kept.mjs'), 'export const kept = true;');
  const removed = path.join(root, 'removed.mjs');
  await fs.writeFile(removed, 'export const removed = true;');
  // Another process (a test cleaning up its fixture) removes the file between the listing and its stat.
  const stat = fs.stat;
  t.mock.method(fs, 'stat', async (file, ...rest) => {
    if (file === removed) await fs.rm(removed);
    return stat.call(fs, file, ...rest);
  });
  const digest = await cachedImplementationSourceFingerprint(root);
  t.mock.restoreAll();
  assert.equal(digest, await implementationSourceFingerprint(root));
});

test('an on-demand browser asset edit invalidates evidence from still-loaded modules', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-implementation-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'browser.js'), 'window.localVersion = 1;');
  const loaded = await sourceFingerprint(root);
  const state = {
    config: {},
    data: {},
    status: {
      ...implementationEvidence(loaded, loaded),
      sourceFingerprint: 'portal',
      localOrigin: 'http://127.0.0.1:1',
    },
  };
  const report = {
    passed: true,
    verified: true,
    localOrigin: state.status.localOrigin,
    simulator: {
      stateSha256: stateFingerprint(state),
      sourceFingerprint: 'portal',
      implementationFingerprint: state.status.implementationFingerprint,
    },
  };
  assert.equal(observedEvidence(report, state).passed, true);
  await fs.writeFile(path.join(root, 'browser.js'), 'window.localVersion = 2;');
  Object.assign(state.status, implementationEvidence(loaded, await sourceFingerprint(root)));
  assert.equal(state.status.loadedImplementationFingerprint, loaded);
  assert.equal(state.status.implementationChanged, true);
  assert.equal(observedEvidence(report, state).passed, false);
});
test('observed parity becomes stale after identity, data, source or origin changes', () => {
  const state = {
    config: { identity: { id: 'one' } },
    data: { contact: [] },
    status: {
      sourceFingerprint: 'source',
      implementationFingerprint: 'runtime',
      localOrigin: 'http://127.0.0.1:1',
    },
  };
  const report = {
    passed: true,
    verified: true,
    localOrigin: state.status.localOrigin,
    simulator: {
      stateSha256: stateFingerprint(state),
      sourceFingerprint: 'source',
      implementationFingerprint: 'runtime',
    },
  };
  assert.equal(observedEvidence(report, state).passed, true);
  for (const mutate of [
    (s) => (s.config.identity.id = 'two'),
    (s) => s.data.contact.push({ id: 'new' }),
    (s) => (s.status.sourceFingerprint = 'changed'),
    (s) => (s.status.implementationFingerprint = 'changed'),
    (s) => delete s.status.implementationFingerprint,
    (s) => (s.status.localOrigin = 'http://127.0.0.1:2'),
  ]) {
    const changed = structuredClone(state);
    mutate(changed);
    const result = observedEvidence(report, changed);
    assert.equal(result.passed, false);
    assert.equal(result.verified, false);
    assert.equal(result.stale, true);
    assert.equal(result.originalPassed, true);
  }
});
