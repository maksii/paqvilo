import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  makeTemporaryDirectory,
  makeTemporaryDirectorySync,
  ownedFixture,
  assertTemporaryDirectory,
} from '../testing/owned-fixture.mjs';

test('temporary workspace creators resolve physical parents while retaining distinct complete prefixes', async (t) => {
  const parent = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-temp-parent-'));
  ownedFixture(t).remove(() => fs.rm(parent, { recursive: true, force: true }));
  const physical = path.join(parent, 'physical'),
    alias = path.join(parent, 'alias');
  await fs.mkdir(physical);
  await fs.symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const asynchronous = await makeTemporaryDirectory(path.join(alias, 'asynchronous workspace '));
  const synchronous = makeTemporaryDirectorySync(path.join(alias, 'synchronous workspace '));
  assert.equal(asynchronous, await fs.realpath(asynchronous));
  assert.equal(synchronous, await fs.realpath(synchronous));
  assert.equal(path.dirname(asynchronous), physical);
  assert.equal(path.dirname(synchronous), physical);
  assert.ok(path.basename(asynchronous).startsWith('asynchronous workspace '));
  assert.ok(path.basename(synchronous).startsWith('synchronous workspace '));
  assert.notEqual(asynchronous, synchronous);
  await fs.writeFile(path.join(asynchronous, 'invented.txt'), 'invented');
  assert.equal(await fs.readFile(path.join(alias, path.basename(asynchronous), 'invented.txt'), 'utf8'), 'invented');
});

test('temporary workspace creators create an absent ignored state parent, as a fresh CI checkout has none', async (t) => {
  const checkout = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-fresh-checkout-'));
  ownedFixture(t).remove(() => fs.rm(checkout, { recursive: true, force: true }));
  const asynchronous = await makeTemporaryDirectory(path.join(checkout, '.paqvilo', 'asynchronous-'));
  const synchronous = makeTemporaryDirectorySync(path.join(checkout, '.paqvilo', 'nested', 'synchronous-'));
  assert.equal(path.dirname(asynchronous), path.join(checkout, '.paqvilo'));
  assert.equal(path.dirname(synchronous), path.join(checkout, '.paqvilo', 'nested'));
});

test('temporary cleanup containment resolves aliases, checks direct children and preserves physical boundaries', async (t) => {
  const parent = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-cleanup-physical-parent-'));
  const sibling = parent + '-sibling';
  ownedFixture(t).remove(() => fs.rm(parent, { recursive: true, force: true }));
  ownedFixture(t).remove(() => fs.rm(sibling, { recursive: true, force: true }));
  const direct = path.join(parent, 'direct'),
    nested = path.join(direct, 'nested'),
    alias = path.join(parent, 'parent-alias');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'sentinel'), 'untouched');
  await fs.symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(
    await assertTemporaryDirectory(path.join(alias, 'direct'), { parent: alias, directChild: true }),
    direct,
  );
  assert.equal(await assertTemporaryDirectory(nested, { parent: alias }), nested);
  await assert.rejects(assertTemporaryDirectory(nested, { parent: alias, directChild: true }), /direct child/);
  for (const outside of [parent, sibling, path.join(parent, '..', path.basename(sibling))])
    await assert.rejects(assertTemporaryDirectory(outside, { parent: alias }), /strictly inside/);
  const redirected = path.join(parent, 'redirected');
  await fs.symlink(sibling, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertTemporaryDirectory(redirected, { parent: alias }), /strictly inside/);
  assert.equal(await fs.readFile(path.join(sibling, 'sentinel'), 'utf8'), 'untouched');
  if (process.platform === 'win32') {
    const driveCase = parent.replace(/^[a-z]:/i, (drive) => drive.toLowerCase());
    assert.equal(await assertTemporaryDirectory(direct, { parent: driveCase, directChild: true }), direct);
    const short = execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/v:off', '/c', 'for %I in ("%PAQ_TEST_SHORT_PARENT%") do @echo %~sI'],
      {
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: { ...process.env, PAQ_TEST_SHORT_PARENT: parent },
      },
    ).trim();
    assert.equal(
      await assertTemporaryDirectory(path.join(short, 'direct'), { parent: short, directChild: true }),
      direct,
    );
    t.diagnostic(
      short.includes('~')
        ? 'Verified an actual Windows 8.3 parent alias.'
        : 'The volume returned its long path; actual junction and drive-case checks still ran.',
    );
  }
});
