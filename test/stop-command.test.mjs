import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mirageStopCommand } from '../lense/stop-command.mjs';

const execute = promisify(execFile);
const shells = process.platform === 'win32' ? ['cmd', 'cmd-delayed', 'powershell'] : ['posix'];
const cases = [
  {
    values: ['D:\\demo\\model-proof\\mirage.project.yml', 'C:\\', '\\\\invented-host\\share\\'],
    windowsReadable: true,
    posixReadable: true,
  },
  {
    values: ["D:\\demo projects\\O'Brien & ^ fixture\\mirage.project.yml"],
    windowsReadable: true,
    posixReadable: true,
  },
  {
    values: ['D:\\fixture\\$([char]65) `ticks\\%PAQ_STOP_TEST%\\!PAQ_STOP_TEST!\\file.yml'],
    windowsReadable: false,
    posixReadable: true,
  },
  {
    values: ['D:\\fixture\\"quoted"\\file.yml', 'D:\\directory with space\\', ''],
    windowsReadable: false,
    posixReadable: true,
  },
  {
    values: ['tab\tvalue', 'line\nvalue', 'return\rvalue', 'del\u007fvalue'],
    windowsReadable: false,
    posixReadable: false,
  },
];
async function capture(command, shell, directory, cli, bashFile) {
  if (shell === 'git-bash') command = 'npx(){ node "$PAQ_TEST_SHIM" "$@"; }; ' + command;
  const cmd = shell.startsWith('cmd');
  const posix = shell === 'posix' || shell === 'git-bash';
  const file = cmd
    ? 'cmd.exe'
    : shell === 'powershell'
      ? 'powershell.exe'
      : shell === 'git-bash'
        ? bashFile
        : '/bin/sh';
  const args = cmd
    ? ['/d', '/s', shell === 'cmd-delayed' ? '/v:on' : '/v:off', '/c', command]
    : shell === 'powershell'
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : shell === 'git-bash'
        ? ['--noprofile', '--norc', '-s']
        : ['-c', command];
  const pending = execute(file, args, {
    cwd: directory,
    windowsHide: true,
    windowsVerbatimArguments: cmd,
    timeout: 15000,
    env: {
      ...process.env,
      PATH: (posix ? path.join(directory, 'posix-bin') : directory) + path.delimiter + process.env.PATH,
      ...(shell === 'git-bash' ? { MSYS2_ARG_CONV_EXCL: '*', MSYS_NO_PATHCONV: '1' } : {}),
      PAQ_STOP_TEST: 'EXPANSION_MUST_NOT_APPEAR',
      PAQ_TEST_CLI: cli,
      PAQ_TEST_SHIM: path.join(directory, 'shim.mjs'),
    },
  });
  // Feed the script directly: Windows command-line quoting is not the POSIX
  // parser being tested, and Git Bash's startup argv translation differs from CRT.
  if (shell === 'git-bash') pending.child.stdin.end(command + '\n');
  const result = await pending;
  return JSON.parse(result.stdout);
}

test('Windows and POSIX formatters keep copied hints on one line while retaining ordinary literal quoting', () => {
  const cli = path.resolve('invented-cli.mjs');
  for (const platform of ['linux', 'win32'])
    for (const { values, windowsReadable, posixReadable } of cases) {
      const args = values.flatMap((value) => ['--project', value]);
      const hint = mirageStopCommand(args, { cli, platform });
      assert.doesNotMatch(hint, /[\r\n]/, platform);
      assert.equal(hint.startsWith('npx paqvilo '), platform === 'win32' ? windowsReadable : posixReadable);
      if (hint.startsWith('node -e ')) {
        const payload = /Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(hint)[1];
        assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')), [cli, 'mirage', 'stop', ...args]);
      }
    }
  assert.ok(mirageStopCommand(['--project', "O'Brien"], { cli, platform: 'linux' }).includes("'O'\"'\"'Brien'"));
});

test(
  'printed stop commands preserve literal argv in every native shell without downloads or shell side effects',
  { timeout: 60000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-stop-argv-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const cli = path.join(directory, 'collector.mjs');
    await fs.writeFile(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    await fs.writeFile(
      path.join(directory, 'shim.mjs'),
      "import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';assert.equal(process.argv[2],'paqvilo');execFileSync(process.execPath,[process.env.PAQ_TEST_CLI,...process.argv.slice(3)],{stdio:'inherit'});",
    );
    if (process.platform === 'win32') await fs.writeFile(path.join(directory, 'npx.cmd'), '@node shim.mjs %*\r\n');
    const shim = path.join(directory, 'posix-bin', 'npx');
    await fs.mkdir(path.dirname(shim));
    await fs.writeFile(shim, '#!/bin/sh\nexec node "$PAQ_TEST_SHIM" "$@"\n');
    await fs.chmod(shim, 0o755);
    let bashFile;
    if (process.platform === 'win32') {
      for (const candidate of [
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/bin/bash.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Git/bin/bash.exe'),
      ]) {
        if (
          await fs.access(candidate).then(
            () => true,
            () => false,
          )
        ) {
          bashFile = candidate;
          break;
        }
      }
      if (bashFile) t.diagnostic('POSIX argv is also exercised through Git Bash with MSYS path conversion disabled.');
    }
    for (const { values, windowsReadable, posixReadable } of cases) {
      const args = values.flatMap((value) => ['--project', value]);
      // Execute each exact hint. A fixture-owned npx shim forwards to the collector
      // without a network install; fallback hints invoke that same CLI directly.
      for (const shell of [...shells, ...(bashFile ? ['git-bash'] : [])]) {
        const platform = shell === 'posix' || shell === 'git-bash' ? 'linux' : 'win32';
        const hint = mirageStopCommand(args, { cli, platform });
        assert.doesNotMatch(hint, /[\r\n]/, 'the copyable command remains a single line');
        assert.equal(hint.startsWith('npx paqvilo '), platform === 'win32' ? windowsReadable : posixReadable);
        assert.deepEqual(
          await capture(hint, shell, directory, cli, bashFile),
          ['mirage', 'stop', ...args],
          shell + ': ' + hint,
        );
      }
    }
    assert.throws(() => mirageStopCommand(['--project', 'invalid\0path'], { cli }), /NUL/);
    assert.throws(() => mirageStopCommand([], { cli: './relative-cli.mjs' }), /absolute CLI/);
  },
);
