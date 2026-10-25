import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createPortalRenderer } from '../mirage/lib/liquid.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';
import { createInspectionProvenanceTransport } from '../lense/inspection-provenance-transport.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

async function fixture(t, source, { scriptFor } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-parser-boundary-'));
  const metadataFile = path.join(directory, 'Main.webtemplate.yml');
  await fs.writeFile(metadataFile, 'adx_webtemplateid: invented-main\nadx_name: Main');
  await fs.writeFile(path.join(directory, 'Main.webtemplate.source.html'), source);
  const renderer = createPortalRenderer({
    sourceDir: directory,
    website: {},
    records: [],
    pages: [],
    snippets: {},
    templates: {
      Main: {
        id: 'invented-main',
        name: 'Main',
        metadata: { id: 'invented-main', kind: 'webtemplate', name: 'Main', _file: metadataFile },
        source,
      },
    },
  });
  const response = await renderer.renderStringWithProvenance(
    source,
    {},
    renderer.sourceIndex().templates.get('invented-main'),
  );
  const proof = { ...response.provenance, channel: 'lense-applied-response' };
  const server = http.createServer((request, result) => {
    if (request.url === '/write.js' && scriptFor) {
      result.writeHead(200, { 'content-type': 'application/javascript' }).end(scriptFor(response));
      return;
    }
    result.writeHead(200, { 'content-type': 'text/html' }).end(response.html);
  });
  let context, detach;
  t.after(async () => {
    await detach?.();
    await context?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  context = await browser.newContext();
  context.setDefaultTimeout(7000);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const transport = createInspectionProvenanceTransport(context, [{ origin }]);
  detach = await interceptOrigin(
    context,
    origin,
    (route) =>
      route.request().resourceType() === 'document'
        ? route.fulfill({ body: response.html, headers: { 'content-type': 'text/html' }, provenance: proof })
        : route.fallback(),
    { onAttach: transport.onAttach },
  );
  await page.goto(origin);
  const scope = { documentId: 'invented-document', frameId: 'top', uiEpoch: 1, sourceRevision: proof.sourceRevision };
  const query = (kind) =>
    page.evaluate(
      ({ slot, scope }) => window[slot].query(document.getElementById('claimed'), { scope, anchorGeneration: 1 }),
      { slot: kind === 'portal' ? transport.slot : transport.domSlot, scope },
    );
  const domProof = async () => {
    await page.waitForFunction(
      ({ slot, scope }) =>
        window[slot]?.query(document.getElementById('claimed'), { scope, anchorGeneration: 1 }).facts.length > 0,
      { slot: transport.domSlot, scope },
    );
    return query('dom');
  };
  return { page, query, domProof, transport, source, scope, errors };
}

for (const [name, source, relationship, call] of [
  [
    'inert-template clone',
    '<!doctype html><html><body><template id="pattern"><button id="claimed">Literal source</button></template><script>window.scriptNode=document.getElementById("pattern").content.cloneNode(true).firstElementChild;document.body.append(scriptNode)</script></body></html>',
    'cloned-by',
    'cloneNode',
  ],
  [
    'predicted future literal marker',
    '<!doctype html><html><body><p>Earlier literal</p><script>const marker=document.currentScript.getAttribute("data-paqvilo-source"),cut=marker.lastIndexOf(":");window.scriptNode=document.createElement("button");scriptNode.id="claimed";scriptNode.setAttribute("data-paqvilo-source",marker.slice(0,cut+1)+(Number(marker.slice(cut+1))+1));document.body.append(scriptNode);document.write("<!--")</script><button id="claimed">Future literal</button></body></html>',
    'created-by',
    'createElement',
  ],
  [
    'DOMParser future-marker insertion',
    '<!doctype html><html><body><p>Earlier literal</p><script>const marker=document.currentScript.getAttribute("data-paqvilo-source"),cut=marker.lastIndexOf(":"),next=marker.slice(0,cut+1)+(Number(marker.slice(cut+1))+1);window.scriptNode=new DOMParser().parseFromString(`<button id="claimed" data-paqvilo-source="${next}">Created</button>`,"text/html").body.firstChild;document.body.append(scriptNode);document.write("<!--")</script><button id="claimed">Future literal</button></body></html>',
    'attached-by',
    'append',
  ],
])
  test('actual composite response never grants parser proof to ' + name, async (t) => {
    const fx = await fixture(t, source);
    const dom = await fx.domProof();
    assert.equal(await fx.page.evaluate(() => document.getElementById('claimed') === window.scriptNode), true);
    assert.equal(await fx.page.locator('#claimed').count(), 1, 'the future original never appeared');
    const portal = await fx.query('portal');
    assert.deepEqual(
      portal.facts,
      [],
      'a script-created or first-inserted node cannot borrow response-literal identity',
    );
    assert.deepEqual(portal.sourceRefs, []);
    assert.equal(dom.facts[0].proof, 'observed-dom-callsite');
    assert.equal(dom.facts[0].predicate, relationship);
    assert.equal(dom.sourceRefs[0].relationship, relationship);
    const scriptStart = source.indexOf('<script>');
    assert.equal(dom.sourceRefs[0].region.start, source.indexOf(call, scriptStart));
    assert.deepEqual(fx.errors, []);
  });

test('actual inert parser original keeps its literal identity when moved into the active document', async (t) => {
  const source =
    '<!doctype html><html><body><template id="pattern"><button id="claimed">Literal source</button></template><script>window.original=document.getElementById("pattern").content.firstElementChild;document.body.append(original)</script></body></html>';
  const fx = await fixture(t, source);
  await fx.domProof();
  await fx.page.waitForFunction(
    ({ slot, scope }) =>
      window[slot]
        ?.query(document.getElementById('claimed'), { scope, anchorGeneration: 1 })
        .facts.some((fact) => fact.kind === 'lense-applied-literal'),
    {
      slot: fx.transport.slot,
      scope: {
        documentId: 'invented-document',
        frameId: 'top',
        uiEpoch: 1,
        sourceRevision: (await fx.query('dom')).sourceRefs[0].sourceRevision,
      },
    },
  );
  const portal = await fx.query('portal');
  assert.equal(await fx.page.evaluate(() => document.getElementById('claimed') === window.original), true);
  assert.equal(portal.facts[0].kind, 'lense-applied-literal');
  assert.equal(portal.facts[0].region.start, source.indexOf('<button'));
  assert.deepEqual(fx.errors, []);
});

test('native document.write cannot grant literal proof even with the valid future raw HTML and marker', async (t) => {
  const source =
    '<!doctype html><html><body><p id="earlier">Earlier</p><script src="/write.js"></script><button id="claimed">Future literal</button></body></html>';
  let suppliedOriginal;
  const fx = await fixture(t, source, {
    scriptFor(response) {
      suppliedOriginal = response.html.match(/<button\b[^>]*\bid="claimed"[^>]*>Future literal<\/button>/)?.[0];
      assert.ok(suppliedOriginal?.includes('data-paqvilo-source='), 'the attacker receives an actual valid marker');
      return `document.write(${JSON.stringify(suppliedOriginal + '<!--')});window.scriptNode=document.getElementById('claimed')`;
    },
  });
  await fx.page.waitForFunction(
    ({ slot, scope }) =>
      window[slot]?.query(document.getElementById('earlier'), { scope, anchorGeneration: 1 }).facts.length === 1,
    { slot: fx.transport.slot, scope: fx.scope },
  );
  assert.equal(await fx.page.locator('#claimed').count(), 1, 'the later parser original is suppressed');
  assert.equal(await fx.page.locator('#claimed').evaluate((node) => node.outerHTML), suppliedOriginal);
  assert.equal(await fx.page.evaluate(() => document.getElementById('claimed') === window.scriptNode), true);
  assert.equal(
    await fx.page.evaluate(
      (slot) => window[slot].isScriptObserved(document.getElementById('claimed')),
      fx.transport.domSlot,
    ),
    true,
    'native write records the actual inserted node identity',
  );
  const portal = await fx.query('portal');
  assert.deepEqual(portal.facts, [], 'valid raw markup does not turn a script-written node into a parser original');
  assert.deepEqual(portal.sourceRefs, []);
  assert.deepEqual(fx.errors, []);
});

test('actual Mirage keeps response descriptors private from authored scripts that know a public proof ID', async (t) => {
  const fx = inspectionFixture();
  let app, context, detach;
  t.after(async () => {
    await detach?.();
    await context?.close();
    await app?.close();
    fx.cleanup();
  });
  await fs.writeFile(
    path.join(fx.portal, 'web-templates/Main.webtemplate.source.html'),
    '<!doctype html><html><body><p id="earlier">Earlier</p><script src="/attack.js"></script><button id="claimed">Future literal</button></body></html>',
  );
  await fs.writeFile(
    path.join(fx.portal, 'web-files/attack.js.webfile.yml'),
    'adx_webfileid: attack-js\nadx_name: attack.js\nadx_partialurl: attack.js\nadx_parentpageid: home\nfilename: attack.js',
  );
  await fs.writeFile(
    path.join(fx.portal, 'web-files/attack.js'),
    `const slot=Object.getOwnPropertyNames(window).find(key=>key.startsWith('__paqviloPortal_'));
const packet=window[slot].query(document.getElementById('earlier'),{scope:{},anchorGeneration:1});
window.attackStatus={earlyFacts:packet.facts.length};
if(packet.facts.length){const id=packet.facts[0].id.split(':')[0];const request=new XMLHttpRequest();
request.open('GET','/_sim/api/page-provenance?proof='+encodeURIComponent(id),false);request.send();
attackStatus.status=request.status;attackStatus.descriptorExposed=request.responseText.includes('bindings');}`,
  );
  app = await createSimulator({ sourceDir: fx.portal, watch: false, stateFile: path.join(fx.work, 'state.json') });
  const handlers = app.server.listeners('request');
  app.server.removeAllListeners('request');
  app.server.on('request', (request, response) => {
    const deliver = () => handlers.forEach((handler) => handler.call(app.server, request, response));
    // Keep the parser at a real exported script while CDP admits the earlier document proof.
    if (new URL(request.url, 'http://fixture.invalid').pathname === '/attack.js') setTimeout(deliver, 1200);
    else deliver();
  });
  context = await browser.newContext();
  context.setDefaultTimeout(7000);
  const page = await context.newPage();
  const transport = createInspectionProvenanceTransport(context, [{ origin: app.url, mirage: true }]);
  detach = await interceptOrigin(context, app.url, (route) => route.fallback(), { onAttach: transport.onAttach });
  await page.goto(app.url);
  assert.deepEqual(await page.evaluate(() => window.attackStatus), {
    earlyFacts: 1,
    status: 404,
    descriptorExposed: false,
  });
  await page.waitForFunction(
    (slot) =>
      window[slot]
        ?.query(document.getElementById('claimed'), { scope: {}, anchorGeneration: 1 })
        .facts.some((fact) => fact.kind === 'render-literal'),
    transport.slot,
  );
});
