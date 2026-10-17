import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openInEditor, resolveEditorCommand } from '../lense/panel.mjs';
import { DEV_PROBLEM_MATCHER, DEV_READY } from '../lense/dev-messages.mjs';

test('tracked toolkit and demo debugger launches wait for CLI readiness and attach to their task port', () => {
  const debugPorts = [];
  for (const directory of ['../', '../examples/project/']) {
    const tasks = JSON.parse(fs.readFileSync(new URL(directory + '.vscode/tasks.json', import.meta.url), 'utf8')).tasks;
    const launches = JSON.parse(fs.readFileSync(new URL(directory + '.vscode/launch.json', import.meta.url), 'utf8')).configurations;
    const labels = new Set(tasks.map(task => task.label));
    for (const task of tasks) {
      if (task.dependsOn) assert.ok(labels.has(task.dependsOn), task.label);
      if (!task.isBackground) continue;
      assert.deepEqual(task.problemMatcher, DEV_PROBLEM_MATCHER, task.label);
      assert.ok(new RegExp(task.problemMatcher.background.endsPattern).test(DEV_READY));
      assert.ok(!new RegExp(task.problemMatcher.pattern.regexp).test('paqvilo: terminal-only diagnostic'));
    }
    for (const launch of launches.filter(launch => launch.request === 'attach' && launch.preLaunchTask)) {
      const task = tasks.find(task => task.label === launch.preLaunchTask);
      assert.ok(task?.isBackground, launch.name);
      assert.equal(task.type, 'process');
      assert.equal(task.command, 'node');
      assert.equal(task.options.cwd, '${workspaceFolder}');
      assert.equal(Number(task.args[task.args.indexOf('--debug-port') + 1]), launch.port, launch.name);
      if (directory === '../') debugPorts.push(launch.port);
    }
  }
  assert.equal(new Set(debugPorts).size, debugPorts.length, 'toolkit Lense and Mirage can use separate debugger ports');
});

test('Windows editor discovery preserves PATH and explicit editor choices, then locates regular vendor CLIs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-editor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'Local App Data');
  const machine = path.join(dir, 'Program Files');
  const pathname = path.join(dir, 'preferred');
  const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'invented CLI fixture; never executed'); return file; };
  const stable = write(path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'));
  const insiders = write(path.join(machine, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'));
  const env = { localappdata: local, PROGRAMFILES: machine, Path: '' };
  const resolve = (editor, overrides = {}) => resolveEditorCommand(editor, { platform: 'win32', env: { ...env, ...overrides } });
  assert.equal(resolve('code'), stable);
  assert.equal(resolve('code-insiders'), insiders);
  assert.equal(resolve('other-editor'), 'other-editor');
  assert.equal(resolve('C:/custom/code.cmd'), 'C:/custom/code.cmd');
  assert.equal(resolve('code.cmd'), 'code.cmd');
  assert.equal(resolveEditorCommand('code', { platform: 'linux', env }), 'code');
  write(path.join(pathname, 'code.cmd'));
  assert.equal(resolve('code', { Path: `"${pathname}"` }), 'code', 'existing PATH choice takes precedence');
  fs.rmSync(stable);
  fs.mkdirSync(stable);
  assert.equal(resolve('code'), 'code', 'a directory named code.cmd is not a CLI');
  assert.equal(resolve('code-insiders', { PROGRAMFILES: machine + '&unexpected' }), 'code-insiders', 'shell syntax in environment-derived paths is rejected');
});

test('Windows source-open invokes the discovered CLI with the exact quoted file location when PATH is empty', { skip: process.platform !== 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-editor-launch-'));
  const command = path.join(dir, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
  const capture = path.join(dir, 'captured.txt');
  const source = path.join(dir, 'Source & form (draft).js');
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(source, 'invented source');
  fs.writeFileSync(command, `@echo off\r\n> "${capture}" echo "%~2"\r\nexit /b 0\r\n`);
  const names = ['PATH', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => {
    clearInterval(keepAlive);
    for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.PATH = '';
  process.env.LOCALAPPDATA = dir;
  process.env.ProgramFiles = dir;
  process.env['ProgramFiles(x86)'] = dir;
  assert.equal(await openInEditor('code', source, 12, 3), null);
  assert.equal(fs.readFileSync(capture, 'utf8').trim(), `"${source}:12:3"`);
});
