import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeTemporaryDirectory, ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { interceptOrigin } from '../../lense/intercept.mjs';
import { createInspectionProvenanceTransport } from '../../lense/inspection-provenance-transport.mjs';
import { scriptResourceProof, scriptSourceBody } from '../../lense/script-source-evidence.mjs';
import { listenOwnedServer } from './owned-server.mjs';

export const inventedScope = {
  documentId: 'invented-document',
  frameId: 'invented-frame',
  uiEpoch: 1,
  sourceRevision: 'invented-revision',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Whether a sent DevTools command calls a verified method of the registry in `slot`: the transport sends the claim
 * secret (and, at disposal, the release key) only this way, as the single argument of that function.
 */
export const isRegistryCall = (method, params, slot) =>
  method === 'Runtime.callFunctionOn' &&
  params?.objectGroup === slot &&
  params.functionDeclaration === 'function(value){return this(value)}';

/** An invented local web file with the response body and acknowledged script proof Lense serves for it. */
export async function inventedScriptResource(directory, source, { sourceMaps = false } = {}) {
  const file = path.join(directory, 'widget.js');
  await fs.writeFile(file, source);
  const sourceRef = {
    id: 'web-file:invented-widget:$content',
    key: 'web-file:invented-widget:$content',
    componentKey: 'web-file:invented-widget',
    kind: 'web-file',
    ref: 'web-files/widget.js',
    sourceRevision: inventedScope.sourceRevision,
    contentRevision: hash(Buffer.from(source)),
    file,
  };
  const inspector = {
    sourceIndexFor: async () => ({
      sourceRevision: inventedScope.sourceRevision,
      sources: new Map([[sourceRef.id, sourceRef]]),
    }),
  };
  const body = scriptSourceBody(await fs.readFile(file), file, { sourceMaps });
  return { file, body, proof: await scriptResourceProof(inspector, file, body) };
}

/**
 * A loopback page whose `/widget.js` is the acknowledged invented `source` (`html` is the markup of every other path,
 * or a function of the path that returns it), inspected through the real interception
 * and provenance transport. `onSession(cdp, transport)` sees the attachment's DevTools session before the transport attaches.
 * `onError` receives the interception's diagnostics. The page, context, interception and server are owned by the test.
 */
export async function scriptProvenancePage(t, browser, { html, source, onSession, onError }) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-dom-page-'));
  const { body, proof } = await inventedScriptResource(directory, source);
  const context = await browser.newContext();
  let detach;
  // Registered before the server's own shutdown steps, so the page and its interception close first.
  ownedFixture(t).add(async () => {
    await detach?.();
    await context.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const page = await context.newPage();
  const origin = await listenOwnedServer(
    t,
    http.createServer((request, response) =>
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(typeof html === 'function' ? html(new URL(request.url, 'http://invented.invalid').pathname) : html),
    ),
  );
  const transport = createInspectionProvenanceTransport(context, [{ origin }]);
  detach = await interceptOrigin(
    context,
    origin,
    (route) =>
      new URL(route.request().url()).pathname === '/widget.js'
        ? route.fulfill({ body, headers: { 'content-type': 'application/javascript' }, provenance: proof })
        : route.fallback(),
    {
      onAttach: async (options) => {
        await onSession?.(options.cdp, transport);
        return transport.onAttach(options);
      },
      onError,
    },
  );
  const query = (id) =>
    page.evaluate(
      ({ id, slot, scope }) => window[slot].query(document.getElementById(id), { scope, anchorGeneration: 3 }),
      { id, slot: transport.domSlot, scope: inventedScope },
    );
  // Waits until the callsite of `id` has a verdict: a proof, or a reason it has none.
  const verdict = async (id) => {
    await page.waitForFunction(
      ({ id, slot, scope }) => {
        const packet = window[slot]?.query(document.getElementById(id), { scope, anchorGeneration: 3 });
        return (
          packet?.facts.length > 0 || packet?.availability.some((item) => item.reason !== 'creation-proof-pending')
        );
      },
      { id, slot: transport.domSlot, scope: inventedScope },
    );
    return query(id);
  };
  return { origin, context, page, transport, query, verdict };
}
