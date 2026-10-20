import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelDrivenOverlay, modelDrivenOrigin } from '../lense/model-driven.mjs';

const imported = text => ({ resources: [{ name: 'x_script.js', type: 'script', url: '/_apps/resources/script' }], assets: new Map([
  ['/_apps/resources/script', { name: 'x_script.js', data: Buffer.from(text), mime: 'text/javascript' }],
  ['/_apps/controls/c/bundle.js', { name: 'x_Invented.Control/bundle.js', data: Buffer.from('pcf'), mime: 'text/javascript' }],
]), diagnostics: [] });
const fake = (url, method = 'GET', resourceType = 'script', page) => {
  const result = { fallback: 0 };
  return { result, request: () => ({ url: () => url, method: () => method, resourceType: () => resourceType, frame: () => ({ page: () => page }) }), fallback: async () => { result.fallback++; }, fulfill: async value => { result.response = value; } };
};

test('Solution overlays admit exact declared resources and never intercept API mutations or another origin', async () => {
  const overlay = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('local'), mappings: [{ path: '/%7B123%7D/webresources/native.Control/bundle.js', resource: 'x_Invented.Control/bundle.js' }] });
  const script = fake('https://invented.invalid/webresources/x_script.js?credential=never-record'); await overlay.handle(script);
  assert.equal(script.result.response.body.toString(), 'local');
  const pcf = fake('https://invented.invalid/%7b123%7d/webresources/native.Control/bundle.js'); await overlay.handle(pcf);
  assert.equal(pcf.result.response.body.toString(), 'pcf');
  for (const route of [fake('https://other.invalid/WebResources/x_script.js'), fake('https://invented.invalid/WebResources/x_script.js', 'POST'), fake('https://invented.invalid/api/data/v9.2/x_items')]) {
    await overlay.handle(route); assert.equal(route.result.fallback, 1);
  }
  const report = overlay.report(); assert.equal(report.applied, 2); assert.equal(report.unbound.length, 0);
  assert.equal(JSON.stringify(report).includes('never-record'), false);
  assert.equal(JSON.stringify(report).includes('/api/data'), false);
});

test('overlay import publication is atomic and HEAD has no body', async () => {
  const overlay = createModelDrivenOverlay({ origin: 'http://127.0.0.1:3210', imported: imported('first') });
  assert.throws(() => overlay.replace(imported('broken'), [{ path: '/not-found.js', resource: 'undeclared.js' }]), /undeclared/);
  const first = fake('http://127.0.0.1:3210/WebResources/x_script.js'); await overlay.handle(first); assert.equal(first.result.response.body.toString(), 'first');
  overlay.replace(imported('second'));
  assert.equal(overlay.report().applied, 1); assert.equal(overlay.report().currentRevisionApplied, 0);
  assert.equal(overlay.report().resources[0].currentRevisionApplied, 0);
  const changed = fake('http://127.0.0.1:3210/WebResources/x_script.js'); await overlay.handle(changed); assert.equal(changed.result.response.body.toString(), 'second');
  const head = fake('http://127.0.0.1:3210/WebResources/x_script.js', 'HEAD'); await overlay.handle(head); assert.equal(head.result.response.body.length, 0);
  assert.equal(overlay.report().currentRevisionApplied, 2);
  assert.equal(overlay.report().revision, 2);
});

test('invalid origins, traversal and ambiguous resource maps fail before a browser opens', () => {
  for (const origin of ['https://user:password@invented.invalid', 'https://invented.invalid/main.aspx?appid=1', 'http://public.invalid', 'file:///app']) assert.throws(() => modelDrivenOrigin(origin));
  for (const path of ['//other.invalid/script.js', '/a/../b', '/%2e%2e/b', '/a?token=secret', '/a\\b', '/api/data/v9.2/items', '/api%2Fdata', '/oauth2/token', '/main.aspx', '/_apps/api/tables', '/_sim/']) assert.throws(() => createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('test'), mappings: [{ path, resource: 'x_script.js' }] }));
  assert.throws(() => createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('test'), mappings: [{ path: '/WebResources/x_script.js', resource: 'x_Invented.Control/bundle.js' }] }), /Multiple/);
});

test('a dedicated model-driven session leaves other user pages and navigation requests untouched', async () => {
  const owner = {}, user = {};
  const overlay = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('local'), ownsRequest: request => request.frame().page() === owner });
  for (const route of [fake('https://invented.invalid/WebResources/x_script.js', 'GET', 'script', user), fake('https://invented.invalid/WebResources/x_script.js', 'GET', 'document', owner)]) { await overlay.handle(route); assert.equal(route.result.fallback, 1); }
  const owned = fake('https://invented.invalid/WebResources/x_script.js', 'GET', 'script', owner); await overlay.handle(owned);
  assert.equal(owned.result.response.body.toString(), 'local'); assert.equal(overlay.report().applied, 1);
});
