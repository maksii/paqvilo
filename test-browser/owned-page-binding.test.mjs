import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createOwnedPageBindings } from '../lense/owned-page-binding.mjs';
import { comparison } from '../lense/panel.mjs';
import { freeDebugPort } from './helpers/debug-port.mjs';
import { drainFixture, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

const server = http.createServer((request, response) =>
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><h1>Invented</h1>'),
);
let browser, origin;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() =>
  drainFixture([
    () => browser?.close(),
    () => {
      // Keep-alive sockets from the separate CDP-attached profile would otherwise hold close() open.
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  ]),
);

// lense/owned-page-binding.mjs: concurrent callbacks per bridge and the reply delivery deadline.
const OWNED_CALL_CAPACITY = 32;
const REPLY_DEADLINE_MS = 1500;

// A fresh context per test on the shared browser. t.after hooks run in registration order,
// so bridges registered through own() close (newest first) before this context does.
async function fixture(t) {
  const context = await browser.newContext();
  const owned = [];
  t.after(() => drainFixture([...owned.toReversed(), () => context.close()]));
  const page = await context.newPage();
  await page.goto(origin);
  return { context, page, origin, own: (close) => owned.push(close) };
}

// The rejection message of one owned call, or null when it resolves.
const rejectionOf = (page, value) =>
  page.evaluate(
    (value) =>
      window.inventedEcho(value).then(
        () => null,
        (error) => error.message,
      ),
    value,
  );

// Only the external-owner test needs a persistent profile with a debugging port.
async function persistentFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'owned-binding-test-'))),
    owner = ownedFixture(t);
  owner.remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const port = await freeDebugPort();
  const context = await chromium.launchPersistentContext(
    root,
    browserLaunchOptions({
      headless: true,
      args: ['--remote-debugging-port=' + port],
    }),
  );
  owner.add(() => context.close());
  const page = context.pages()[0];
  await page.goto(origin);
  return { context, page, origin, port };
}

test('binding fixture drains every bridge and its context after one bridge close fails', async (t) => {
  const hooks = [];
  let f;
  ownedFixture(t).add(() => f?.context.close());
  f = await fixture({ after: (hook) => hooks.push(hook) });
  const failure = Error('Invented bridge close failure'),
    closed = [];
  f.own(() => closed.push('remaining bridge'));
  f.own(() => {
    throw failure;
  });
  await assert.rejects(hooks[0](), (error) => error === failure);
  assert.deepEqual(closed, ['remaining bridge']);
  assert.equal(f.page.isClosed(), true, 'one rejected bridge close must not retain its context');
});

test('persistent binding fixture releases its browser and profile after initial navigation fails', async (t) => {
  const hooks = [],
    failure = Error('Invented first navigation failure'),
    launch = chromium.launchPersistentContext.bind(chromium);
  let context, profile;
  const owner = ownedFixture(t);
  owner.add(() => context?.close());
  owner.remove(() => profile && fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  t.mock.method(chromium, 'launchPersistentContext', async (directory, ...args) => {
    profile = directory;
    context = await launch(directory, ...args);
    t.mock.method(context.pages()[0], 'goto', async () => {
      throw failure;
    });
    return context;
  });
  await assert.rejects(persistentFixture({ after: (hook) => hooks.push(hook) }), (error) => error === failure);
  assert.equal(hooks.length, 1, 'owned cleanup must exist before the first page navigation');
  await hooks[0]();
  assert.equal(context.pages().length, 0);
  await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
});

test('owned raw binding survives independent persistent-browser CDP owners and observers', async (t) => {
  const f = await persistentFixture(t);
  const helper = new URL('../lense/owned-page-binding.mjs', import.meta.url).href;
  const child = `import{chromium}from'playwright-core';import{createOwnedPageBindings}from'${helper}';const b=await chromium.connectOverCDP('http://127.0.0.1:${f.port}');let observer;try{const p=await b.contexts()[0].newPage();await p.goto('${f.origin}/attached');const bridge=await createOwnedPageBindings(p,{origin:'${f.origin}',bindings:{inventedEcho:(_source,v)=>({echo:v})}});const before=await p.evaluate(()=>inventedEcho('before'));observer=await chromium.connectOverCDP('http://127.0.0.1:${f.port}');const during=await p.evaluate(()=>inventedEcho('during'));await observer.close();observer=null;const after=await p.evaluate(()=>inventedEcho('after'));await p.reload();const navigation=await p.evaluate(()=>inventedEcho('navigation'));await bridge.close();const closed=await p.evaluate(()=>typeof inventedEcho);await p.reload();const retired=await p.evaluate(()=>typeof inventedEcho);console.log(JSON.stringify({before,during,after,navigation,closed,retired}));await p.close()}finally{await observer?.close();await b.close()}`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', child], {
    windowsHide: true,
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    before: { echo: 'before' },
    during: { echo: 'during' },
    after: { echo: 'after' },
    navigation: { echo: 'navigation' },
    closed: 'undefined',
    retired: 'undefined',
  });
});

test('owned binding rejects child contexts, foreign origins, oversized calls and oversized replies', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const bridge = await createOwnedPageBindings(f.page, {
    origin: f.origin,
    maxBytes: 200,
    maxResultBytes: 200,
    bindings: {
      inventedEcho(source, value) {
        calls++;
        assert.equal(source.page, f.page);
        assert.equal(source.frame, f.page.mainFrame());
        return value === 'large-result' ? 'x'.repeat(201) : value;
      },
    },
  });
  f.own(() => bridge.close());
  assert.equal(await f.page.evaluate(() => window.inventedEcho('valid')), 'valid');
  assert.equal(await rejectionOf(f.page, 'x'.repeat(300)), 'The owned page request is too large.');
  assert.equal(await rejectionOf(f.page, 'large-result'), 'The owned page request failed.');
  await f.page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = '/child';
    document.body.append(frame);
  });
  const child = await f.page.waitForEvent('framenavigated', {
    predicate: (frame) => frame !== f.page.mainFrame(),
  });
  assert.equal(await child.evaluate(() => typeof inventedEcho), 'undefined');
  await child.evaluate(() => {
    const raw = Object.getOwnPropertyNames(window).find((name) => name.startsWith('__paqviloOwned_'));
    window[raw](JSON.stringify({ id: 1, name: 'inventedEcho', args: ['child'] }));
  });
  await f.page.goto(f.origin.replace('127.0.0.1', 'localhost'));
  assert.equal(await f.page.evaluate(() => typeof inventedEcho), 'undefined');
  await f.page.evaluate(() => {
    const raw = Object.getOwnPropertyNames(window).find((name) => name.startsWith('__paqviloOwned_'));
    window[raw](JSON.stringify({ id: 1, name: 'inventedEcho', args: ['foreign'] }));
  });
  // Binding calls arrive in order on one DevTools session and refused calls return before
  // any callback, so a later accepted call is a barrier for the two refused ones above.
  await f.page.goto(f.origin);
  assert.equal(await f.page.evaluate(() => window.inventedEcho('barrier')), 'barrier');
  assert.equal(calls, 3);
});

test('late callback replies remain confined to the original document context', async (t) => {
  const f = await fixture(t);
  let release, began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const bridge = await createOwnedPageBindings(f.page, {
    origin: f.origin,
    bindings: {
      inventedEcho(_source, value) {
        if (value === 'old') {
          began();
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return value;
      },
    },
  });
  f.own(() => bridge.close());
  const old = f.page.evaluate(() => window.inventedEcho('old')).catch(() => 'document-retired');
  await started;
  await f.page.reload();
  assert.equal(await f.page.evaluate(() => window.inventedEcho('fresh')), 'fresh');
  release('old-reply');
  assert.equal(await old, 'document-retired');
  assert.equal(await f.page.evaluate(() => window.inventedEcho('still-fresh')), 'still-fresh');
});

test('bounded callback lifetime and real debugger pause preserve a fresh bridge call', async (t) => {
  const f = await fixture(t);
  const bridge = await createOwnedPageBindings(f.page, {
    origin: f.origin,
    callTimeout: 50,
    bindings: {
      inventedEcho(_source, value) {
        return value === 'never' ? new Promise(() => {}) : value;
      },
    },
  });
  f.own(() => bridge.close());
  assert.equal(await rejectionOf(f.page, 'never'), 'The owned page request failed.');
  const debuggerSession = await f.context.newCDPSession(f.page);
  let pauses = 0;
  debuggerSession.on('Debugger.paused', () => {
    pauses++;
    void debuggerSession.send('Debugger.resume').catch(() => {});
  });
  await debuggerSession.send('Debugger.enable');
  assert.equal(
    await f.page.evaluate(() => {
      // eslint-disable-next-line no-debugger -- The debugger pause is the synthetic lifecycle boundary under test.
      debugger;
      return window.inventedEcho('after-debugger');
    }),
    'after-debugger',
  );
  assert.ok(pauses > 0);
  await debuggerSession.detach();
});

test('wrapper installation exceptions fail readiness and clean the owned channel', async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() =>
    Object.defineProperty(window, 'inventedEcho', {
      value: 'occupied',
      configurable: false,
    }),
  );
  await assert.rejects(
    createOwnedPageBindings(f.page, {
      origin: f.origin,
      bindings: { inventedEcho: () => 'unexpected' },
    }),
    /wrapper installation failed/,
  );
  assert.equal(
    await f.page.evaluate(
      () => Object.getOwnPropertyNames(window).filter((name) => name.startsWith('__paqviloOwned')).length,
    ),
    0,
  );
  assert.equal(await f.page.evaluate(() => window.inventedEcho), 'occupied');
});

test('cleanup attempts later real protocol operations and preserves an exact injected cause', async (t) => {
  const f = await fixture(t),
    original = f.context.newCDPSession.bind(f.context);
  const marker = Error('Invented script cleanup refusal');
  let fail = false;
  const commands = [];
  f.context.newCDPSession = async (page) => {
    const session = await original(page),
      send = session.send.bind(session);
    session.send = async (method, params) => {
      commands.push(method);
      if (fail && method === 'Page.removeScriptToEvaluateOnNewDocument') throw marker;
      return send(method, params);
    };
    return session;
  };
  const bridge = await createOwnedPageBindings(f.page, {
    origin: f.origin,
    bindings: { inventedEcho: (_source, value) => value },
  });
  fail = true;
  commands.length = 0;
  await assert.rejects(bridge.close(), (error) => error === marker);
  assert.ok(commands.indexOf('Runtime.evaluate') > commands.indexOf('Page.removeScriptToEvaluateOnNewDocument'));
  assert.ok(commands.indexOf('Runtime.removeBinding') > commands.indexOf('Runtime.evaluate'));
  assert.equal(await f.page.evaluate(() => typeof inventedEcho), 'undefined');
});

test('closing the bridge preserves a real user debugger pause and the owned browser', async (t) => {
  const f = await fixture(t);
  const bridge = await createOwnedPageBindings(f.page, {
    origin: f.origin,
    bindings: { inventedEcho: (_source, value) => value },
  });
  const debuggerSession = await f.context.newCDPSession(f.page);
  await debuggerSession.send('Debugger.enable');
  let resolvePaused,
    resumed = false;
  const paused = new Promise((resolve) => {
    resolvePaused = resolve;
  });
  debuggerSession.on('Debugger.paused', resolvePaused);
  debuggerSession.on('Debugger.resumed', () => {
    resumed = true;
  });
  const execution = f.page.evaluate(() => {
    // eslint-disable-next-line no-debugger -- The debugger pause is the synthetic lifecycle boundary under test.
    debugger;
    return 'continued';
  });
  await paused;
  try {
    // The pause is released only after close settles, so a close that waited for the
    // user's debugger would never settle and the test deadline would fail it.
    await bridge.close();
    assert.equal(resumed, false);
    assert.equal(f.page.isClosed(), false);
  } finally {
    await debuggerSession.send('Debugger.resume').catch(() => {});
    await debuggerSession.detach();
  }
  assert.equal(await execution, 'continued');
});

test('blocked protocol replies release capacity and expired delivery cannot complete a request', async (t) => {
  const f = await fixture(t),
    original = f.context.newCDPSession.bind(f.context);
  let send,
    blocked = true,
    allDelayed;
  const delayed = [];
  const capacityHeld = new Promise((resolve) => {
    allDelayed = resolve;
  });
  f.context.newCDPSession = async (page) => {
    const session = await original(page);
    send = session.send.bind(session);
    session.send = (method, params) => {
      if (blocked && method === 'Runtime.callFunctionOn') {
        if (delayed.push(params) === OWNED_CALL_CAPACITY) allDelayed();
        return new Promise(() => {});
      }
      return send(method, params);
    };
    return session;
  };
  const bridge = await createOwnedPageBindings(f.page, {
    origin: f.origin,
    bindings: { inventedEcho: (_source, value) => value },
  });
  f.own(() => bridge.close());
  await f.page.evaluate(() => {
    window.ownedDeliveryProbe = Promise.all(
      Array.from({ length: 32 }, () =>
        window.inventedEcho('held').then(
          () => 'incorrect-success',
          (error) => error.message,
        ),
      ),
    );
  });
  await capacityHeld;
  assert.equal(delayed.length, OWNED_CALL_CAPACITY);
  // Every reply's deadline timer was scheduled before its blocked send was recorded, and
  // Node fires timers in expiry order, so this later timer runs only after all of them have
  // released capacity. The page also sees its expiresAt stamp in the past.
  await new Promise((resolve) => setTimeout(resolve, REPLY_DEADLINE_MS + 100));
  blocked = false;
  assert.equal(await f.page.evaluate(() => window.inventedEcho('fresh-after-deadlines')), 'fresh-after-deadlines');
  for (const params of delayed) await send('Runtime.callFunctionOn', params);
  assert.deepEqual(
    await f.page.evaluate(() => window.ownedDeliveryProbe),
    Array(32).fill('The owned page reply expired.'),
  );
});

test('existing Unicode Diff results above4MiB remain supported and results above16MiB are refused', async (t) => {
  const f = await fixture(t);
  const before = ('//' + '漢'.repeat(498) + '\n').repeat(1500),
    after = ('//' + '字'.repeat(498) + '\n').repeat(1500);
  assert.ok(Buffer.byteLength(before) < 3 * 1024 * 1024 && Buffer.byteLength(after) < 3 * 1024 * 1024);
  const valid = comparison(before, after);
  assert.ok(Buffer.byteLength(JSON.stringify(valid)) > 4 * 1024 * 1024);
  const bridge = await createOwnedPageBindings(f.page, {
    origin: f.origin,
    bindings: {
      inventedEcho: (_source, input) => (input === 'valid' ? valid : 'x'.repeat(16 * 1024 * 1024 + 1)),
    },
  });
  f.own(() => bridge.close());
  const result = await f.page.evaluate(async () => {
    const value = await window.inventedEcho('valid');
    return {
      lines: value.lines.length,
      added: value.added,
      removed: value.removed,
    };
  });
  assert.deepEqual(result, {
    lines: 3000,
    added: valid.added,
    removed: valid.removed,
  });
  assert.equal(await rejectionOf(f.page, 'oversized'), 'The owned page request failed.');
});

test('cross-origin retirement accepts only actual already-absent script removal and still retires wrappers', async (t) => {
  const f = await fixture(t),
    original = f.context.newCDPSession.bind(f.context);
  let absenceObserved = false;
  f.context.newCDPSession = async (page) => {
    const session = await original(page),
      send = session.send.bind(session);
    session.send = async (method, params) => {
      if (method !== 'Page.removeScriptToEvaluateOnNewDocument') return send(method, params);
      // A real second removal deterministically exercises Chromium's absence response
      // even on versions which retain script IDs across the origin change.
      try {
        await send(method, params);
        await send(method, params);
      } catch (error) {
        absenceObserved = error.message.endsWith(
          'Protocol error (Page.removeScriptToEvaluateOnNewDocument): Script not found',
        );
        throw error;
      }
    };
    return session;
  };
  const bridge = await createOwnedPageBindings(f.page, {
    origin: f.origin,
    bindings: { inventedEcho: (_source, value) => value },
  });
  assert.equal(await f.page.evaluate(() => window.inventedEcho('before')), 'before');
  await f.page.goto(f.origin.replace('127.0.0.1', 'localhost'));
  await bridge.close();
  assert.equal(absenceObserved, true);
  await f.page.goto(f.origin);
  assert.equal(await f.page.evaluate(() => typeof inventedEcho), 'undefined');
});
