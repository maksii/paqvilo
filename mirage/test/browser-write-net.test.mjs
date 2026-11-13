// @test-kind security: the browser-session write net stops every write of an owned page, popup or frame, continues foreign pages untouched and fails closed when the owner cannot be resolved
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBrowserWriteNet, connectCdpTransport, UNATTRIBUTED } from '../lib/browser-write-net.mjs';
import { fakeTransport } from './support/fake-cdp-transport.mjs';

const OWNER = { tab: 'owned' };
const decide = ({ method }) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return { action: 'continue' };
  if (method === 'PUT') return { action: 'fulfil', status: 204 };
  return { action: 'block' };
};

const created = (targetId, type, openerId) => ({
  method: 'Target.targetCreated',
  params: { targetInfo: { targetId, type, ...(openerId ? { openerId } : {}) } },
});
const paused = (requestId, frameId, method, path = '/save') => ({
  method: 'Fetch.requestPaused',
  params: { requestId, frameId, request: { method, url: `https://portal.invalid${path}` } },
});
const noTarget = () => {
  throw new Error('No target with given id found');
};

async function openNet(transport, extra = {}) {
  const decided = [];
  const net = await openBrowserWriteNet({ transport, decide, onDecided: (entry) => decided.push(entry), ...extra });
  return { net, decided };
}

test('open enables target discovery, then request interception on the browser session', async () => {
  const transport = fakeTransport();
  const { net } = await openNet(transport);
  assert.deepEqual(
    transport.calls.map((call) => [call.method, call.params, call.sessionId]),
    [
      ['Target.setDiscoverTargets', { discover: true }, undefined],
      ['Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, undefined],
    ],
  );
  await net.close();
});

test('owners follow roots, the opener chain and the parent chain of cross-process frames', async () => {
  const transport = fakeTransport((method, params) => {
    if (method === 'Target.getTargetInfo' && params.targetId === 'OOPIF')
      return { targetInfo: { targetId: 'OOPIF', type: 'iframe', parentId: 'NESTED' } };
    return {};
  });
  const { net } = await openNet(transport);
  transport.emit(created('TAB', 'page'));
  net.addRoot('TAB', OWNER);
  transport.emit(created('POPUP', 'page', 'TAB'));
  transport.emit(created('NESTED', 'page', 'POPUP'));
  assert.equal(await net.ownerOf('TAB'), OWNER, 'the root');
  assert.equal(await net.ownerOf('POPUP'), OWNER, 'a popup of the root');
  assert.equal(await net.ownerOf('NESTED'), OWNER, 'a popup of the popup');
  assert.equal(await net.ownerOf('OOPIF'), OWNER, 'a cross-process frame of the nested popup');
  await net.close();
});

test('an in-process frame belongs to the owned page whose frame tree contains it, with one session per page', async () => {
  const transport = fakeTransport((method, params, sessionId) => {
    if (method === 'Target.getTargetInfo') noTarget();
    if (method === 'Target.attachToTarget') return { sessionId: `S-${params.targetId}` };
    if (method === 'Page.getFrameTree' && sessionId === 'S-TAB')
      return {
        frameTree: {
          frame: { id: 'TAB' },
          childFrames: [{ frame: { id: 'A' }, childFrames: [{ frame: { id: 'SUB' } }] }],
        },
      };
    if (method === 'Page.getFrameTree' && sessionId === 'S-FOREIGN')
      return { frameTree: { frame: { id: 'FOREIGN' }, childFrames: [{ frame: { id: 'OTHER-SUB' } }] } };
    return {};
  });
  const { net } = await openNet(transport);
  transport.emit(created('TAB', 'page'));
  transport.emit(created('FOREIGN', 'page'));
  net.addRoot('TAB', OWNER);
  assert.equal(await net.ownerOf('SUB'), OWNER);
  assert.equal(await net.ownerOf('OTHER-SUB'), null, 'a frame in no owned tree belongs to a page the net does not own');
  assert.deepEqual(
    transport.named('Target.attachToTarget').map((call) => call.params.targetId),
    ['TAB', 'FOREIGN'],
  );
  await net.close();
  assert.deepEqual(
    transport.named('Target.detachFromTarget').map((call) => call.params),
    [{ sessionId: 'S-TAB' }, { sessionId: 'S-FOREIGN' }],
  );
});

test('a write from a frame that no page tree contains is failed', async () => {
  const frameTrees = { 'S-TAB': { frame: { id: 'TAB' } }, 'S-FOREIGN': { frame: { id: 'FOREIGN' } } };
  const transport = fakeTransport((method, params, sessionId) => {
    if (method === 'Target.getTargetInfo') noTarget();
    if (method === 'Target.attachToTarget') return { sessionId: `S-${params.targetId}` };
    if (method === 'Page.getFrameTree') return { frameTree: frameTrees[sessionId] };
    return {};
  });
  const { net, decided } = await openNet(transport);
  transport.emit(created('TAB', 'page'));
  transport.emit(created('FOREIGN', 'page'));
  net.addRoot('TAB', OWNER);
  assert.equal(await net.ownerOf('GONE'), UNATTRIBUTED, 'a frame that left every tree is unattributed');
  transport.emit(paused('1', 'GONE', 'POST', '/removed-frame-save'));
  await net.close();
  assert.deepEqual(
    transport.named('Fetch.failRequest').map((call) => call.params.requestId),
    ['1'],
  );
  assert.equal(transport.named('Fetch.continueRequest').length, 0, 'the write is not continued');
  assert.deepEqual(
    decided.map((entry) => [entry.owner, entry.decision.action]),
    [[UNATTRIBUTED, 'block']],
  );
});

test('a frame inside a cross-process frame belongs to the owner of the page that contains that frame', async () => {
  const parents = { OOPIF: 'TAB', 'FOREIGN-OOPIF': 'FOREIGN' };
  const frameTrees = {
    'S-TAB': { frame: { id: 'TAB' } },
    'S-FOREIGN': { frame: { id: 'FOREIGN' } },
    'S-OOPIF': { frame: { id: 'OOPIF' }, childFrames: [{ frame: { id: 'LEAF' } }] },
    'S-FOREIGN-OOPIF': { frame: { id: 'FOREIGN-OOPIF' }, childFrames: [{ frame: { id: 'FOREIGN-LEAF' } }] },
  };
  const transport = fakeTransport((method, params, sessionId) => {
    if (method === 'Target.getTargetInfo') {
      if (!parents[params.targetId]) noTarget();
      return { targetInfo: { targetId: params.targetId, type: 'iframe', parentId: parents[params.targetId] } };
    }
    if (method === 'Target.attachToTarget') return { sessionId: `S-${params.targetId}` };
    if (method === 'Page.getFrameTree') return { frameTree: frameTrees[sessionId] };
    return {};
  });
  const { net, decided } = await openNet(transport);
  transport.emit(created('TAB', 'page'));
  transport.emit(created('FOREIGN', 'page'));
  transport.emit(created('OOPIF', 'iframe'));
  transport.emit(created('FOREIGN-OOPIF', 'iframe'));
  net.addRoot('TAB', OWNER);
  assert.equal(await net.ownerOf('LEAF'), OWNER);
  assert.equal(await net.ownerOf('FOREIGN-LEAF'), null);
  transport.emit(paused('1', 'LEAF', 'POST', '/leaf-save'));
  transport.emit(paused('2', 'FOREIGN-LEAF', 'POST', '/foreign-leaf-save'));
  await net.close();
  assert.deepEqual(
    transport.named('Fetch.failRequest').map((call) => call.params.requestId),
    ['1'],
  );
  assert.deepEqual(
    transport.named('Fetch.continueRequest').map((call) => call.params.requestId),
    ['2'],
  );
  assert.deepEqual(
    decided.map((entry) => [entry.request.method, entry.decision.action, entry.owner]),
    [['POST', 'block', OWNER]],
  );
});

test("a frame is not treated as foreign because a foreign page's lookup failed", async () => {
  const transport = fakeTransport((method, params, sessionId) => {
    if (method === 'Target.getTargetInfo') noTarget();
    if (method === 'Target.attachToTarget' && params.targetId === 'FOREIGN') throw new Error('Target is gone');
    if (method === 'Target.attachToTarget') return { sessionId: `S-${params.targetId}` };
    if (method === 'Page.getFrameTree' && sessionId === 'S-TAB') return { frameTree: { frame: { id: 'TAB' } } };
    return {};
  });
  const { net, decided } = await openNet(transport);
  transport.emit(created('TAB', 'page'));
  transport.emit(created('FOREIGN', 'page'));
  net.addRoot('TAB', OWNER);
  assert.equal(await net.ownerOf('GONE'), UNATTRIBUTED, 'a failed lookup on the foreign page is not a foreign frame');
  transport.emit(paused('1', 'GONE', 'POST', '/gone-save'));
  await net.close();
  assert.deepEqual(
    transport.named('Fetch.failRequest').map((call) => call.params.requestId),
    ['1'],
  );
  assert.equal(transport.named('Fetch.continueRequest').length, 0, 'the write is not continued');
  assert.deepEqual(
    decided.map((entry) => [entry.owner, entry.decision.action]),
    [[UNATTRIBUTED, 'block']],
  );
});

test('a page the net does not own resolves to null without a lookup; an unresolvable frame is UNATTRIBUTED', async () => {
  const transport = fakeTransport((method, params) => {
    if (method === 'Target.getTargetInfo' && params.targetId === 'LOOP-A')
      return { targetInfo: { targetId: 'LOOP-A', type: 'iframe', parentId: 'LOOP-B' } };
    if (method === 'Target.getTargetInfo' && params.targetId === 'LOOP-B')
      return { targetInfo: { targetId: 'LOOP-B', type: 'iframe', parentId: 'LOOP-A' } };
    return {};
  });
  const { net } = await openNet(transport);
  transport.emit(created('FOREIGN', 'page'));
  assert.equal(await net.ownerOf('FOREIGN'), null);
  assert.equal(transport.named('Target.getTargetInfo').length, 0);
  assert.equal(await net.ownerOf(undefined), UNATTRIBUTED, 'a request without a frame');
  assert.equal(await net.ownerOf('LOOP-A'), UNATTRIBUTED, 'a parent chain that never ends');
  await net.close();
});

test('owned writes are failed or fulfilled and reported; foreign writes and reads are continued and not reported', async () => {
  const transport = fakeTransport();
  const { net, decided } = await openNet(transport);
  transport.emit(created('TAB', 'page'));
  transport.emit(created('FOREIGN', 'page'));
  net.addRoot('TAB', OWNER);
  transport.emit(paused('1', 'TAB', 'POST'));
  transport.emit(paused('2', 'FOREIGN', 'POST'));
  transport.emit(paused('3', 'TAB', 'GET'));
  transport.emit(paused('4', 'TAB', 'PUT'));
  await net.close();
  assert.deepEqual(
    transport.named('Fetch.failRequest').map((call) => call.params),
    [{ requestId: '1', errorReason: 'BlockedByClient' }],
  );
  assert.deepEqual(
    transport
      .named('Fetch.continueRequest')
      .map((call) => call.params.requestId)
      .sort(),
    ['2', '3'],
  );
  assert.deepEqual(
    transport.named('Fetch.fulfillRequest').map((call) => [call.params.requestId, call.params.responseCode]),
    [['4', 204]],
  );
  assert.deepEqual(
    decided.map((entry) => [entry.request.method, entry.decision.action, entry.owner]),
    [
      ['POST', 'block', OWNER],
      ['PUT', 'fulfil', OWNER],
    ],
  );
});

test('a write is failed and reported UNATTRIBUTED when a lookup call throws, and when decide throws', async () => {
  const transport = fakeTransport((method) => {
    if (method === 'Target.getTargetInfo') noTarget();
    if (method === 'Target.attachToTarget') throw new Error('transport failure');
    return {};
  });
  const decided = [];
  const net = await openBrowserWriteNet({
    transport,
    decide: ({ url }) => {
      if (url.endsWith('/throws')) throw new Error('decide failure');
      return decide({ method: 'POST' });
    },
    onDecided: (entry) => decided.push(entry),
  });
  transport.emit(created('TAB', 'page'));
  net.addRoot('TAB', OWNER);
  transport.emit(paused('1', 'SUB', 'POST'));
  transport.emit(paused('2', 'TAB', 'POST', '/throws'));
  await net.close();
  assert.deepEqual(
    transport
      .named('Fetch.failRequest')
      .map((call) => call.params.requestId)
      .sort(),
    ['1', '2'],
  );
  assert.equal(transport.named('Fetch.continueRequest').length, 0);
  assert.deepEqual(
    decided
      .map((entry) => [entry.request.url.split('/').pop(), entry.owner === UNATTRIBUTED, entry.decision.action])
      .sort(),
    [
      ['save', true, 'block'],
      ['throws', false, 'block'],
    ],
  );
});

test('only pages created after the net opened, without an opener, are adopted', async () => {
  const transport = fakeTransport((method, _params, _sessionId, self) => {
    if (method === 'Target.setDiscoverTargets') self.emit(created('EXISTING', 'page'));
    return {};
  });
  const { net } = await openNet(transport, { adoptNewPages: OWNER });
  transport.emit(created('NEW', 'page'));
  transport.emit(created('POPUP-OF-EXISTING', 'page', 'EXISTING'));
  assert.equal(await net.ownerOf('EXISTING'), null);
  assert.equal(await net.ownerOf('NEW'), OWNER);
  assert.equal(await net.ownerOf('POPUP-OF-EXISTING'), null);
  await net.close();
});

test('the net reports every page it adopts', async () => {
  const adopted = [];
  const transport = fakeTransport();
  const { net } = await openNet(transport, {
    adoptNewPages: OWNER,
    onAdopted: (targetId) => adopted.push(targetId),
  });
  transport.emit(created('NEW', 'page'));
  assert.deepEqual(adopted, ['NEW']);
  transport.emit(created('WORKER', 'worker'));
  transport.emit(created('POPUP-OF-NEW', 'page', 'NEW'));
  assert.deepEqual(adopted, ['NEW'], 'a worker and a popup with an opener are not adopted as roots');
  await net.close();
});

test('close answers a write still being resolved before disabling, and is idempotent', async () => {
  const lookup = Promise.withResolvers();
  const transport = fakeTransport((method, params) => {
    if (method === 'Target.getTargetInfo' && params.targetId === 'SLOW') return lookup.promise;
    return {};
  });
  const { net } = await openNet(transport);
  transport.emit(created('TAB', 'page'));
  net.addRoot('TAB', OWNER);
  transport.emit(paused('1', 'SLOW', 'POST'));
  const first = net.close();
  assert.equal(net.close(), first, 'the same close');
  // Events delivered while closing are answered without a lookup: owned and unknown writes fail, foreign ones continue.
  transport.emit(created('FOREIGN', 'page'));
  transport.emit(paused('2', 'TAB', 'POST'));
  transport.emit(paused('3', 'FOREIGN', 'POST'));
  transport.emit(paused('4', 'UNKNOWN-FRAME', 'POST'));
  lookup.resolve({ targetInfo: { targetId: 'SLOW', type: 'iframe', parentId: 'TAB' } });
  await first;
  const order = transport.calls.map(
    (call) => `${call.method}${call.params.requestId ? ':' + call.params.requestId : ''}`,
  );
  const disabled = order.indexOf('Fetch.disable');
  const cleared = transport.calls.findIndex(
    (call) => call.method === 'Fetch.enable' && call.params.patterns.length === 0,
  );
  assert.ok(
    cleared !== -1 && cleared < disabled,
    'new pauses stop before the paused requests are drained and the net is disabled',
  );
  for (const answered of [
    'Fetch.failRequest:1',
    'Fetch.failRequest:2',
    'Fetch.continueRequest:3',
    'Fetch.failRequest:4',
  ])
    assert.ok(order.indexOf(answered) !== -1 && order.indexOf(answered) < disabled, `${answered} before Fetch.disable`);
  assert.equal(order.at(-1), 'Target.setDiscoverTargets');
  assert.equal(transport.listening, false, 'the listener is removed');
  const sent = transport.calls.length;
  transport.emit(paused('5', 'TAB', 'POST'));
  await net.close();
  assert.equal(transport.calls.length, sent, 'nothing is sent after close');
});

test('a decision that is not an object blocks the request', async () => {
  const transport = fakeTransport();
  const { net, decided } = await openNet(transport, { decide: () => undefined });
  transport.emit(created('TAB', 'page'));
  net.addRoot('TAB', OWNER);
  transport.emit(paused('1', 'TAB', 'POST'));
  await net.close();
  const methods = transport.calls.map((call) => call.method);
  assert.deepEqual(
    transport.named('Fetch.failRequest').map((call) => call.params.requestId),
    ['1'],
  );
  assert.deepEqual(
    decided.map((entry) => [entry.owner, entry.decision.action]),
    [[OWNER, 'block']],
  );
  assert.ok(
    methods.indexOf('Fetch.failRequest') < methods.indexOf('Fetch.disable'),
    'the request is failed before interception is disabled',
  );
});

test('a fulfil the browser refuses is answered by failing the request', async () => {
  const transport = fakeTransport((method) => {
    if (method === 'Fetch.fulfillRequest') throw new Error('Invalid response status');
    return {};
  });
  const { net } = await openNet(transport);
  transport.emit(created('TAB', 'page'));
  net.addRoot('TAB', OWNER);
  transport.emit(paused('4', 'TAB', 'PUT'));
  await net.close();
  assert.deepEqual(
    transport.named('Fetch.fulfillRequest').map((call) => call.params.requestId),
    ['4'],
  );
  assert.deepEqual(
    transport.named('Fetch.failRequest').map((call) => call.params),
    [{ requestId: '4', errorReason: 'BlockedByClient' }],
  );
  const methods = transport.calls.map((call) => call.method);
  assert.ok(
    methods.indexOf('Fetch.failRequest') < methods.indexOf('Fetch.disable'),
    'the request is failed before interception is disabled',
  );
});

test('a failed open removes its listener and turns discovery off again', async () => {
  const transport = fakeTransport((method) => {
    if (method === 'Fetch.enable') throw new Error('Fetch unavailable');
    return {};
  });
  await assert.rejects(openNet(transport), { message: 'Fetch unavailable' });
  assert.equal(transport.listening, false);
  assert.deepEqual(transport.calls.at(-1), {
    method: 'Target.setDiscoverTargets',
    params: { discover: false },
    sessionId: undefined,
  });
});

/** A WebSocket double: it opens on a microtask, answers each call with an empty result, discards sends once closed. */
class AnsweringSocket extends EventTarget {
  static CLOSED = 3;
  static sockets = [];
  readyState = 1;
  constructor(url) {
    super();
    this.url = url;
    AnsweringSocket.sockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(data) {
    if (this.readyState === AnsweringSocket.CLOSED) return;
    const { id } = JSON.parse(data);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result: {} }) })));
  }
  drop() {
    this.readyState = AnsweringSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  close() {
    this.drop();
  }
}
const versionEndpoint = async () => ({
  json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' }),
});

// @test-kind contract: a closed debugging socket rejects later sends, so a net on it can close instead of waiting
test('a closed debugging socket rejects later sends, and the net closes without waiting for them', async () => {
  AnsweringSocket.sockets.length = 0;
  const transport = await connectCdpTransport('http://127.0.0.1:9222', {
    WebSocketImpl: AnsweringSocket,
    fetchImpl: versionEndpoint,
  });
  const { net } = await openNet(transport);
  AnsweringSocket.sockets[0].drop();
  await assert.rejects(transport.send('X'), { message: 'The browser debugging socket closed.' });
  await net.close();
  await transport.close();
});

// @test-kind contract: a debugging socket that never opens is closed when the open guard expires
test('a debugging socket that never opens is closed when the open guard expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const constructed = Promise.withResolvers();
  class SilentSocket extends EventTarget {
    static CLOSED = 3;
    readyState = 0;
    constructor() {
      super();
      constructed.resolve(this);
    }
    send() {}
    close() {
      this.readyState = SilentSocket.CLOSED;
      this.dispatchEvent(new Event('close'));
    }
  }
  const opening = connectCdpTransport('ws://127.0.0.1:9222/devtools/browser/x', { WebSocketImpl: SilentSocket });
  const socket = await constructed.promise;
  t.mock.timers.tick(30_000);
  await assert.rejects(opening, { message: 'The browser debugging socket did not open.' });
  assert.equal(socket.readyState, SilentSocket.CLOSED, 'the socket that never opened is closed');
});

test('a write a page sends after its target closed belongs to its owner, and a foreign page write is continued', async () => {
  // The browser destroys a closing page's target before it pauses the beacon that page sends from pagehide.
  const transport = fakeTransport((method) => {
    if (method === 'Target.getTargetInfo') noTarget();
    return {};
  });
  const { net, decided } = await openNet(transport);
  transport.emit(created('TAB', 'page'));
  transport.emit(created('FOREIGN', 'page'));
  net.addRoot('TAB', OWNER);
  transport.emit({ method: 'Target.targetDestroyed', params: { targetId: 'TAB' } });
  transport.emit({ method: 'Target.targetDestroyed', params: { targetId: 'FOREIGN' } });
  transport.emit(paused('1', 'TAB', 'POST', '/owned-unload-beacon'));
  transport.emit(paused('2', 'FOREIGN', 'POST', '/foreign-unload-beacon'));
  await net.close();
  assert.deepEqual(
    transport.named('Fetch.failRequest').map((call) => call.params.requestId),
    ['1'],
  );
  assert.deepEqual(
    transport.named('Fetch.continueRequest').map((call) => call.params.requestId),
    ['2'],
    "the foreign page's own write is continued",
  );
  assert.deepEqual(
    decided.map((entry) => [entry.request.url.split('/').pop(), entry.decision.action, entry.owner]),
    [['owned-unload-beacon', 'block', OWNER]],
  );
  assert.equal(transport.named('Target.attachToTarget').length, 0, 'a closed page is not searched for frames');
});
