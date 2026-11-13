// @test-kind contract: provenance transports wait for each DevTools answer until their attachment is disposed, and report an answer that never comes
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { request } from 'playwright-core';
import { createPortalProvenanceTransport, readEndedByContextClose } from '../lense/portal-provenance-transport.mjs';
import { createDomProvenanceTransport } from '../lense/dom-provenance-transport.mjs';
import { liveTimers } from './helpers/live-timers.mjs';

const LENSE = import.meta.resolve('../lense/');
const ORIGIN = 'https://portal.invalid';
const PAGE = ORIGIN + '/invented-page';

/** A DevTools session whose frame tree reports `loader`; `hold()` makes the next frame-tree reads wait for the test. */
function fakeSession() {
  const sent = [];
  let loader = 'initial-loader',
    held = null,
    gone = false;
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method, params = {}) => {
      sent.push({ method, params });
      // A closed page, context or browser rejects every command of its session.
      if (gone) throw new Error('Target page, context or browser has been closed');
      if (method === 'Page.getFrameTree') {
        if (held) await held.promise;
        return { frameTree: { frame: { id: 'main', loaderId: loader } } };
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'invented-script' };
      if (method === 'Runtime.evaluate' && params.expression?.includes('claim'))
        return { result: { objectId: 'invented-registry' } };
      return {};
    },
  });
  return {
    cdp,
    sent,
    navigate(next) {
      loader = next;
    },
    close() {
      gone = true;
    },
    hold() {
      held = Promise.withResolvers();
      return held;
    },
    release() {
      held?.resolve();
      held = null;
    },
  };
}

const settle = async (done) => {
  for (let i = 0; i < 50 && !done(); i++) await setImmediate();
};

let disposal;
/**
 * The errors the pinned Playwright raises when a request context is disposed under a sideband read: `inFlight` for a
 * read still waiting for its answer, `dropped` for reading the body of an answer that arrived but was not read yet.
 * Produced once by a standalone request context against a loopback server this helper owns.
 */
const disposalErrors = () =>
  (disposal ??= (async () => {
    const server = http.createServer((incoming, response) => {
      if (incoming.url !== '/never') response.end('{}');
    });
    let context;
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      context = await request.newContext();
      const unread = await context.get(base + '/answered');
      const arrived = once(server, 'request');
      const waiting = context.get(base + '/never').then(
        () => assert.fail('a read of an answer that never comes resolved'),
        (error) => error,
      );
      await arrived;
      await context.dispose();
      context = null;
      const dropped = await unread.body().then(
        () => assert.fail('the body of a disposed answer was read'),
        (error) => error,
      );
      return { inFlight: await waiting, dropped };
    } finally {
      await context?.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  })());

async function attachedPortal(t) {
  const session = fakeSession(),
    reports = [];
  const transport = createPortalProvenanceTransport({ request: {} }, [{ origin: ORIGIN }]);
  const attachment = await transport.onAttach({
    cdp: session.cdp,
    configure: (method, params) => session.cdp.send(method, params),
    report: (error) => reports.push(error.message),
  });
  ownedFixture(t).add(() => attachment.dispose());
  // A new document of the configured origin claims the registry its bootstrap installed.
  session.navigate('document-loader');
  session.cdp.emit('Network.requestWillBeSent', {
    type: 'Document',
    requestId: 'invented-request',
    frameId: 'main',
    loaderId: 'document-loader',
    request: { url: PAGE },
  });
  session.cdp.emit('Runtime.executionContextCreated', {
    context: { id: 7, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
  });
  await settle(() => session.sent.filter(({ method }) => method === 'Page.getFrameTree').length >= 3);
  await setImmediate();
  const proof = {
    version: 1,
    channel: 'lense-applied-response',
    proofId: 'invented-proof',
    bindings: [],
    sourceRefs: [],
  };
  const publish = () =>
    attachment.publishProvenance(
      { resourceType: 'Document', networkId: 'invented-request', frameId: 'main', request: { url: PAGE } },
      proof,
    );
  const published = () =>
    session.sent.some(
      ({ method, params }) => method === 'Runtime.callFunctionOn' && params.arguments?.[0]?.value === proof,
    );
  return { session, reports, attachment, publish, published };
}

test('a markup proof whose frame-tree check answers after the old 3 s deadline is still published', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const live = liveTimers(t, LENSE);
  const { session, reports, publish, published } = await attachedPortal(t);
  session.hold();
  let done = false;
  const publishing = publish().then(() => {
    done = true;
  });
  await setImmediate();
  t.mock.timers.tick(3_001);
  await setImmediate();
  assert.equal(done, false, 'the check is still awaited');
  session.release();
  await publishing;
  assert.equal(published(), true);
  assert.deepEqual(reports, []);
  assert.equal(live.size, 0, 'no command guard remains armed');
});

test('disposing a markup attachment ends a waiting command at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const live = liveTimers(t, LENSE);
  const { session, reports, attachment, publish, published } = await attachedPortal(t);
  session.hold();
  let done = false;
  const publishing = publish().then(() => {
    done = true;
  });
  await setImmediate();
  await attachment.dispose();
  await settle(() => done);
  assert.equal(done, true, 'no timer had to fire');
  await publishing;
  assert.equal(published(), false);
  assert.deepEqual(reports, [], 'a disposed attachment reports nothing');
  assert.equal(live.size, 0);
});

test('a markup command that a live renderer never answers is reported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, reports, publish, published } = await attachedPortal(t);
  session.hold();
  const publishing = publish();
  await setImmediate();
  t.mock.timers.tick(30_000);
  await publishing;
  assert.equal(published(), false);
  assert.deepEqual(reports, ['Page.getFrameTree did not answer within 30000 ms']);
});

async function attachedDom(t) {
  const session = fakeSession(),
    reports = [];
  const transport = createDomProvenanceTransport({ request: {} }, [{ origin: ORIGIN }]);
  const attachment = await transport.onAttach({
    cdp: session.cdp,
    configure: (method, params) => session.cdp.send(method, params),
    report: (error) => reports.push(error.message),
  });
  ownedFixture(t).add(() => attachment.dispose());
  const claimed = () =>
    session.sent.some(({ method, params }) => method === 'Runtime.evaluate' && params.expression?.includes('claim'));
  // A new document's context reads its loader before claiming the registry its bootstrap installed.
  const open = () => {
    session.navigate('document-loader');
    session.cdp.emit('Runtime.executionContextCreated', {
      context: { id: 9, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
    });
  };
  return { session, reports, attachment, claimed, open };
}

test('a script-provenance context whose loader read answers after the old 3 s deadline still claims its registry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const live = liveTimers(t, LENSE);
  const { session, reports, claimed, open } = await attachedDom(t);
  session.hold();
  open();
  await setImmediate();
  t.mock.timers.tick(3_001);
  await setImmediate();
  assert.equal(claimed(), false);
  session.release();
  await settle(claimed);
  assert.equal(claimed(), true);
  await setImmediate();
  assert.deepEqual(reports, []);
  assert.equal(live.size, 0, 'no command guard remains armed');
});

test('disposing a script-provenance attachment ends a waiting command at once, and a never-answered one is reported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const live = liveTimers(t, LENSE);
  const disposed = await attachedDom(t);
  disposed.session.hold();
  disposed.open();
  await setImmediate();
  assert.equal(live.size, 1, 'the guard is armed while the loader read waits');
  await disposed.attachment.dispose();
  await settle(() => live.size === 0);
  assert.equal(live.size, 0, 'no timer had to fire');
  assert.equal(disposed.claimed(), false);
  assert.deepEqual(disposed.reports, []);
  const silent = await attachedDom(t);
  silent.session.hold();
  silent.open();
  await setImmediate();
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.deepEqual(silent.reports, ['Page.getFrameTree did not answer within 30000 ms']);
});

/** A browser context whose sideband reads wait until the test answers or fails them. */
function fakeContext() {
  const reads = [];
  return {
    reads,
    context: {
      request: {
        get: (url) => {
          const read = Promise.withResolvers();
          reads.push({ url, ...read });
          return read.promise;
        },
      },
    },
  };
}

const answer = (status, body) => ({
  status: () => status,
  headers: () => ({ 'content-type': 'application/json' }),
  body: async () => Buffer.from(JSON.stringify(body)),
  dispose: async () => {},
});

const SCRIPT = ORIGIN + '/invented.js';
const HASH = 'a'.repeat(64);
const ACCESS = 'b'.repeat(64);
const scriptDescriptor = {
  version: 1,
  channel: 'mirage-resource',
  proofId: 'invented-script-proof',
  sourceRevision: 'invented-revision',
  sourceRefs: [{ id: 'invented-ref' }],
  scriptProofs: [
    {
      id: 'invented-script',
      hashAlgorithm: 'sha256-utf8',
      generatedHash: HASH,
      lineStarts: [0],
      mappings: [{ sourceRefId: 'invented-ref', generatedStart: 0, generatedEnd: 100, sourceStart: 0, sourceEnd: 100 }],
    },
  ],
};

/** A Mirage document whose script creates DOM nodes; the script's proof comes from a sideband read. */
async function mirageDom(t) {
  const session = fakeSession(),
    browser = fakeContext(),
    reports = [];
  const transport = createDomProvenanceTransport(browser.context, [{ origin: ORIGIN, mirage: true }]);
  const attachment = await transport.onAttach({
    cdp: session.cdp,
    configure: (method, params) => session.cdp.send(method, params),
    report: (error) => reports.push(error.message),
  });
  ownedFixture(t).add(() => attachment.dispose());
  const bootstrap = session.sent.find(({ method }) => method === 'Page.addScriptToEvaluateOnNewDocument').params.source;
  const secret = /"secret":"([a-f0-9]{64})"/.exec(bootstrap)[1],
    binding = /"binding":"([^"]+)"/.exec(bootstrap)[1];
  session.navigate('document-loader');
  session.cdp.emit('Runtime.executionContextCreated', {
    context: { id: 9, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
  });
  const claimed = () =>
    session.sent.some(({ method, params }) => method === 'Runtime.evaluate' && params.expression?.includes('claim'));
  await settle(claimed);
  await setImmediate();
  session.cdp.emit('Debugger.scriptParsed', {
    executionContextId: 9,
    scriptId: 'invented-script-id',
    url: SCRIPT,
    hash: HASH,
    startLine: 0,
    startColumn: 0,
    endLine: 0,
    endColumn: 100,
  });
  const serve = (requestId) => {
    session.cdp.emit('Network.requestWillBeSent', {
      type: 'Script',
      requestId,
      frameId: 'main',
      loaderId: 'document-loader',
      request: { url: SCRIPT },
    });
    session.cdp.emit('Network.responseReceived', {
      type: 'Script',
      requestId,
      response: {
        status: 200,
        url: SCRIPT,
        headers: { 'x-paqvilo-script-proof': scriptDescriptor.proofId, 'x-paqvilo-provenance-access': ACCESS },
      },
    });
  };
  const create = (id) =>
    session.cdp.emit('Runtime.bindingCalled', {
      name: binding,
      executionContextId: 9,
      payload: JSON.stringify({
        version: 1,
        secret,
        id,
        relationship: 'created-by',
        frames: [{ url: SCRIPT, line: 1, column: 1 }],
      }),
    });
  /** The verdict delivered to the page for node `id`, or undefined while it is pending. */
  const verdict = (id) =>
    session.sent
      .filter(
        ({ method, params }) =>
          method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('resolveMany'),
      )
      .flatMap(({ params }) => params.arguments[0].value)
      .find((entry) => entry.id === id)?.proof;
  return { session, browser, reports, attachment, serve, create, verdict };
}

test('a callsite whose script proof arrives after any amount of time is mapped, with nothing armed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const live = liveTimers(t, LENSE);
  const dom = await mirageDom(t);
  dom.serve('script-request');
  dom.create('late-node');
  await setImmediate();
  t.mock.timers.tick(600_000);
  await setImmediate();
  assert.equal(dom.verdict('late-node'), undefined, 'the node waits while its document has a read in flight');
  dom.browser.reads[0].resolve(answer(200, scriptDescriptor));
  await settle(() => dom.verdict('late-node'));
  assert.deepEqual(
    dom.verdict('late-node').sourceRefs.map((ref) => ref.id),
    ['invented-ref'],
  );
  assert.equal(dom.verdict('late-node').facts[0].proof, 'observed-dom-callsite');
  assert.deepEqual(dom.reports, []);
  assert.equal(live.size, 0);
});

test('a callsite is unmapped at once when no read for its document can still prove it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const live = liveTimers(t, LENSE);
  const dom = await mirageDom(t);
  dom.create('unread-node');
  await settle(() => dom.verdict('unread-node'));
  assert.equal(dom.verdict('unread-node')?.reason, 'script-callsite-unmapped', 'no read is in flight');
  dom.serve('script-request');
  dom.create('read-node');
  await setImmediate();
  assert.equal(dom.verdict('read-node'), undefined);
  dom.browser.reads[0].resolve(answer(404, {}));
  await settle(() => dom.verdict('read-node'));
  assert.equal(dom.verdict('read-node')?.reason, 'script-callsite-unmapped', 'the only read settled without a proof');
  assert.deepEqual(dom.reports, []);
  assert.equal(live.size, 0, 'no timer decided either verdict');
});

test('a script read that fails while its tab is live is reported and settles its callsites', async (t) => {
  const dom = await mirageDom(t);
  dom.serve('script-request');
  dom.create('failed-node');
  dom.browser.reads[0].reject(new Error('invented loopback failure'));
  await settle(() => dom.verdict('failed-node'));
  assert.equal(dom.verdict('failed-node')?.reason, 'script-callsite-unmapped');
  assert.deepEqual(dom.reports, ['the script provenance read did not complete']);
});

test('Playwright request-context disposal errors are recognised; another failure is not', async () => {
  const { inFlight, dropped } = await disposalErrors();
  assert.equal(readEndedByContextClose(inFlight), true, inFlight.message);
  assert.equal(readEndedByContextClose(dropped), true, dropped.message);
  assert.equal(readEndedByContextClose(new Error('invented body failure')), false);
  assert.equal(readEndedByContextClose(new Error('Target page, context or browser has been closed')), false);
});

test('closing the browser before a script read fails ends the read quietly', async (t) => {
  const { inFlight } = await disposalErrors();
  const dom = await mirageDom(t);
  dom.serve('script-request');
  dom.session.close();
  dom.browser.reads[0].reject(inFlight);
  for (let i = 0; i < 10; i++) await setImmediate();
  assert.deepEqual(dom.reports, []);
});

/** A Mirage page answer whose provenance read is in flight as `browser.reads[0]`; the attachment closes with `t`. */
async function pageReadInFlight(t) {
  const session = fakeSession(),
    browser = fakeContext(),
    reports = [];
  const transport = createPortalProvenanceTransport(browser.context, [{ origin: ORIGIN, mirage: true }]);
  const attachment = await transport.onAttach({
    cdp: session.cdp,
    configure: (method, params) => session.cdp.send(method, params),
    report: (error) => reports.push(error.message),
  });
  ownedFixture(t).add(() => attachment.dispose());
  session.cdp.emit('Network.responseReceived', {
    type: 'Document',
    requestId: 'invented-request',
    frameId: 'main',
    loaderId: 'document-loader',
    response: {
      status: 200,
      url: PAGE,
      headers: { 'x-paqvilo-provenance': 'invented-proof', 'x-paqvilo-provenance-access': ACCESS },
    },
  });
  await setImmediate();
  return { session, browser, reports };
}

test('closing the browser before a page read fails ends the read quietly; a live tab reports another failure', async (t) => {
  const { inFlight } = await disposalErrors();
  for (const closing of [true, false]) {
    const { session, browser, reports } = await pageReadInFlight(t);
    if (closing) session.close();
    browser.reads[0].reject(closing ? inFlight : new Error('invented loopback failure'));
    for (let i = 0; i < 10; i++) await setImmediate();
    assert.deepEqual(reports, closing ? [] : ['the page provenance read did not complete']);
  }
});

test('a script acknowledgement for a request that is not a script load does not hold the callsites of its frame', async (t) => {
  const dom = await mirageDom(t);
  // A script file read by fetch or XHR is acknowledged too, but no script-load notification will ever match it.
  const fetched = await dom.attachment.publishProvenance(
    { resourceType: 'Fetch', networkId: 'fetched-script', frameId: 'main', request: { url: SCRIPT } },
    { ...scriptDescriptor, channel: 'lense-script-resource' },
  );
  assert.equal(fetched, false);
  dom.create('fetched-node');
  await settle(() => dom.verdict('fetched-node'));
  assert.equal(dom.verdict('fetched-node')?.reason, 'script-callsite-unmapped');
  assert.deepEqual(dom.reports, []);
});

/** An answer whose body Playwright dropped when its browser context began to close; `error` is what reading it raises. */
const droppedAnswer = (error) => ({
  ...answer(200, {}),
  body: async () => {
    throw error;
  },
});

test('closing the browser context while a script answer is unread or in flight ends the read quietly; another failure is reported', async (t) => {
  const { inFlight, dropped } = await disposalErrors();
  // The tab still answers: Playwright closes the pages only after it has disposed of the request context.
  for (const end of [(read) => read.resolve(droppedAnswer(dropped)), (read) => read.reject(inFlight)]) {
    const quiet = await mirageDom(t);
    quiet.serve('script-request');
    quiet.create('closing-node');
    end(quiet.browser.reads[0]);
    await settle(() => quiet.verdict('closing-node'));
    assert.equal(quiet.verdict('closing-node')?.reason, 'script-callsite-unmapped');
    assert.deepEqual(quiet.reports, []);
  }
  const failed = await mirageDom(t);
  failed.serve('script-request');
  failed.browser.reads[0].resolve({
    ...answer(200, {}),
    body: async () => {
      throw new Error('invented body failure');
    },
  });
  await settle(() => failed.reports.length);
  assert.deepEqual(failed.reports, ['the script provenance read did not complete']);
});

test('closing the browser context while a page answer is unread or in flight ends the read quietly', async (t) => {
  const { inFlight, dropped } = await disposalErrors();
  for (const end of [(read) => read.resolve(droppedAnswer(dropped)), (read) => read.reject(inFlight)]) {
    const { browser, reports } = await pageReadInFlight(t);
    end(browser.reads[0]);
    for (let i = 0; i < 10; i++) await setImmediate();
    assert.deepEqual(reports, []);
  }
});
