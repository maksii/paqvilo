// @test-kind security: a live capture holds the browser-level write net from before its bridge call until its evidence is received
import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from '../baseline-suite.mjs';
import { fakeTransport } from './support/fake-cdp-transport.mjs';

const { liveSide, openCaptureWriteNet } = __testing;
const origin = 'https://portal.invalid';
const cdpUrl = 'http://127.0.0.1:9222';
const NO_CDP_LINE = 'live.cdpUrl is not set: writes are guarded per page by the capture runner only';

const evidenceFor = (blockedWrites = []) => ({
  summary: { id: 'sign-in', status: 'captured', problems: [], steps: 1 },
  raw: { requests: [], console: [], pageErrors: [], blockedWrites, identityTraffic: [], dialogs: [] },
});

// A side with fake bridge, evidence receiver and write net. `events` records the order of the net and the bridge call;
// `callTool` runs as the bridge call and `received` is the evidence the run waits for.
function liveSideWith({ live = {}, events, received, callTool, net }) {
  return liveSide({
    matrix: { origin, live: { command: 'invented-bridge', signIn: { steps: [{ goto: '/' }] }, ...live } },
    allowWrites: false,
    cwd: '.',
    outputRoot: '.',
    startBridge: () => ({
      initialize: async () => {},
      listTools: async () => [{ name: 'browser_run_code_unsafe' }],
      callTool: async () => {
        events.push('bridge-call');
        return callTool();
      },
      close: async () => {},
    }),
    startEvidenceSaver: async () => ({
      url: 'http://127.0.0.1:9/capture',
      token: 'invented-token',
      late: [],
      expect: () => ({ run: 'invented-run', received }),
      close: async () => {},
    }),
    openWriteNet: async (url) => {
      events.push(`net-open ${url}`);
      return net;
    },
  });
}

const newNet = (events) => ({
  blocked: [],
  adopted: () => 1,
  close: async () => {
    events.push('net-close');
  },
});

test('the net opens before the bridge call and closes only after the evidence is received', async () => {
  const events = [];
  const evidence = Promise.withResolvers();
  const called = Promise.withResolvers();
  const sidePromise = liveSideWith({
    live: { cdpUrl },
    events,
    received: evidence.promise,
    net: newNet(events),
    callTool: () => {
      called.resolve();
      return 'posted';
    },
  });
  await called.promise;
  assert.deepEqual(events, [`net-open ${cdpUrl}`, 'bridge-call']);
  evidence.resolve(evidenceFor());
  const side = await sidePromise;
  assert.deepEqual(events, [`net-open ${cdpUrl}`, 'bridge-call', 'net-close']);
  assert.equal(side.diagnostics().includes(NO_CDP_LINE), false);
  await side.close();
});

test('the net is closed when the bridge call throws, and the error reaches the caller', async () => {
  const events = [];
  const pending = Promise.withResolvers();
  await assert.rejects(
    liveSideWith({
      live: { cdpUrl },
      events,
      received: pending.promise,
      net: newNet(events),
      callTool: () => {
        throw new Error('invented bridge failure');
      },
    }),
    /invented bridge failure/,
  );
  assert.deepEqual(events, [`net-open ${cdpUrl}`, 'bridge-call', 'net-close']);
});

test('writes the net stopped during the bridge call are listed after the runner blocked writes', async () => {
  const events = [];
  const net = newNet(events);
  const evidence = evidenceFor([{ method: 'POST', path: '/runner-block' }]);
  const side = await liveSideWith({
    live: { cdpUrl },
    events,
    received: Promise.resolve(evidence),
    net,
    callTool: () => {
      net.blocked.push({ method: 'POST', path: '/_api/accounts' });
      return 'posted';
    },
  });
  assert.deepEqual(evidence.raw.blockedWrites, [
    { method: 'POST', path: '/runner-block' },
    { method: 'POST', path: '/_api/accounts' },
  ]);
  await side.close();
});

test('a capture whose page did not open in the browser of live.cdpUrl is refused', async () => {
  const events = [];
  const net = { ...newNet(events), adopted: () => 0 };
  await assert.rejects(
    liveSideWith({
      live: { cdpUrl },
      events,
      received: Promise.resolve(evidenceFor()),
      net,
      callTool: () => 'posted',
    }),
    /live\.cdpUrl is not the bridge browser/,
  );
  assert.deepEqual(events, [`net-open ${cdpUrl}`, 'bridge-call', 'net-close']);
});

test('the capture net adopts a new page and refuses its portal write', async () => {
  const transport = fakeTransport();
  const capture = await openCaptureWriteNet(cdpUrl, { origin }, { connect: async () => transport });
  transport.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'PAGE', type: 'page' } } });
  transport.emit({
    method: 'Fetch.requestPaused',
    params: {
      requestId: 'REQUEST',
      frameId: 'PAGE',
      resourceType: 'Fetch',
      request: { method: 'POST', url: `${origin}/_api/accounts` },
    },
  });
  await capture.close();
  assert.equal(capture.adopted(), 1);
  assert.deepEqual(
    transport.named('Fetch.failRequest').map((call) => call.params.requestId),
    ['REQUEST'],
  );
  assert.equal(transport.named('Fetch.continueRequest').length, 0, 'the write is not continued');
  assert.deepEqual(capture.blocked, [{ method: 'POST', path: '/_api/accounts' }]);
});

test('without live.cdpUrl the net is never opened and the diagnostics name the per-page guard once', async () => {
  const events = [];
  const side = await liveSideWith({
    events,
    received: Promise.resolve(evidenceFor()),
    net: newNet(events),
    callTool: () => 'posted',
  });
  assert.deepEqual(events, ['bridge-call']);
  assert.equal(side.diagnostics().filter((line) => line === NO_CDP_LINE).length, 1);
  await side.close();
});
