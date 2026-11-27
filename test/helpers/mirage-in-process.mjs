// Test-only: the Mirage lifecycle commands run in the test process against runtimes that are loopback listeners of
// the test process instead of operating-system processes. The product code under test is unchanged: `mirage()` (the
// command), `start`, `stopOwnedSessions`, `mirageStatus`, the ownership records, the discovery records, the start
// channel and the HTTP status/shutdown contract are the real ones. Only the process table is the test's own
// (runtimeHost): which PID runs, with which start identity, and what a signal does to it.
//
// A real runtime start costs seconds of CPU; a test whose subject is which record a stop selects, which hint a start
// prints or whether a start reuses a runtime needs none. The process boundary itself (a detached runtime that outlives
// the command, a shell that replays a hint, a runtime that is ended by force) is covered by the tests that start real
// runtimes: test/mirage-process-boundary.test.mjs, which also holds this fixture to the real runtime's contract.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import mirage, { mirageCommandConfiguration, portAvailable } from '../../lense/commands/mirage.mjs';
import { LENSE_OPTIONS, parseOptions } from '../../lense/cli-options.mjs';
import { failureDocument, jsonEnvelope } from '../../lense/cli-envelope.mjs';
import { newStartIdentity } from '../../lense/process-identity.mjs';
import { START_CHANNEL_ENV, startChannelReporter } from '../../lense/start-channel.mjs';
import {
  makeTemporaryDirectory,
  makeTemporaryDirectorySync,
  ownedFixture,
} from '../../mirage/testing/owned-fixture.mjs';
import { FILES } from '../fixture.mjs';

export const cli = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));

// PIDs no operating system hands out next to a test run: Linux ends at 4194304, and Windows reuses low numbers. A
// code path that reached the real process table with one of them would find nothing, never another program.
const FIRST_PID = 2_000_000_000;
let lastPid = FIRST_PID;

const SERVE_OPTIONS = {
  'state-dir': { type: 'string' },
  port: { type: 'string' },
  state: { type: 'string' },
  project: { type: 'string' },
  portal: { type: 'string' },
  source: { type: 'string' },
  site: { type: 'string' },
  runtime: { type: 'string' },
  simulation: { type: 'string' },
  preset: { type: 'string' },
  'preset-mode': { type: 'string' },
};

/**
 * The process table of a test, in the shape the lifecycle commands take as their host (lense/commands/mirage.mjs
 * hostOf). `spawnRuntime` starts a runtime double from the argv a real runtime would be started with: it listens on
 * the port that argv names, publishes the discovery record a real runtime publishes for it, announces itself on the
 * start channel and answers the status and shutdown requests of the toolkit. `launches` lists every start, `kills`
 * every signal. A runtime double can be told to behave like the cases a stop must handle: `refuseShutdown()` (it
 * answers 503, so the stop signals it), `ignore('SIGTERM')`, and `reusePid()` (the runtime has gone and its PID
 * belongs to another program, which must never be signalled). `failNextStart(text)` makes the next runtime write
 * `text` to its start-up log and exit with code 1 before it is ready, as a runtime that refuses its settings does.
 */
export function runtimeHost(t) {
  const runtimes = new Map();
  // The loopback ports reservePair holds for a start, by port: a runtime double adopts its server (runtimeDouble).
  const reserved = new Map();
  let refusal = null;
  // Set when the test's fixtures are released. A start still running then (a sibling of a failed Promise.all) must
  // not leave a reserved pair or a runtime listening after the cleanup, or the test process never exits.
  let released = false;
  const afterRelease = () => new Error('The test ended before this start finished');
  const host = {
    launches: [],
    kills: [],
    failNextStart(text) {
      refusal = text;
    },
    /** The runtime double with this PID. */
    runtime: (pid) => runtimes.get(pid),
    /** Holds a free consecutive loopback pair for one start and returns its base port (reservePair). */
    reservePair: async () => {
      const base = await reservePair(reserved);
      if (!released) return base;
      for (const port of [base, base + 1]) reserved.get(port)?.close();
      reserved.delete(base);
      reserved.delete(base + 1);
      throw afterRelease();
    },
    /** A reserved port is free for the start that holds it; any other port is asked of the operating system. */
    portAvailable: async (port) => reserved.has(port) || portAvailable(port),
    alive: (pid) => Boolean(runtimes.get(pid)?.running),
    identityOf: async (pid) => {
      const runtime = runtimes.get(pid);
      return runtime?.running ? runtime.identity : null;
    },
    kill(pid, signal) {
      host.kills.push([pid, signal]);
      const runtime = runtimes.get(pid);
      if (!runtime?.running) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      // A signal to another program is recorded above and changes nothing here: the test asserts there is none.
      if (!runtime.foreign && !runtime.ignored.has(signal)) runtime.end({ signal });
      return true;
    },
    spawnRuntime(command, argv, options) {
      if (released) throw afterRelease();
      const pid = ++lastPid;
      const child = Object.assign(new EventEmitter(), {
        pid,
        exitCode: null,
        signalCode: null,
        killed: false,
        unref() {},
        kill(signal = 'SIGTERM') {
          child.killed = true;
          try {
            return host.kill(pid, signal);
          } catch {
            return false;
          }
        },
      });
      const runtime = runtimeDouble({ pid, child, argv, options, reserved });
      runtimes.set(pid, runtime);
      host.launches.push(runtime);
      if (refusal === null) runtime.boot().catch(() => runtime.end({ code: 1 }));
      else {
        // The launcher hands the runtime its start-up log as standard output and error, open while it spawns.
        fsSync.writeSync(options.stdio[2], `${refusal}\n`);
        refusal = null;
        runtime.running = false;
        child.exitCode = 1;
      }
      return child;
    },
  };
  ownedFixture(t).add(async () => {
    released = true;
    for (const runtime of runtimes.values()) await runtime.close();
    // Ports reserved for a start that no runtime adopted.
    for (const server of reserved.values()) server.close();
    reserved.clear();
  });
  return host;
}

function runtimeDouble({ pid, child, argv, options, reserved }) {
  const [, action, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: SERVE_OPTIONS, strict: false });
  const csrf = createHash('sha256').update(`csrf ${pid}`).digest('hex');
  const stateDir = path.resolve(values['state-dir']);
  const discovery = path.join(stateDir, 'simulator', `session-${pid}.json`);
  const servers = [];
  const holds = new Map();
  let shutdown = 'accept';
  const runtime = {
    pid,
    argv,
    /** The options of the serve command line, as the runtime parses them. */
    values,
    environment: options?.env ?? {},
    identity: newStartIdentity('win32'),
    running: true,
    foreign: false,
    ignored: new Set(),
    url: null,
    record: null,
    /** The runtime stays up and answers its shutdown request 503. */
    refuseShutdown() {
      shutdown = 'refuse';
    },
    ignore(signal) {
      runtime.ignored.add(signal);
    },
    /**
     * Holds the answer to requests for `pathname` until `release()`: `asked` resolves when one arrives, and release()
     * answers the held requests the way the runtime answers any request (a late answer).
     */
    hold(pathname) {
      let resolveAsked;
      const asked = new Promise((resolve) => {
        resolveAsked = resolve;
      });
      const pending = [];
      holds.set(pathname, (request, response) => {
        pending.push([request, response]);
        resolveAsked();
      });
      return {
        asked,
        release() {
          holds.delete(pathname);
          for (const [request, response] of pending.splice(0)) answer(request, response);
        },
      };
    },
    /** The runtime has gone without a trace of its own and another program now holds its PID. */
    async reusePid() {
      await runtime.close();
      runtime.running = true;
      runtime.foreign = true;
      runtime.identity = newStartIdentity('win32');
    },
    async boot() {
      assert.equal(action, 'serve', 'the toolkit starts a runtime with the serve command');
      let kind = values.runtime ?? 'power-pages',
        project = null;
      if (values.project) {
        const { loadProjectConfig } = await import('../../mirage/lib/project-config.mjs');
        project = await loadProjectConfig(values.project);
        kind = values.runtime ?? project.runtime?.kind ?? 'power-pages';
      }
      const listen = () =>
        new Promise((resolve, reject) => {
          const port = Number(values.port ?? 0);
          // A pair the start reserved is adopted as it stands: nothing binds the port again.
          if (reserved.has(port)) {
            const held = reserved.get(port);
            reserved.delete(port);
            held.on('request', answer);
            servers.push(held);
            return resolve(`http://127.0.0.1:${held.address().port}`);
          }
          const server = http.createServer((request, response) => answer(request, response));
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => {
            servers.push(server);
            resolve(`http://127.0.0.1:${server.address().port}`);
          });
        });
      const url = await listen();
      // Ended while it was binding: end() found it already stopped, so the listener just bound is closed here.
      if (!runtime.running) {
        for (const server of servers.splice(0)) {
          server.close();
          server.closeIdleConnections();
        }
        return;
      }
      const stateFile = path.resolve(values.state);
      const origins = { url, adminUrl: `${url}/_sim/`, appsUrl: `${url}/_apps/` };
      // Each record has the fields a real runtime of that kind publishes (mirage/cli.mjs), which
      // test/mirage-process-boundary.test.mjs compares with a real runtime's record.
      if (kind !== 'power-pages')
        runtime.record = {
          pid,
          runtime: { kind },
          project: project?.configFile ?? null,
          sourceDir: null,
          stateFile,
          url,
          adminUrl: origins.adminUrl,
          discovery,
        };
      else if (project) {
        const portal = project.portals.find((item) => item.id === (values.portal ?? project.defaultPortal));
        assert.ok(portal, `the project names portal ${values.portal}`);
        runtime.record = {
          pid,
          project: project.configFile,
          portals: [{ id: portal.id, sourceDir: portal.sourceDir, stateFile, ...origins }],
          discovery,
        };
      } else runtime.record = { pid, ...origins, sourceDir: values.source, stateFile };
      runtime.kind = kind;
      runtime.url = url;
      // A runtime saves its state where it was told to, unless it keeps its records in memory (dry-run); one that
      // finds a state file keeps it.
      if (values.simulation !== 'dry-run') {
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        await fs.writeFile(stateFile, '{}', { flag: 'wx' }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
      await fs.mkdir(path.dirname(discovery), { recursive: true });
      await fs.writeFile(discovery, JSON.stringify(runtime.record, null, 2));
      // The announcement a real runtime makes once its record is published (mirage/cli.mjs).
      startChannelReporter(runtime.environment[START_CHANNEL_ENV])({ phase: 'ready', elapsedMs: 0 });
    },
    /** Ends the runtime as an exit of its process: by itself (`code`) or by a signal. */
    end({ code = null, signal = null, graceful = false } = {}) {
      if (!runtime.running || runtime.foreign) return;
      runtime.running = false;
      // A listener stops accepting at once; the answer being written still reaches its reader.
      for (const server of servers.splice(0)) {
        server.close();
        server.closeIdleConnections();
      }
      // A runtime that shuts down removes its discovery record; one that is ended leaves it behind.
      if (graceful) fsSync.rmSync(discovery, { force: true });
      child.exitCode = signal ? null : (code ?? 0);
      child.signalCode = signal;
      child.emit('exit', child.exitCode, signal);
    },
    async close() {
      if (runtime.foreign) {
        runtime.running = false;
        return;
      }
      runtime.end({ signal: 'SIGKILL' });
    },
  };
  const status = () => ({
    site: values.site ?? null,
    pageCount: 0,
    runtime: { kind: runtime.kind },
    liveWrites: 'disabled',
    startupPreset: { name: values.preset ?? null, mode: values['preset-mode'] ?? 'always', applied: false },
    adminUrl: runtime.record?.adminUrl ?? runtime.record?.portals?.[0]?.adminUrl,
  });
  function answer(request, response) {
    const send = (code, body) => {
      // No connection is kept: a stopped runtime must refuse the next request, not answer it on an old socket.
      response.writeHead(code, { 'content-type': 'application/json', connection: 'close' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const { pathname } = new URL(request.url, 'http://127.0.0.1');
    const hold = holds.get(pathname);
    if (hold) return hold(request, response);
    if (runtime.respond?.(request, response, send)) return;
    if (request.method === 'GET' && pathname === '/_sim/api/status') return send(200, status());
    if (request.method === 'GET' && pathname === '/_sim/api/state') return send(200, { csrf, status: status() });
    if (request.method === 'POST' && pathname === '/_sim/api/shutdown') {
      if (shutdown === 'refuse' || request.headers['x-sim-csrf'] !== csrf) return send(503);
      runtime.end({ code: 0, graceful: true });
      return send(202);
    }
    return send(404);
  }
  return runtime;
}

/** The commands and working directory a printed hint runs, without a shell: both forms the toolkit prints. */
export function hintCommands(hint) {
  if (hint.startsWith('node -e ')) {
    const inline = /inflateRawSync\(Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(hint)?.[1];
    const stored = /fs\.openSync\(Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(hint)?.[1];
    assert.ok(inline || stored, 'an encoded hint carries its argv, or the file that holds it');
    const data = inline
      ? inflateRawSync(Buffer.from(inline, 'base64'))
      : fsSync.readFileSync(Buffer.from(stored, 'base64').toString('utf8'));
    if (stored)
      assert.ok(hint.includes(`'${createHash('sha256').update(data).digest('hex')}'`), 'a stored payload is unchanged');
    const directory = /cwd:Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(hint)?.[1];
    return {
      cwd: directory ? Buffer.from(directory, 'base64').toString('utf8') : null,
      commands: JSON.parse(data.toString('utf8')).map(([program, ...argv]) => {
        assert.equal(program, cli, 'an encoded hint runs the toolkit that printed it');
        return argv;
      }),
    };
  }
  const tokens =
    process.platform === 'win32'
      ? hint.match(/"[^"]*"|[^\s"]+/g).map((token) => (token.startsWith('"') ? token.slice(1, -1) : token))
      : hint.match(/(?:'[^']*'|"[^"]*"|[^\s'"]+)+/g).map((token) =>
          token
            .match(/'[^']*'|"[^"]*"|[^'"]+/g)
            .map((part) => (/^["']/.test(part) ? part.slice(1, -1) : part))
            .join(''),
        );
  assert.deepEqual(tokens.slice(0, 2), ['npx', 'paqvilo'], 'a readable hint runs the toolkit through npx');
  return { cwd: null, commands: [tokens.slice(2)] };
}

// One command at a time: a command reads the working directory, the environment and the console of the process.
let turn = Promise.resolve();
const inTurn = (run) => {
  const result = turn.then(run);
  turn = result.catch(() => {});
  return result;
};

/**
 * Where a command runs when its test names no directory: an empty directory of this test process, never the toolkit
 * checkout the tests are run from. A start run from a project folder notes its record folder in that folder's
 * `.paqvilo` and every status and stop run there reads the noted folders (lense/commands/mirage.mjs recordFolders). In
 * the checkout that note is shared by every test process, each with a process table of its own whose PIDs start at
 * the same number: the stop of one process took the runtimes another had recorded for exited and removed their records.
 */
let ownDirectory = null;
function neutralDirectory() {
  if (!ownDirectory) {
    ownDirectory = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-in-process-'));
    process.once('exit', () => {
      // At exit nothing can report a failure: a folder Windows still holds open stays in the temporary folder.
      try {
        fsSync.rmSync(ownDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* left for the system's temporary-folder cleanup */
      }
    });
  }
  return ownDirectory;
}

/**
 * Runs `paqvilo <argv>` (a Mirage lifecycle command: `['mirage', action, ...options]`) in this process from `cwd`,
 * with the toolkit's settings removed from the environment as a clean shell has none, and returns what the command
 * line would: its exit status, standard output and standard error. `host` is the process table (runtimeHost).
 */
export function runMirage(argv, { cwd = neutralDirectory(), host } = {}) {
  return inTurn(async () => {
    assert.equal(argv[0], 'mirage', 'the in-process runner runs Mirage lifecycle commands');
    const stdout = [],
      stderr = [];
    const previous = {
      cwd: process.cwd(),
      log: console.log,
      error: console.error,
      exitCode: process.exitCode,
      settings: Object.entries(process.env).filter(([key]) => key.startsWith('PAQVILO_')),
    };
    for (const [key] of previous.settings) delete process.env[key];
    process.chdir(cwd);
    let status,
      phase = 'arguments',
      positionals = [],
      json = argv.includes('--json');
    // Every JSON line gets the envelope a command line prints (lense/cli.mjs), so a result read here has its fields.
    const envelope = (text) => jsonEnvelope(text, { command: 'mirage', positionals: ['mirage', ...positionals] });
    console.log = (...values) => stdout.push(json ? envelope(values.join(' ')) : values.join(' '));
    console.error = (...values) => stderr.push(values.join(' '));
    process.exitCode = undefined;
    try {
      const parsed = parseOptions({
        args: argv.slice(1),
        allowPositionals: true,
        options: LENSE_OPTIONS,
      });
      positionals = parsed.positionals;
      json = parsed.values.json === true;
      phase = 'configuration';
      const cfg = await mirageCommandConfiguration(parsed.values, positionals[0] ?? 'status', {
        env: { ...process.env },
      });
      phase = 'execution';
      status = (await mirage(cfg, parsed.values, positionals, host)) || process.exitCode || 0;
    } catch (error) {
      status = 1;
      // The failure a command line prints (lense/cli.mjs).
      if (json) stdout.push(envelope(JSON.stringify(failureDocument(error, { command: 'mirage', phase }))));
      else stderr.push(`paqvilo: ${error.message}`);
    } finally {
      console.log = previous.log;
      console.error = previous.error;
      process.chdir(previous.cwd);
      process.exitCode = previous.exitCode;
      Object.assign(process.env, Object.fromEntries(previous.settings));
    }
    return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  });
}

/** A portal export as the toolkit reads one: the files of the shared test portal, without a repository. */
async function writePortal(directory) {
  for (const [name, content] of Object.entries(FILES)) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

/**
 * Writes a catalogue file that reads the portal export at `sourceRoot`: its first site, or both sites when `all`. The
 * sites use the Mirage `project` (when given) and `port`.
 */
export const catalogueWriter =
  (sourceRoot) =>
  async (file, { all = false, project, port = 0 } = {}) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        sourceRoot,
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

/**
 * A temporary folder for one lifecycle scenario, with the commands of a command line run in-process (runMirage)
 * against a process table of its own (`host`): two checkouts of a portal export, a directory the commands run from,
 * `start` (a `mirage start --json` that must succeed, parsed), `run`, `writeCatalogue` and `replay`, which runs the
 * commands a printed hint holds from another directory (hintCommands).
 */
export async function workspace(t) {
  const host = runtimeHost(t);
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-lifecycle-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const defaults = path.join(directory, 'default checkout');
  const alternate = path.join(directory, 'alternate checkout');
  await Promise.all([writePortal(path.join(defaults, 'portal')), writePortal(path.join(alternate, 'portal'))]);
  const cwd = path.join(directory, 'copy hint here');
  await fs.mkdir(cwd);
  const run = (args, from = cwd) => runMirage(args, { cwd: from, host });
  const start = async (args, from) => {
    const result = await run(['mirage', 'start', ...args, '--json'], from);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const writeCatalogue = catalogueWriter(defaults);
  /** Runs the commands of `hint` as a shell started in `from` would; every one must succeed. */
  const replay = async (hint, from = cwd) => {
    const { commands, cwd: encoded } = hintCommands(hint);
    const results = [];
    for (const argv of commands) {
      const result = await run(argv, encoded ?? from);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      results.push(result);
    }
    return results;
  };
  return { host, directory, cwd, alternate, defaults, run, start, writeCatalogue, replay };
}

/**
 * Holds a free consecutive loopback pair for one start: both ports stay bound by the harness, in `reserved`, until the
 * runtime doubles of that start adopt them (runtimeDouble), so no other process can take one in between. Returns the
 * base port.
 */
async function reservePair(reserved) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const servers = [http.createServer(), http.createServer()];
    let kept = false;
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
      reserved.set(base, servers[0]);
      reserved.set(base + 1, servers[1]);
      kept = true;
      return base;
    } catch (error) {
      // EACCES: Windows reserves port ranges (Hyper-V, WSL) that refuse a bind; such a pair is skipped like a used one.
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    } finally {
      if (!kept)
        await Promise.all(
          servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))),
        );
    }
  }
  throw new Error('The loopback fixture could not reserve consecutive ports.');
}

/**
 * Starts a two-portal group with `mirage start <selectors(base)>` on a reserved consecutive pair and returns the base
 * port and the start's JSON.
 */
export async function startOnPair(work, selectors) {
  const base = String(await work.host.reservePair());
  return { base, started: await work.start(selectors(base)) };
}

const statusOf = (session) => fetch(new URL('/_sim/api/status', session.url), { redirect: 'error' });
/** The runtime of this session answers its status. */
export const alive = async (session) => assert.equal((await statusOf(session)).status, 200);
/** Nothing listens where this session's runtime answered. */
export const stopped = (session) => assert.rejects(statusOf(session), /fetch failed/);
export const portalProject = (sourceDir) => ({
  version: 2,
  defaultPortal: 'first',
  portals: ['first', 'second'].map((id) => ({ id, path: sourceDir })),
  solutions: [],
});
