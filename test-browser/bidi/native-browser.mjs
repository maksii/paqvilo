import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { makeTemporaryDirectory, ownedFixture, removeFixtureDirectory } from '../../mirage/testing/owned-fixture.mjs';
import { startOnFreePort } from '../helpers/debug-port.mjs';

const COMMAND_TIMEOUT = 10_000;
const STARTUP_TIMEOUT = 30_000;

async function connect(address, dispose) {
  const endpoint = new URL(address);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password)
    throw new Error('Native BiDi probe requires an owned loopback WebSocket.');
  const socket = new WebSocket(endpoint);
  dispose(() => socket.close());
  const pending = new Map();
  const events = new EventEmitter();
  let sequence = 0;
  socket.addEventListener('close', () => {
    for (const command of pending.values()) command.reject(new Error('Native BiDi connection closed.'));
  });
  socket.addEventListener('message', ({ data }) => {
    const packet = JSON.parse(data);
    if (packet.type === 'event') {
      events.emit(packet.method, packet.params);
      return;
    }
    const command = pending.get(packet.id);
    if (packet.type === 'success') command?.resolve(packet.result);
    if (packet.type === 'error') command?.reject(Object.assign(new Error(packet.message), { code: packet.error }));
  });
  await once(socket, 'open', { signal: AbortSignal.timeout(STARTUP_TIMEOUT) });
  return {
    on(method, listener) {
      events.on(method, listener);
      return () => events.off(method, listener);
    },
    async send(method, params = {}, { timeout = COMMAND_TIMEOUT } = {}) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Native BiDi connection is unavailable.');
      const id = ++sequence;
      const { promise, resolve, reject } = Promise.withResolvers();
      pending.set(id, { resolve, reject });
      const timer = setTimeout(
        () => reject(Object.assign(new Error(`${method} did not answer in ${timeout} ms.`), { code: 'probe timeout' })),
        timeout,
      );
      try {
        socket.send(JSON.stringify({ id, method, params }));
        return await promise;
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
  };
}

function startProcess(command, args, owner, beforeExit = async () => {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const ended = once(child, 'exit').catch((error) => error);
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    diagnostics = (diagnostics + text).slice(-8192);
  });
  owner.add(async () => {
    try {
      await beforeExit();
    } finally {
      child.kill();
      const guard = new AbortController();
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
      try {
        await Promise.race([
          ended,
          delay(5_000, undefined, { signal: guard.signal }).then(() => {
            throw new Error('The owned native browser process did not exit.');
          }),
        ]);
      } finally {
        guard.abort();
        clearTimeout(force);
      }
    }
  });
  return { child, ended, diagnostics: () => diagnostics };
}

async function firefoxEndpoint(process) {
  const listening = Promise.withResolvers();
  const report = () => {
    const match = /WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(process.diagnostics());
    if (match) listening.resolve(match[1] + '/session');
  };
  report();
  process.child.stderr.on('data', report);
  const timer = setTimeout(
    () => listening.reject(new Error('Firefox did not publish its BiDi port.')),
    STARTUP_TIMEOUT,
  );
  try {
    return await Promise.race([
      listening.promise,
      process.ended.then((exit) => {
        throw new Error(`Firefox exited before BiDi startup: ${exit}. ${process.diagnostics()}`);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    process.child.stderr.off('data', report);
  }
}

export async function startFirefox(t) {
  const owner = ownedFixture(t);
  const profile = await makeTemporaryDirectory(path.join(os.tmpdir(), 'lense-firefox-bidi-'));
  owner.remove(() => removeFixtureDirectory(profile));
  const command =
    process.env.LENSE_FIREFOX_BINARY ||
    (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox');
  let closeSocket, bidi;
  const launched = startProcess(
    command,
    ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0', 'about:blank'],
    owner,
    async () => {
      try {
        await bidi?.send('session.end');
      } finally {
        closeSocket?.();
      }
    },
  );
  bidi = await connect(await firefoxEndpoint(launched), (close) => {
    closeSocket = close;
  });
  const { capabilities } = await bidi.send('session.new', {
    capabilities: { alwaysMatch: { browserName: 'firefox' } },
  });
  return { bidi, capabilities };
}

async function driverRequest(origin, endpoint, { body, method = body ? 'POST' : 'GET', signal } = {}) {
  const response = await fetch(origin + endpoint, {
    method,
    ...(body && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(COMMAND_TIMEOUT),
  });
  const { value } = await response.json();
  if (!response.ok) throw new Error(`Safari WebDriver ${endpoint} failed: ${value?.message ?? response.statusText}`);
  return value;
}

const SAFARI_HTTP_SERVICE = 'com.apple.WebDriver.HTTPService';

function safariServicesBeforeLaunch() {
  // launchd owns Safari's helper process, so the driver process is not its parent.
  const result = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], { encoding: 'utf8', timeout: 2_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not enumerate Safari WebDriver services.');
  return new Set(
    result.stdout
      .split('\n')
      .filter((line) => line.endsWith('/' + SAFARI_HTTP_SERVICE))
      .map((line) => line.trim().split(/\s+/)[0]),
  );
}

function safariListener(port) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  if (result.error) throw result.error;
  const listeners = [...result.stdout.matchAll(/^p(\d+)\nc([^\n]+)$/gm)];
  if (listeners.length !== 1 || listeners[0][2] !== SAFARI_HTTP_SERVICE) return null;
  return listeners[0][1];
}

async function waitForDriver(origin, launched, previousServices) {
  const signal = AbortSignal.timeout(STARTUP_TIMEOUT);
  const port = new URL(origin).port;
  while (!signal.aborted) {
    if (!launched.child.pid || launched.child.exitCode !== null || launched.child.signalCode !== null)
      throw new Error(`Safari WebDriver exited before startup. ${launched.diagnostics()}`);
    const listener = safariListener(port);
    if (
      listener &&
      !previousServices.has(listener) &&
      (await driverRequest(origin, '/status', { signal }).catch(() => null))?.ready
    )
      return listener;
    await delay(100, undefined, { signal }).catch((error) => {
      if (!signal.aborted) throw error;
    });
  }
  throw new Error('Safari WebDriver did not become ready.');
}

export async function startSafari(t) {
  const owner = ownedFixture(t);
  return startOnFreePort(async (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const previousServices = safariServicesBeforeLaunch();
    let session, closeSocket;
    const launched = startProcess('/usr/bin/safaridriver', ['--port', String(port), '--bidi', '0'], owner, async () => {
      closeSocket?.();
      if (session) await driverRequest(origin, session, { method: 'DELETE' });
    });
    const service = await waitForDriver(origin, launched, previousServices);
    const { sessionId, capabilities } = await driverRequest(origin, '/session', {
      body: {
        capabilities: {
          alwaysMatch: { browserName: 'safari', webSocketUrl: true, 'safari:experimentalWebSocketUrl': true },
        },
      },
    });
    session = `/session/${sessionId}`;
    const endpoint = new URL(capabilities.webSocketUrl);
    if (safariListener(endpoint.port) !== service || endpoint.pathname !== session)
      throw new Error('Safari WebDriver did not expose the owned BiDi port.');
    const bidi = await connect(endpoint, (close) => {
      closeSocket = close;
    });
    return { bidi, capabilities };
  });
}
