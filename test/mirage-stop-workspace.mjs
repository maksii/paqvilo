// Shared workspace for the Mirage stop-scope tests: real CLI processes, real detached runtimes and
// real shells replaying the advertised stop hints from other directories.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixture } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { startReaper, stopRecordedRuntimes } from './mirage-reaper.mjs';

export const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
// Longer than the product's 120 s startup deadline (lense/commands/mirage.mjs), so a slow start ends
// through the CLI's own abandon path, which stops its runtime, before this bound kills the CLI.
const CLI_TIMEOUT_MS = 150_000;
// The grace the product's own stop gives a runtime before SIGKILL (STOP_DEADLINE).
const TERMINATE_GRACE_MS = 5_000;

// One immutable export per test file, removed after its last test: every workspace copies it.
// Created at import so the hook belongs to the file, not to the first test that uses it.
const portal = createFixture();
after(() => portal.cleanup());

export async function availablePair() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const servers = [net.createServer(), net.createServer()];
    try {
      const listen = (server, port) =>
        new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
      // Stay below the OS ephemeral range: concurrent fixture listeners should
      // not consume the second planned port immediately after these probes close.
      await listen(servers[0], 20000 + Math.floor(Math.random() * 10000));
      const base = servers[0].address().port;
      if (base === 65535) continue;
      await listen(servers[1], base + 1);
      return base;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    } finally {
      await Promise.all(
        servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))),
      );
    }
  }
  throw new Error('The loopback fixture could not reserve consecutive ports.');
}

/** Ends a CLI or shell process and every process it started that is still attached to it. */
async function stopProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  if (process.platform === 'win32')
    // Windows keeps the parent link of a detached runtime, so /t also ends a runtime still starting.
    await new Promise((resolve) =>
      execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, resolve),
    );
  else {
    // POSIX children run in their own process group; the CLI's SIGTERM handler stops a starting runtime.
    // The group can already be gone while the CLI's exit is still unreported (ESRCH): signal the CLI itself.
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        child.kill(name);
      }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), TERMINATE_GRACE_MS);
    await closed;
    clearTimeout(timer);
  }
  await closed;
}

export async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-stop-scope-'));
  // Registered before anything starts. Closers run before the directory removal, and on a test
  // failure or timeout as well: running CLIs are ended with their process tree, then every runtime
  // recorded anywhere under the workspace is stopped. The reaper covers an abruptly ended test process.
  const reaper = startReaper(directory);
  const running = new Set();
  let disposal;
  const dispose = () =>
    (disposal ??= (async () => {
      // Every step runs even when an earlier one fails: a skipped step would leak a runtime, and an unfinished
      // reaper keeps the inherited output open so the test runner never sees this file end.
      const stopped = await Promise.allSettled([...running].map(stopProcessTree));
      let left;
      try {
        left = await stopRecordedRuntimes(directory);
      } finally {
        await reaper.finish();
      }
      const failures = stopped.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Ending the workspace CLIs failed.');
      assert.deepEqual(left, [], 'every runtime started in the workspace stopped');
    })());
  const owner = ownedFixture(t);
  owner.add(dispose);
  owner.remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fixture = portal;
  const defaults = path.join(directory, 'default checkout');
  const alternate = path.join(directory, 'alternate checkout');
  await fs.cp(fixture.dir, path.join(defaults, 'portal'), { recursive: true });
  await fs.cp(fixture.dir, path.join(alternate, 'portal'), { recursive: true });
  const cwd = path.join(directory, 'copy hint here');
  await fs.mkdir(cwd);
  const shim = path.join(cwd, 'npx-shim.mjs');
  const preload = path.join(cwd, 'collect-cli.mjs');
  await fs.writeFile(
    preload,
    'if(process.argv[1]===process.env.PAQ_REAL_CLI){console.log(JSON.stringify(process.argv.slice(2)));process.exit(0)}',
  );
  await fs.writeFile(
    shim,
    "import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';assert.equal(process.argv[2],'paqvilo');const args=process.argv.slice(3);if(process.env.PAQ_CAPTURE_HINT)console.log(JSON.stringify(args));else execFileSync(process.execPath,[process.env.PAQ_REAL_CLI,...args],{stdio:'inherit'});",
  );
  if (process.platform === 'win32') await fs.writeFile(path.join(cwd, 'npx.cmd'), '@node "%PAQ_NPX_SHIM%" %*\r\n');
  else {
    await fs.writeFile(path.join(cwd, 'npx'), '#!/bin/sh\nexec node "$PAQ_NPX_SHIM" "$@"\n');
    await fs.chmod(path.join(cwd, 'npx'), 0o755);
  }
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:PAQVILO_|GIT_)/.test(key)),
  );
  /** Starts a tracked process; `result` settles with its status and output. */
  const launch = (file, args, options) => {
    let child;
    const result = new Promise((resolve, reject) => {
      child = execFile(
        file,
        args,
        {
          windowsHide: true,
          timeout: CLI_TIMEOUT_MS,
          detached: process.platform !== 'win32',
          ...options,
        },
        (error, stdout, stderr) => {
          // A process ended by a signal reports that signal as its status.
          if (error && typeof error.code !== 'number' && !error.signal)
            reject(Object.assign(error, { stdout, stderr }));
          else resolve({ status: error ? (error.signal ?? error.code) : 0, stdout, stderr });
        },
      );
    });
    running.add(child);
    child.once('close', () => running.delete(child));
    return { child, result: Promise.all([result, reaper.track(child)]).then(([value]) => value) };
  };
  const launchCli = (args, extraEnvironment = {}, from = cwd) =>
    launch(process.execPath, [cli, ...args], { cwd: from, env: { ...environment, ...extraEnvironment } });
  const run = (args, extraEnvironment, from) => launchCli(args, extraEnvironment, from).result;
  const start = async (args) => {
    const result = await run(['mirage', 'start', ...args, '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const writeCatalogue = async (file, { all = false, project, port = 0 } = {}) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        sourceRoot: defaults,
        defaultSite: 'first',
        portals: all ? 'all' : 'selected',
        sites: Object.fromEntries(
          (all ? ['first', 'second'] : ['first']).map((id) => [
            id,
            {
              source: 'portal',
              environments: { dev: 'https://invented.example.invalid' },
              mirage: { solutionRoots: [], port, ...(project ? { project } : {}) },
            },
          ]),
        ),
      }),
    );
  };
  const replay = async (hint, capture = false, from = cwd, selectedShell) => {
    const shell = selectedShell ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
    const cmd = shell === 'cmd.exe';
    const args = cmd
      ? ['/d', '/s', '/v:on', '/c', hint]
      : shell.endsWith('powershell.exe') || shell.endsWith('pwsh.exe')
        ? ['-NoProfile', '-NonInteractive', '-Command', hint]
        : ['-c', hint];
    const result = await launch(shell, args, {
      cwd: from,
      windowsVerbatimArguments: cmd,
      env: {
        ...environment,
        PATH: cwd + path.delimiter + process.env.PATH,
        PAQ_REAL_CLI: cli,
        PAQ_NPX_SHIM: shim,
        ...(capture
          ? {
              PAQ_CAPTURE_HINT: '1',
              NODE_OPTIONS: ((environment.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(preload).href).trim(),
            }
          : {}),
      },
    }).result;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  return { directory, cwd, alternate, defaults, launchCli, run, start, writeCatalogue, replay, dispose };
}

export function fixtureStatusURL(session) {
  let address;
  try {
    address = new URL(session.url);
  } catch {
    throw new Error('Expected an owned HTTP loopback runtime address.');
  }
  const port = Number(address.port || 80);
  if (
    address.protocol !== 'http:' ||
    address.hostname !== '127.0.0.1' ||
    address.username ||
    address.password ||
    address.pathname !== '/' ||
    address.search ||
    address.hash ||
    !/^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/?$/.test(session.url) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Expected an owned HTTP loopback runtime address.');
  // Only the validated numeric listener port crosses this boundary. Neither
  // a record's URL nor any file content becomes a request host/path/header.
  return `http://127.0.0.1:${port}/_sim/api/status`;
}
const requestStatus = (session) =>
  fetch(fixtureStatusURL(session), { redirect: 'error', signal: AbortSignal.timeout(5000) });
export const alive = async (session) => assert.equal((await requestStatus(session)).status, 200);
export const stopped = (session) => assert.rejects(requestStatus(session), /fetch failed/);
export const portalProject = (sourceDir) => ({
  version: 2,
  defaultPortal: 'first',
  portals: ['first', 'second'].map((id) => ({ id, path: sourceDir })),
  solutions: [],
});
