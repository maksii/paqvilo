import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  assert.match(manifest.scripts['dev:debug'], /--debug-port 9222/);
  const workspace = JSON.parse(await fs.readFile(path.join(directory, 'paqvilo-demo.code-workspace'), 'utf8'));
  assert.equal(workspace.folders[0].path, '.');
  const tasks = JSON.parse(await fs.readFile(path.join(directory, '.vscode/tasks.json'), 'utf8'));
  const launch = JSON.parse(await fs.readFile(path.join(directory, '.vscode/launch.json'), 'utf8'));
  const labels = new Set(tasks.tasks.map((task) => task.label));
  for (const configuration of launch.configurations) {
    assert.equal(configuration.request, 'attach', 'debugger reuses the toolkit browser');
    if (configuration.preLaunchTask) assert.ok(labels.has(configuration.preLaunchTask));
  }
  for (const task of tasks.tasks) {
    if (task.dependsOn) assert.ok(labels.has(task.dependsOn));
    if (task.isBackground) assert.ok(new RegExp(task.problemMatcher.background.endsPattern).test('edit a file under the sources and the browser follows.'));
  }
  await fs.writeFile(path.join(directory, '.vscode/tasks.json'), '{"myTask":true}');
  await fs.unlink(path.join(directory, '.vscode/launch.json'));
  await fs.unlink(path.join(directory, 'paqvilo-demo.code-workspace'));
  await prepareDemo(directory);
  assert.equal(await fs.readFile(path.join(directory, '.vscode/tasks.json'), 'utf8'), '{"myTask":true}');
  await fs.access(path.join(directory, '.vscode/launch.json'));
  await fs.access(path.join(directory, 'paqvilo-demo.code-workspace'));
  const scaffold = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url)), 'mirage', 'demo', '--scaffold', '--dir', directory], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.match(scaffold, /No runtime was started/);
  assert.match(scaffold, /paqvilo-demo\.code-workspace/);
  assert.deepEqual(await fs.readdir(path.join(directory, '.paqvilo')), ['demo.json']);
  await fs.access(path.join(directory, 'solution/Entities/Account/Entity.xml'));
  await fs.access(path.join(directory, 'metadata/Other/Relationships.xml'));
  await fs.access(path.join(directory, 'components/DataversePlugins/AccountRules.cs'));
  await fs.access(path.join(directory, 'solution/PluginAssemblies/PaqviloDemoPlugins-B4700000-0000-4000-8000-370000000001/PaqviloDemoPlugins.dll'));
  for (const output of ['bin', 'obj']) await assert.rejects(fs.access(path.join(directory, 'components/DataversePlugins', output)), { code: 'ENOENT' });
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
