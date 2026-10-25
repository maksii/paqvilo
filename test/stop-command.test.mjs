import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mirageStopCommand, mirageCommandHint, listenerPort } from '../lense/stop-command.mjs';

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
async function capture(command, shell, directory, cli, bashFile, { batch = false, expectedCode = 0 } = {}) {
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
  const result = await pending.catch((error) => {
    if (expectedCode === 0) throw error;
    return error;
  });
  assert.equal(result.code ?? 0, expectedCode, result.stderr);
  return batch
    ? result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : JSON.parse(result.stdout);
}

async function collectorFixture(t, { reportCwd = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-stop-argv-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'collector.mjs');
  await fs.writeFile(
    cli,
    `process.stdout.write(JSON.stringify(${reportCwd ? '[process.cwd(),...process.argv.slice(2)]' : 'process.argv.slice(2)'})+'\\n');if(process.argv.includes('--fail'))process.exitCode=3;`,
  );
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
  return { directory, cli, bashFile, availableShells: [...shells, ...(bashFile ? ['git-bash'] : [])] };
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
        assert.deepEqual(JSON.parse(inflateRawSync(Buffer.from(payload, 'base64')).toString('utf8')), [
          [cli, 'mirage', 'stop', ...args],
        ]);
      }
    }
  assert.ok(mirageStopCommand(['--project', "O'Brien"], { cli, platform: 'linux' }).includes("'O'\"'\"'Brien'"));
});

test(
  'printed stop commands preserve literal argv in every native shell without downloads or shell side effects',
  { timeout: 60000 },
  async (t) => {
    const { directory, cli, bashFile, availableShells } = await collectorFixture(t);
    for (const { values, windowsReadable, posixReadable } of cases) {
      const args = values.flatMap((value) => ['--project', value]);
      // Execute each exact hint. A fixture-owned npx shim forwards to the collector
      // without a network install; fallback hints invoke that same CLI directly.
      for (const shell of availableShells) {
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

test('listener selectors retain default HTTP ports and distinguish an absent listener', () => {
  assert.equal(listenerPort('http://127.0.0.1:80'), '80');
  assert.equal(listenerPort('https://localhost:443'), '443');
  assert.equal(listenerPort('http://127.0.0.1:9000'), '9000');
  assert.equal(listenerPort(null), undefined);
  assert.equal(listenerPort('file:///invented'), undefined);
});

test(
  'directory-bound hints execute in their original ownership directory across shells',
  { timeout: 60000 },
  async (t) => {
    const { directory, cli, bashFile, availableShells } = await collectorFixture(t, { reportCwd: true });
    const selected = path.join(directory, "runtime %PAQ_STOP_TEST% !PAQ_STOP_TEST! $ ` O'Brien & ^");
    await fs.mkdir(selected);
    const cwd = await fs.realpath(selected),
      args = ['--state', path.join(directory, 'invented state.json'), '--port', '9000'];
    for (const shell of availableShells) {
      const platform = ['posix', 'git-bash'].includes(shell) ? 'linux' : 'win32';
      const hint = mirageStopCommand(args, { cli, platform, cwd });
      assert.match(hint, /^node -e /);
      assert.deepEqual(await capture(hint, shell, directory, cli, bashFile), [cwd, 'mirage', 'stop', ...args]);
    }
    assert.throws(() => mirageStopCommand(args, { cli, cwd: './relative' }), /working directory/);
    assert.throws(() => mirageStopCommand(args, { cli, cwd: cwd + '\0' }), /working directory/);
  },
);

test(
  'a compressed sixteen-target command fits CMD and attempts every target after a failure',
  { timeout: 120000 },
  async (t) => {
    const { directory, cli, bashFile, availableShells } = await collectorFixture(t);
    const commands = Array.from({ length: 16 }, (_, i) => [
      'mirage',
      'stop',
      '--config',
      path.join(directory, 'catalogues/invented-workspace/paqvilo.config.yml'),
      '--repo',
      path.join(directory, 'source-checkouts/invented-workspace'),
      '--site',
      `portal-${i}`,
      '--portals',
      'selected',
      '--project',
      path.join(directory, `projects/portal-${i}/mirage.project.yml`),
      '--portal',
      `portal-${i}`,
      '--runtime',
      'power-pages',
      '--state',
      path.join(directory, `catalogues/invented-workspace/.paqvilo/simulator/projects/project-${i}/state.json`),
      '--port',
      String(20000 + i),
      ...(i === 7 ? ['--fail'] : []),
    ]);
    assert.ok(
      Buffer.from(JSON.stringify(commands.map((args) => [cli, ...args]))).toString('base64').length > 8191,
      'the representative uncompressed transport exceeds CMD capacity on either platform',
    );
    for (const shell of availableShells) {
      const platform = ['posix', 'git-bash'].includes(shell) ? 'linux' : 'win32';
      const hint = mirageCommandHint(commands, { cli, platform });
      assert.ok(hint.length <= 8000, shell);
      assert.deepEqual(
        await capture(hint, shell, directory, cli, bashFile, { batch: true, expectedCode: 1 }),
        commands,
        shell,
      );
    }
  },
);

test('oversized incompressible commands use immutable file transport across shells', { timeout: 120000 }, async (t) => {
  const { directory, cli, bashFile, availableShells } = await collectorFixture(t, { reportCwd: true });
  const selected = path.join(directory, "file runtime %PAQ_STOP_TEST% !PAQ_STOP_TEST! $ ` O'Brien & ^");
  await fs.mkdir(selected);
  const cwd = await fs.realpath(selected);
  const commands = Array.from({ length: 6 }, (_, i) => [
    'mirage',
    'stop',
    '--fixture',
    String(i),
    '--literal',
    randomBytes(2048).toString('hex'),
  ]);
  const payloadFile = path.join(directory, "payload %PAQ_STOP_TEST% !PAQ_STOP_TEST! $ ` O'Brien & ^.json");
  const stored = [];
  const storePayload = (data) => {
    stored.push(Buffer.from(data));
    writeFileSync(payloadFile, data, { mode: 0o600 });
    return payloadFile;
  };
  assert.throws(() => mirageCommandHint(commands, { cli, platform: 'win32' }), /copyable shell limit/);
  assert.throws(() => mirageCommandHint(commands, { cli, storePayload: () => './relative.json' }), /absolute filename/);
  for (const shell of availableShells) {
    const platform = ['posix', 'git-bash'].includes(shell) ? 'linux' : 'win32';
    const hint = mirageCommandHint(commands, { cli, platform, storePayload, cwd });
    assert.ok(hint.length <= 8000, shell);
    assert.doesNotMatch(hint, /[\r\n]/);
    assert.deepEqual(
      JSON.parse(stored.at(-1).toString('utf8')),
      commands.map((args) => [cli, ...args]),
    );
    assert.deepEqual(
      await capture(hint, shell, directory, cli, bashFile, { batch: true }),
      commands.map((args) => [cwd, ...args]),
      shell,
    );
    await fs.appendFile(payloadFile, ' ');
    assert.deepEqual(
      await capture(hint, shell, directory, cli, bashFile, { batch: true, expectedCode: 1 }),
      [],
      'changed file never invokes a child',
    );
    await fs.writeFile(payloadFile, Buffer.alloc(1024 * 1024 + 1));
    assert.deepEqual(
      await capture(hint, shell, directory, cli, bashFile, { batch: true, expectedCode: 1 }),
      [],
      'oversized replacement never invokes a child',
    );
  }
  assert.equal(mirageCommandHint([], { cli }), null);
  assert.throws(
    () => mirageCommandHint([['mirage', 'stop', 'x'.repeat(1024 * 1024)]], { cli, storePayload }),
    /byte limit/,
  );
});

test('external command replay refuses a pipe before reading or executing any child', { timeout: 10000 }, async (t) => {
  const { directory, cli } = await collectorFixture(t);
  let file;
  if (process.platform === 'win32') {
    file = `\\\\.\\pipe\\paqvilo-stop-payload-${process.pid}-${randomBytes(8).toString('hex')}`;
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, resolve);
    });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
  } else {
    file = path.join(directory, 'replaced-payload.fifo');
    await execute('mkfifo', [file]);
  }
  const commands = Array.from({ length: 6 }, () => ['mirage', 'stop', '--literal', randomBytes(2048).toString('hex')]);
  const hint = mirageCommandHint(commands, { cli, storePayload: () => file });
  assert.match(hint, /^node -e "/);
  await assert.rejects(
    execute(process.execPath, ['-e', hint.slice('node -e "'.length, -1)], {
      cwd: directory,
      timeout: 3000,
      windowsHide: true,
    }),
    (error) => error.code === 1 && /Command payload must be a regular file/.test(error.stderr) && error.stdout === '',
  );
});
