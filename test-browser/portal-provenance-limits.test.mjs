// @test-kind contract: how the page provenance transport reports a document over its binding limit or its descriptor bound is Paqvilo's designed diagnostics, exercised with invented documents on a loopback server
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { createInspectionProvenanceTransport } from '../lense/inspection-provenance-transport.mjs';
import { createPortalRenderer } from '../mirage/lib/liquid.mjs';
import { listenOwnedServer } from './helpers/owned-server.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
const scope = { documentId: 'invented-document', frameId: 'top', uiEpoch: 1, sourceRevision: 'invented-source' };

/** A rendered invented document served through Lense's interception with its applied-response descriptor. */
async function servedDocument(t, source) {
  const renderer = createPortalRenderer({
    sourceDir: null,
    website: {},
    templates: {
      Main: { id: 'main', name: 'Main', metadata: { id: 'main', kind: 'webtemplate', name: 'Main' }, source },
    },
    records: [],
    pages: [],
    snippets: {},
  });
  const rendered = await renderer.renderStringWithProvenance(source, {}, renderer.sourceIndex().templates.get('main'));
  const proof = { ...rendered.provenance, channel: 'lense-applied-response' };
  const origin = await listenOwnedServer(
    t,
    http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('')),
  );
  const context = await browser.newContext();
  let detach;
  ownedFixture(t).add(async () => {
    await detach?.();
    await context.close();
  });
  const page = await context.newPage();
  const transport = createInspectionProvenanceTransport(context, [{ origin }]);
  const losses = [];
  detach = await interceptOrigin(
    context,
    origin,
    (route) =>
      route.request().resourceType() === 'document'
        ? route.fulfill({ body: rendered.html, headers: { 'content-type': 'text/html' }, provenance: proof })
        : route.fallback(),
    { onAttach: (options) => transport.onAttach({ ...options, report: (error) => losses.push(error.message) }) },
  );
  await page.goto(origin + '/');
  // Waits until the registry answers for `selector` with `reason`, and returns that answer.
  const answer = async (selector, reason) => {
    await page.waitForFunction(
      ({ selector, slot, scope, reason }) =>
        window[slot]
          ?.query(document.querySelector(selector), { scope, anchorGeneration: 1 })
          .availability.some((item) => item.reason === reason),
      { selector, slot: transport.slot, scope, reason },
    );
    return page.evaluate(
      ({ selector, slot, scope }) =>
        window[slot].query(document.querySelector(selector), { scope, anchorGeneration: 1 }),
      { selector, slot: transport.slot, scope },
    );
  };
  const query = (selector) =>
    page.evaluate(
      ({ selector, slot, scope }) =>
        window[slot].query(document.querySelector(selector), { scope, anchorGeneration: 1 }),
      { selector, slot: transport.slot, scope },
    );
  return { proof, page, answer, query, losses };
}

test('a document with more elements than the binder binds carries its incompleteness to the elements left unbound', async (t) => {
  // The binder's own limit (MAX_BINDINGS, 20,000 in mirage/lib/render-provenance.mjs) is exceeded by the document.
  const fx = await servedDocument(
    t,
    '<!doctype html><html><body>' + '<i></i>'.repeat(20500) + '<b id="last">Last</b></body></html>',
  );
  assert.equal(fx.proof.complete, false);
  assert.ok(fx.proof.omitted > 0);
  const last = await fx.answer('#last', 'response-proof-incomplete');
  assert.equal(last.limits.truncated, true);
  assert.deepEqual(last.facts, []);
  const first = await fx.query('i');
  assert.equal(first.facts[0]?.kind, 'lense-applied-literal', JSON.stringify(first));
  assert.equal(first.limits.truncated, true, 'a proof that is incomplete says so for its bound elements as well');
});

test('a descriptor over the transport bound is reported, and its elements say the provenance was too large', async (t) => {
  // Every element carries a long id, which its binding repeats: the descriptor grows past 8 MiB.
  const id = (index) => 'invented-' + String(index).padStart(6, '0') + '-' + 'x'.repeat(3000);
  let body = '';
  for (let index = 0; index < 3000; index++) body += `<i id="${id(index)}"></i>`;
  const fx = await servedDocument(t, `<!doctype html><html><body>${body}<b>Unbound</b></body></html>`);
  assert.ok(Buffer.byteLength(JSON.stringify(fx.proof)) > 8 * 1024 * 1024);
  const bound = await fx.answer('i', 'response-proof-too-large');
  assert.equal(bound.limits.truncated, true);
  assert.deepEqual(bound.facts, []);
  assert.ok(
    fx.losses.some((message) => /larger than 8 MiB/.test(message)),
    JSON.stringify(fx.losses),
  );
});
