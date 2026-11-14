import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preserveNavigationEvidence } from './navigation-evidence-fixture.mjs';
import { collectSyntheticEvidence } from '../../scripts/collect-evidence.mjs';
import { makeTemporaryDirectory, ownedFixture, assertTemporaryDirectory } from '../testing/owned-fixture.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a40cAAAAASUVORK5CYII=',
  'base64',
);
const secret = 'invented-private-value-that-must-not-be-published';

async function fixture(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-document-commit-'));
  const toolkitRoot = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-evidence-toolkit-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  ownedFixture(t).remove(() => fs.rm(toolkitRoot, { recursive: true, force: true }));
  const evidence = path.join(root, 'evidence');
  await fs.mkdir(evidence);
  const screenshot = path.join(evidence, '1-Document-boundary-failure.png');
  await fs.writeFile(screenshot, png);
  await fs.writeFile(
    path.join(evidence, '1-browser-network.json'),
    JSON.stringify({
      frameEvents: [
        {
          event: 'frameNavigated',
          frameId: 'abcdef01',
          loaderId: '12345678',
          headers: { authorization: secret },
          body: secret,
        },
      ],
    }),
  );
  const flow = {
    passed: false,
    error: 'locator.waitFor: ' + secret,
    screenshots: [screenshot],
    resources: [
      {
        method: 'GET',
        url: `http://localhost:1234/submit?token=${secret}`,
        status: 200,
        body: secret,
        headers: { authorization: secret },
      },
    ],
    steps: [{ action: 'visible', passed: false, value: secret }],
    pendingRequests: [{ method: 'POST', url: `https://private.invalid/${secret}`, body: secret }],
    raw: secret,
    initial: secret,
    final: secret,
  };
  return { root, toolkitRoot, evidence, screenshot, flow };
}

function inspectArtifactHandle(t, screenshot, inspect) {
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === screenshot) inspect(handle);
    return handle;
  });
}

function observedReads(t, handle, beforeRead = async () => {}) {
  const observed = { bytes: 0, calls: 0, unboundedCalls: 0 };
  const read = handle.read.bind(handle);
  const readFile = handle.readFile.bind(handle);
  t.mock.method(handle, 'read', async (...args) => {
    await beforeRead();
    const result = await read(...args);
    observed.calls++;
    observed.bytes += result.bytesRead;
    return result;
  });
  t.mock.method(handle, 'readFile', async (...args) => {
    await beforeRead();
    const result = await readFile(...args);
    observed.unboundedCalls++;
    observed.bytes += result.length;
    return result;
  });
  return observed;
}

test('navigation evidence refuses an ordinary source directory substituted before opening an artifact', async (t) => {
  const files = await fixture(t);
  const replacement = path.join(files.toolkitRoot, 'invented-replacement');
  await fs.mkdir(replacement);
  await fs.writeFile(
    path.join(replacement, path.basename(files.screenshot)),
    Buffer.concat([png, Buffer.from(secret)]),
  );
  const open = fs.open.bind(fs);
  let substituted = false;
  let reads;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === files.screenshot && !substituted) {
      substituted = true;
      await fs.rename(files.evidence, files.evidence + '-original');
      await fs.rename(replacement, files.evidence);
    }
    const handle = await open(file, ...args);
    if (file === files.screenshot) reads = observedReads(t, handle);
    return handle;
  });
  await assert.rejects(preserveNavigationEvidence(files.root, files.flow, files), /source directory changed/);
  assert.equal(substituted, true);
  assert.deepEqual(reads, { bytes: 0, calls: 0, unboundedCalls: 0 });
  assert.deepEqual(await fs.readFile(path.join(files.evidence + '-original', path.basename(files.screenshot))), png);
  assert.equal((await fs.readFile(files.screenshot)).includes(Buffer.from(secret)), true);
  await assert.rejects(fs.stat(path.join(files.toolkitRoot, '.paqvilo')), { code: 'ENOENT' });
});

test('navigation evidence refuses a publication directory substituted before its exclusive output open', async (t) => {
  const files = await fixture(t);
  const destination = path.join(files.toolkitRoot, '.paqvilo', 'synthetic-navigation');
  const outside = path.join(files.toolkitRoot, 'invented-outside');
  await fs.mkdir(outside);
  const sentinel = path.join(outside, 'sentinel.json');
  await fs.writeFile(sentinel, secret);
  const open = fs.open.bind(fs);
  const writeFile = fs.writeFile.bind(fs);
  let substituted = false;
  let written = 0;
  const substitute = async (file) => {
    if (path.dirname(file) === destination && !substituted) {
      substituted = true;
      await fs.rename(destination, destination + '-original');
      await fs.symlink(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');
    }
  };
  t.mock.method(fs, 'writeFile', async (file, bytes, ...args) => {
    await substitute(file);
    if (path.dirname(file) === destination) written += Buffer.byteLength(bytes);
    return writeFile(file, bytes, ...args);
  });
  t.mock.method(fs, 'open', async (file, ...args) => {
    await substitute(file);
    const handle = await open(file, ...args);
    if (path.dirname(file) === destination) {
      const writeFile = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async (bytes, ...options) => {
        written += Buffer.byteLength(bytes);
        return writeFile(bytes, ...options);
      });
    }
    return handle;
  });
  await assert.rejects(preserveNavigationEvidence(files.root, files.flow, files), /publication directory changed/);
  assert.equal(substituted, true);
  assert.equal(written, 0, 'no bytes may be written through a redirected publication directory');
  assert.deepEqual(await fs.readdir(outside), ['sentinel.json']);
  assert.equal(await fs.readFile(sentinel, 'utf8'), secret);
  assert.deepEqual(await fs.readdir(destination + '-original'), []);
});

test('navigation evidence refuses a publication leaf replaced during its descriptor write', async (t) => {
  const files = await fixture(t);
  const destination = path.join(files.toolkitRoot, '.paqvilo', 'synthetic-navigation');
  const open = fs.open.bind(fs);
  let substituted;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (path.dirname(file) === destination && !substituted) {
      const writeFile = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async (...writeArgs) => {
        substituted = file;
        await fs.rename(file, file + '-original');
        await fs.writeFile(file, secret);
        return writeFile(...writeArgs);
      });
    }
    return handle;
  });
  await assert.rejects(preserveNavigationEvidence(files.root, files.flow, files), /publication file changed/);
  assert.equal(typeof substituted, 'string');
  assert.equal(await fs.readFile(substituted, 'utf8'), secret, 'cleanup must preserve the injected foreign leaf');
  assert.equal(JSON.parse(await fs.readFile(substituted + '-original', 'utf8')).synthetic, true);
});

test('navigation evidence opens its candidate before a controlled pathname substitution and reads no replacement', async (t) => {
  const files = await fixture(t);
  const original = await fs.lstat(files.screenshot, { bigint: true });
  const replacement = path.join(files.toolkitRoot, 'private-replacement.png');
  await fs.writeFile(replacement, Buffer.concat([png, Buffer.from(secret)]));
  const lstat = fs.lstat.bind(fs);
  let substituted = false;
  let openedOriginal = false;
  let reads;
  inspectArtifactHandle(t, files.screenshot, (handle) => {
    const stat = handle.stat.bind(handle);
    t.mock.method(handle, 'stat', async (...args) => {
      const current = await stat(...args);
      openedOriginal = current.dev === original.dev && current.ino === original.ino;
      return current;
    });
    reads = observedReads(t, handle);
  });
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    const entry = await lstat(file, ...args);
    if (file === files.screenshot && !substituted) {
      substituted = true;
      await fs.rename(file, file + '.original');
      await fs.copyFile(replacement, file);
    }
    return entry;
  });
  await assert.rejects(preserveNavigationEvidence(files.root, files.flow, files), /changed while opening/);
  assert.equal(substituted, true);
  assert.equal(openedOriginal, true, 'the candidate descriptor must precede every pathname identity check');
  assert.deepEqual(reads, { bytes: 0, calls: 0, unboundedCalls: 0 });
  assert.equal((await fs.readFile(replacement)).includes(Buffer.from(secret)), true);
  await assert.rejects(fs.stat(path.join(files.toolkitRoot, '.paqvilo')), { code: 'ENOENT' });
});

test('navigation evidence bounds descriptor reads even when a source grows after metadata validation', async (t) => {
  const files = await fixture(t);
  const maximum = 2 * 1024 * 1024;
  let grown = false;
  let reads;
  inspectArtifactHandle(t, files.screenshot, (handle) => {
    reads = observedReads(t, handle, async () => {
      if (grown) return;
      grown = true;
      await fs.appendFile(files.screenshot, Buffer.alloc(maximum + 256));
    });
  });
  await assert.rejects(preserveNavigationEvidence(files.root, files.flow, files), /exceeds its bound/);
  assert.equal(grown, true);
  assert.equal(reads.unboundedCalls, 0, 'a descriptor readFile cannot impose a pre-read allocation bound');
  assert.ok(reads.bytes <= maximum + 1, 'only a bounded overflow sentinel may be read');
  await assert.rejects(fs.stat(path.join(files.toolkitRoot, '.paqvilo')), { code: 'ENOENT' });
});

test('navigation evidence refuses nonregular descriptor metadata before reading any bytes', async (t) => {
  const files = await fixture(t);
  let reads;
  inspectArtifactHandle(t, files.screenshot, (handle) => {
    const stat = handle.stat.bind(handle);
    t.mock.method(handle, 'stat', async (...args) => {
      const entry = await stat(...args);
      Object.defineProperty(entry, 'isFile', { value: () => false });
      return entry;
    });
    reads = observedReads(t, handle);
  });
  await assert.rejects(preserveNavigationEvidence(files.root, files.flow, files), /ordinary bounded file/);
  assert.deepEqual(reads, { bytes: 0, calls: 0, unboundedCalls: 0 });
});

test('navigation evidence distinguishes 64-bit descriptor and pathname identities without Number collisions', async (t) => {
  const files = await fixture(t);
  const openedInode = 9007199254740992n;
  const replacedInode = 9007199254740993n;
  assert.equal(Number(openedInode), Number(replacedInode), 'the controlled IDs collide as Numbers');
  let reads;
  inspectArtifactHandle(t, files.screenshot, (handle) => {
    const stat = handle.stat.bind(handle);
    t.mock.method(handle, 'stat', async (options) => {
      const entry = await stat(options);
      entry.dev = options?.bigint ? 77n : 77;
      entry.ino = options?.bigint ? openedInode : Number(openedInode);
      return entry;
    });
    reads = observedReads(t, handle);
  });
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async (file, options) => {
    const entry = await lstat(file, options);
    if (file === files.screenshot) {
      entry.dev = options?.bigint ? 77n : 77;
      entry.ino = options?.bigint ? replacedInode : Number(replacedInode);
    }
    return entry;
  });
  await assert.rejects(preserveNavigationEvidence(files.root, files.flow, files), /changed while opening/);
  assert.deepEqual(reads, { bytes: 0, calls: 0, unboundedCalls: 0 });
  await assert.rejects(fs.stat(path.join(files.toolkitRoot, '.paqvilo')), { code: 'ENOENT' });
});

test('invented navigation failure evidence survives fixture cleanup and reaches the synthetic collector', async (t) => {
  const files = await fixture(t);
  await fs.writeFile(path.join(files.evidence, 'discovery.json'), secret);
  const preserved = await preserveNavigationEvidence(files.root, files.flow, files);
  await fs.rm(await assertTemporaryDirectory(files.root), { recursive: true, force: true });
  const collected = collectSyntheticEvidence(path.join(files.toolkitRoot, '.paqvilo'));
  assert.deepEqual(collected.files.sort(), preserved.files.map((name) => `synthetic-navigation/${name}`).sort());
  const json = await fs.readFile(
    path.join(
      collected.output,
      collected.files.find((name) => name.endsWith('.json')),
    ),
    'utf8',
  );
  assert.ok(Buffer.byteLength(json) <= 64 * 1024);
  assert.equal(json.includes(secret), false);
  assert.equal(json.includes('authorization'), false);
  assert.equal(json.includes('discovery'), false);
  const diagnostic = JSON.parse(json);
  assert.equal(diagnostic.resources[0].url, 'http://localhost:1234/submit');
  assert.equal(diagnostic.pendingRequests[0].url, '<external>');
  assert.deepEqual(
    await fs.readFile(
      path.join(
        collected.output,
        collected.files.find((name) => name.endsWith('.png')),
      ),
    ),
    png,
  );
});

test('navigation evidence refuses foreign screenshot paths and linked or hard-linked source artifacts', async (t) => {
  const files = await fixture(t);
  const foreign = path.join(files.toolkitRoot, 'foreign.png');
  await fs.writeFile(foreign, png);
  await assert.rejects(
    preserveNavigationEvidence(files.root, { ...files.flow, screenshots: [foreign] }, files),
    /allowlist/,
  );
  await fs.rm(files.screenshot);
  await fs.link(foreign, files.screenshot);
  await assert.rejects(preserveNavigationEvidence(files.root, files.flow, files), /ordinary bounded file/);
  assert.deepEqual(await fs.readFile(foreign), png);
  await fs.rm(files.screenshot);
  const outside = path.join(files.toolkitRoot, 'outside');
  await fs.mkdir(outside);
  await fs.rm(files.evidence, { recursive: true, force: true });
  await fs.symlink(outside, files.evidence, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    preserveNavigationEvidence(files.root, { ...files.flow, screenshots: [] }, files),
    /must not be a link/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a post-flow assertion failure retains the known final screenshot after source cleanup', async (t) => {
  const files = await fixture(t);
  const final = path.join(files.evidence, '1-Document-boundary-final.png');
  await fs.rename(files.screenshot, final);
  const preserved = await preserveNavigationEvidence(
    files.root,
    {
      ...files.flow,
      passed: true,
      error: undefined,
      screenshots: [final],
    },
    files,
  );
  await fs.rm(await assertTemporaryDirectory(files.root), { recursive: true, force: true });
  const collected = collectSyntheticEvidence(path.join(files.toolkitRoot, '.paqvilo'));
  assert.deepEqual(collected.files.sort(), preserved.files.map((name) => `synthetic-navigation/${name}`).sort());
  const diagnostic = JSON.parse(
    await fs.readFile(
      path.join(
        collected.output,
        collected.files.find((name) => name.endsWith('.json')),
      ),
      'utf8',
    ),
  );
  assert.equal(diagnostic.passed, true, 'the flow completed before its outer assertion failed');
  assert.equal(diagnostic.imageStage, 'final');
  assert.deepEqual(
    await fs.readFile(
      path.join(
        collected.output,
        collected.files.find((name) => name.endsWith('.png')),
      ),
    ),
    png,
  );
});

test('navigation evidence refuses linked publication storage and the collector ignores private and hard-linked files', async (t) => {
  const files = await fixture(t);
  const outside = path.join(files.toolkitRoot, 'outside');
  await fs.mkdir(outside);
  const state = path.join(files.toolkitRoot, '.paqvilo');
  await fs.symlink(outside, state, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(preserveNavigationEvidence(files.root, files.flow, files), /must not be links/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(state);
  const published = await preserveNavigationEvidence(files.root, files.flow, files);
  const foreign = path.join(files.toolkitRoot, 'foreign.json');
  await fs.writeFile(foreign, secret);
  await fs.writeFile(path.join(published.destination, 'discovery.json'), secret);
  await fs.link(foreign, path.join(published.destination, `${'b'.repeat(32)}-diagnostic.json`));
  const collected = collectSyntheticEvidence(state);
  assert.deepEqual(collected.files.sort(), published.files.map((name) => `synthetic-navigation/${name}`).sort());
  assert.equal(await fs.readFile(foreign, 'utf8'), secret);
});
