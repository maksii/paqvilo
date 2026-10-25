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
import { createStandaloneRuntime } from '../mirage/lib/standalone-runtime.mjs';
import { modelDrivenActionAvailability } from '../lense/model-driven-action-runner.mjs';

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
  'model-driven startup deadline disposes a late owned browser context and leaves its sibling usable',
  { timeout: 15000 },
  async (t) => {
    const setup = await fixture(t);
    const browser = await chromium.launch({
      channel: setup.channel === 'chromium' ? undefined : setup.channel,
      headless: true,
    });
    setup.owner.add(() => browser.close());
    const sibling = await browser.newContext(),
      siblingPage = await sibling.newPage();
    await siblingPage.setContent('<input value="sibling draft">');
    let late, closed;
    const lateClosed = new Promise((resolve) => {
      closed = resolve;
    });
    t.mock.method(chromium, 'launchPersistentContext', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      late = await browser.newContext();
      late.once('close', closed);
      return late;
    });
    await assert.rejects(
      run(null, {
        project: setup.project,
        url: setup.origin,
        headless: true,
        browser: setup.channel,
        'startup-timeout': '1000',
      }),
      (error) => error.code === 'startup_timeout' && error.phase === 'browser setup',
    );
    await Promise.race([
      lateClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Late owned context was not closed')), 5000)),
    ]);
    assert.ok(late);
    assert.equal(await siblingPage.locator('input').inputValue(), 'sibling draft');
    assert.equal(browser.isConnected(), true);
  },
);

test(
  'paired local-simulation panel opens on Mirage and stops without owning the underlying runtime',
  { timeout: 20000 },
  async (t) => {
    const setup = await fixture(t);
    const appId = '77777777-7777-4777-8777-777777777777';
    const solution = path.join(setup.directory, 'solution');
    for (const [relative, content] of [
      [
        'AppModules/x_workspace/AppModule.xml',
        `<AppModule><AppModuleId>${appId}</AppModuleId><UniqueName>x_workspace</UniqueName><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>`,
      ],
      [
        'Entities/x_item/Entity.xml',
        '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
      ],
    ]) {
      const file = path.join(solution, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
    const runtime = await createStandaloneRuntime({
      runtime: { kind: 'model-driven', defaultApp: appId },
      simulation: { level: 'dry-run' },
      solutionRoots: [path.join(setup.directory, 'solution')],
      modelDriven: { trustedExtensions: true },
      projectRoot: setup.directory,
    });
    setup.owner.add(() => runtime.close());
    const launch = chromium.launchPersistentContext.bind(chromium);
    let opened;
    const requests = [];
    const browserOpened = new Promise((resolve) => {
      opened = resolve;
    });
    t.mock.method(chromium, 'launchPersistentContext', async (profile, options) => {
      const context = await launch(profile, { ...options, ...setup.network });
      context.on('request', (request) => requests.push(request.url()));
      opened(context);
      return context;
    });
    const running = run(null, {
      project: setup.project,
      url: runtime.url,
      headless: true,
      browser: setup.channel,
      'local-simulation': true,
      timeout: '2000',
    });
    running.catch(() => {});
    const context = await browserOpened;
    const page = context.pages()[0];
    await page.waitForSelector('#paqvilo-panel', { state: 'attached' });
    await page.waitForFunction(() =>
      document.querySelector('#paqvilo-panel')?.shadowRoot?.textContent.includes('Local simulation'),
    );
    const availability = await page.evaluate(modelDrivenActionAvailability, {
      origin: runtime.url,
      actions: [
        { id: 'environment', requirements: ['environment'] },
        { id: 'privileges', requirements: ['privileges'] },
      ],
    });
    assert.equal(availability[0].available, false);
    assert.match(availability[0].reason, /local simulator has none/);
    assert.equal(availability[1].available, false);
    assert.match(availability[1].reason, /security role privileges/);
    assert.equal(await running, 0);
    assert.equal((await fetch(runtime.url + '/_sim/api/status')).status, 200);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((value) => new URL(value).origin === runtime.url));
  },
);

test(
  'startup cancellation closes its owned page before draining stalled inspector initialization',
  { timeout: 10000 },
  async (t) => {
    const setup = await fixture(t),
      launch = chromium.launchPersistentContext.bind(chromium);
    let frameTrees = 0,
      stalled = false,
      closed = false;
    t.mock.method(chromium, 'launchPersistentContext', async (profile, options) => {
      const context = await launch(profile, { ...options, ...setup.network });
      context.once('close', () => {
        closed = true;
      });
      const attach = context.newCDPSession.bind(context);
      context.newCDPSession = async (page) => {
        const cdp = await attach(page),
          send = cdp.send.bind(cdp);
        cdp.send = (method, params) => {
          if (method === 'Page.getFrameTree' && ++frameTrees === 2) {
            stalled = true;
            return new Promise((_, reject) =>
              page.once('close', () => reject(new Error('Owned page closed during inspector setup'))),
            );
          }
          return send(method, params);
        };
        return cdp;
      };
      return context;
    });
    await assert.rejects(
      run(null, {
        project: setup.project,
        url: setup.origin,
        headless: true,
        browser: setup.channel,
        'startup-timeout': '1500',
      }),
      (error) => error.code === 'startup_timeout' && error.phase === 'interception and inspector setup',
    );
    assert.equal(stalled, true);
    assert.equal(closed, true);
  },
);

test(
  'initial document deadline detaches an external CDP browser and preserves its existing draft',
  { timeout: 15000 },
  async (t) => {
    const setup = await fixture(t, { resetDocument: true });
    const portServer = net.createServer();
    await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
    const port = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    const external = await chromium.launchPersistentContext(path.join(setup.directory, 'external-profile'), {
      channel: setup.channel === 'chromium' ? undefined : setup.channel,
      headless: true,
      ...setup.network,
      args: [...setup.network.args, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
    });
    setup.owner.add(() => external.close());
    const sibling = external.pages()[0];
    await sibling.setContent('<input value="external draft">');
    await assert.rejects(
      run(null, {
        project: setup.project,
        url: setup.origin,
        headless: true,
        'cdp-url': `http://127.0.0.1:${port}`,
        'startup-timeout': '1500',
      }),
      (error) => error.code === 'startup_timeout' && error.phase === 'document navigation',
    );
    assert.equal(external.pages().length, 1);
    assert.equal(await sibling.locator('input').inputValue(), 'external draft');
  },
);

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
