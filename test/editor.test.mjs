// @test-kind contract: Paqvilo's own editor launch for the panel's Open in editor (resolution, message, invocation)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { editorNotFound, openInEditor, resolveEditorCommand } from '../lense/panel.mjs';
import { DEV_PROBLEM_MATCHER, DEV_READY } from '../lense/dev-messages.mjs';
import { tempDirSync } from './fixture.mjs';

test('tracked toolkit and demo debugger launches wait for CLI readiness and attach to their task port', () => {
  const debugPorts = [];
  for (const directory of ['../', '../examples/project/']) {
    const tasks = JSON.parse(fs.readFileSync(new URL(directory + '.vscode/tasks.json', import.meta.url), 'utf8')).tasks;
    const launches = JSON.parse(
      fs.readFileSync(new URL(directory + '.vscode/launch.json', import.meta.url), 'utf8'),
    ).configurations;
    const labels = new Set(tasks.map((task) => task.label));
    for (const task of tasks) {
      if (task.dependsOn) assert.ok(labels.has(task.dependsOn), task.label);
      if (!task.isBackground) continue;
      assert.deepEqual(task.problemMatcher, DEV_PROBLEM_MATCHER, task.label);
      assert.ok(new RegExp(task.problemMatcher.background.endsPattern).test(DEV_READY));
      assert.ok(!new RegExp(task.problemMatcher.pattern.regexp).test('paqvilo: terminal-only diagnostic'));
    }
    for (const launch of launches.filter((launch) => launch.request === 'attach' && launch.preLaunchTask)) {
      const task = tasks.find((task) => task.label === launch.preLaunchTask);
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

test('Windows editor discovery returns the full CLI path from PATH/PATHEXT or the VS Code install folders, else null', (t) => {
  const dir = tempDirSync('paqvilo-editor-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'Local App Data');
  const machine = path.join(dir, 'Program Files');
  const pathname = path.join(dir, 'preferred');
  const write = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'invented CLI fixture; never executed');
    return file;
  };
  const stable = write(path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'));
  const insiders = write(path.join(machine, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'));
  const custom = write(path.join(dir, 'custom', 'code.cmd'));
  const env = { localappdata: local, PROGRAMFILES: machine, Path: '' };
  const resolve = (editor, overrides = {}) =>
    resolveEditorCommand(editor, { platform: 'win32', env: { ...env, ...overrides } });
  assert.equal(resolve('code'), stable);
  assert.equal(resolve('code-insiders'), insiders);
  assert.equal(resolve('other-editor'), null, 'an editor found nowhere is reported, not spawned');
  assert.equal(resolve(custom), custom, 'an explicit existing path is kept');
  assert.equal(resolve(path.join(dir, 'missing', 'code.cmd')), null);
  // PAQVILO_EDITOR=C:\tools\subl: Windows runs subl.exe for an extensionless path, and so does the launcher.
  const subl = write(path.join(dir, 'tools', 'subl.exe'));
  assert.equal(resolve(path.join(dir, 'tools', 'subl')), subl, 'an extensionless path takes a PATHEXT extension');
  assert.equal(resolve(path.join(dir, 'tools', 'subl'), { PATHEXT: '.CMD' }), null);
  assert.equal(resolveEditorCommand('code', { platform: 'linux', env }), 'code');
  const onPath = write(path.join(pathname, 'code.cmd'));
  write(path.join(pathname, 'code'));
  // A quoted bare "code" makes cmd.exe run code.cmd with the working directory as %~dp0 (exit 9009): the full path is required.
  assert.equal(resolve('code', { Path: `"${pathname}"` }), onPath, 'PATH takes precedence, as its full .cmd path');
  assert.equal(resolve('code.cmd', { Path: pathname }), onPath);
  const exe = write(path.join(pathname, 'other-editor.exe'));
  assert.equal(
    resolve('other-editor', { Path: pathname, PATHEXT: '.EXE;.CMD' }),
    exe,
    'PATHEXT decides the extensions',
  );
  assert.equal(resolve('other-editor', { Path: pathname, PATHEXT: '.CMD' }), null);
  fs.rmSync(stable);
  fs.mkdirSync(stable);
  assert.equal(resolve('code'), null, 'a directory named code.cmd is not a CLI');
  assert.equal(
    resolve('code-insiders', { PROGRAMFILES: machine + '&unexpected' }),
    null,
    'shell syntax in environment-derived paths is rejected',
  );
  // Injected file system: nothing on disk is consulted.
  const tool = path.join('C:/Tools', 'ed.cmd');
  const fake = { statSync: (file) => ({ isFile: () => file === tool }) };
  assert.equal(resolveEditorCommand('ed', { platform: 'win32', env: { PATH: 'C:/Tools' }, fs: fake }), tool);
});

test('an editor that cannot be found names the editor and the settings that choose it', async (t) => {
  const dir = tempDirSync('paqvilo-editor-none-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const message = await openInEditor(path.join(dir, 'no-editor'), 'invented.js');
  assert.match(message, /^Editor ".*no-editor" was not found\. Set PAQVILO_EDITOR or the catalogue's editor setting/);
  assert.doesNotMatch(message, /code \d+/);
  assert.match(editorNotFound('code'), /not found on PATH or in the VS Code install folders/);
});

test('PATH folders that the shell would interpret are skipped and named when the editor is not found', () => {
  const skipped = [];
  const tool = path.join('C:/Safe', 'ed.cmd');
  const fake = { statSync: (file) => ({ isFile: () => file === tool }) };
  const env = { PATH: 'C:/Tools & More;%TOOLS%\\bin;;C:/Plain', PATHEXT: '.CMD' };
  assert.equal(resolveEditorCommand('ed', { platform: 'win32', env, fs: fake, skipped }), null);
  assert.deepEqual(skipped, ['C:/Tools & More', '%TOOLS%\\bin'], 'empty and safe entries are not reported');
  const message = editorNotFound('ed', skipped);
  assert.match(message, /PATH folders with & \^ % ! or quotes are not searched/);
  assert.match(message, /C:\/Tools & More; %TOOLS%\\bin\./);
  assert.match(message, /Set PAQVILO_EDITOR or the catalogue's editor setting to the editor's full path/);
  // Found in a safe folder: nothing to report.
  const found = [];
  assert.equal(
    resolveEditorCommand('ed', {
      platform: 'win32',
      env: { ...env, PATH: 'C:/Tools&x;C:/Safe' },
      fs: fake,
      skipped: found,
    }),
    tool,
  );
  assert.equal(editorNotFound('ed').includes('not searched'), false);
});

// The foreground limit never fires here: each call waits for the CLI's exit, and only --test-timeout guards a hang.
const untilExit = { foregroundMs: Infinity };

// Windows runs the editor's .cmd through cmd.exe and discovers it when PATH is empty; POSIX spawns the named
// executable with its arguments unchanged. Each platform runs its own launch path for real.
test('source-open invokes the editor CLI with the exact file location and reports a failing CLI', async (t) => {
  const windows = process.platform === 'win32';
  const dir = tempDirSync('paqvilo-editor-launch-');
  const capture = path.join(dir, 'captured.txt');
  const source = path.join(dir, 'Source & form (draft).js');
  const cli = (file, exitCode) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      windows
        ? `@echo off\r\n> "${capture}" echo "%~2"\r\nexit /b ${exitCode}\r\n`
        : `#!/bin/sh\nprintf '"%s"\\n' "$2" > '${capture}'\nexit ${exitCode}\n`,
      { mode: 0o755 },
    );
    return file;
  };
  fs.writeFileSync(source, 'invented source');
  const names = ['PATH', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)'];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  // The editor child is unref'd: keep the loop alive until the child exits.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => {
    clearInterval(keepAlive);
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let editor = 'code';
  if (windows) {
    cli(path.join(dir, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), 0);
    process.env.PATH = '';
    process.env.LOCALAPPDATA = dir;
    process.env.ProgramFiles = dir;
    process.env['ProgramFiles(x86)'] = dir;
  } else editor = cli(path.join(dir, 'bin', 'code'), 0);
  assert.equal(await openInEditor(editor, source, 12, 3, untilExit), null);
  assert.equal(fs.readFileSync(capture, 'utf8').trim(), `"${source}:12:3"`);
  const failing = cli(path.join(dir, 'failing', windows ? 'editor.cmd' : 'editor'), 3);
  assert.equal(await openInEditor(failing, source, 1, 1, untilExit), `"${failing}" ended with code 3`);
  assert.equal(fs.readFileSync(capture, 'utf8').trim(), `"${source}:1:1"`, 'the failing CLI still got the location');
  if (!windows) return;
  // Like VS Code's code.cmd, this CLI on PATH finds its program through %~dp0, which cmd.exe sets to the working
  // directory when it runs a quoted bare "code" (exit 9009); the launcher must run it by its full path.
  const bin = path.join(dir, 'on-path', 'bin');
  cli(path.join(bin, 'program.cmd'), 0);
  fs.writeFileSync(path.join(bin, 'code.cmd'), '@echo off\r\ncall "%~dp0program.cmd" %*\r\nexit /b %ERRORLEVEL%\r\n');
  process.env.PATH = bin;
  process.env.LOCALAPPDATA = process.env.ProgramFiles = process.env['ProgramFiles(x86)'] = path.join(dir, 'none');
  assert.equal(await openInEditor('code', source, 7, 2, untilExit), null);
  assert.equal(fs.readFileSync(capture, 'utf8').trim(), `"${source}:7:2"`);
});

// @test-kind contract: an editor that keeps running (stays in the foreground) counts as opened once the limit passes
test('an editor CLI that is still running when the foreground limit passes counts as opened', async (t) => {
  const windows = process.platform === 'win32';
  const dir = tempDirSync('paqvilo-editor-foreground-');
  const gate = path.join(dir, 'gate'),
    done = path.join(dir, 'done');
  // The CLI runs until the test opens its gate: it cannot exit before openInEditor answers.
  const editor = path.join(dir, windows ? 'held.cmd' : 'held');
  fs.writeFileSync(
    editor,
    windows
      ? `@echo off
:wait
if exist "${gate}" goto go
ping -n 2 127.0.0.1 >nul
goto wait
:go
> "${done}" echo done
exit /b 0
`
      : `#!/bin/sh
while [ ! -f '${gate}' ]; do sleep 0.1; done
echo done > '${done}'
`,
    { mode: 0o755 },
  );
  const { promise: exited, resolve: onExit } = Promise.withResolvers();
  // openInEditor does not keep the process alive for its editor: the test does, until the editor has ended.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => {
    clearInterval(keepAlive);
    // A run that failed before it opened the gate: the CLI ends by itself once the gate exists.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(gate, '');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(await openInEditor(editor, path.join(dir, 'invented.js'), 1, 1, { foregroundMs: 0, onExit }), null);
  assert.equal(fs.existsSync(done), false, 'answered while the CLI was still running');
  // The CLI's process must have ended before its folder is removed: until then Windows refuses the removal (the
  // file it writes last appears while the process still holds the folder).
  fs.writeFileSync(gate, '');
  await exited;
  assert.equal(fs.existsSync(done), true, 'the CLI ran to its end after the answer');
  fs.rmSync(dir, { recursive: true }); // one attempt: the ended CLI no longer holds its folder
});
