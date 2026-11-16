// @test-kind security: an agent discovery file holds a bearer token; it does not outlive an owner that can observe its own end, and a file whose owner is gone is rejected by readers, never probed and swept by the next agent start
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  discoveryOwner,
  discoveryOwnerGone,
  sweepStaleDiscovery,
  writeOwnedDiscovery,
} from '../lense/agent-discovery.mjs';
import { startAgentServer } from '../lense/agent-server.mjs';
import { listAgentSessions, readDiscovery } from '../lense/commands/agent.mjs';
import { tempDirSync } from './fixture.mjs';

const MODULE = new URL('../lense/agent-discovery.mjs', import.meta.url).href;
// A PID no process has: above the largest Linux PID, and an invalid process handle value on Windows.
const NO_PROCESS = 0x7ffffffc;
const TOKEN = 'secret'.repeat(8);

function stateDir(t) {
  const dir = tempDirSync('pp-agent-discovery-');
  ownedFixture(t).remove(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.mkdirSync(path.join(dir, 'agents'));
  return dir;
}

const discovery = (extra = {}) => ({
  schemaVersion: 1,
  id: 'fixture-session',
  token: TOKEN,
  endpoint: 'http://127.0.0.1:9',
  site: 'fixture',
  environment: 'local',
  ...discoveryOwner(),
  startedAt: new Date().toISOString(),
  ...extra,
});

// A process that owns one discovery file and then ends the way `mode` says. 'wait' reports that the file is written
// and stays alive until it is ended from outside.
const OWNER = `
import { discoveryOwner, writeOwnedDiscovery } from ${JSON.stringify(MODULE)};
const [file, mode] = process.argv.slice(1);
writeOwnedDiscovery(file, {
  schemaVersion: 1,
  id: 'owner',
  token: ${JSON.stringify(TOKEN)},
  endpoint: 'http://127.0.0.1:9',
  ...discoveryOwner(),
  startedAt: new Date().toISOString(),
});
if (mode === 'exit') process.exit(3);
if (mode === 'throw') throw new Error('uncaught in the owner');
if (mode === 'wait') {
  process.stdout.write('written\\n');
  setInterval(() => {}, 2 ** 30);
}
`;

function owner(t, file, mode) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', OWNER, file, mode], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }));
  ownedFixture(t).add(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return { child, closed, written: once(child.stdout, 'data') };
}

test('the owner removes its discovery file when it ends normally, exits or throws', async (t) => {
  const dir = stateDir(t);
  const ends = { end: 0, exit: 3, throw: 1 };
  await Promise.all(
    Object.entries(ends).map(async ([mode, code]) => {
      const file = path.join(dir, 'agents', `${mode}.json`);
      const ended = await owner(t, file, mode).closed;
      assert.equal(ended.code, code, `${mode}: the owner ended the way the scenario says`);
      assert.equal(fs.existsSync(file), false, `${mode}: no token file is left behind`);
    }),
  );
});

test('a signal that ends the owner removes its file first; an end the owner cannot observe leaves a stale file', async (t) => {
  const dir = stateDir(t);
  // Windows ends a signalled process without notice (TerminateProcess), like SIGKILL: no code of the owner runs.
  const signals = process.platform === 'win32' ? ['SIGKILL'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL'];
  await Promise.all(
    signals.map(async (signal) => {
      const file = path.join(dir, 'agents', `${signal}.json`);
      const { child, closed, written } = owner(t, file, 'wait');
      await written;
      const recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(recorded.pid, child.pid);
      child.kill(signal);
      const ended = await closed;
      if (signal === 'SIGKILL') {
        assert.equal(fs.existsSync(file), true, 'an owner ended without notice cannot remove its file');
        return;
      }
      assert.equal(ended.signal, signal, 'the signal still ends the owner as it would without the file');
      assert.equal(fs.existsSync(file), false, `${signal}: no token file is left behind`);
    }),
  );
});

test('with another listener for the signal, the stop is left to it and the file stays until the agent closes', (t) => {
  const dir = stateDir(t);
  const file = path.join(dir, 'agents', 'listened.json');
  let stops = 0;
  const stop = () => stops++;
  process.on('SIGINT', stop);
  t.after(() => process.off('SIGINT', stop));
  const before = process.listenerCount('SIGINT');
  const release = writeOwnedDiscovery(file, discovery());
  assert.equal(process.listenerCount('SIGINT'), before + 1);
  process.emit('SIGINT');
  assert.equal(stops, 1);
  assert.equal(fs.existsSync(file), true, 'the session goes on until its owner stops it');
  release();
  assert.equal(fs.existsSync(file), false);
  assert.equal(process.listenerCount('SIGINT'), before, 'the last release removes the process listeners');
  release();
});

test('a discovery file whose owner is gone is told from a live one without starting a process', () => {
  assert.equal(discoveryOwnerGone(discovery()), false, 'this process, a file written now');
  assert.equal(discoveryOwnerGone(discovery({ pid: NO_PROCESS })), true, 'no process has that PID');
  assert.equal(discoveryOwnerGone(discovery({ pid: undefined })), true);
  assert.equal(discoveryOwnerGone(discovery({ pid: -1 })), true);
  // The PID of this process, in a file written before this process started: the PID was used again.
  assert.equal(
    discoveryOwnerGone(discovery({ startedAt: new Date(performance.timeOrigin - 60_000).toISOString() })),
    true,
  );
  // The parent process is alive under its own PID.
  assert.equal(discoveryOwnerGone(discovery({ pid: process.ppid, processStart: null })), false);
  // A live process under the recorded PID with another start identity is another process. Reading a start identity
  // starts no process only on Linux (/proc); elsewhere a reused PID of a live process is not detected.
  assert.equal(
    discoveryOwnerGone(discovery({ pid: process.ppid, processStart: 'another start' })),
    process.platform === 'linux',
  );
});

test('a stale discovery file is rejected by readers and listed without sending its token anywhere', async (t) => {
  const dir = stateDir(t);
  const authorizations = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.end(JSON.stringify({ schemaVersion: 1, id: 'fixture-session' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  // Something answers on the recorded port, as after the port was given to another process.
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const stale = path.join(dir, 'agents', 'stale.json');
  fs.writeFileSync(stale, JSON.stringify(discovery({ id: 'stale-session', endpoint, pid: NO_PROCESS })));
  await assert.rejects(
    readDiscovery(stale),
    (error) => error.code === 'session_stale' && !error.message.includes(TOKEN),
  );
  const live = path.join(dir, 'agents', 'live.json');
  fs.writeFileSync(live, JSON.stringify(discovery({ endpoint })));
  assert.equal((await readDiscovery(live)).id, 'fixture-session');
  const report = await listAgentSessions(dir);
  assert.deepEqual(
    report.sessions.map((session) => [session.id, session.reachable]),
    [
      ['fixture-session', true],
      ['stale-session', false],
    ],
  );
  assert.match(report.sessions[1].error, /owner process is gone/);
  assert.deepEqual(authorizations, [`Bearer ${TOKEN}`], 'only the live session was probed');
  assert.equal(JSON.stringify(report).includes(TOKEN), false);
});

test('an agent start sweeps the stale discovery files of its state folder and keeps every other file', async (t) => {
  const dir = stateDir(t);
  const agents = path.join(dir, 'agents');
  const write = (name, content) => fs.writeFileSync(path.join(agents, name), content);
  write('gone.json', JSON.stringify(discovery({ pid: NO_PROCESS })));
  write(
    'reused.json',
    JSON.stringify(discovery({ startedAt: new Date(performance.timeOrigin - 60_000).toISOString() })),
  );
  write('parent.json', JSON.stringify(discovery({ pid: process.ppid, processStart: null })));
  write('other.json', JSON.stringify({ pid: NO_PROCESS, note: 'not a discovery file' }));
  write('broken.json', 'not json');
  write('notes.txt', 'kept');
  const release = writeOwnedDiscovery(path.join(agents, 'owned.json'), discovery());
  t.after(release);
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  const session = Object.assign(new EventEmitter(), {
    cfg: { stateDir: dir, origin: 'https://portal.example', siteName: 'fixture', envName: 'local', sourceDir: dir },
  });
  const server = await startAgentServer({ context, session });
  ownedFixture(t).add(() => server.close());
  const started = path.basename(server.discoveryFile);
  assert.deepEqual(
    fs.readdirSync(agents).sort(),
    ['broken.json', 'notes.txt', 'other.json', 'owned.json', 'parent.json', started].sort(),
  );
  const written = JSON.parse(fs.readFileSync(server.discoveryFile, 'utf8'));
  assert.equal(written.pid, process.pid);
  assert.equal(typeof written.startedAt, 'string');
  assert.equal(typeof written.processStart, process.platform === 'linux' ? 'string' : 'object');
  assert.equal((await readDiscovery(server.discoveryFile)).id, written.id);
  await server.close();
  assert.equal(fs.existsSync(server.discoveryFile), false);
  sweepStaleDiscovery(path.join(dir, 'missing'));
});
