// Test-file fixtures: one browser per file, an isolated context per test.
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { before, after } from 'node:test';
import { chromium } from 'playwright-core';
import ts from 'typescript';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, drainFixture } from '../testing/owned-fixture.mjs';

/**
 * Launches one browser for the calling test file; `page(t)` opens a fresh context that closes with the test, among the
 * test's ownedFixture closers and so before its directories are removed (node:test runs t.after hooks first in, first out).
 */
export function sharedBrowser(launchOptions) {
  let browser;
  before(async () => {
    browser = await chromium.launch(browserLaunchOptions(launchOptions));
  });
  after(() => browser?.close());
  return {
    get browser() {
      return browser;
    },
    async page(t, contextOptions) {
      const context = await browser.newContext(contextOptions);
      ownedFixture(t).add(() => context.close());
      return context.newPage();
    },
  };
}

/**
 * The origin of a simulator's app paths (main.aspx, /_apps/*, /api/data/*, the staff session): the apps listener when
 * the host has one, otherwise the portal origin (the standalone model-driven host serves its apps on its own origin).
 */
export function appsOrigin(sim, origin) {
  return sim.appsUrl ? new URL(sim.appsUrl).origin : origin;
}

/** The origins an app's own requests may use: the portal origin, where a navigation starts, and the apps origin. */
export function appOrigins(sim, origin) {
  return sim.appsUrl ? [origin, new URL(sim.appsUrl).origin] : [origin];
}

const MODULE_BASE = 'http://served.invalid';

// Every relative module specifier a source file imports: static, side-effect, re-export and literal dynamic imports.
const relativeImports = (source) =>
  ts
    .preProcessFile(source, true, true)
    .importedFiles.map((file) => file.fileName)
    .filter((specifier) => /^\.\.?\//.test(specifier));

/**
 * The modules an entry module imports, transitively, keyed by the path each is served at: the entry at `servedPath`,
 * each relative import at the path it resolves to from its importer's served path. Serving every key from its
 * file lets a fixture server answer a module import with the real module instead of a fallback page.
 */
export async function moduleGraph(entry, servedPath) {
  const modules = new Map();
  const pending = [[new URL(entry), servedPath]];
  while (pending.length) {
    const [file, served] = pending.pop();
    if (modules.has(served)) continue;
    modules.set(served, file);
    const source = await fs.readFile(file, 'utf8');
    for (const specifier of relativeImports(source))
      pending.push([new URL(specifier, file), new URL(specifier, new URL(served, MODULE_BASE)).pathname]);
  }
  return modules;
}

/** Closes a fixture server without waiting on browser keep-alive sockets, which can hold `close()` open. */
export function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Serves `handler` on an ephemeral loopback port until the test ends. It closes among the test's ownedFixture closers,
 * dropping keep-alive sockets that a browser context still open at that point would otherwise hold.
 */
export async function loopbackServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => closeServer(server));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// Modules of the admin app that live in mirage/lib instead of mirage/admin.
const ADMIN_LIB_MODULES = new Set(['persona-search.mjs', 'persona-picker-view.mjs']);

/**
 * Answers a request for the admin app's page (`/__sim/`), one of its modules or a stylesheet with the file from the
 * Mirage sources; another name is answered 404. A read failure rejects, for the caller's request handler to answer.
 */
export async function serveAdminFile(res, url) {
  const name = url.pathname === '/__sim/' ? 'index.html' : url.pathname.split('/').at(-1);
  if (name !== 'index.html' && !/^[a-z0-9-]+\.(?:mjs|css)$/.test(name)) return res.writeHead(404).end();
  res.setHeader(
    'content-type',
    name.endsWith('.mjs') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
  );
  res.end(await fs.readFile(new URL(`../${ADMIN_LIB_MODULES.has(name) ? 'lib' : 'admin'}/${name}`, import.meta.url)));
}

/**
 * Reads a simulator's admin state once before a page times its first render. The first read in a process builds the
 * organization runtime (lazy modules and system tables: about 1 s idle, over 8 s on a loaded host), which admin view
 * tests do not measure and which would otherwise count against their first waits.
 */
export async function warmState(app) {
  const response = await fetch(app.url + '/__sim/api/state');
  if (!response.ok) throw new Error(`Simulator state returned HTTP ${response.status}`);
  await response.arrayBuffer();
}

/** A page in a fresh context on a warmed simulator; the context, the simulator and its directory close with the test. */
export async function adminPage(t, browser, app, directory) {
  let context;
  const fixture = ownedFixture(t);
  fixture.add(() => context?.close());
  fixture.add(() => app.close());
  fixture.remove(() => fs.rm(directory, { recursive: true, force: true }));
  context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await warmState(app);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, errors };
}

/**
 * An array of observed events whose pushes wake `until(predicate)`, so a test awaits the recorded event itself
 * instead of polling on a timer. No clock bounds the wait: the test's timeout is the hang guard. When the test `t`
 * ends while a wait is pending, the wait ends too and `message` is reported as a diagnostic of that test (the
 * runner reports a timed-out test only as a timeout).
 */
export function eventLog(t, { message = 'The expected event did not arrive' } = {}) {
  const { signal } = t;
  const items = [],
    waiters = new Set();
  const push = items.push.bind(items);
  Object.defineProperties(items, {
    push: {
      value: (...values) => {
        const length = push(...values);
        for (const wake of [...waiters]) wake();
        return length;
      },
    },
    until: {
      value: (predicate) =>
        new Promise((resolve, reject) => {
          const abort = () => {
            waiters.delete(check);
            const failure = `${message} (${items.length} event(s) recorded)`;
            t.diagnostic(failure);
            reject(new Error(failure, { cause: signal.reason }));
          };
          const check = () => {
            if (!predicate(items)) return;
            signal.removeEventListener('abort', abort);
            waiters.delete(check);
            resolve(items);
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
          waiters.add(check);
          check();
        }),
    },
  });
  return items;
}

/** A test-context stand-in whose cleanups run in the file's after hook, for fixtures shared by read-only tests. */
export function fileScope() {
  const cleanups = [];
  after(() => drainFixture(cleanups.toReversed()));
  return {
    after: (cleanup) => {
      cleanups.push(cleanup);
    },
  };
}

/**
 * Launches a browser handed to `own` at once (so the caller's cleanup closes it even if loading fails), opens `origin`
 * and collects page errors and any request leaving that origin.
 */
export async function observedPage(origin, own) {
  const browser = own(await chromium.launch(browserLaunchOptions({ headless: true })));
  const page = await browser.newPage();
  const errors = [],
    external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(origin + '/')) external.push(request.url());
  });
  await page.goto(origin);
  return { page, errors, external };
}

/**
 * The permissions, settings and simulator of an invented account-list site: the Member contact reads accounts, which the
 * list shows by name. A caller spreads it into its initial state beside its own mappings and tables.
 */
export function accountListAccess(contact) {
  return {
    permissions: [{ id: 'account', entity: 'account', scope: 'global', roles: ['Member'], operations: ['read'] }],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      identity: { id: contact, contactId: contact, roles: ['Member'] },
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        Accounts: { entity: 'account', fields: [{ name: 'name', label: 'Name' }] },
      },
    },
  };
}

/**
 * A simulator over `initial`, whose state file lives in `dir`, and a page in a fresh context signed in as the Member
 * `contact`. The simulator and the context close with the test; `errors` collects the page's errors.
 */
export async function signedInSimulatorPage(t, browser, { dir, initial, contact }) {
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false });
  let context;
  ownedFixture(t).add(() => context?.close());
  ownedFixture(t).add(() => app.close());
  context = await browser.newContext();
  await signInContext(context, app, contact, { roles: ['Member'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { app, page, errors };
}

/** The port in a DevToolsActivePort file once Chromium has written both of its lines, otherwise null. */
async function readDevToolsPort(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const [port, target] = text.split('\n');
  return port && target ? Number(port) : null;
}

/**
 * The remote-debugging port a browser launched on `profile` writes to its DevToolsActivePort file. Chromium writes the
 * file on its own thread, after the launch has resolved, so the watch starts first and the file is read on each change
 * and once at the start; the watch is closed when the port is read or the watch fails.
 */
export function devToolsActivePort(profile) {
  const file = path.join(profile, 'DevToolsActivePort');
  return new Promise((resolve, reject) => {
    const watcher = watch(profile, { persistent: false });
    const settle = (port) => {
      if (port === null) return;
      watcher.close();
      resolve(port);
    };
    const fail = (error) => {
      watcher.close();
      reject(error);
    };
    watcher.on('change', () => readDevToolsPort(file).then(settle, fail));
    watcher.on('error', fail);
    readDevToolsPort(file).then(settle, fail);
  });
}

/**
 * A second debugging client of the browser at `cdpUrl` that resumes every target the moment it is attached, as the
 * toolkit's own client does. Its page sessions run ahead of any guard the caller attaches later. `close()` ends the socket.
 */
export async function openResumingClient(cdpUrl) {
  const { webSocketDebuggerUrl } = await (await fetch(new URL('/json/version', cdpUrl))).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  await once(socket, 'open');
  const closed = once(socket, 'close');
  const attached = Promise.withResolvers();
  let nextId = 0;
  const send = (method, params, sessionId) => {
    nextId += 1;
    socket.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
  };
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) attached.resolve();
    if (message.method === 'Target.attachedToTarget' && message.params.waitingForDebugger)
      send('Runtime.runIfWaitingForDebugger', {}, message.params.sessionId);
  });
  send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await attached.promise;
  return {
    async close() {
      socket.close();
      await closed;
    },
  };
}
