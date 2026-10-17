import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFrameReadiness } from '../lib/frame-readiness.mjs';
import { observedConfig } from '../lib/project-config.mjs';

test('frame overrides require evidence and immediate mode omits the load blocker', () => {
  assert.throws(() => observedConfig({ modalLoadOrdering: 'immediate' }), /evidence/);
  assert.throws(() => observedConfig({ modalLoadOrdering: 'later', evidence: 'synthetic' }), /ready or immediate/);
  const observed = observedConfig({ modalLoadOrdering: 'immediate', formSubmissionErrorMessage: 'Observed plain text', evidence: 'invented reference' });
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

test('a missing ready release fails open at a bounded timeout and cleans owned requests', async t => {
  const diagnostics = [], readiness = createFrameReadiness({ timeoutMs: 30, diagnostic: item => diagnostics.push(item) });
  const server = http.createServer((req, res) => readiness.handle(req, res, new URL(req.url, `http://${req.headers.host}`)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { readiness.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const document = readiness.decorate('<html><body>Frame</body></html>', { path: '/synthetic' });
  const route = /src="([^"]+)"/.exec(document)[1];
  // Local instrumentation is marked so the baseline compare skips it (no extra body child).
  assert.match(document, /<img hidden alt="" aria-hidden="true" data-paqvilo-frame-ready src="\/__sim\/frame-ready\/[^"]+"><script data-paqvilo-frame-ready>/);
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
  await response.arrayBuffer();
  assert.equal(diagnostics[0].code, 'FRAME_READY_TIMEOUT');
  assert.equal(diagnostics[0].path, '/synthetic');
});

test('the marker image and script leave the document once the frame has loaded', () => {
  const html = createFrameReadiness().decorate('<html><body><p>Frame</p></body></html>');
  const script = /<script data-paqvilo-frame-ready>([\s\S]*?)<\/script>/.exec(html)[1];
  const listeners = {}, removed = [];
  const nodes = [{ remove: () => removed.push('img') }, { remove: () => removed.push('script') }];
  const document = { addEventListener() {}, querySelectorAll: (selector) => (selector === '[data-paqvilo-frame-ready]' ? nodes : []) };
  const window = { addEventListener: (type, listener) => { listeners[type] = listener; } };
  new Function('window', 'document', script)(window, document);
  assert.deepEqual(removed, []);
  listeners.load();
  assert.deepEqual(removed, ['img', 'script']);
});
