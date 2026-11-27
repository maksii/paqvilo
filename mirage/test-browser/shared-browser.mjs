// Test-file fixtures: one browser per file, an isolated context per test.
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { before, after } from 'node:test';
import { chromium } from 'playwright-core';
import { syntaxNodes } from '../../test/estree.mjs';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, drainFixture } from '../testing/owned-fixture.mjs';
import { SCENARIO_HANG_GUARD_MS } from '../../test/helpers/bounded-command.mjs';

/**
 * Hang guard only: runAcceptance's `timeout` for a run whose test asserts no deadline. The runner's 15 s default is a
 * product budget, and a loaded host can spend it on one navigation; a test that asserts a deadline passes its own.
 */
export const ACCEPTANCE_HANG_GUARD_MS = 120_000;

/**
 * Launches one browser for the calling test file; `page(t)` opens a fresh context that closes with the test, among the
 * test's ownedFixture closers and so before its directories are removed (node:test runs t.after hooks first in, first out).
 */
export function sharedBrowser(launchOptions) {
  let browser;
  // Hang guard only: a hook without its own timeout gets the lane's, which a browser start or close on a loaded slow
  // host overran while still progressing.
  before(
    async () => {
      browser = await chromium.launch(browserLaunchOptions(launchOptions));
    },
    { timeout: SCENARIO_HANG_GUARD_MS },
  );
  after(() => browser?.close(), { timeout: SCENARIO_HANG_GUARD_MS });
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

const MODULE_REFERENCES = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'ImportExpression',
]);
// The specifier text of a module reference: a string literal, or a template literal without substitutions.
const specifierOf = ({ source }) =>
  source?.type === 'TemplateLiteral' && !source.expressions.length ? source.quasis[0].value.cooked : source?.value;

// Every relative module specifier a source file imports: static, side-effect, re-export and literal dynamic imports.
// Text that is not a JavaScript module (JSON, a stylesheet) has no module references.
const relativeImports = (source) =>
  syntaxNodes(source)
    .filter((node) => MODULE_REFERENCES.has(node.type))
    .map(specifierOf)
    .filter((specifier) => typeof specifier === 'string' && /^\.\.?\//.test(specifier))
    .toArray();

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
  if (name !== 'index.html' && !/^[a-z0-9-]+\.(?:mjs|css|js)$/.test(name)) return res.writeHead(404).end();
  res.setHeader(
    'content-type',
    name.endsWith('.mjs') || name.endsWith('.js')
      ? 'text/javascript'
      : name.endsWith('.css')
        ? 'text/css'
        : 'text/html',
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

/**
 * Clicks the administration's Refresh and waits until that refresh has finished. The button is disabled from the click
 * until the refreshed view is on screen, so what the test reads or opens next belongs to the refreshed view, not to
 * the one the refresh is about to replace.
 */
export async function refreshWorkspace(page) {
  await page.locator('#refresh').click();
  await page.locator('#refresh:not([disabled])').waitFor();
}

/**
 * Waits until the administration has nothing outstanding: the open view is rendered with the data it asked for. The
 * workspace marks its content busy from the start of a refresh or a view load until its last answer is rendered, so
 * elements a test keeps (or measures) after this are not replaced by a render that was still on its way.
 */
export async function workspaceSettled(page) {
  await page.locator('#content[aria-busy="false"]').waitFor();
}

/**
 * Opens `url` and waits until the ready handlers its scripts registered have run. jQuery 3 runs ready handlers from a
 * timer of its own, after the document is parsed and possibly after `load`, so the controls a script binds in a ready
 * handler (grids, lookups, form actions) answer a click only from then on. The handler registered here runs after the
 * ones registered before it; a page without jQuery has none to wait for.
 */
export async function openPortalPage(page, url, options) {
  const response = await page.goto(url, options);
  await readyHandlersRan(page);
  return response;
}

/** Waits until the ready handlers the page's scripts have registered so far have run (see `openPortalPage`). */
export async function readyHandlersRan(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        if (typeof globalThis.jQuery === 'function') globalThis.jQuery(() => resolve());
        else resolve();
      }),
  );
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
  // Hang guard only: the file's shared fixtures close here, which on a loaded slow host is slow, not hung.
  after(() => drainFixture(cleanups.toReversed()), { timeout: SCENARIO_HANG_GUARD_MS });
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
export async function signedInSimulatorPage(t, browser, { dir, initial, contact, identityProvider }) {
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    initial,
    watch: false,
    ...(identityProvider ? { identityProvider } : {}),
  });
  let context;
  ownedFixture(t).add(() => context?.close());
  ownedFixture(t).add(() => app.close());
  context = await browser.newContext();
  if (contact) await signInContext(context, app, contact, { roles: ['Member'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { app, page, errors };
}

/** The port in a DevToolsActivePort file once Chromium has written both of its lines, otherwise null. */
async function readDevToolsPort(file) {
  let text;
  while (text === undefined) {
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      // Windows refuses the read while the browser has the file open to write it: read again once it has closed it.
      if (error.code !== 'EBUSY') throw error;
      await new Promise((resolve) => setImmediate(resolve));
    }
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
