import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareDemo } from '../lense/commands/demo.mjs';

test('demo copies an editable project, preserves source edits on repeat and refuses unrelated folders', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-demo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example');
  assert.equal((await prepareDemo(directory)).created, true);
  const template = path.join(directory, 'portal/web-files/demo.css');
  await fs.writeFile(template, 'My local changes');
  assert.equal((await prepareDemo(directory)).created, false);
  assert.equal(await fs.readFile(template, 'utf8'), 'My local changes');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  assert.ok(!manifest.devDependencies.paqvilo.startsWith('file:'));
  await fs.access(path.join(directory, 'solution/Entities/Account/Entity.xml'));
  await fs.access(path.join(directory, 'metadata/Other/Relationships.xml'));
  for (const file of ['deployment/PaqviloDemoSample.zip', 'deployment/PaqviloDemoCodeComponents.zip', 'deployment/demo-data.zip', 'deployment/configure.mjs', 'code-solution/Other/Solution.xml', 'components/pcf-field-types/ExampleAccountFields/index.ts', 'components/pcf-field-types/ExampleAccountFields/ControlManifest.Input.xml']) {
    await fs.access(path.join(directory, file));
  }
  const fixtures = JSON.parse(await fs.readFile(path.join(directory, 'pack/fixtures.json'), 'utf8'));
  assert.equal(fixtures.account.length, 12);
  assert.equal(fixtures.contact.length, 24);
  const unrelated = path.join(root, 'existing-project');
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(unrelated, 'important.txt'), 'Keep me');
  await assert.rejects(prepareDemo(unrelated), /No files were changed/);
  assert.deepEqual(await fs.readdir(unrelated), ['important.txt']);
  await assert.rejects(prepareDemo(path.join(unrelated, 'important.txt')), /regular directory/);
});
