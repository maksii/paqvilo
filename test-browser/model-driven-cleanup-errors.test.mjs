import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import run from '../lense/commands/model-driven.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

async function fixture(t, { resetDocument = false } = {}) {
  const owner = ownedFixture(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-model-close-'));
  owner.remove(() => fs.rm(directory, { recursive: true, force: true }));
  const solution = path.join(directory, 'solution');
  await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
  await fs.mkdir(path.join(solution, 'WebResources'));
  await fs.writeFile(
    path.join(solution, 'Other/Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  await fs.writeFile(
    path.join(solution, 'WebResources/x_script.js.data.xml'),
    '<WebResource><Name>x_script.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/x_script.js</FileName></WebResource>',
  );
  await fs.writeFile(
    path.join(solution, 'WebResources/x_script.js'),
    'document.querySelector("h1").textContent="local";fetch("/observed");',
  );
  const project = path.join(directory, 'project.yml');
  await fs.writeFile(
    project,
    'version: 2\nruntime:\n  kind: model-driven\nmodelDriven:\n  trustedExtensions: true\nsolutions:\n  - id: invented\n    path: ./solution\n',
  );
  let releaseDocument, documentRequested, observed;
  const documentGate = new Promise((resolve) => {
    releaseDocument = resolve;
  });
  const requested = new Promise((resolve) => {
    documentRequested = resolve;
  });
  const applied = new Promise((resolve) => {
    observed = resolve;
  });
  const methods = [];
  // This fixture deliberately resets its document and rejects CONNECT traffic.
  // Closing those owned streams can report a peer reset on Windows. Keep the
  // allowance at this transport boundary; every other stream error still fails.
  const streamError = (cause) => {
    if (!['ECONNRESET', 'EPIPE'].includes(cause.code)) server.emit('error', cause);
  };
  const server = http.createServer((request, response) => {
    request.on('error', streamError);
    response.on('error', streamError);
    if (!request.url.startsWith('/')) return response.writeHead(403).end();
    methods.push(request.method);
    if (request.url.startsWith('/observed')) {
      observed();
      return response.writeHead(200).end('ok');
    }
    if (request.url.startsWith('/WebResources/x_script.js'))
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end('window.native=true;');
    if (resetDocument && request.url.startsWith('/main.aspx')) {
      documentRequested();
      void documentGate.then(() => response.destroy());
      return;
    }
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        '<!doctype html><title>Owned model close</title><h1>Initial</h1><script src="/WebResources/x_script.js"></script>',
      );
  });
  server.on('connection', (socket) => socket.on('error', streamError));
  server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  owner.add(async () => {
    releaseDocument();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  const network = {
    proxy: { server: origin, bypass: '127.0.0.1,localhost' },
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
  };
  const agents = path.join(directory, '.paqvilo/agents');
  const blockDiscovery = async () => {
    const names = await fs.readdir(agents);
    const file = path.join(
      agents,
      names.find((name) => name.endsWith('.json')),
    );
    const discovery = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.unlink(file);
    await fs.mkdir(file);
    return { file, discovery };
  };
  return {
    owner,
    directory,
    project,
    origin,
    channel,
    network,
    requested,
    applied,
    releaseDocument,
    methods,
    agents,
    blockDiscovery,
  };
}

test(
  'actual model-driven CLI reports unsuccessful cleanup while preserving its final overlay receipt',
  { timeout: 30000 },
  async (t) => {
    const setup = await fixture(t);
    const { owner, directory, project, origin, channel } = setup;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(?:PAQVILO_|GIT_)/.test(key) &&
          !['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'].includes(key),
      ),
    );
    const outputFile = path.join(directory, 'overlay.json');
    const child = spawn(
      process.execPath,
      [
        '--import',
        new URL('./helpers/browser-loopback-preload.mjs', import.meta.url).href,
        fileURLToPath(new URL('../lense/cli.mjs', import.meta.url)),
        'model-driven',
        'dev',
        '--project',
        project,
        '--url',
        origin,
        '--browser',
        channel,
        '--headless',
        '--debug-port',
        '0',
        '--timeout',
        '5000',
        '--output',
        outputFile,
      ],
      {
        windowsHide: true,
        signal: t.signal,
        env: { ...env, PAQVILO_TEST_LOOPBACK_PROXY: origin },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '',
      blocker;
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-32000);
      });
    child.on('error', () => {}); // The test deadline owns Abort; still await stdio close.
    const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
    owner.add(async () => {
      if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
      await closed;
      if (blocker) await fs.rmdir(blocker.file);
    });
    await setup.applied;
    blocker = await setup.blockDiscovery();
    assert.equal(blocker.discovery.pid, child.pid);
    // The production timeout stops this exact CLI after the fault is installed.
    // No fixture credential is sent over HTTP and browser signal defaults stay intact.
    assert.equal(await closed, 1, 'filesystem cleanup failure must not produce a successful CLI exit');
    const report = JSON.parse(await fs.readFile(outputFile, 'utf8'));
    assert.ok(report.applied >= 1);
    assert.equal(output.includes(blocker.discovery.token), false);
    assert.match(output, /stopped with cleanup failures/);
    const endpoint = new URL(blocker.discovery.endpoint);
    assert.equal(endpoint.protocol, 'http:');
    assert.equal(endpoint.hostname, '127.0.0.1');
    const port = Number(endpoint.port);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    await assert.rejects(
      async () => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setTimeout(1000, () => {
          socket.destroy(new Error('Owned listener did not close'));
        });
        try {
          await once(socket, 'connect');
        } finally {
          socket.destroy();
        }
      },
      { code: 'ECONNREFUSED' },
    );
    assert.ok(setup.methods.every((method) => method === 'GET'));
  },
);

test(
  'model-driven navigation and real filesystem cleanup failures both survive after every owner drains',
  { timeout: 30000 },
  async (t) => {
    const setup = await fixture(t, { resetDocument: true });
    const { owner, directory, project, origin, channel, network } = setup;
    const contexts = [];
    const launch = chromium.launchPersistentContext;
    t.mock.method(chromium, 'launchPersistentContext', async function (profile, options) {
      const context = await launch.call(this, profile, {
        ...options,
        proxy: network.proxy,
        args: [...options.args, ...network.args],
      });
      contexts.push(context);
      return context;
    });
    let blocker, settled;
    owner.add(async () => {
      setup.releaseDocument();
      for (const context of contexts) await context.close();
      await settled;
      if (blocker) await fs.rmdir(blocker.file);
    });
    const running = run(
      null,
      {
        project,
        url: origin,
        browser: channel,
        headless: true,
        'debug-port': '0',
        timeout: '20000',
        output: path.join(directory, 'overlay.json'),
      },
      ['dev'],
    );
    settled = running.then(
      () => null,
      (cause) => cause,
    );
    await setup.requested;
    blocker = await setup.blockDiscovery();
    setup.releaseDocument();
    const failure = await settled;
    assert.ok(failure instanceof AggregateError);
    assert.match(failure.message, /Could not open the model-driven app/);
    assert.equal(failure.errors.length, 2);
    assert.match(failure.errors[0].message, /Could not open the model-driven app/);
    assert.match(failure.errors[1].code, /EISDIR|EPERM/);
    assert.ok(
      contexts.every((context) => context.pages().length === 0),
      'owned browser contexts close after inspector failure',
    );
    // A refused connection, not the abort timeout of a listener that is still open.
    await assert.rejects(
      fetch(blocker.discovery.endpoint + '/v1/session', {
        signal: AbortSignal.timeout(1000),
      }),
      { name: 'TypeError', message: 'fetch failed' },
    );
    assert.ok(setup.methods.every((method) => method === 'GET'));
  },
);
