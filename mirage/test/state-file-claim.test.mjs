// @test-kind contract: one runtime holds a state file while it runs; a second runtime on that file is refused by name, and a holder that ended holds nothing
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSimulator } from '../api.mjs';
import { claimStateFile, stateFileEndpoint } from '../lib/state-file-claim.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CLAIM = pathToFileURL(fileURLToPath(new URL('../lib/state-file-claim.mjs', import.meta.url))).href;

async function folder(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-state-claim-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a second claim on a held state file is refused with the holder, and succeeds after the release', async (t) => {
  const stateFile = path.join(await folder(t), 'state.json');
  const first = await claimStateFile(stateFile);
  ownedFixture(t).add(() => first.release());
  first.describe({ url: 'http://127.0.0.1:4100' });
  await assert.rejects(claimStateFile(stateFile), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'StateFileInUse');
    assert.deepEqual(error.holder, { pid: process.pid, url: 'http://127.0.0.1:4100' });
    assert.equal(
      error.message,
      `The state file ${stateFile} is in use by another Mirage runtime (pid ${process.pid}, http://127.0.0.1:4100). Two runtimes cannot write one state file: each would overwrite the other's saves. Stop that runtime, or start this one with --state <other file>.`,
    );
    return true;
  });
  await first.release();
  const second = await claimStateFile(stateFile);
  await second.release();
});

test('every spelling of one state file is the same claim, and another file is another claim', async (t) => {
  const dir = await folder(t);
  const stateFile = path.join(dir, 'state.json');
  const viaDots = path.join(dir, 'sub', '..', 'state.json');
  assert.equal(await stateFileEndpoint(viaDots), await stateFileEndpoint(stateFile));
  assert.notEqual(await stateFileEndpoint(path.join(dir, 'other.json')), await stateFileEndpoint(stateFile));
  // Windows names are not case sensitive: the claim is not either. Elsewhere two cases are two files.
  assert.equal(
    await stateFileEndpoint(stateFile.toUpperCase(), { platform: 'win32' }),
    await stateFileEndpoint(stateFile.toLowerCase(), { platform: 'win32' }),
  );
  const held = await claimStateFile(stateFile);
  ownedFixture(t).add(() => held.release());
  await assert.rejects(claimStateFile(viaDots), { code: 'StateFileInUse' });
  const other = await claimStateFile(path.join(dir, 'other.json'));
  await other.release();
});

test('a temporary folder too long for a Unix socket path falls back to /tmp, and the claim still holds', async (t) => {
  const stateFile = path.join(await folder(t), 'state.json');
  // sun_path holds 104 bytes on macOS (108 on Linux); macOS's own temporary folder leaves only three to spare.
  const long = '/' + 'x'.repeat(60);
  for (const [platform, limit] of [
    ['darwin', 103],
    ['linux', 107],
  ]) {
    const fallback = await stateFileEndpoint(stateFile, { platform, tmpdir: long });
    assert.match(fallback, /^\/tmp\/paqvilo-state-[0-9a-f]{32}\.sock$/, platform);
    const fits = '/' + 'y'.repeat(limit - fallback.length + '/tmp'.length - 1);
    const kept = await stateFileEndpoint(stateFile, { platform, tmpdir: fits });
    assert.equal(kept.length, limit, `${platform}: a path of exactly the limit is kept`);
    assert.equal(path.dirname(kept), fits);
    assert.equal(path.basename(kept), path.basename(fallback), 'the same file names the same socket');
  }
  if (process.platform === 'win32') return;
  // Two runtimes whose (different) temporary folders are both too long meet at the same socket in /tmp.
  const base = os.tmpdir();
  const tmpdir = t.mock.method(os, 'tmpdir', () => path.join(base, 'z'.repeat(120)));
  const held = await claimStateFile(stateFile);
  ownedFixture(t).add(() => held.release());
  tmpdir.mock.restore();
  t.mock.method(os, 'tmpdir', () => path.join(base, 'w'.repeat(120)));
  await assert.rejects(claimStateFile(stateFile), { code: 'StateFileInUse' });
});

test('a holder that was killed holds nothing: the next claim succeeds without any clean-up', async (t) => {
  const stateFile = path.join(await folder(t), 'state.json');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { claimStateFile } from ${JSON.stringify(CLAIM)};
       const claim = await claimStateFile(process.argv[1]);
       claim.describe({ url: 'http://127.0.0.1:4200' });
       console.log('held');
       setInterval(() => {}, 1000);`,
      stateFile,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  await assert.rejects(claimStateFile(stateFile), (error) => {
    assert.deepEqual(error.holder, { pid: child.pid, url: 'http://127.0.0.1:4200' });
    return true;
  });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const claim = await claimStateFile(stateFile);
  await claim.release();
});

async function portal(t) {
  const root = await folder(t);
  const files = {
    'website.yml': 'adx_websiteid: invented\nadx_name: State claim',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<!doctype html><html><body><h1>Invented</h1></body></html>',
  };
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(root, file), body);
  return root;
}

test('a second runtime on the state file of a running one refuses to start and names it; after the first closes it starts', async (t) => {
  const root = await portal(t);
  const stateFile = path.join(root, 'state.json');
  const first = await createSimulator({ sourceDir: root, stateFile, watch: false });
  ownedFixture(t).add(() => first.close());
  await assert.rejects(createSimulator({ sourceDir: root, stateFile, watch: false }), (error) => {
    assert.equal(error.code, 'StateFileInUse');
    assert.ok(error.message.includes(`(pid ${process.pid}, ${first.url})`), error.message);
    return true;
  });
  assert.equal((await fetch(first.url)).status, 200, 'the running runtime is not disturbed');
  await first.close();
  const second = await createSimulator({ sourceDir: root, stateFile, watch: false });
  ownedFixture(t).add(() => second.close());
  assert.equal((await fetch(second.url)).status, 200);
});

test('a runtime that fails to start releases its state file', async (t) => {
  const root = await portal(t);
  const stateFile = path.join(root, 'state.json');
  await fs.writeFile(stateFile, '{"truncated":');
  await assert.rejects(createSimulator({ sourceDir: root, stateFile, watch: false }), /cannot be read/);
  await fs.rm(stateFile);
  const started = await createSimulator({ sourceDir: root, stateFile, watch: false });
  ownedFixture(t).add(() => started.close());
  assert.equal((await fetch(started.url)).status, 200);
});

test('dry-run runtimes keep their state in memory and do not claim the file', async (t) => {
  const root = await portal(t);
  const stateFile = path.join(root, 'state.json');
  const options = { sourceDir: root, stateFile, watch: false, simulation: { level: 'dry-run' } };
  const first = await createSimulator(options);
  ownedFixture(t).add(() => first.close());
  const second = await createSimulator(options);
  ownedFixture(t).add(() => second.close());
  assert.equal((await fetch(second.url)).status, 200);
});
