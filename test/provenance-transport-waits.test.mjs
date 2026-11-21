// @test-kind contract: provenance transports wait for each DevTools answer until their attachment is disposed, and report an answer that never comes
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { request } from 'playwright-core';
import { createHash } from 'node:crypto';
import { createPortalProvenanceTransport, readEndedByContextClose } from '../lense/portal-provenance-transport.mjs';
import { createDomProvenanceTransport } from '../lense/dom-provenance-transport.mjs';
import { liveTimers } from './helpers/live-timers.mjs';

const LENSE = import.meta.resolve('../lense/');
const ORIGIN = 'https://portal.invalid';
const PAGE = ORIGIN + '/invented-page';

// A reported loss as text; one that a reload cannot repair is marked.
const reportText = (error) => (error.reloadHelps === false ? 'no reload: ' : '') + error.message;

/** Where V8 locates a bootstrap's registry method: the zero-based line and column of its parameter list. */
const methodLocation = (source, signature) => {
  const before = source.slice(0, source.indexOf(signature) + signature.indexOf('('));
  return { lineNumber: before.split('\n').length - 1, columnNumber: before.length - before.lastIndexOf('\n') - 1 };
};

/** Whether a sent command calls a verified registry `claim` (its object id names the context: method:<context>:...). */
const isClaim = ({ method, params }) =>
  method === 'Runtime.callFunctionOn' && /^method:\d+:\d+:claim$/.test(params.objectId);

/**
 * A DevTools session whose frame tree reports `loader`; `hold()` makes the next frame-tree reads wait for the test.
 * Every context of a registered bootstrap gets that bootstrap's registry as the browser reports it: the parsed
 * bootstrap script, a global slot and its `claim` and `release` functions located in that script. `useRegistries()`
 * makes later contexts have no slot (`absent`), a page-made lookalike whose functions lie elsewhere (`forged`), or a
 * registry whose bootstrap script the browser does not report (`unreported`).
 */
function fakeSession() {
  const sent = [],
    bootstraps = [];
  let loader = 'initial-loader',
    held = null,
    gone = false,
    registries = 'genuine',
    claimAnswer = { result: { objectId: 'invented-writer' } };
  const answer = (method, params) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      bootstraps.push({ source: params.source, slot: /"slot":"(\w+)"/.exec(params.source)[1] });
      return { identifier: 'invented-script' };
    }
    if (method === 'Runtime.evaluate' && params.expression === 'this')
      return { result: { objectId: 'global:' + params.contextId } };
    const [kind, context, index, name] = String(params.objectId).split(':');
    const bootstrap = bootstraps[index];
    if (method === 'Runtime.getProperties' && kind === 'global')
      return {
        result:
          registries === 'absent'
            ? []
            : bootstraps.map((item, position) => ({
                name: item.slot,
                isOwn: true,
                writable: false,
                configurable: false,
                value: { type: 'object', objectId: `registry:${context}:${position}` },
              })),
      };
    if (method === 'Runtime.getProperties' && kind === 'registry')
      return {
        result: ['claim', 'release'].map((member) => ({
          name: member,
          isOwn: true,
          writable: false,
          configurable: false,
          value: { type: 'function', objectId: `method:${context}:${index}:${member}` },
        })),
      };
    if (method === 'Runtime.getProperties' && kind === 'method')
      return {
        internalProperties: [
          {
            name: '[[FunctionLocation]]',
            value: {
              value: {
                scriptId: registries === 'forged' ? 'page-script' : `bootstrap:${context}:${index}`,
                ...methodLocation(bootstrap.source, name + '(value) {'),
              },
            },
          },
        ],
      };
    if (method === 'Runtime.callFunctionOn' && kind === 'method' && name === 'claim') {
      if (claimAnswer instanceof Error) throw claimAnswer;
      return claimAnswer;
    }
    return {};
  };
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method, params = {}) => {
      sent.push({ method, params });
      // A closed page, context or browser rejects every command of its session.
      if (gone) throw new Error('Target page, context or browser has been closed');
      if (method === 'Page.getFrameTree') {
        if (held) await held.promise;
        return { frameTree: { frame: { id: 'main', loaderId: loader } } };
      }
      return answer(method, params);
    },
  });
  const emit = cdp.emit.bind(cdp);
  // The browser parses each bootstrap in a new context of a configured origin.
  cdp.emit = (event, payload) => {
    const delivered = emit(event, payload);
    if (event === 'Runtime.executionContextCreated' && payload.context.origin === ORIGIN && registries !== 'unreported')
      bootstraps.forEach((bootstrap, index) =>
        emit('Debugger.scriptParsed', {
          executionContextId: payload.context.id,
          scriptId: `bootstrap:${payload.context.id}:${index}`,
          url: '',
          hash: createHash('sha256').update(bootstrap.source).digest('hex'),
        }),
      );
    return delivered;
  };
  return {
    cdp,
    sent,
    navigate(next) {
      loader = next;
    },
    // The answer of every later registry claim: a protocol answer, or an Error the command rejects with.
    answerClaims(answer) {
      claimAnswer = answer;
    },
    useRegistries(kind) {
      registries = kind;
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

/** A markup attachment whose `open()` announces a new document of the configured origin, which then claims its registry. */
async function attachedPortalDocument(t) {
  const session = fakeSession(),
    reports = [];
  const transport = createPortalProvenanceTransport({ request: {} }, [{ origin: ORIGIN }]);
  const attachment = await transport.onAttach({
    cdp: session.cdp,
    configure: (method, params) => session.cdp.send(method, params),
    report: (error) => reports.push(reportText(error)),
  });
  ownedFixture(t).add(() => attachment.dispose());
  const open = () => {
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
  };
  return { session, reports, attachment, open };
}

async function attachedPortal(t) {
  const { session, reports, attachment, open } = await attachedPortalDocument(t);
  open();
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
    report: (error) => reports.push(reportText(error)),
  });
  ownedFixture(t).add(() => attachment.dispose());
  const claimed = () => session.sent.some(isClaim);
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

for (const [kind, attach] of [
  ['script', attachedDom],
  ['markup', attachedPortalDocument],
])
  test(`a ${kind}-provenance claim is sent once, only to a verified registry: a document without a registry is quiet, an unverifiable, refused or rejected one on a live document is reported`, async (t) => {
    const claims = (session) => session.sent.filter(isClaim).length;
    for (const [registries, answer, expected, sent] of [
      ['absent', null, [], 0],
      ['forged', null, ['held'], 0],
      ['unreported', null, ['claimed'], 0],
      ['genuine', { result: { type: 'object', subtype: 'null', value: null } }, ['claimed'], 1],
      ['genuine', new Error('Cannot find context with specified id'), ['claimed'], 1],
    ]) {
      const { session, reports, open } = await attach(t);
      session.useRegistries(registries);
      session.answerClaims(answer);
      open();
      await settle(() => claims(session) === sent && reports.length === expected.length);
      // Every continuation the verification and the claim's answer could start has run.
      await setImmediate();
      assert.equal(claims(session), sent, `${registries}: the claim is sent at most once, and only when verified`);
      assert.deepEqual(
        reports.map((message) =>
          /^no reload: a page script holds the place of the (?:script|page) provenance registry in a document, so provenance for that document is not recorded$/.test(
            message,
          )
            ? 'held'
            : (/registry of a document could not be (claimed)/.exec(message)?.[1] ?? message),
        ),
        expected,
        registries,
      );
    }
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
    report: (error) => reports.push(reportText(error)),
  });
  ownedFixture(t).add(() => attachment.dispose());
  const bootstrap = session.sent.find(({ method }) => method === 'Page.addScriptToEvaluateOnNewDocument').params.source;
  const notifyKey = /"notifyKey":"([a-f0-9]{64})"/.exec(bootstrap)[1],
    binding = /"binding":"([^"]+)"/.exec(bootstrap)[1];
  session.navigate('document-loader');
  session.cdp.emit('Runtime.executionContextCreated', {
    context: { id: 9, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
  });
  const claimed = () => session.sent.some(isClaim);
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
  const create = (id, executionContextId = 9) =>
    session.cdp.emit('Runtime.bindingCalled', {
      name: binding,
      executionContextId,
      payload: JSON.stringify({
        version: 1,
        key: notifyKey,
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
  let current = 9;
  /**
   * The next document of the frame, in Chromium's order: the end of the current document's context, the commit
   * notification, what follows it, the new context and its claimed registry, and its parsed script.
   */
  const commit = async (loaderId, executionContextId, afterCommit = () => {}) => {
    session.cdp.emit('Runtime.executionContextDestroyed', { executionContextId: current });
    current = executionContextId;
    session.cdp.emit('Page.frameNavigated', { frame: { id: 'main', loaderId } });
    afterCommit();
    session.navigate(loaderId);
    session.cdp.emit('Runtime.executionContextCreated', {
      context: { id: executionContextId, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
    });
    await settle(() =>
      session.sent.some(
        (command) => isClaim(command) && command.params.objectId.startsWith(`method:${executionContextId}:`),
      ),
    );
    await setImmediate();
    session.cdp.emit('Debugger.scriptParsed', {
      executionContextId,
      scriptId: 'invented-script-id-' + executionContextId,
      url: SCRIPT,
      hash: HASH,
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 100,
    });
  };
  const requested = (requestId, loaderId) =>
    session.cdp.emit('Network.requestWillBeSent', {
      type: 'Script',
      requestId,
      frameId: 'main',
      loaderId,
      request: { url: SCRIPT },
    });
  /** A Lense script acknowledgement as the interception publishes it after Fetch.fulfillRequest answered. */
  const acknowledge = (networkId) =>
    attachment.publishProvenance(
      { resourceType: 'Script', networkId, frameId: 'main', request: { url: SCRIPT } },
      { ...scriptDescriptor, channel: 'lense-script-resource' },
    );
  return { session, browser, reports, attachment, serve, create, verdict, commit, requested, acknowledge };
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

test('a script acknowledged before its document commit notification proves the callsite of that document', async (t) => {
  const dom = await mirageDom(t);
  // The browser answers Fetch.fulfillRequest before the renderer's Page.frameNavigated and Network.requestWillBeSent
  // of the document that requested the script arrive (the hosted order: acknowledgement, commit, request).
  assert.equal(await dom.acknowledge('next-script'), true);
  await dom.commit('next-loader', 10, () => dom.requested('next-script', 'next-loader'));
  dom.create('next-node', 10);
  await settle(() => dom.verdict('next-node'));
  assert.equal(dom.verdict('next-node')?.reason, undefined, 'the acknowledgement was not discarded by the commit');
  assert.deepEqual(
    dom.verdict('next-node').sourceRefs.map((ref) => ref.id),
    ['invented-ref'],
  );
  assert.equal(dom.verdict('next-node').facts[0].proof, 'observed-dom-callsite');
  assert.deepEqual(dom.reports, []);
});

test('an acknowledgement that names the replaced document holds the next document only until its notification', async (t) => {
  const dom = await mirageDom(t);
  assert.equal(await dom.acknowledge('replaced-script'), true);
  await dom.commit('next-loader', 10);
  dom.create('next-node', 10);
  // A verdict is sent within the microtasks of the binding event; one turn of the event loop has passed them.
  await setImmediate();
  assert.equal(dom.verdict('next-node'), undefined, 'an acknowledgement of this frame can still prove the node');
  // Its notification names the replaced document: the proof stays there, and the waiting node receives its verdict.
  dom.requested('replaced-script', 'document-loader');
  await settle(() => dom.verdict('next-node'));
  assert.equal(dom.verdict('next-node')?.reason, 'script-callsite-unmapped');
  assert.deepEqual(dom.verdict('next-node').sourceRefs, []);
  assert.deepEqual(dom.reports, []);
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
    report: (error) => reports.push(reportText(error)),
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

// Calls of a verified registry `release`; the context is the second part of the method's object id.
const retirements = (session) =>
  session.sent
    .filter(({ method, params }) => method === 'Runtime.callFunctionOn' && /:release$/.test(params.objectId ?? ''))
    .map((command) => ({ ...command, contextId: Number(command.params.objectId.split(':')[1]) }));

test('disposal retires the registry of every live document context, also beyond the record limit and before its claim', async () => {
  for (const create of [createDomProvenanceTransport, createPortalProvenanceTransport]) {
    const session = fakeSession();
    const transport = create({ request: {} }, [{ origin: ORIGIN }]);
    const attachment = await transport.onAttach({
      cdp: session.cdp,
      configure: (method, params) => session.cdp.send(method, params),
      report: () => {},
    });
    session.navigate('document-loader');
    const ids = Array.from({ length: 130 }, (_, index) => 100 + index);
    for (const id of ids)
      session.cdp.emit('Runtime.executionContextCreated', {
        context: { id, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
      });
    // A context of another origin, an isolated world and a destroyed context have no registry to retire.
    session.cdp.emit('Runtime.executionContextCreated', {
      context: { id: 300, origin: 'https://other.invalid', auxData: { isDefault: true, frameId: 'main' } },
    });
    session.cdp.emit('Runtime.executionContextCreated', {
      context: { id: 301, origin: ORIGIN, auxData: { isDefault: false, frameId: 'main' } },
    });
    session.cdp.emit('Runtime.executionContextDestroyed', { executionContextId: ids.pop() });
    // Disposed in the same turn: no claim has been answered for any context yet.
    await attachment.dispose();
    assert.deepEqual(
      retirements(session)
        .map(({ contextId }) => contextId)
        .sort((a, b) => a - b),
      ids,
      create.name,
    );
    assert.ok(
      session.sent.findIndex(({ method }) => method === 'Page.removeScriptToEvaluateOnNewDocument') <
        session.sent.findIndex((command) => /:release$/.test(command.params?.objectId ?? '')),
      `${create.name}: the bootstrap is removed before the registries are retired`,
    );
  }
});

test('a document that was open before the bootstrap is never sent the release key', async () => {
  for (const create of [createDomProvenanceTransport, createPortalProvenanceTransport]) {
    const session = fakeSession();
    const transport = create({ request: {} }, [{ origin: ORIGIN }]);
    const attachment = await transport.onAttach({
      cdp: session.cdp,
      configure: (method, params) => session.cdp.send(method, params),
      report: () => {},
    });
    // The frame still shows the loader it had when the transport attached.
    session.cdp.emit('Runtime.executionContextCreated', {
      context: { id: 5, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
    });
    await settle(() => session.sent.filter(({ method }) => method === 'Page.getFrameTree').length >= 2);
    await setImmediate();
    await attachment.dispose();
    assert.deepEqual(
      session.sent.filter(({ method }) => method === 'Runtime.evaluate'),
      [],
      create.name,
    );
  }
});

test('disposal sends the release key only to a verified registry', async () => {
  for (const create of [createDomProvenanceTransport, createPortalProvenanceTransport]) {
    const session = fakeSession();
    const transport = create({ request: {} }, [{ origin: ORIGIN }]);
    const attachment = await transport.onAttach({
      cdp: session.cdp,
      configure: (method, params) => session.cdp.send(method, params),
      report: () => {},
    });
    session.navigate('document-loader');
    session.useRegistries('forged');
    session.cdp.emit('Runtime.executionContextCreated', {
      context: { id: 7, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
    });
    await attachment.dispose();
    const bootstrap = session.sent.find(({ method }) => method === 'Page.addScriptToEvaluateOnNewDocument').params
      .source;
    const releaseKey = /"releaseKey":"([a-f0-9]{64})"/.exec(bootstrap)[1];
    assert.deepEqual(retirements(session), [], create.name);
    assert.equal(
      session.sent.some(
        ({ method, params }) =>
          method !== 'Page.addScriptToEvaluateOnNewDocument' && JSON.stringify(params).includes(releaseKey),
      ),
      false,
      `${create.name}: the release key goes to no registry that is not the bootstrap's own`,
    );
    assert.equal(
      session.sent.some(({ method }) => method === 'Runtime.callFunctionOn'),
      false,
      `${create.name}: nothing is called on a registry that is not the bootstrap's own`,
    );
  }
});

const tookOver = (kind) =>
  `no reload: a document took over the window of its frame's initial empty document, so its ${kind} provenance is not recorded`;
const kinds = new Map([
  [attachedDom, 'script'],
  [attachedPortalDocument, 'page'],
]);

test('a document that takes over the live context of its frame is reported once per frame, without reload advice, and never claimed', async (t) => {
  for (const [attach, kind] of kinds) {
    const { session, reports, open } = await attach(t);
    const verifications = () => session.sent.filter(({ method }) => method === 'Runtime.getProperties').length;
    // The initial empty document's context, whose bootstrap installed no registry.
    session.useRegistries('absent');
    open();
    await settle(() => verifications() > 0);
    await setImmediate();
    // The same-origin document commits into that window: Chromium reports the navigation, and no new context.
    session.useRegistries('genuine');
    session.cdp.emit('Page.frameNavigated', {
      frame: { id: 'main', loaderId: 'reused-loader', url: PAGE },
      type: 'Navigation',
    });
    await setImmediate();
    assert.deepEqual(reports, [tookOver(kind)], attach.name);
    // Another document of the same frame takes over a live context again: the frame was already reported.
    session.useRegistries('absent');
    const before = verifications();
    session.cdp.emit('Runtime.executionContextCreated', {
      context: { id: 21, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
    });
    await settle(() => verifications() > before);
    await setImmediate();
    session.cdp.emit('Page.frameNavigated', {
      frame: { id: 'main', loaderId: 'next-reused-loader', url: PAGE },
      type: 'Navigation',
    });
    await setImmediate();
    assert.deepEqual(reports, [tookOver(kind)], `${attach.name}: one report per frame`);
    assert.equal(session.sent.some(isClaim), false, `${attach.name}: nothing is claimed in a reused window`);
  }
});

test('a document restored from the back/forward cache is claimed again and is not reported as a reused window', async (t) => {
  for (const [attach] of kinds) {
    const { session, reports, open } = await attach(t);
    open();
    await settle(() => session.sent.filter(isClaim).length === 1);
    // Chromium's order for a restore: the contexts are cleared, the restored document's context is reported again,
    // then its navigation of type BackForwardCacheRestore.
    session.navigate('restored-loader');
    session.cdp.emit('Runtime.executionContextsCleared', {});
    const restored = session.sent.length;
    session.cdp.emit('Runtime.executionContextCreated', {
      context: { id: 23, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
    });
    session.cdp.emit('Page.frameNavigated', {
      frame: { id: 'main', loaderId: 'restored-loader' },
      type: 'BackForwardCacheRestore',
    });
    await settle(() => session.sent.slice(restored).some(isClaim));
    await setImmediate();
    assert.equal(
      session.sent
        .slice(restored)
        .some((command) => isClaim(command) && command.params.objectId.startsWith('method:23:')),
      true,
      `${attach.name}: the restored document is claimed`,
    );
    assert.deepEqual(reports, [], attach.name);
  }
});

// @test-kind security: a registry is verified only against the bootstrap the browser reported for the current context;
// after a renderer swap the same numeric context and script ids can name a page-made function at the claim location
test('after the contexts are cleared, a reused context id with a lookalike at the old bootstrap location receives nothing', async (t) => {
  for (const [attach] of kinds) {
    const { session, open } = await attach(t);
    open();
    await settle(() => session.sent.filter(isClaim).length === 1);
    const contextId = Number(session.sent.find(isClaim).params.objectId.split(':')[1]);
    // A new renderer process restarts its ids: the next document's context has the same id, its functions report the
    // same script id and location, and the browser reports no bootstrap for it.
    session.cdp.emit('Runtime.executionContextsCleared', {});
    session.useRegistries('unreported');
    const after = session.sent.length;
    session.cdp.emit('Runtime.executionContextCreated', {
      context: { id: contextId, origin: ORIGIN, auxData: { isDefault: true, frameId: 'main' } },
    });
    await settle(() => session.sent.slice(after).some(({ method }) => method === 'Runtime.getProperties'));
    await setImmediate();
    await setImmediate();
    assert.equal(
      session.sent.slice(after).some(({ method }) => method === 'Runtime.callFunctionOn'),
      false,
      `${attach.name}: nothing is sent to the lookalike`,
    );
  }
});

test('a document without a target origin that takes over a live context is not reported', async (t) => {
  for (const [attach] of kinds) {
    const { session, reports, open } = await attach(t);
    session.useRegistries('absent');
    open();
    await settle(() => session.sent.some(({ method }) => method === 'Runtime.getProperties'));
    await setImmediate();
    session.cdp.emit('Page.frameNavigated', {
      frame: { id: 'main', loaderId: 'srcdoc-loader', url: 'about:srcdoc' },
      type: 'Navigation',
    });
    await setImmediate();
    assert.deepEqual(reports, [], attach.name);
    assert.equal(session.sent.some(isClaim), false);
  }
});

test('verifying a registry never reads the indexed properties of the page global, which are its frames windows', async (t) => {
  for (const [attach] of kinds) {
    const { session, open } = await attach(t);
    open();
    await settle(() => session.sent.some(isClaim));
    const globalReads = session.sent.filter(
      ({ method, params }) => method === 'Runtime.getProperties' && params.objectId.startsWith('global:'),
    );
    assert.ok(globalReads.length > 0, attach.name);
    for (const { params } of globalReads)
      assert.equal(params.nonIndexedPropertiesOnly, true, `${attach.name}: a frame window is never materialized`);
  }
});
