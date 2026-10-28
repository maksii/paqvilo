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
