// @test-kind contract: Mirage's own frame load blocker and the observed settings that switch it off; no native behaviour is claimed.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFrameReadiness } from '../lib/frame-readiness.mjs';
import { observedConfig } from '../lib/project-config.mjs';

test('frame overrides require evidence and immediate mode omits the load blocker', () => {
  assert.throws(() => observedConfig({ modalLoadOrdering: 'immediate' }), /evidence/);
  assert.throws(() => observedConfig({ modalLoadOrdering: 'later', evidence: 'synthetic' }), /ready or immediate/);
  const observed = observedConfig({
    modalLoadOrdering: 'immediate',
    formSubmissionErrorMessage: 'Observed plain text',
    evidence: 'invented reference',
  });
  const readiness = createFrameReadiness();
  const html = '<html><body>Frame</body></html>';
  assert.equal(readiness.decorate(html, { observed }), html);
  assert.equal(observed.formSubmissionErrorMessage, 'Observed plain text');
  assert.throws(() => observedConfig({ formSubmissionErrorMessage: '', evidence: 'synthetic' }), /plain text/);
});

test('the blocker leaves authored closing-tag literals intact and ignores fragments', () => {
  const readiness = createFrameReadiness();
  const script = '<script>window.literal = "</body>";</script>';
  const html = `<html><body>${script}</body></html>`;
  assert.ok(readiness.decorate(html).includes(script));
  assert.equal(readiness.decorate('<div>Fragment</div>'), '<div>Fragment</div>');
  readiness.close();
});

// @test-kind contract: Mirage's own frame load blocker fails open after its limit, counted from the browser's image request; no native behaviour is claimed.
test('a missing ready release fails open at a bounded timeout and cleans owned requests', async (t) => {
  // The deadline runs on a mock clock and starts when the held image request is observed: the time before the browser
  // asked for the image (delivery of the document and its scripts on a loaded host) never counts against the page.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeoutMs = 2500, // not the 5 s default, so the configured bound is the one observed
    diagnostics = [],
    readiness = createFrameReadiness({ timeoutMs, diagnostic: (item) => diagnostics.push(item) });
  let observeHeld;
  const held = new Promise((resolve) => (observeHeld = resolve));
  const server = http.createServer((req, res) => {
    readiness.handle(req, res, new URL(req.url, `http://${req.headers.host}`));
    if (req.method === 'GET') observeHeld(!res.writableEnded);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(async () => {
    readiness.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const document = readiness.decorate('<html><body>Frame</body></html>', { path: '/synthetic' });
  const route = /image\.src='([^']+)'/.exec(document)[1];
  // Local instrumentation is marked so the baseline compare skips it (no extra body child). The image has no src in the
  // markup: the browser cannot request it ahead of the parser.
  assert.match(
    document,
    /<img hidden alt="" aria-hidden="true" data-paqvilo-frame-ready><script data-paqvilo-frame-ready>/,
  );
  assert.match(route, /^\/__sim\/frame-ready\/[\da-f-]+$/);
  // A loaded host delivers the document's scripts, and so the image request, long after decoration.
  t.mock.timers.tick(3 * timeoutMs);
  assert.deepEqual(diagnostics, [], 'a document not yet requested keeps its blocker');
  const responding = fetch(`http://127.0.0.1:${server.address().port}${route}`);
  assert.equal(await held, true, 'the late image request is held, not answered at once');
  t.mock.timers.tick(timeoutMs - 1);
  assert.deepEqual(diagnostics, [], 'the image stays held until the deadline');
  t.mock.timers.tick(1);
  assert.deepEqual(
    diagnostics.map(({ code, path }) => ({ code, path })),
    [{ code: 'FRAME_READY_TIMEOUT', path: '/synthetic' }],
  );
  const response = await responding;
  assert.equal(response.headers.get('content-type'), 'image/gif');
  assert.ok((await response.arrayBuffer()).byteLength > 0, 'the held image is released with its GIF body');
  // The expired entry is forgotten: a late request for it is answered at once and adds no diagnostic.
  const late = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
  assert.equal(late.status, 204);
  assert.equal(diagnostics.length, 1);
});

/** Runs the marker script against a fake document; returns the listeners it registered and the releases it sent. */
function runMarker(html, document) {
  const script = /<script data-paqvilo-frame-ready>([\s\S]*?)<\/script>/.exec(html)[1];
  const listeners = {},
    released = [];
  const fetch = (url) => {
    released.push(url);
    return Promise.resolve({ arrayBuffer: () => Promise.resolve() });
  };
  const window = {
    addEventListener: (type, listener) => {
      listeners['window:' + type] = listener;
    },
  };
  document.addEventListener = (type, listener) => {
    listeners[type] = listener;
  };
  let error = null;
  try {
    new Function('window', 'document', 'fetch', script)(window, document, fetch);
  } catch (thrown) {
    // In a browser the failure reaches the page's error handler; the listeners registered before it stay.
    error = thrown;
  }
  return { listeners, released, error };
}

test('the marker image and script leave the document once the frame has loaded', () => {
  const html = createFrameReadiness().decorate('<html><body><p>Frame</p></body></html>');
  const removed = [];
  const nodes = [{ remove: () => removed.push('img') }, { remove: () => removed.push('script') }];
  const { listeners, error } = runMarker(html, {
    querySelector: () => ({}),
    querySelectorAll: (selector) => (selector === '[data-paqvilo-frame-ready]' ? nodes : []),
  });
  assert.equal(error, null);
  assert.deepEqual(removed, []);
  listeners['window:load']();
  assert.deepEqual(removed, ['img', 'script']);
});

test('the marker script requests the image as the parser reaches it and releases it at DOMContentLoaded', () => {
  // A browser fetches an image in the markup ahead of the parser, while the document's own scripts can still be
  // arriving on a loaded host; the blocker's deadline starts at that request. The script assigns the source when it
  // runs, after every parser-blocking script before it, and finds the image by its marker: the parser moves it out of
  // an unclosed table (foster parenting), so it need not be the script's previous sibling.
  const html = createFrameReadiness().decorate('<html><body><table><tr></body></html>');
  assert.doesNotMatch(html, /<img[^>]*\ssrc=/);
  const image = {};
  const { listeners, released } = runMarker(html, {
    querySelector: (selector) => (selector === 'img[data-paqvilo-frame-ready]' ? image : null),
  });
  assert.match(image.src, /^\/__sim\/frame-ready\/[\da-f-]+$/);
  assert.deepEqual(released, [], 'the release waits for DOMContentLoaded');
  listeners.DOMContentLoaded();
  assert.deepEqual(released, [image.src + '?reason=dom-ready']);
});

test('the marker script sends its release when the image cannot be found or assigned', () => {
  const html = createFrameReadiness().decorate('<html><body><p>Frame</p></body></html>');
  const route = /image\.src='([^']+)'/.exec(html)[1];
  const failure = new Error('invented lookup failure');
  for (const [querySelector, expectedError] of [
    [() => null, null],
    [
      () => {
        throw failure;
      },
      failure,
    ],
  ]) {
    const { listeners, released, error } = runMarker(html, { querySelector });
    assert.equal(error, expectedError);
    listeners.DOMContentLoaded();
    assert.deepEqual(released, [route + '?reason=dom-ready']);
  }
});

// @test-kind contract: Mirage's own frame load blocker reports a document whose page never asked for the image; no native behaviour is claimed.
test('a document whose page never requests the image ends after its lifetime with a diagnostic; close and eviction stay quiet for it', async (t) => {
  // A site policy without 'unsafe-inline' stops the marker script: the load is not held, and that must be reported.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeoutMs = 100,
    diagnostics = [],
    readiness = createFrameReadiness({ timeoutMs, diagnostic: (item) => diagnostics.push(item) });
  readiness.decorate('<html><body>Frame</body></html>', { path: '/blocked-script' });
  t.mock.timers.tick(12 * timeoutMs - 1);
  assert.deepEqual(diagnostics, []);
  t.mock.timers.tick(1);
  assert.deepEqual(
    diagnostics.map(({ code, path, ordering }) => ({ code, path, ordering })),
    [{ code: 'FRAME_READY_TIMEOUT', path: '/blocked-script', ordering: 'never-requested' }],
  );
  // Closing the runtime, or evicting at the limit, forgets a never-requested entry without a diagnostic.
  readiness.decorate('<html><body>Frame</body></html>', { path: '/unloaded' });
  readiness.close();
  assert.equal(diagnostics.length, 1);
});

test('the entry limit evicts the oldest document: a held image is released with a timeout, a never-requested one quietly', async (t) => {
  const diagnostics = [],
    readiness = createFrameReadiness({ limit: 1, diagnostic: (item) => diagnostics.push(item) });
  const server = http.createServer((req, res) =>
    readiness.handle(req, res, new URL(req.url, `http://${req.headers.host}`)),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(async () => {
    readiness.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const routeOf = (html) => /image\.src='([^']+)'/.exec(html)[1];
  const held = routeOf(readiness.decorate('<html><body>A</body></html>', { path: '/held' }));
  const answer = fetch(origin + held);
  // The server's own request listener (the blocker) runs first, so the image is held once this one runs.
  await new Promise((resolve) => server.once('request', resolve));
  const unrequested = routeOf(readiness.decorate('<html><body>B</body></html>', { path: '/unrequested' }));
  assert.equal((await answer).headers.get('content-type'), 'image/gif', 'the evicted held image is released');
  readiness.decorate('<html><body>C</body></html>', { path: '/newest' });
  assert.deepEqual(
    diagnostics.map(({ code, path }) => ({ code, path })),
    [{ code: 'FRAME_READY_TIMEOUT', path: '/held' }],
  );
  assert.equal((await fetch(origin + unrequested)).status, 204, 'the evicted entry is forgotten');
});

test('a HEAD answer gets no load blocker and keeps no entry', () => {
  const diagnostics = [];
  const readiness = createFrameReadiness({ diagnostic: (item) => diagnostics.push(item) });
  const html = '<html><body><p>Frame</p></body></html>';
  assert.equal(readiness.decorate(html, { path: '/modal', head: true }), html);
  readiness.close();
  assert.deepEqual(diagnostics, []);
});
