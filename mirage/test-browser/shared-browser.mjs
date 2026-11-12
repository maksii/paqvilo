// Test-file fixtures: one browser per file, an isolated context per test.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { before, after } from 'node:test';
import { chromium } from 'playwright-core';
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

const RELATIVE_IMPORT = /\bfrom\s+'(\.\.?\/[^']+)'/g;
const MODULE_BASE = 'http://served.invalid';

/**
 * The modules an entry module imports, transitively, keyed by the path each is served at: the entry at `servedPath`,
 * each relative static import at the path it resolves to from its importer's served path. Serving every key from its
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
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT))
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
 * instead of polling on a timer. The bound only turns a missing event into a named failure before the test timeout.
 */
export function eventLog({ timeout = 60_000, message = 'The expected event did not arrive' } = {}) {
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
          const timer = setTimeout(() => {
            waiters.delete(check);
            reject(new Error(`${message} within ${timeout} ms`));
          }, timeout);
          const check = () => {
            if (!predicate(items)) return;
            clearTimeout(timer);
            waiters.delete(check);
            resolve(items);
          };
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
  ownedFixture(t).add(() => app.close());
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, contact, { roles: ['Member'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { app, page, errors };
}
