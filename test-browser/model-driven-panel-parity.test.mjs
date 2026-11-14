// @test-kind contract: shared model-driven panel tests run on owned loopback fixtures with the agent ownership the command gives them.
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';

import { NATIVE_READ_GUARD_MS, startModelDrivenInspector } from '../lense/model-driven-inspector.mjs';
import { startAgentServer } from '../lense/agent-server.mjs';
import { EventEmitter } from 'node:events';
import { createModelDrivenOverlay } from '../lense/model-driven.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { readModelDrivenNativeSource } from '../lense/model-driven-native-comparison.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { modelDrivenPanelData } from '../lense/model-driven-panel.mjs';
import { modelDrivenInspectorUi } from '../lense/model-driven-inspector-ui.mjs';
import { PROFILE_RELEASE_RETRIES } from './helpers/profile-cleanup.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions());
});
after(() => browser?.close());

// Resolves on the first panel redraw that starts after the request and after the inspector's refresh has completed.
// The inspector also redraws while a refresh is pending; such a redraw does not resolve the promise.
function redrawEvents(page, inspectorOf) {
  const evaluate = page.evaluate.bind(page);
  let asked = [];
  page.evaluate = (fn, input) => {
    if (fn !== modelDrivenInspectorUi) return evaluate(fn, input);
    const waiting = inspectorOf()?.snapshot().pendingInspection === false ? asked : [];
    if (waiting === asked) asked = [];
    return evaluate(fn, input).finally(() => {
      for (const resolve of waiting) resolve();
    });
  };
  return () =>
    new Promise((resolve) => {
      asked.push(resolve);
    });
}

// Records the guards an inspector arms. A guard expires only when a test calls its expire(); an operation that
// settles cancels its guard, which the record shows.
function guardScheduler() {
  const guards = [];
  let notify = () => {};
  const open = (since) => guards.slice(since).filter((guard) => !guard.cancelled);
  return {
    guards,
    armed: () => guards.length,
    scheduleGuard(expire, ms) {
      const guard = { ms, cancelled: false, expired: false, expire: () => expireGuard(guard, expire) };
      guards.push(guard);
      notify();
      return () => {
        guard.cancelled = true;
      };
    },
    // Resolves with the guards armed from index since that are still pending, once there are at least count of them.
    async pending(count, since) {
      while (open(since).length < count)
        await new Promise((resolve) => {
          notify = resolve;
        });
      return open(since);
    },
  };
}
function expireGuard(guard, expire) {
  guard.expired = true;
  expire();
}

// Wraps a frame: its provider disposal call goes to onDisposal(target, fn, input), other calls pass through.
function disposalGatedFrame(frame, onDisposal) {
  return new Proxy(frame, {
    get(target, key) {
      if (key !== 'evaluate') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (fn, input) => {
        if (!String(fn).includes('provider.dispose()')) return target.evaluate(fn, input);
        return onDisposal(target, fn, input);
      };
    },
  });
}

async function modelPanelFixture(t, { nativeBody, withGit = true, archive = false, nativeReadGuardMs } = {}) {
  const owner = ownedFixture(t),
    f = { agentClosed: false },
    guards = guardScheduler(),
    root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'model-panel-parity-'));
  // Async Git reads started by a refresh can still hold the directory briefly on Windows.
  owner.remove(() => fs.rm(root, { recursive: true, force: true, ...PROFILE_RELEASE_RETRIES }));
  const file = path.join(root, 'x_script.js'),
    raw = 'window.sourceRevision="same";';
  await fs.writeFile(file, raw);
  // Repository variables of a calling Git process, and hooks and signing in the user's configuration, stay out.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (args) =>
    execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      env: gitEnv,
      windowsHide: true,
      stdio: 'pipe',
    });
  if (withGit) {
    git(['init', '-q']);
    git(['add', 'x_script.js']);
    git(['-c', 'user.name=Invented', '-c', 'user.email=invented@example.invalid', 'commit', '-qm', 'Initial']);
  }
  const nativeHeaders = [],
    nativeBytes = gzipSync(Buffer.from(nativeBody ?? raw));
  const server = http.createServer((request, response) => {
    if (request.url.toLowerCase().includes('/webresources/')) {
      nativeHeaders.push(request.headers['x-paqvilo-native-comparison']);
      return response
        .writeHead(200, {
          'content-type': 'text/javascript',
          'content-length': nativeBytes.length,
          'content-encoding': 'gzip',
        })
        .end(nativeBytes);
    }
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        '<!doctype html><title>Invented app</title><h1>Source controls</h1><script src="/%7b2026%7d/webresources/x_script.js"></script>',
      );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  owner.add(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext(),
    page = await context.newPage();
  owner.add(() => context.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const nextRedraw = redrawEvents(page, () => inspector);
  const makeImported = (data) => ({
    assets: new Map([
      [
        'x_script.js',
        { name: 'x_script.js', file: archive ? undefined : file, mime: 'text/javascript', data: Buffer.from(data) },
      ],
    ]),
    resources: [{ name: 'x_script.js' }],
    layers: [{ dir: root, documents: [] }],
    diagnostics: [],
  });
  const imported = makeImported(raw),
    overlay = createModelDrivenOverlay({
      origin,
      imported,
      mappings: [{ path: '/%7b2026%7d/webresources/x_script.js', resource: 'x_script.js' }],
      ownsRequest: (request) => request.frame().page() === page,
    });
  const release = await interceptOrigin(context, origin, (route) => overlay.handle(route), {
    ownsPage: (candidate) => candidate === page,
  });
  owner.add(release);
  let live = false;
  const inspector = await startModelDrivenInspector({
    context,
    page,
    overlay,
    imported,
    nativeReadGuardMs,
    scheduleGuard: guards.scheduleGuard,
    cfg: { origin, stateDir: path.join(root, '.state'), sourceDir: root },
    runtime: {
      liveReload: false,
      setLive(value) {
        live = value;
      },
    },
  });
  owner.add(() => inspector.close());
  // The command starts one agent per dev session and attaches each inspector's state to it.
  const agent = await startAgentServer({
    session: Object.assign(new EventEmitter(), {
      cfg: { stateDir: path.join(root, '.state'), origin, sourceDir: root },
      rel: String,
    }),
    context,
    stop: () => {},
    runtime: { watching: true, debugPort: null },
    options: { deferred: true, ownsPage: (candidate) => candidate === page },
  });
  agent.setInspector(inspector.agentState);
  // The failed-removal test asserts this rejection, then marks the agent closed so teardown skips it.
  owner.add(() => (f.agentClosed ? undefined : agent.close()));
  await page.goto(origin + '/main.aspx');
  await page.locator('#paqvilo-panel').waitFor();
  await page.keyboard.press('Alt+Shift+P');
  // The inspector installs its provider asynchronously after it starts; every test that uses this fixture starts here.
  await page.waitForFunction(() => typeof globalThis.__paqviloModelDrivenProvider === 'object');
  assert.equal(await page.evaluate(() => typeof globalThis.__paqviloModelDrivenProvider), 'object');
  // The start-up inspection is still running when the provider appears. Wait for its completed redraw, so every test
  // starts from an idle inspector and its own refresh is the only one in flight.
  if (inspector.snapshot().pendingInspection) await nextRedraw();
  assert.equal(inspector.snapshot().pendingInspection, false, 'the start-up inspection has completed');
  return Object.assign(f, {
    root,
    file,
    page,
    context,
    overlay,
    inspector,
    agent,
    guards,
    nextRedraw,
    origin,
    errors,
    makeImported,
    nativeHeaders,
    getLive: () => live,
  });
}

test('canonical model panel executes actual source controls, preserves Actions drafts and shares Power Pages chrome', async (t) => {
  const f = await modelPanelFixture(t),
    { page, inspector, overlay, root } = f,
    host = page.locator('#paqvilo-panel');
  await host.getByRole('button', { name: 'Local', exact: true }).waitFor();
  assert.match(await host.locator('[data-act=live]').getAttribute('title'), /off/);
  await host.locator('[data-act=live]').click();
  assert.equal(f.getLive(), true);
  await host.getByRole('tab', { name: 'Explore', exact: true }).click();
  await host.getByText('x_script.js', { exact: true }).first().waitFor();
  await host.getByRole('tab', { name: 'Actions', exact: true }).click();
  await host.locator('.actions-tabs').getByRole('button', { name: 'Custom', exact: true }).click();
  const editor = host.getByRole('textbox', { name: 'Command JavaScript', exact: true });
  await editor.fill('return "draft retained";');
  await editor.evaluate((node) => node.setSelectionRange(3, 7));
  const redrawn = f.nextRedraw();
  inspector.refresh();
  // The refresh is pending until its panel redraw has finished; check the draft after that.
  assert.equal(inspector.snapshot().pendingInspection, true);
  await redrawn;
  assert.equal(inspector.snapshot().pendingInspection, false, 'the refresh has completed');
  assert.equal(await editor.inputValue(), 'return "draft retained";');
  await host.getByRole('tab', { name: /^Overrides/ }).click();
  await host.getByRole('tab', { name: 'Actions', exact: true }).click();
  assert.equal(await editor.inputValue(), 'return "draft retained";');
  await host.getByRole('tab', { name: /^Overrides/ }).click();
  const shots = process.env.PAQVILO_MODEL_PANEL_SCREENSHOTS;
  if (shots) {
    await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'model-driven-canonical.png') });
  }
  await host.getByRole('button', { name: 'Online', exact: true }).click();
  await page.waitForFunction(() => window.sourceRevision === 'same');
  await page.locator('#paqvilo-panel').waitFor();
  await page.keyboard.press('Alt+Shift+P');
  assert.equal(overlay.report().online, true);
  await page.evaluate(() => fetch('/%7b2026%7d/webresources/x_script.js').then((r) => r.text()));
  const comparison = await page.evaluate(
    async (token) => window.__paqviloModelPanelApi({ token, name: 'diff', body: { rel: 'x_script.js' } }),
    inspector.snapshot().token,
  );
  assert.equal(comparison.ok, true);
  assert.equal(comparison.against, 'Model-driven');
  assert.equal(
    comparison.added + comparison.removed,
    0,
    'raw local source comparison excludes debugger source-map suffix',
  );
  assert.equal(comparison.rawEqual, true);
  assert.ok(f.nativeHeaders.length > 0);
  assert.ok(
    f.nativeHeaders.every((value) => value === undefined),
    'one-use bypass header never reaches native server',
  );
  const denied = await page.evaluate(() =>
    window.__paqviloModelPanelApi({ token: 'foreign', name: 'mode', body: { online: false } }),
  );
  assert.equal(denied.ok, false);
  assert.equal(overlay.report().online, true);
  const frame = await page.evaluateHandle(() => {
    const iframe = document.createElement('iframe');
    iframe.src = '/frame';
    document.body.append(iframe);
    return iframe;
  });
  await frame
    .asElement()
    .contentFrame()
    .then(async (inner) => {
      await inner.waitForLoadState();
      assert.equal(
        await inner.evaluate(() => typeof window.__paqviloModelPanelApi),
        'undefined',
        'child frames do not receive the owned main-frame transport',
      );
    });
  if (shots) {
    const state = inspector.snapshot(),
      data = modelDrivenPanelData(state, { cfg: { sourceDir: root }, ui: { open: true } });
    await inspector.close();
    await page.evaluate(panelUi, {
      ...data,
      modelDriven: false,
      transport: undefined,
      token: 'pp-visual-fixture',
      capabilities: { actions: false, targets: false },
      items: [],
      unobserved: [],
    });
    await page.screenshot({ path: path.join(shots, 'power-pages-canonical.png') });
  }
  assert.deepEqual(f.errors, []);
});

test('explicit Online comparison streams decoded compressed bytes, cancels oversized sources and preserves Local overlay', async (t) => {
  const f = await modelPanelFixture(t, { nativeBody: '/*' + 'x'.repeat(3 * 1024 * 1024) + '*/' });
  const before = f.overlay.report().applied;
  const result = await f.page.evaluate(
    (token) => window.__paqviloModelPanelApi({ token, name: 'diff', body: { rel: 'x_script.js' } }),
    f.inspector.snapshot().token,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /decoded native source exceeds/);
  assert.equal(f.overlay.report().online, false);
  assert.equal(f.overlay.report().applied, before);
  assert.deepEqual(f.nativeHeaders, [undefined]);
  await f.page.evaluate(() => fetch('/%7b2026%7d/webresources/x_script.js').then((r) => r.text()));
  assert.equal(f.overlay.report().applied, before + 1, 'next ordinary source request still uses Local');
});

test('comparison preserves UTF8 BOM and rejects a stale source revision without accepting late bytes', async (t) => {
  const f = await modelPanelFixture(t, { nativeBody: '\ufeffwindow.sourceRevision="same";' });
  const token = f.inspector.snapshot().token;
  const call = () =>
    f.page.evaluate(
      (token) => window.__paqviloModelPanelApi({ token, name: 'diff', body: { rel: 'x_script.js' } }),
      token,
    );
  const bom = await call();
  assert.equal(bom.ok, true);
  assert.equal(bom.rawEqual, false);
  const lease = f.overlay.nativeRead('x_script.js');
  const bytes = await f.page.evaluate(readModelDrivenNativeSource, {
    origin: f.origin,
    path: lease.path,
    token: lease.token,
  });
  lease.release();
  assert.equal(bytes.ok, true);
  assert.equal(bytes.text.charCodeAt(0), 0xfeff);
  assert.equal(Buffer.byteLength(bytes.text), bytes.bytes, 'BOM bytes survive the browser/controller boundary');
  const original = f.page.evaluate.bind(f.page);
  let release, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  f.page.evaluate = (fn, input) =>
    fn.name === 'readModelDrivenNativeSource'
      ? new Promise((resolve) => {
          release = resolve;
          started();
        })
      : original(fn, input);
  const pending = call();
  await began;
  const next = f.makeImported('window.sourceRevision="new";');
  f.overlay.replace(next);
  f.inspector.refresh(next);
  release({ ok: true, text: 'old source', bytes: 10 });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /revision changed/);
  f.page.evaluate = original;
});

test('a paused comparison evaluator releases its lease at the Node deadline and permits a fresh read', async (t) => {
  const f = await modelPanelFixture(t, { nativeReadGuardMs: 1500 }),
    original = f.page.evaluate.bind(f.page);
  // The paused read is gated. The gate reports the index of the guard the read arms, which is the next one armed.
  let paused = 0,
    settled = false,
    enteredGate;
  const entered = new Promise((resolve) => {
    enteredGate = resolve;
  });
  f.page.evaluate = (fn, input) => {
    if (fn.name !== 'readModelDrivenNativeSource') return original(fn, input);
    paused++;
    enteredGate(f.guards.armed());
    return new Promise(() => {});
  };
  const token = f.inspector.snapshot().token;
  const pending = original(
    (token) => window.__paqviloModelPanelApi({ token, name: 'diff', body: { rel: 'x_script.js' } }),
    token,
  ).finally(() => {
    settled = true;
  });
  const [guard] = await f.guards.pending(1, await entered);
  assert.equal(guard.ms, 1500);
  // The catalogue is answered from Node state over the same page channel, so a reply to the paused read would have
  // arrived before this one.
  const catalogue = await original((token) => window.__paqviloModelPanelApi({ token, name: 'catalog' }), token);
  assert.equal(catalogue.ok, true);
  assert.equal(settled, false, 'the paused read is still awaited while its guard is pending');
  guard.expire();
  const result = await pending;
  assert.equal(paused, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'native-read-timed-out');
  assert.match(result.error, /1500 ms/);
  assert.match(result.error, /did not answer/);
  f.page.evaluate = original;
  const fresh = await original(
    (token) => window.__paqviloModelPanelApi({ token, name: 'diff', body: { rel: 'x_script.js' } }),
    token,
  );
  assert.equal(fresh.ok, true);
});

test('a native structure read that answers after ten seconds is kept under the default guard', async (t) => {
  const f = await modelPanelFixture(t),
    original = f.page.evaluate.bind(f.page),
    token = f.inspector.snapshot().token;
  // The refresh's structure read is the only page evaluation that selects the document scope; it is gated here and
  // answers only after the test has seen its guard armed and still pending.
  let enteredGate, release;
  const entered = new Promise((resolve) => {
    enteredGate = resolve;
  });
  f.page.evaluate = (fn, input) => {
    if (!String(fn).includes('getSelectionScope(document.documentElement)')) return original(fn, input);
    enteredGate(f.guards.armed());
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  try {
    const pending = original(
      (token) => window.__paqviloModelPanelApi({ token, name: 'inspect', body: { refresh: true } }),
      token,
    );
    const [guard] = await f.guards.pending(1, await entered);
    assert.equal(guard.ms, NATIVE_READ_GUARD_MS);
    assert.equal(
      f.guards.guards.some((item) => item.expired),
      false,
      'no guard expires before the answer arrives',
    );
    const redrawn = f.nextRedraw();
    release({ invented: 'structure' });
    await redrawn;
    await pending;
    assert.deepEqual(f.inspector.snapshot().nativeStructure, { invented: 'structure' });
    assert.equal(guard.cancelled, true, 'the answer settles the read and cancels its guard');
    assert.equal(guard.expired, false, 'the answered read never expires its guard');
  } finally {
    f.page.evaluate = original;
  }
});

test('a native structure read that never answers reports native-read-timed-out under the configured guard', async (t) => {
  const f = await modelPanelFixture(t, { nativeReadGuardMs: 1000 }),
    original = f.page.evaluate.bind(f.page),
    token = f.inspector.snapshot().token;
  let enteredGate;
  const entered = new Promise((resolve) => {
    enteredGate = resolve;
  });
  f.page.evaluate = (fn, input) => {
    if (!String(fn).includes('getSelectionScope(document.documentElement)')) return original(fn, input);
    enteredGate(f.guards.armed());
    return new Promise(() => {});
  };
  try {
    const pending = original(
      (token) => window.__paqviloModelPanelApi({ token, name: 'inspect', body: { refresh: true } }),
      token,
    );
    const [guard] = await f.guards.pending(1, await entered);
    assert.equal(guard.ms, 1000);
    const redrawn = f.nextRedraw();
    guard.expire();
    await redrawn;
    await pending;
    const state = f.inspector.snapshot(),
      problem = state.problems.find((item) => item.code === 'native-read-timed-out');
    assert.equal(state.nativeStructure, null);
    assert.match(problem.text, /1000 ms/);
    assert.match(problem.text, /did not answer/);
  } finally {
    f.page.evaluate = original;
  }
});

test('owned provider cleanup that answers after five seconds completes and disposes the provider', async (t) => {
  const f = await modelPanelFixture(t),
    realFrames = f.page.frames.bind(f.page);
  assert.equal(await f.page.evaluate(() => typeof globalThis.__paqviloModelDrivenProvider), 'object');
  // Each frame the cleanup visits is wrapped so that only the provider disposal call is gated.
  // The gate resolves with the guard index that the disposal arms.
  let answerDispose, requestDispose, markRetired;
  const requested = new Promise((resolve) => {
      requestDispose = resolve;
    }),
    retirementDone = new Promise((resolve) => {
      markRetired = resolve;
    });
  const gated = (frame) =>
    disposalGatedFrame(frame, (target, fn, input) => {
      requestDispose(f.guards.armed());
      return new Promise((resolve) => {
        answerDispose = () => resolve(target.evaluate(fn, input));
      });
    });
  f.page.frames = () => realFrames().map(gated);
  const originalEvaluate = f.page.evaluate.bind(f.page);
  f.page.evaluate = (fn, input) => {
    const call = originalEvaluate(fn, input);
    return String(fn).includes('__paqviloRetiredModelInspectors') ? call.finally(markRetired) : call;
  };
  try {
    const closing = f.inspector.close();
    // A failed close is reported by the await below; this handler only keeps a rejection from going unhandled earlier.
    closing.catch(() => {});
    const disposalFrom = await requested;
    // The retirement runs alongside the disposal, so it completes while the disposal is still unanswered; close must
    // still wait for the disposal.
    await retirementDone;
    const [disposal] = await f.guards.pending(1, disposalFrom);
    assert.equal(disposal.ms, NATIVE_READ_GUARD_MS);
    assert.equal(
      f.guards.guards.some((item) => item.expired),
      false,
      'no guard expires while the disposal is unanswered',
    );
    answerDispose();
    await closing;
    assert.equal(disposal.cancelled, true, 'the answered disposal cancels its guard');
    assert.equal(disposal.expired, false, 'the answered disposal never expires its guard');
    assert.equal(await originalEvaluate(() => globalThis.__paqviloModelDrivenProvider), undefined);
  } finally {
    f.page.evaluate = originalEvaluate;
    f.page.frames = realFrames;
  }
});

test('owned provider cleanup that never answers records the leak in the session log and still completes close', async (t) => {
  const f = await modelPanelFixture(t, { nativeReadGuardMs: 1000 }),
    realFrames = f.page.frames.bind(f.page);
  // The disposal is never answered: only the expiry of its own guard ends the wait.
  let requestDispose;
  const requested = new Promise((resolve) => {
    requestDispose = resolve;
  });
  f.page.frames = () =>
    realFrames().map((frame) =>
      disposalGatedFrame(frame, () => {
        requestDispose(f.guards.armed());
        return new Promise(() => {});
      }),
    );
  try {
    const closing = f.inspector.close();
    const [disposal] = await f.guards.pending(1, await requested);
    assert.equal(disposal.ms, 1000);
    disposal.expire();
    await closing;
    const problem = f.inspector.snapshot().problems.find((item) => item.code === 'cleanup-timed-out');
    assert.ok(problem, 'the unanswered disposal is recorded in the session log');
    assert.match(problem.text, /Owned provider disposal did not answer within 1000 ms/);
  } finally {
    f.page.frames = realFrames;
  }
});

test('canonical Issues shows source reasons, console warnings and request failures in distinct groups', async (t) => {
  const f = await modelPanelFixture(t),
    host = f.page.locator('#paqvilo-panel');
  const next = f.makeImported('window.sourceRevision="same";');
  next.diagnostics = [{ code: 'INVENTED_MAPPING', message: 'An observed native mapping is required.', source: f.file }];
  f.overlay.replace(next);
  f.inspector.refresh(next);
  await f.page.route('**/failed-asset.js', (route) => route.abort('failed'));
  await f.page.evaluate(async () => {
    console.warn('Invented native console warning');
    await fetch('/failed-asset.js').catch(() => {});
  });
  await host.getByRole('tab', { name: /^Issues/ }).click();
  await host.getByText('INVENTED_MAPPING: An observed native mapping is required.', { exact: true }).waitFor();
  await host.getByText('Invented native console warning', { exact: true }).waitFor();
  await host.getByText('net::ERR_FAILED', { exact: true }).waitFor();
  await host.getByText('Console warnings', { exact: true }).waitFor();
  await host.getByText('Failed requests', { exact: true }).waitFor();
  const text = await host.evaluate((node) => node.shadowRoot.textContent);
  assert.match(text, /Console warnings/);
  assert.match(text, /Failed requests/);
  const title = await host.locator('.pill .n.err').getAttribute('title');
  assert.match(title, /1 failed request/);
  assert.equal(await host.locator('.pill .n.warn').textContent(), '2', 'one source note and one console warning');
});

test('mapped runtime locations open the exact selected source at one-based line and column, while native-only URLs stay display-only', async (t) => {
  const f = await modelPanelFixture(t),
    host = f.page.locator('#paqvilo-panel');
  const next = f.makeImported('window.sourceRevision="same";\n\nconsole.error("Invented mapped error");');
  f.overlay.replace(next);
  f.inspector.refresh(next);
  await f.page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/%7b2026%7d/webresources/x_script.js';
        script.onload = resolve;
        script.onerror = reject;
        document.body.append(script);
      }),
  );
  await host.getByRole('tab', { name: /^Issues/ }).click();
  const error = host.getByText('Invented mapped error', { exact: true });
  await error.waitFor();
  const row = error.locator('xpath=ancestor::div[contains(@class,"row")][1]');
  assert.equal(await row.getAttribute('data-rel'), 'x_script.js');
  assert.equal(await row.getAttribute('data-line'), '3');
  assert.equal(await row.getAttribute('data-col'), '9');
  assert.equal(await row.locator('button.main').getAttribute('title'), 'Open in the editor at line 3');
  f.overlay.setOnline(true);
  await f.page.route('**/webresources/x_script.js', (route) => route.abort('failed'));
  await f.page.evaluate(() => fetch('/%7b2026%7d/webresources/x_script.js').catch(() => {}));
  const failed = host.getByText('net::ERR_FAILED', { exact: true });
  await failed.waitFor();
  assert.equal(
    await failed.locator('xpath=ancestor::div[contains(@class,"row")][1]').getAttribute('data-rel'),
    'x_script.js',
  );
});

test('inspector drains shared-panel DOM and listeners even when owned discovery removal fails', async (t) => {
  const f = await modelPanelFixture(t);
  const discovery = f.agent.discoveryFile;
  await fs.rm(discovery);
  await fs.mkdir(discovery);
  // The owner retires the inspector first, then closes the agent, as the command's cleanup does.
  f.agent.setInspector(null);
  await f.inspector.close();
  await assert.rejects(f.agent.close(), (cause) => ['EPERM', 'EISDIR', 'ERR_FS_EISDIR'].includes(cause.code));
  f.agentClosed = true;
  await f.page.waitForFunction(
    () => !document.getElementById('paqvilo-panel') && !document.getElementById('paqvilo-xray'),
  );
  assert.equal(f.context.browser().isConnected(), true, 'inspector disposal does not close an attached browser');
  assert.equal(
    await f.page.evaluate(() => typeof window.__paqviloModelPanelApi),
    'undefined',
    'retired transport wrapper is removed',
  );
  assert.equal(f.page.listenerCount('console'), 0);
  assert.equal(f.page.listenerCount('response'), 0);
});

test('mapped nonGit and archive sources can bootstrap explicit native Diff', async (t) => {
  for (const archive of [false, true]) {
    await t.test(archive ? 'archive' : 'directory', async (child) => {
      const f = await modelPanelFixture(child, { withGit: false, archive });
      const button = f.page.locator('#paqvilo-panel [data-rel="x_script.js"] [data-act=diff]');
      await f.page.locator('#paqvilo-panel [data-rel="x_script.js"]').hover();
      await button.click();
      await f.page.getByText('No difference', { exact: true }).waitFor();
      assert.deepEqual(f.nativeHeaders, [undefined]);
    });
  }
});

test('Power Pages capability restores a visible tab after an Actions-tab UI state', async (t) => {
  const f = await modelPanelFixture(t),
    state = f.inspector.snapshot();
  await f.inspector.close();
  const data = modelDrivenPanelData(state, { cfg: {}, ui: { open: true, tab: 'actions' } });
  await f.page.evaluate(panelUi, {
    ...data,
    token: 'invented-pp-state',
    transport: undefined,
    modelDriven: false,
    capabilities: { actions: false, targets: false },
    items: [],
    notes: [],
    inspection: { active: false },
  });
  assert.equal(await f.page.getByRole('tab', { name: 'Actions', exact: true }).count(), 0);
  assert.equal(await f.page.getByRole('tab', { name: /^Overrides/ }).getAttribute('aria-selected'), 'true');
});

test('mapped thrown script errors retain exact source positions and Chromium network console duplicates stay out of JS errors', async (t) => {
  const f = await modelPanelFixture(t),
    host = f.page.locator('#paqvilo-panel');
  const next = f.makeImported('window.sourceRevision="same";\n\nthrow new Error("Invented mapped exception");');
  f.overlay.replace(next);
  f.inspector.refresh(next);
  await f.page.evaluate(
    () =>
      new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = '/%7b2026%7d/webresources/x_script.js';
        script.onload = resolve;
        script.onerror = resolve;
        document.body.append(script);
      }),
  );
  await host.getByRole('tab', { name: /^Issues/ }).click();
  const exception = host.getByText('Invented mapped exception', { exact: true });
  await exception.waitFor();
  const row = exception.locator('xpath=ancestor::div[contains(@class,"row")][1]');
  assert.equal(await row.getAttribute('data-rel'), 'x_script.js');
  assert.equal(await row.getAttribute('data-line'), '3');
  assert.equal(await row.locator('button.main').getAttribute('title'), 'Open in the editor at line 3');
  await f.page.route('**/failed-native.js', (route) => route.abort('failed'));
  await f.page.evaluate(() => fetch('/failed-native.js').catch(() => {}));
  await host.getByText('net::ERR_FAILED', { exact: true }).waitFor();
  assert.equal(await host.locator('.pill .n.err').getAttribute('title'), '1 JavaScript error, 1 failed request');
  assert.equal(
    await host.getByText(/^Failed to load resource/).count(),
    0,
    'network failures retain one failed-request entry',
  );
});

test('a warning-only shared panel counts one issue without a JavaScript or network error', async (t) => {
  const f = await modelPanelFixture(t),
    state = f.inspector.snapshot();
  await f.inspector.close();
  const data = modelDrivenPanelData(
    { ...state, resources: [], diagnostics: [], problems: [{ type: 'warning', text: 'Invented warning only' }] },
    { cfg: {}, ui: { open: true, tab: 'issues' } },
  );
  await f.page.evaluate(panelUi, {
    ...data,
    token: 'warning-only-fixture',
    capabilities: { actions: false, targets: false },
    inspection: { active: false },
  });
  const host = f.page.locator('#paqvilo-panel');
  assert.equal(await host.getAttribute('data-issues'), '1');
  assert.equal(await host.locator('.pill .n.warn').textContent(), '1');
  assert.equal(await host.locator('.pill .n.err').count(), 0);
  await host.getByText('Console warnings', { exact: true }).waitFor();
  await host.getByText('Invented warning only', { exact: true }).waitFor();
});
