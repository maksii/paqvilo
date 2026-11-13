// @test-kind contract: Paqvilo's own _sim, Lense and setup user interface behaviour
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAcceptance } from '../acceptance.mjs';
import { navigationCommitBudget } from '../lib/navigation-budget.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { preserveNavigationEvidence } from '../test/navigation-evidence-fixture.mjs';
import { PROCESS_SLOTS } from '../test/process-slots.mjs';

function fixtureApi(pathname, res, fallback) {
  if (!pathname.startsWith('/__sim/api/')) return false;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify(
      pathname.endsWith('/state')
        ? {
            config: { mode: 'local', pageMode: 'local', endpoints: [] },
            status: { sourceFingerprint: 'fixture', implementationFingerprint: 'fixture' },
          }
        : fallback,
    ),
  );
  return true;
}

// The product calls the hook as it creates a navigation hold. Only tests that release writes on the hold get one.
function navigationHoldHook(enabled, fixtureEvents, navigationHeld) {
  if (!enabled) return undefined;
  return () => {
    fixtureEvents.push('navigation-held');
    navigationHeld.resolve();
  };
}

async function navigationFixture(
  t,
  {
    history = 'hash',
    late = false,
    completed = false,
    noCommit = false,
    noContent = false,
    resetNavigation = false,
    documentDelay,
    redirectHops = 1,
    noNavigation = false,
    redirect = false,
    child = false,
    writeMs = 0,
    // Writes answer only after both have arrived and the product has held the navigation, so they are in flight
    // when the navigation starts and finish during its hold.
    releaseWritesOnNavigation = false,
    actionDelay = 0,
    replacementRead = false,
    embedded = false,
    crossOrigin = false,
    // The triggering click and its settlement default to the runner's action budget; tests about budgets set it.
    timeout,
    // A test asserting that settlement fails sets only this, so the click keeps its own deadline.
    settleTimeout = timeout,
    navigationCommitReserveMs,
    gateDocumentOnWrites = false,
    controlledLateWrites = late,
    scheduleDocumentResponse = setTimeout,
    customizeContext = null,
  } = {},
) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-document-commit-'));
  let flow;
  ownedFixture(t).remove(async () => {
    if (!t.passed && flow) {
      const evidence = await preserveNavigationEvidence(root, flow);
      t.diagnostic(`Preserved invented navigation diagnostics: ${evidence.files.join(', ')}`);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const historyChange =
    history === 'none' ? '' : history === 'hash' ? "location.hash='pending'" : "history.pushState({},'', '?pending=1')";
  const writes = `fetch('/slow-one',{method:'PATCH'}).catch(()=>{});fetch('/slow-two',{method:'POST'}).catch(()=>{})`;
  const form = `<form action="/submit" method="${redirect ? 'POST' : 'GET'}"><button id="save">Save</button></form>`;
  const timerScript = `document.querySelector('form').addEventListener('submit',event=>{${actionDelay ? `const end=Date.now()+${actionDelay};while(Date.now()<end){}` : ''}${noNavigation ? 'event.preventDefault();' : ''}${late ? '' : writes};setTimeout(()=>{${historyChange}},50);${late ? `setTimeout(()=>{${writes}},150);` : ''}})`;
  const script = noCommit
    ? `document.querySelector('form').addEventListener('submit',event=>{${noNavigation ? 'event.preventDefault();' : ''}fetch('/never').catch(()=>{});fetch('/no-content-ready').then(response=>response.text()).then(()=>{${historyChange}})})`
    : controlledLateWrites
      ? `document.querySelector('form').addEventListener('submit',()=>{fetch('/late-writes-ready').then(response=>response.text()).then(()=>{${historyChange};${writes}})})`
      : timerScript;
  const documentRequested = Promise.withResolvers();
  const navigationHeld = Promise.withResolvers();
  const lateGateFinished = Promise.withResolvers();
  const writesObserved = Promise.withResolvers();
  const readArrived = Promise.withResolvers();
  const readObserved = Promise.withResolvers();
  const historyObserved = Promise.withResolvers();
  const historyReadFinished = Promise.withResolvers();
  if (history === 'none') historyObserved.resolve();
  const fixtureEvents = [];
  let observedWrites = 0;
  let releaseDocument;
  const writesArrived = new Promise((resolve) => {
    releaseDocument = resolve;
  });
  // Released writes are answered only after the server has received both and the product has held the navigation
  // (onNavigationHold). 'writes-released' is recorded before any answer.
  const writesReleased = Promise.all([writesArrived, navigationHeld.promise]).then(() => {
    fixtureEvents.push('writes-released');
  });
  const server = http.createServer((req, res) => {
    req.resume();
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (fixtureApi(pathname, res, { events: [] })) return;
    if (pathname.startsWith('/slow-') || pathname === '/never') {
      if (noCommit && pathname === '/never') {
        fixtureEvents.push('read:/never');
        readArrived.resolve();
      }
      if (pathname.startsWith('/slow-')) {
        fixtureEvents.push('write:' + pathname);
        if (++observedWrites === 2) releaseDocument();
      }
      if (releaseWritesOnNavigation && pathname.startsWith('/slow-')) {
        void writesReleased.then(() => {
          fixtureEvents.push('write-answered:' + pathname);
          res.end('done');
        });
        return;
      }
      if (pathname !== '/never' && (completed || writeMs)) {
        const timer = setTimeout(() => res.end('done'), writeMs || 1000);
        res.once('close', () => clearTimeout(timer));
      }
      return;
    }
    if (noCommit && pathname === '/no-content-ready') {
      void Promise.all([
        readArrived.promise,
        readObserved.promise,
        ...(noNavigation ? [] : [documentRequested.promise]),
      ]).then(() => {
        fixtureEvents.push('history-released');
        res.end('ready');
      });
      return;
    }
    if (controlledLateWrites && pathname === '/late-writes-ready') {
      void documentRequested.promise.then(() => {
        fixtureEvents.push('late-writes-released');
        res.end('ready');
      });
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (noCommit && pathname === '/submit') {
      fixtureEvents.push('navigation');
      documentRequested.resolve();
      void Promise.all([historyObserved.promise, historyReadFinished.promise]).then(() => {
        fixtureEvents.push('document-response');
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (controlledLateWrites && pathname === '/submit') {
      fixtureEvents.push('navigation');
      documentRequested.resolve();
      void Promise.all([writesArrived, lateGateFinished.promise, writesObserved.promise]).then(() => {
        fixtureEvents.push('document-response');
        res.end('<p id="done">Saved</p>' + (replacementRead ? "<script>fetch('/never').catch(()=>{})</script>" : ''));
      });
      return;
    }
    if (pathname === '/submit' && gateDocumentOnWrites) {
      void writesArrived.then(() => res.end('<p id="done">Saved</p>'));
      return;
    }
    if (pathname === '/submit' || pathname.startsWith('/hop-')) {
      const timer = scheduleDocumentResponse(
        () => {
          if (resetNavigation) return req.socket.destroy();
          if (noContent) {
            res.statusCode = typeof noContent === 'number' ? noContent : 204;
            return res.end();
          }
          const hop = pathname === '/submit' ? 1 : Number(pathname.slice(5));
          if (redirect && hop <= redirectHops) {
            res.statusCode = 303;
            res.setHeader('location', hop < redirectHops ? '/hop-' + (hop + 1) : '/done');
            return res.end();
          }
          res.end('<p id="done">Saved</p>' + (replacementRead ? "<script>fetch('/never').catch(()=>{})</script>" : ''));
        },
        documentDelay ?? (redirect ? 20 : 1500),
      );
      res.once('close', () => clearTimeout(timer));
      return;
    }
    if (pathname === '/done') {
      const timer = setTimeout(
        () =>
          res.end('<p id="done">Saved</p>' + (replacementRead ? "<script>fetch('/never').catch(()=>{})</script>" : '')),
        redirectHops > 1 ? documentDelay : 0,
      );
      res.once('close', () => clearTimeout(timer));
      return;
    }
    if (embedded && pathname === '/')
      return res.end(
        `<iframe id="child" src="${crossOrigin ? `http://localhost:${server.address().port}` : ''}/child"></iframe>`,
      );
    if (child && pathname === '/')
      return res.end(
        `<iframe id="child" src="/child"></iframe>${form}<script>document.querySelector('form').addEventListener('submit',()=>{document.querySelector('iframe').contentWindow.startWrites()})</script>`,
      );
    res.end(form + `<script>${child ? `window.startWrites=()=>{${writes}}` : script}</script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const onNavigationHold = navigationHoldHook(releaseWritesOnNavigation, fixtureEvents, navigationHeld);
  const result = await runAcceptance({
    localUrl: `http://127.0.0.1:${server.address().port}`,
    outputDir: path.join(root, 'evidence'),
    timeout: HANG_GUARD_ACTION_MS,
    navigationCommitReserveMs,
    onNavigationHold,
    prepareContext:
      noCommit || controlledLateWrites || customizeContext
        ? async (context) => {
            await customizeContext?.(context);
            if (noCommit) {
              let historyRecorded = false;
              context.on('page', (page) => {
                page.on('framenavigated', (frame) => {
                  const url = new URL(frame.url());
                  if (
                    !historyRecorded &&
                    frame === page.mainFrame() &&
                    (url.hash === '#pending' || url.searchParams.get('pending') === '1')
                  ) {
                    historyRecorded = true;
                    fixtureEvents.push('history-observed');
                    historyObserved.resolve();
                  }
                });
              });
              context.on('request', (request) => {
                if (new URL(request.url()).pathname === '/never') {
                  fixtureEvents.push('read-observed:/never');
                  readObserved.resolve();
                }
              });
              context.on('requestfinished', (request) => {
                if (new URL(request.url()).pathname === '/no-content-ready') {
                  fixtureEvents.push('no-content-gate-read-finished');
                  historyReadFinished.resolve();
                }
              });
            }
            if (!controlledLateWrites) return;
            const observed = new Set();
            context.on('request', (request) => {
              const pathname = new URL(request.url()).pathname;
              if (pathname === '/slow-one' || pathname === '/slow-two') {
                fixtureEvents.push('write-observed:' + pathname);
                observed.add(pathname);
                if (observed.size === 2) writesObserved.resolve();
              }
            });
            context.on('requestfinished', (request) => {
              if (new URL(request.url()).pathname === '/late-writes-ready') {
                fixtureEvents.push('gate-read-finished');
                lateGateFinished.resolve();
              }
            });
          }
        : null,
    flows: [
      {
        name: 'Document boundary',
        steps: [
          { action: 'navigate', path: '/' },
          ...(child || embedded ? [{ action: 'visible', frame: '#child', selector: '#save' }] : []),
          // The budgets under test belong to the triggering action and its settlement; page loads and unbudgeted
          // steps keep the runner's action budget, so a slow cold load cannot consume them.
          { action: 'click', selector: '#save', timeout, ...(embedded ? { frame: '#child' } : {}) },
          { action: 'settle', timeout: settleTimeout },
          ...(!noCommit && !noContent && !resetNavigation && !noNavigation
            ? [{ action: 'visible', selector: '#done', ...(embedded ? { frame: '#child' } : {}) }]
            : []),
        ],
      },
    ],
  });
  flow = { ...result.flows[0], fixtureEvents };
  return flow;
}

// Each test owns its loopback server and the browser runAcceptance launches, so a few run at once.
// Every subtest launches a browser; outer validation lanes share the same machine.
const TESTS_IN_PARALLEL = Math.min(4, PROCESS_SLOTS);
// The runner's action budget for these flows, not a product budget under test. Tests that assert a budget set their
// own; the rest keep this one, so no step ends by elapsed time on a loaded host. Order is controlled by gates.
const HANG_GUARD_ACTION_MS = 120_000;
// The reserve a wait used, recomputed from the remaining budget that wait recorded. Only the first wait of a
// budget is measured this way: later hops of a chain reuse its reserve.
function reserveFor(wait) {
  return navigationCommitBudget(wait.writeHoldAllowanceMs + wait.commitReserveMs, {
    comparableMs: wait.comparableNavigationMs,
  }).reserveMs;
}
describe('acceptance navigation boundaries', { concurrency: TESTS_IN_PARALLEL }, () => {
  for (const history of ['hash', 'pushState'])
    test(`same-document ${history} does not consume a pending document replacement`, async (t) => {
      const flow = await navigationFixture(t, { history, late: true });
      assert.equal(flow.passed, true, JSON.stringify(flow));
      assert.equal(flow.navigationCancelledRequests?.length, 2);
      assert.ok(flow.navigationCancelledRequests.every((row) => row.reason === 'document-replaced'));
    });

  test('writes completed before a document commits stay finished across a hash change', async (t) => {
    const flow = await navigationFixture(t, { completed: true });
    assert.equal(flow.passed, true, JSON.stringify(flow));
    assert.equal(flow.navigationCancelledRequests?.length ?? 0, 0);
    assert.equal(flow.resources.filter((row) => /slow-/.test(row.url) && row.finished).length, 2);
  });

  for (const noNavigation of [false, true])
    test(`a hash change cannot retire a hanging read (${noNavigation ? 'no navigation' : '204 navigation'})`, async (t) => {
      const flow = await navigationFixture(t, { noCommit: true, noNavigation, settleTimeout: 2500 });
      assert.equal(flow.passed, false);
      assert.match(flow.error, /Portal requests did not settle.*GET.*never/);
      assert.equal(flow.navigationCancelledRequests?.length ?? 0, 0);
    });

  test('a 204 negative flow reaches pending-read diagnostics without a fixture response timer', async (t) => {
    let releaseDocumentResponse;
    const flow = await navigationFixture(t, {
      noCommit: true,
      settleTimeout: 2500,
      scheduleDocumentResponse: (callback) => {
        releaseDocumentResponse = callback;
      },
      customizeContext: async (context) => {
        // Pause this invented page's authored history timer; browser protocol, promises and the native action
        // deadline continue normally. Neither history ordering nor a 204 response should need that fixture clock.
        await context.addInitScript(() => {
          globalThis.setTimeout = () => 0;
        });
        context.on('page', (page) => {
          const locate = page.locator.bind(page);
          page.locator = (...args) => {
            const locator = locate(...args);
            if (args[0] === '#save') {
              const click = locator.click.bind(locator);
              locator.click = async (...options) => {
                try {
                  return await click(...options);
                } finally {
                  // Release a legacy response timer after the actual action ends, so its timeout stays observable
                  // without leaving the fixture's native navigation pending during failure capture or teardown.
                  releaseDocumentResponse?.();
                }
              };
            }
            return locator;
          };
        });
      },
    });
    assert.equal(flow.passed, false);
    assert.match(flow.error, /Portal requests did not settle.*GET.*never/);
    assert.deepEqual(
      flow.steps.map(({ action, passed }) => [action, passed]),
      [
        ['navigate', true],
        ['click', true],
        ['settle', false],
      ],
    );
    assert.equal(flow.noContentNavigations?.length, 1);
    assert.equal(flow.noContentNavigations[0].status, 204);
    assert.deepEqual(
      flow.pendingRequests.map(({ method, url }) => [method, new URL(url).pathname]),
      [['GET', '/never']],
    );
    assert.equal(flow.navigationCancelledRequests?.length ?? 0, 0);
    for (const event of ['read:/never', 'read-observed:/never', 'history-observed', 'no-content-gate-read-finished']) {
      assert.ok(flow.fixtureEvents.includes(event), event);
      assert.ok(flow.fixtureEvents.indexOf(event) < flow.fixtureEvents.indexOf('document-response'), event);
    }
    assert.ok(flow.fixtureEvents.indexOf('navigation') < flow.fixtureEvents.indexOf('history-released'));
  });

  for (const child of [false, true])
    test(`redirect chains share one navigation hold (${child ? 'child' : 'main'} writes)`, async (t) => {
      // The writes never answer, so they are still pending when the chain commits and the hold ends at its deadline.
      const flow = await navigationFixture(t, { redirect: true, history: 'none', child });
      assert.equal(flow.passed, true, JSON.stringify(flow));
      assert.equal(flow.navigationCancelledRequests?.length, 2);
      assert.ok(
        flow.navigationCancelledRequests.every(
          (row) => row.reason === (child ? 'frame-detached' : 'document-replaced'),
        ),
      );
      assert.ok(flow.navigationWaits.length > 0, 'redirect hold reported at least one navigation wait');
      const [first, ...later] = flow.navigationWaits;
      assert.equal(first.commitReserveMs, reserveFor(first));
      assert.ok(
        later.every((wait) => wait.writeHoldAllowanceMs === 0),
        'later hops of the chain reuse the first hold',
      );
    });

  test('redirect waits allow writes within the navigation budget to finish', async (t) => {
    // The writes answer when the product holds the navigation, so they finish inside its hold without a timed answer.
    const flow = await navigationFixture(t, { redirect: true, history: 'none', releaseWritesOnNavigation: true });
    assert.equal(flow.passed, true, JSON.stringify(flow));
    assert.equal(flow.navigationCancelledRequests?.length ?? 0, 0);
    assert.equal(flow.resources.filter((row) => /slow-/.test(row.url) && row.finished).length, 2);
    assert.ok(flow.navigationWaits?.length > 0, 'the navigation was held while its writes were in flight');
    assert.ok(
      flow.navigationWaits.every((wait) => wait.settled === true && wait.commitReserveMs === reserveFor(wait)),
      JSON.stringify(flow.navigationWaits),
    );
  });

  for (const crossOrigin of [false, true])
    test(`${crossOrigin ? 'cross-origin' : 'same-origin'} child document commits retire only their predecessor requests`, async (t) => {
      const flow = await navigationFixture(t, {
        embedded: true,
        crossOrigin,
        late: true,
        controlledLateWrites: true,
      });
      assert.equal(flow.passed, true, JSON.stringify(flow));
      assert.equal(flow.navigationCancelledRequests?.length, 2);
      assert.ok(flow.navigationCancelledRequests.every((row) => row.reason === 'document-replaced'));
      assert.deepEqual(flow.blockedRequests, []);
      assert.equal(flow.fixtureEvents[0], 'navigation');
      assert.equal(flow.fixtureEvents[1], 'late-writes-released');
      assert.deepEqual(flow.fixtureEvents.slice(2, -1).sort(), [
        'gate-read-finished',
        'write-observed:/slow-one',
        'write-observed:/slow-two',
        'write:/slow-one',
        'write:/slow-two',
      ]);
      assert.equal(flow.fixtureEvents.at(-1), 'document-response');
    });

  test('replacement document requests remain pending after retiring its predecessor', async (t) => {
    const flow = await navigationFixture(t, { replacementRead: true, late: true, settleTimeout: 2500 });
    assert.equal(flow.passed, false);
    assert.match(flow.error, /Portal requests did not settle.*GET.*never/);
    assert.equal(flow.navigationCancelledRequests?.length, 2);
    assert.ok(flow.navigationCancelledRequests.every((row) => /slow-/.test(row.url)));
  });

  test('parity browser settling preserves pending requests across same-document changes', async (t) => {
    const { openOwnedBrowser } = await import('../parity-suite.mjs');
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://fixture').pathname;
      if (pathname.startsWith('/never')) return;
      res.setHeader('content-type', 'text/html');
      if (pathname === '/done') return res.end('<p>Replacement</p>');
      if (pathname === '/new') return res.end("<p>Replacement</p><script>fetch('/never-new')</script>");
      const change =
        pathname === '/hash'
          ? "location.hash='pending'"
          : pathname === '/history'
            ? "history.replaceState({},'', '?pending=1')"
            : `location.href='${pathname === '/replace' ? '/done' : '/new'}'`;
      res.end(`<p>Original</p><script>fetch('/never-old');setTimeout(()=>{${change}},100)</script>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const browser = await openOwnedBrowser();
    t.after(() => browser.close());
    const driver = browser.pageDriver(`http://127.0.0.1:${server.address().port}`, 'anonymous');
    for (const pathname of ['/hash', '/history', '/replace', '/replace-new'])
      await t.test(pathname, async () => {
        // Only /replace settles; it returns as soon as the replacement is quiet, so its bound is generous for loaded hosts.
        const observation = await driver.page(pathname, { settleTimeout: pathname === '/replace' ? 30000 : 1500 });
        assert.equal(observation.settled, pathname === '/replace', JSON.stringify(observation));
        if (pathname !== '/replace')
          assert.ok(
            observation.pendingRequests.some((value) =>
              value.includes(pathname === '/replace-new' ? '/never-new' : '/never-old'),
            ),
          );
        if (pathname === '/replace-new')
          assert.ok(!observation.pendingRequests.some((value) => value.includes('/never-old')));
      });
  });

  test('a delayed form submission keeps its hold inside the triggering click deadline', async (t) => {
    // The submit handler busy-waits 1.8 s before the navigation starts, so the hold begins at least that far into
    // the click's budget. The writes never answer, so they stay pending until the document commits.
    const flow = await navigationFixture(t, {
      redirect: true,
      history: 'none',
      actionDelay: 1800,
    });
    assert.equal(flow.passed, true, JSON.stringify(flow));
    assert.equal(flow.navigationCancelledRequests?.length, 2);
    assert.ok(flow.navigationWaits.length > 0, 'delayed submission reported a navigation wait');
    assert.ok(
      flow.navigationWaits.every(
        (wait) => wait.writeHoldAllowanceMs + wait.commitReserveMs <= HANG_GUARD_ACTION_MS - 1800,
      ),
    );
  });

  test('acceptance distinguishes failed loopback writes from external proxy refusals', async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-acceptance-local-boundary-'));
    ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
    // The aborting page is released by the server only after it has received the aborted write.
    const abortedWriteArrived = Promise.withResolvers();
    const server = http.createServer((req, res) => {
      req.resume();
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname.startsWith('/__sim/api/')) {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify(
            url.pathname.endsWith('/state')
              ? {
                  config: { mode: 'local', pageMode: 'local', endpoints: [] },
                  status: { sourceFingerprint: 'fixture', implementationFingerprint: 'fixture' },
                }
              : { events: [] },
          ),
        );
      }
      if (url.pathname === '/aborted-write') return abortedWriteArrived.resolve();
      if (url.pathname === '/abort-after-write')
        return void abortedWriteArrived.promise.then(() => res.end('observed'));
      if (url.pathname === '/failed-write') return req.socket.destroy();
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/child') {
        const action =
          url.searchParams.get('case') === 'abort'
            ? "const controller=new AbortController();fetch('/aborted-write',{method:'PATCH',signal:controller.signal}).catch(()=>{});fetch('/abort-after-write').then(()=>controller.abort())"
            : url.searchParams.get('case') === 'fail'
              ? "fetch('/failed-write',{method:'POST'}).catch(()=>{})"
              : "fetch('https://outside.invalid/blocked-write',{method:'POST',mode:'no-cors',body:'invented fixture'}).catch(()=>{})";
        return res.end(`<button id="send" onclick="${action}">Send</button>`);
      }
      res.end(
        `<iframe id="child" src="http://localhost:${server.address().port}/child?case=${url.pathname.slice(1)}"></iframe>`,
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ownedFixture(t).add(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const kinds = ['abort', 'fail', 'external'];
    // One runner session: every owned Edge session costs seconds on a loaded host, while each flow
    // has its own page and observation.
    const result = await runAcceptance({
      localUrl: `http://127.0.0.1:${server.address().port}`,
      outputDir: path.join(directory, 'evidence'),
      flows: kinds.map((kind) => ({
        name: kind,
        steps: [
          { action: 'navigate', path: '/' + kind },
          // A refused or failed write can stay pending until settlement ends. Neither step asserts a deadline, so both
          // keep the runner's action budget.
          { action: 'click', frame: '#child', selector: '#send' },
          { action: 'settle' },
        ],
      })),
    });
    assert.deepEqual(
      result.flows.map((flow) => flow.name),
      kinds,
    );
    for (const [index, kind] of kinds.entries())
      await t.test(kind, () => {
        const flow = result.flows[index];
        assert.equal(flow.passed, false, JSON.stringify(flow));
        assert.ok(
          flow.failedRequests.some((request) => request.method === (kind === 'abort' ? 'PATCH' : 'POST')),
          JSON.stringify(flow),
        );
        assert.equal(flow.navigationCancelledRequests?.length ?? 0, 0);
        if (kind === 'external') {
          assert.ok(
            flow.blockedRequests.some(
              (request) => request.method === 'POST' && request.url === 'https://outside.invalid/blocked-write',
            ),
            JSON.stringify(flow),
          );
          assert.match(flow.error, /blockedRequests/);
        } else {
          assert.deepEqual(flow.blockedRequests, [], JSON.stringify(flow));
          assert.match(flow.error, /failedRequests/);
        }
      });
  });

  for (const redirect of [false, true])
    test(`a slow ${redirect ? 'POST redirect' : 'GET document'} retains a fallback reserve for its commit`, async (t) => {
      // The writes never answer, so the hold can only end at the reserve's deadline; the document then answers
      // 700 ms later, far inside the remaining action budget.
      const flow = await navigationFixture(t, {
        redirect,
        history: 'none',
        documentDelay: 700,
      });
      assert.equal(flow.passed, true, JSON.stringify(flow));
      assert.equal(flow.navigationCancelledRequests.length, 2);
      assert.ok(flow.navigationWaits.length > 0, 'fallback reserve reported a navigation wait');
      assert.ok(flow.navigationWaits.every((wait) => wait.commitReservePolicy === 'bounded-write-fallback'));
      assert.equal(flow.navigationWaits[0].commitReserveMs, reserveFor(flow.navigationWaits[0]));
    });

  test('a short action retains its half-budget bound when its replacement document cannot arrive within it', async (t) => {
    // The writes never answer, so the hold ends at the reserve's deadline.
    // The replacement document is never answered while the action runs, so it cannot fit however slow the host is.
    const flow = await navigationFixture(t, { history: 'none', timeout: 4000, scheduleDocumentResponse: () => {} });
    assert.equal(flow.passed, false);
    assert.match(flow.error, /Timeout 4000ms/);
    assert.ok(
      flow.navigationWaits.some(
        (wait) => wait.commitReservePolicy === 'bounded-write-fallback' && wait.commitReserveMs === reserveFor(wait),
      ),
    );
  });
  test('writes released by a navigation settle before an immediate redirect within an action budget', async (t) => {
    // The server cannot see the navigation while the product holds it: the document request is paused in the
    // browser and reaches this server only after the hold ends. So the hold itself releases the writes: they stay
    // unanswered until both have reached the server and the product has held the navigation.
    const flow = await navigationFixture(t, {
      redirect: true,
      history: 'none',
      documentDelay: 0,
      releaseWritesOnNavigation: true,
    });
    assert.equal(flow.passed, true, JSON.stringify(flow));
    const sequence = flow.fixtureEvents;
    t.diagnostic(JSON.stringify(sequence));
    const released = sequence.indexOf('writes-released');
    assert.ok(sequence.indexOf('write:/slow-one') < released, 'slow-one reached the server before the release');
    assert.ok(sequence.indexOf('write:/slow-two') < released, 'slow-two reached the server before the release');
    assert.ok(
      sequence.indexOf('navigation-held') < released && sequence.indexOf('navigation-held') >= 0,
      'navigation held while the writes were unanswered',
    );
    assert.ok(released < sequence.indexOf('write-answered:/slow-one'));
    assert.ok(released < sequence.indexOf('write-answered:/slow-two'));
    assert.equal(flow.navigationCancelledRequests?.length ?? 0, 0);
    assert.equal(flow.resources.filter((row) => /slow-/.test(row.url) && row.finished).length, 2);
    // The writes are unanswered until the hold is created, so the hold always records a wait; every recorded wait must
    // have settled within its reserve.
    assert.ok(flow.navigationWaits?.length > 0, 'the navigation was held while its writes were in flight');
    assert.ok(
      flow.navigationWaits.every(
        (wait) =>
          wait.settled === true &&
          wait.commitReservePolicy === 'bounded-write-fallback' &&
          wait.commitReserveMs === reserveFor(wait),
      ),
      JSON.stringify(flow.navigationWaits),
    );
  });
  test('an explicit navigation commit reserve overrides the default half-time budget', async (t) => {
    // The explicit reserve leaves the hold about one second of the action budget; the writes never answer.
    const flow = await navigationFixture(t, {
      history: 'none',
      gateDocumentOnWrites: true,
      navigationCommitReserveMs: HANG_GUARD_ACTION_MS - 1000,
    });
    assert.equal(flow.passed, true, JSON.stringify(flow));
    assert.equal(flow.navigationCancelledRequests.length, 2);
    assert.ok(flow.navigationWaits.length > 0);
    assert.equal(navigationCommitBudget(4000).reserveMs, 2000);
    assert.equal(navigationCommitBudget(4000, { explicitMs: 3000 }).reserveMs, 3000);
    assert.ok(
      flow.navigationWaits.every(
        (wait) =>
          wait.commitReservePolicy === 'explicit' &&
          wait.commitReserveMs === HANG_GUARD_ACTION_MS - 1000 &&
          wait.writeHoldAllowanceMs <= 1000 &&
          wait.settled === false &&
          wait.writes.includes('PATCH /slow-one') &&
          wait.writes.includes('POST /slow-two'),
      ),
    );
  });
  for (const status of [204, 205])
    test(`a ${status} no-content navigation keeps both completed writes and is separate from failed requests`, async (t) => {
      const flow = await navigationFixture(t, {
        noContent: status,
        completed: true,
        writeMs: 1000,
        documentDelay: 300,
      });
      assert.equal(flow.passed, true, JSON.stringify(flow));
      assert.deepEqual(flow.failedRequests, []);
      assert.equal(flow.resources.filter((row) => /slow-/.test(row.url) && row.finished).length, 2);
      // The report must classify the navigation by its 204/205 status, however Chromium ends the empty response.
      await t.test('the navigation is reported as no-content', () => {
        assert.deepEqual(
          flow.noContentNavigations?.map((row) => row.status),
          [status],
          JSON.stringify(flow.resources.filter((row) => /\/submit/.test(row.url))),
        );
      });
    });
  // The 5 s document answers after the hold, so the reserve is what lets it commit inside the action budget.
  test('a fast initial page cannot shrink the fallback reserve for a new 5 s document with writes outlasting the action', async (t) => {
    const flow = await navigationFixture(t, { history: 'none', documentDelay: 5000 });
    assert.equal(flow.passed, true, JSON.stringify(flow));
    assert.equal(flow.navigationCancelledRequests.length, 2);
    assert.ok(flow.navigationCancelledRequests.every((row) => row.reason === 'document-replaced'));
    assert.ok(flow.navigationWaits.length > 0, 'the fallback reserve has recorded navigation wait evidence');
    assert.ok(
      flow.navigationWaits.every(
        (wait) =>
          wait.commitReservePolicy === 'bounded-write-fallback' &&
          wait.comparableNavigationMs === null &&
          wait.commitReserveMs >= 9000,
      ),
    );
    assert.equal(flow.navigationWaits[0].commitReserveMs, reserveFor(flow.navigationWaits[0]));
  });
  test('a new POST to 303 to 303 to GET chain keeps the fallback reserve across all three hops', async (t) => {
    // Each hop answers as soon as the server observes its request, so the chain is released by the navigation
    // itself; the writes never answer, so the first hold is bounded by the reserve alone.
    const flow = await navigationFixture(t, {
      redirect: true,
      redirectHops: 2,
      history: 'none',
      documentDelay: 0,
    });
    assert.equal(flow.passed, true, JSON.stringify(flow));
    assert.ok(flow.navigationWaits.length > 0, 'navigation waits were recorded for the three-hop chain');
    assert.ok(
      flow.navigationWaits.every(
        (wait) => wait.commitReservePolicy === 'bounded-write-fallback' && wait.commitReserveMs >= 9000,
      ),
    );
    assert.equal(flow.navigationWaits[0].commitReserveMs, reserveFor(flow.navigationWaits[0]));
    assert.ok(
      flow.navigationWaits.slice(1).every((wait) => wait.writeHoldAllowanceMs === 0),
      'later hops of the chain reuse the first hold',
    );
  });
  test('a reset navigation without an HTTP response remains a failed request', async (t) => {
    const flow = await navigationFixture(t, {
      resetNavigation: true,
      completed: true,
      writeMs: 100,
      documentDelay: 300,
    });
    assert.equal(flow.passed, false);
    assert.ok(flow.failedRequests.length > 0);
  });

  test('a previously completed comparable redirect chain extends the next commit reserve', async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-comparable-chain-'));
    ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
    const markup = (writes) =>
      `<p id="done">Invented page</p><form action="/save" method="POST"><button id="save">Save</button></form>${writes ? `<script>document.querySelector('form').addEventListener('submit',()=>{fetch('/slow-one',{method:'PATCH'}).catch(()=>{});fetch('/slow-two',{method:'POST'}).catch(()=>{});})</script>` : ''}`;
    const server = http.createServer((req, res) => {
      req.resume();
      const pathname = new URL(req.url, 'http://fixture').pathname;
      if (fixtureApi(pathname, res, { items: [] })) return;
      if (pathname.startsWith('/slow-')) return;
      res.setHeader('content-type', 'text/html');
      if (['/save', '/hop', '/done'].includes(pathname)) {
        const timer = setTimeout(() => {
          if (pathname !== '/done') {
            res.statusCode = 303;
            res.setHeader('location', pathname === '/save' ? '/hop' : '/done');
            res.end();
          } else res.end(markup(true));
        }, 800);
        res.once('close', () => clearTimeout(timer));
        return;
      }
      res.end(markup(false));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ownedFixture(t).add(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    // The first click only measures its chain, so it takes the runner's action budget like the second.
    const result = await runAcceptance({
      localUrl: `http://127.0.0.1:${server.address().port}`,
      outputDir: path.join(directory, 'evidence'),
      timeout: HANG_GUARD_ACTION_MS,
      flows: [
        {
          name: 'Comparable chain',
          steps: [
            { action: 'navigate', path: '/' },
            { action: 'click', selector: '#save' },
            { action: 'visible', selector: '#done' },
            { action: 'click', selector: '#save' },
            { action: 'settle' },
            { action: 'visible', selector: '#done' },
          ],
        },
      ],
    });
    const flow = result.flows[0];
    assert.equal(flow.passed, true, JSON.stringify(flow));
    assert.ok(flow.navigationWaits.length > 0);
    assert.ok(
      flow.navigationWaits.every(
        (wait) =>
          wait.commitReservePolicy === 'comparable-navigation-chain' &&
          wait.comparableNavigationMs >= 2300 &&
          wait.commitReserveMs >= 3300,
      ),
      JSON.stringify(flow.navigationWaits),
    );
    assert.equal(flow.navigationWaits[0].commitReserveMs, reserveFor(flow.navigationWaits[0]));
    assert.equal(
      flow.navigationCancelledRequests.length,
      2,
      'browser cancellations remain recorded without claiming those writes committed',
    );
    t.diagnostic(
      JSON.stringify({
        navigationWaits: flow.navigationWaits.map(
          ({ commitReservePolicy, comparableNavigationMs, commitReserveMs, waitedMs, settled }) => ({
            commitReservePolicy,
            comparableNavigationMs,
            commitReserveMs,
            waitedMs,
            settled,
          }),
        ),
      }),
    );
  });
});
