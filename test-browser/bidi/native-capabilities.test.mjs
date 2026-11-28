// @test-kind compatibility: measure native WebDriver BiDi commands against an original loopback document and multipart response.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOwnedServer } from '../helpers/owned-server.mjs';
import { startFirefox, startSafari } from './native-browser.mjs';

const ORIGINAL = '<title>Original multipart response</title><script>window.responseExecuted = "original"</script>';
const REPLACEMENT = '<title>Rewritten multipart response</title><script>window.responseExecuted = "rewritten"</script>';
const COOKIES = ['probe_one=one; Path=/; SameSite=Lax', 'probe_two=two; Path=/; SameSite=Lax'];
const SOURCE_SCRIPT = 'globalThis.lenseSourceProbe = true;';
const PAGE = `<!doctype html><title>BiDi fixture</title>
<script>window.sawPreload = globalThis.lenseProbePreloaded === true</script>
<script src="/attribution.js"></script>
<div id="sealed"></div>
<form method="post" enctype="multipart/form-data" action="/upload">
  <input name="fixture" value="invented-upload-marker">
</form>
<script>document.getElementById('sealed').attachShadow({ mode: 'closed' }).innerHTML = '<span>invented-closed-root</span>'</script>`;

async function fixture(t) {
  const received = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/page') return response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (request.url === '/attribution.js')
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end(SOURCE_SCRIPT);
    if (request.url === '/local-asset') {
      received.push({ method: request.method, url: request.url });
      return response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Upstream asset</title>');
    }
    if (request.url !== '/upload') return response.writeHead(404).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      method: request.method,
      url: request.url,
      type: request.headers['content-type'],
      bytes: Buffer.concat(chunks).toString(),
    });
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': COOKIES }).end(ORIGINAL);
  });
  const origin = await listenOwnedServer(t, server);
  return { origin, received };
}

async function attempt(command) {
  try {
    return { status: 'accepted', result: await command() };
  } catch (error) {
    if (!error.code) throw error;
    return { status: error.code, message: error.message };
  }
}

function record(bidi, method, relevant) {
  const { promise, resolve, reject } = Promise.withResolvers();
  promise.catch(() => {});
  const stop = bidi.on(method, (event) => {
    if (relevant(event)) resolve(event);
  });
  return {
    async wait(timeout = 10_000) {
      const error = Object.assign(new Error(`No matching ${method} event in ${timeout} ms.`), {
        code: 'event timeout',
      });
      const timer = setTimeout(() => reject(error), timeout);
      try {
        return await promise;
      } finally {
        clearTimeout(timer);
      }
    },
    stop,
  };
}

async function evaluate(bidi, context, expression, options = {}) {
  const answer = await bidi.send('script.evaluate', {
    target: { context },
    expression,
    awaitPromise: true,
    ...options,
  });
  assert.equal(answer.type, 'success', answer.exceptionDetails?.text);
  return answer.result;
}

const navigate = (bidi, context, url) => bidi.send('browsingContext.navigate', { context, url, wait: 'complete' });
const headers = ([name, value]) => ({ name, value: { type: 'string', value } });
const html = { name: 'content-type', value: { type: 'string', value: 'text/html' } };
const body = (value) => ({ type: 'string', value });

function addIntercept(bidi, context, phase, url) {
  return bidi.send('network.addIntercept', {
    contexts: [context],
    phases: [phase],
    urlPatterns: [{ type: 'string', pattern: url }],
  });
}

async function probeFirefoxSource(bidi, context, scriptUrl) {
  const toggle = (enabled) => bidi.send('moz:debugging.setDebuggerEnabled', { contexts: [context], enabled });
  const debuggerStatus = await attempt(() => toggle(true));
  if (!debuggerStatus.result) return debuggerStatus;
  try {
    const scripts = await attempt(() => bidi.send('moz:debugging.listScripts', { context }));
    const source = await attempt(() => bidi.send('moz:debugging.getScriptSource', { context, scriptUrl }));
    return {
      listed: scripts.result?.scripts.includes(scriptUrl) ?? false,
      exactSource: source.result?.source === SOURCE_SCRIPT,
      listStatus: scripts.status,
      sourceStatus: source.status,
    };
  } finally {
    await toggle(null);
  }
}

async function reportScript(t, bidi, context, pageUrl) {
  const channel = 'lense-probe';
  const messages = await attempt(() => bidi.send('session.subscribe', { events: ['script.message'] }));
  const observed = record(
    bidi,
    'script.message',
    (event) => event.channel === channel && event.source?.context === context,
  );
  const preload = await attempt(() =>
    bidi.send('script.addPreloadScript', {
      contexts: [context],
      functionDeclaration: '(send) => { globalThis.lenseProbePreloaded = true; send("preloaded"); }',
      arguments: [{ type: 'channel', value: { channel } }],
    }),
  );
  try {
    await navigate(bidi, context, pageUrl);
    assert.equal((await evaluate(bidi, context, 'document.title')).value, 'BiDi fixture');
    const mainWorld = (await evaluate(bidi, context, 'window.sawPreload')).value === true;
    const closedRoot = await attempt(() =>
      evaluate(bidi, context, 'document.getElementById("sealed")', {
        serializationOptions: { maxDomDepth: 3, includeShadowTree: 'all' },
      }),
    );
    const delivery =
      preload.result && messages.result ? await attempt(() => observed.wait(1_500)) : { status: 'not registered' };
    t.diagnostic(
      JSON.stringify({
        preload: preload.status,
        ranBeforePageScript: mainWorld,
        channelSubscription: messages.status,
        channelDelivery: delivery.result?.data.value === 'preloaded' ? 'verified' : delivery.status,
        closedRootSerialization: closedRoot.status,
        closedRootSerialized: JSON.stringify(closedRoot.result ?? null).includes('invented-closed-root'),
      }),
    );
  } finally {
    observed.stop();
    if (preload.result?.script) await bidi.send('script.removePreloadScript', { script: preload.result.script });
  }
}

async function probeLocalAsset(bidi, context, fixture) {
  const url = fixture.origin + '/local-asset';
  const setup = await attempt(() => addIntercept(bidi, context, 'beforeRequestSent', url));
  if (!setup.result) return setup;
  const request = record(bidi, 'network.beforeRequestSent', (event) => event.isBlocked && event.request.url === url);
  const navigation = navigate(bidi, context, url);
  navigation.catch(() => {});
  try {
    const event = await request.wait();
    const requestId = event.request.request;
    const substitution = await attempt(() =>
      bidi.send('network.provideResponse', {
        request: requestId,
        statusCode: 200,
        headers: [html],
        body: body('<title>Local asset without an upstream request</title>'),
      }),
    );
    if (!substitution.result) await bidi.send('network.continueRequest', { request: requestId });
    await navigation;
    const title = substitution.result ? 'Local asset without an upstream request' : 'Upstream asset';
    assert.equal((await evaluate(bidi, context, 'document.title')).value, title);
    assert.equal(fixture.received.filter(({ url }) => url === '/local-asset').length, substitution.result ? 0 : 1);
    return substitution.result ? { status: 'verified' } : substitution;
  } finally {
    request.stop();
    await bidi.send('network.removeIntercept', { intercept: setup.result.intercept });
  }
}

async function finishResponse(bidi, request, collector) {
  const data = { request, dataType: 'response', ...(collector && { collector }) };
  // Waiting for an answer at this phase is the capability being measured. The guard releases the held response
  // even on implementations that produce the collected bytes only after the original response resumes.
  const pausedBody = collector
    ? await attempt(() => bidi.send('network.getData', data, { timeout: 1_500 }))
    : { status: 'no collector' };
  const replacement = await attempt(() =>
    bidi.send('network.provideResponse', {
      request,
      statusCode: 200,
      headers: [html, ...COOKIES.map((value) => headers(['set-cookie', value]))],
      body: body(REPLACEMENT),
    }),
  );
  if (!replacement.result) await bidi.send('network.continueResponse', { request });
  return { pausedBody, replacement, data };
}

function observedBody(probe) {
  if (!probe.result) return probe;
  const { bytes } = probe.result;
  const text = bytes.type === 'base64' ? Buffer.from(bytes.value, 'base64').toString('utf8') : bytes.value;
  return { status: probe.status, originalBody: text === ORIGINAL };
}

function assertOriginalPost(fixture) {
  const requests = fixture.received.filter(({ url }) => url === '/upload');
  assert.equal(requests.length, 1, 'the document submission reaches the server once');
  assert.equal(requests[0].method, 'POST');
  assert.match(requests[0].type, /^multipart\/form-data; boundary=/);
  assert.match(requests[0].bytes, /invented-upload-marker/);
}

async function probeResponse(bidi, context, fixture) {
  const url = fixture.origin + '/upload';
  const intercept = await attempt(() => addIntercept(bidi, context, 'responseStarted', url));
  if (!intercept.result) return { intercept };
  const collect = await attempt(() =>
    bidi.send('network.addDataCollector', {
      contexts: [context],
      dataTypes: ['response'],
      maxEncodedDataSize: 65_536,
    }),
  );
  const collector = collect.result?.collector;
  const held = record(bidi, 'network.responseStarted', (event) => event.isBlocked && event.request.url === url);
  const complete = record(bidi, 'network.responseCompleted', (event) => event.request.url === url);
  const loaded = record(bidi, 'browsingContext.load', (event) => event.context === context && event.url === url);
  try {
    await navigate(bidi, context, fixture.origin + '/page');
    await evaluate(bidi, context, 'document.forms[0].requestSubmit()');
    const event = await held.wait();
    const { pausedBody, replacement, data } = await finishResponse(bidi, event.request.request, collector);
    await Promise.all([complete.wait(), loaded.wait()]);
    assertOriginalPost(fixture);
    const rewritten = replacement.status === 'accepted';
    assert.equal(
      (await evaluate(bidi, context, 'window.responseExecuted')).value,
      rewritten ? 'rewritten' : 'original',
    );
    const cookies = (await evaluate(bidi, context, 'document.cookie')).value;
    assert.match(cookies, /probe_one=one/);
    assert.match(cookies, /probe_two=two/);
    const completedBody = collector
      ? await attempt(() => bidi.send('network.getData', data))
      : { status: 'no collector' };
    const paused = observedBody(pausedBody);
    const completed = observedBody(completedBody);
    if (!rewritten && completedBody.result) assert.equal(completed.originalBody, true);
    return {
      intercept: 'verified',
      collector: collect.status,
      pausedBody: paused,
      replacement: replacement.result ? { status: 'verified' } : replacement,
      completedBody: completed,
      sameResponseRewrite: paused.originalBody === true && rewritten,
      nativeMultipartPost: 'one upstream request',
      duplicateCookies: 'preserved',
    };
  } finally {
    held.stop();
    complete.stop();
    loaded.stop();
    await bidi.send('network.removeIntercept', { intercept: intercept.result.intercept });
    if (collector) await bidi.send('network.removeDataCollector', { collector });
  }
}

for (const [browser, start] of [
  ['Firefox', startFirefox],
  ['Safari', startSafari],
]) {
  test(`${browser} native BiDi reports Lense transport capabilities`, { timeout: 120_000 }, async (t) => {
    const { bidi, capabilities } = await start(t);
    const page = await fixture(t);
    const { contexts } = await bidi.send('browsingContext.getTree', { maxDepth: 0 });
    assert.equal(contexts.length, 1, 'the probe owns a single native tab');
    const { context } = contexts[0];
    t.diagnostic(`${capabilities.browserName} ${capabilities.browserVersion}`);
    await reportScript(t, bidi, context, page.origin + '/page');
    if (browser === 'Firefox')
      t.diagnostic(
        JSON.stringify({ sourceDebugger: await probeFirefoxSource(bidi, context, page.origin + '/attribution.js') }),
      );
    const events = await attempt(() =>
      bidi.send('session.subscribe', {
        events: [
          'network.beforeRequestSent',
          'network.responseStarted',
          'network.responseCompleted',
          'browsingContext.load',
        ],
      }),
    );
    t.diagnostic(
      JSON.stringify({
        networkEvents: events.status,
        localAsset: await probeLocalAsset(bidi, context, page),
        nativeResponse: await probeResponse(bidi, context, page),
      }),
    );
  });
}
