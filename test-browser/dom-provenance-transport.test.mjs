import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { createInspectionProvenanceTransport } from '../lense/inspection-provenance-transport.mjs';
import { scriptResourceProof, scriptSourceBody } from '../lense/script-source-evidence.mjs';
import { createPortalRenderer } from '../mirage/lib/liquid.mjs';
import { resolveInspectionEvidence } from '../lense/inspection-evidence.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
const scope = {
  documentId: 'invented-document',
  frameId: 'invented-frame',
  uiEpoch: 1,
  sourceRevision: 'invented-revision',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t, { sourceMaps = false, acknowledge = true, inline = false, bulk = 0 } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-dom-response-'));
  const file = path.join(directory, 'widget.js');
  const source =
    '\ufeff// Invented unicode \ud83e\uddea\r\n' +
    'window.makeWidget=function(){const node=document.createElement("button");node.id="created";document.body.appendChild(node);};\r\n' +
    'makeWidget();\r\n' +
    'window.moveParser=function(){document.getElementById("moved").appendChild(document.getElementById("parser"));};\r\n' +
    'window.cloneWidget=function(){const node=document.getElementById("created").cloneNode(true);node.id="clone";document.body.append(node);};\r\n' +
    'window.htmlWidget=function(){document.getElementById("markup").innerHTML="<strong id=html-created>Invented</strong>";};\r\n' +
    (bulk ? `for(let i=0;i<${bulk};i++)makeWidget();\r\n` : '');
  await fs.writeFile(file, source);
  const sourceRef = {
    id: 'web-file:invented-widget:$content',
    key: 'web-file:invented-widget:$content',
    componentKey: 'web-file:invented-widget',
    kind: 'web-file',
    ref: 'web-files/widget.js',
    sourceRevision: scope.sourceRevision,
    contentRevision: hash(Buffer.from(source)),
    file,
  };
  const inspector = {
    sourceIndexFor: async () => ({
      sourceRevision: scope.sourceRevision,
      sources: new Map([[sourceRef.id, sourceRef]]),
    }),
  };
  const body = scriptSourceBody(await fs.readFile(file), file, { sourceMaps });
  const proof = await scriptResourceProof(inspector, file, body);
  let html =
    '<!doctype html><html><body><b id="parser">Invented parser markup</b><aside id="moved"></aside><div id="markup"></div>' +
    (inline
      ? `<script>${source.replace(/^\ufeff/, '')}</script>`
      : '<script src="/widget.js?technical=PRIVATE_QUERY_SENTINEL"></script>') +
    '</body></html>';
  let documentProof;
  const authoredHTML = html;
  if (inline) {
    const metadataFile = path.join(directory, 'Main.webtemplate.yml');
    await fs.writeFile(metadataFile, 'adx_webtemplateid: invented-main\nadx_name: Main');
    await fs.writeFile(path.join(directory, 'Main.webtemplate.source.html'), html);
    const renderer = createPortalRenderer({
      sourceDir: directory,
      website: {},
      templates: {
        Main: {
          id: 'invented-main',
          name: 'Main',
          metadata: { id: 'invented-main', kind: 'webtemplate', name: 'Main', _file: metadataFile },
          source: html,
        },
      },
      records: [],
      pages: [],
      snippets: {},
    });
    const generated = await renderer.renderStringWithProvenance(
      html,
      {},
      renderer.sourceIndex().templates.get('invented-main'),
    );
    html = generated.html;
    documentProof = { ...generated.provenance, channel: 'lense-applied-response' };
  }
  const server = http.createServer((_request, response) =>
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  context.setDefaultTimeout(6000);
  const page = await context.newPage();
  const transport = createInspectionProvenanceTransport(context, [{ origin }]);
  const diagnostics = {
    scripts: [],
    calls: [],
    requests: [],
    contexts: [],
    acks: [],
    proofs: documentProof?.scriptProofs,
    resourceProofs: proof?.scriptProofs,
    sourceLength: source.length,
    rawHash: hash(source),
  };
  let bindingEvent, attachmentCDP;
  const detach = await interceptOrigin(
    context,
    origin,
    async (route) => {
      if (new URL(route.request().url()).pathname === '/widget.js')
        return route.fulfill({
          body,
          headers: { 'content-type': 'application/javascript' },
          ...(acknowledge ? { provenance: proof } : {}),
        });
      if (documentProof && route.request().resourceType() === 'document')
        return route.fulfill({
          body: html,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          provenance: documentProof,
        });
      return route.fallback();
    },
    {
      onAttach: async (options) => {
        attachmentCDP = options.cdp;
        options.cdp.on('Network.requestWillBeSent', (event) => {
          if (event.type === 'Script')
            diagnostics.requests.push({
              id: event.requestId,
              frameId: event.frameId,
              loaderId: event.loaderId,
              type: event.type,
              urlKey: hash(event.request.url),
            });
        });
        options.cdp.on('Runtime.executionContextCreated', ({ context }) => {
          if (context.auxData?.isDefault)
            diagnostics.contexts.push({ id: context.id, frameId: context.auxData.frameId });
        });
        options.cdp.on('Debugger.scriptParsed', (event) => {
          if (event.url.startsWith(origin) || event.url.startsWith('file:')) {
            const info = {
              url: event.url.split('?')[0],
              hash: event.hash,
              startLine: event.startLine,
              startColumn: event.startColumn,
              endLine: event.endLine,
              hasSourceURL: event.hasSourceURL,
              contextId: event.executionContextId,
              urlKey: hash(event.url),
            };
            diagnostics.scripts.push(info);
            options.cdp
              .send('Debugger.getScriptSource', { scriptId: event.scriptId })
              .then(({ scriptSource }) =>
                Object.assign(info, {
                  actualHash: hash(scriptSource),
                  lfHash: hash(scriptSource.replace(/\r\n/g, '\n')),
                  crlf: scriptSource.includes('\r\n'),
                  length: scriptSource.length,
                }),
              )
              .catch(() => {});
          }
        });
        options.cdp.on('Runtime.bindingCalled', (event) => {
          try {
            const data = JSON.parse(event.payload);
            if (data?.version === 1 && data.frames) bindingEvent = event;
            if (data.frames) diagnostics.calls.push({ relationship: data.relationship, frames: data.frames });
          } catch {
            /* Other bindings are unrelated to DOM evidence. */
          }
        });
        const attachment = await transport.onAttach(options);
        return {
          ...attachment,
          publishProvenance: async (event, proof) => {
            const count = diagnostics.requests.length;
            const result = await attachment.publishProvenance(event, proof);
            diagnostics.acks.push({
              networkId: event.networkId,
              frameId: event.frameId,
              channel: proof.channel,
              result,
              requestsBeforeAck: count,
            });
            return result;
          },
        };
      },
    },
  );
  t.after(async () => {
    await detach();
    await context.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await page.goto(origin);
  const query = (id, target = page) =>
    target.evaluate(
      ({ id, slot, scope }) => window[slot]?.query(document.getElementById(id), { scope, anchorGeneration: 3 }) ?? null,
      { id, slot: transport.domSlot, scope },
    );
  const proved = async (id, target = page) => {
    try {
      await target.waitForFunction(
        ({ id, slot, scope }) =>
          window[slot]?.query(document.getElementById(id), { scope, anchorGeneration: 3 }).facts.length > 0,
        { id, slot: transport.domSlot, scope },
      );
    } catch (error) {
      throw new Error(JSON.stringify({ packet: await query(id, target), diagnostics }), { cause: error });
    }
    return query(id, target);
  };
  const malformedBinding = () => {
    for (const data of [null, 0, [], {}, 'invented', false])
      attachmentCDP.emit('Runtime.bindingCalled', { ...bindingEvent, payload: JSON.stringify(data) });
    const valid = JSON.parse(bindingEvent.payload);
    for (const frames of [[null], [0], [[]], [{ url: origin, line: 0, column: 1 }]])
      attachmentCDP.emit('Runtime.bindingCalled', { ...bindingEvent, payload: JSON.stringify({ ...valid, frames }) });
  };
  return { page, query, proved, proof, source, html, authoredHTML, transport, origin, detach, malformedBinding };
}

for (const sourceMaps of [false, true])
  test(`actual parsed ${sourceMaps ? 'mapped' : 'original-byte'} response proves creation, clone and HTML callsites without claiming parser ownership`, async (t) => {
    const fx = await fixture(t, { sourceMaps });
    const created = await fx.proved('created');
    const expected = fx.source.indexOf('createElement');
    assert.equal(created.sourceRefs[0].ref, 'web-files/widget.js');
    assert.equal(created.sourceRefs[0].region.start, expected);
    assert.equal(created.sourceRefs[0].relationship, 'created-by');
    assert.equal(resolveInspectionEvidence(created).source.status, 'exact');
    assert.equal(resolveInspectionEvidence(created).owner.status, 'unavailable');
    await fx.page.evaluate(() => {
      window.moveParser();
      window.cloneWidget();
      window.htmlWidget();
    });
    const clone = await fx.proved('clone'),
      markup = await fx.proved('html-created'),
      parser = await fx.proved('parser');
    assert.equal(clone.sourceRefs[0].relationship, 'cloned-by');
    assert.equal(markup.sourceRefs[0].relationship, 'created-by');
    assert.equal(parser.sourceRefs[0].relationship, 'attached-by');
    assert.equal(
      await fx.page.evaluate(
        (slot) => window[slot].isScriptCreated(document.getElementById('parser')),
        fx.transport.domSlot,
      ),
      false,
    );
    const serialized = JSON.stringify([created, clone, markup, parser]);
    assert.doesNotMatch(serialized, /PRIVATE_QUERY_SENTINEL|Invented parser markup|paqvilo-dom-response-/);
    assert.equal((await fx.query('markup')).facts.length, 0);
  });

test('unacknowledged response bytes cannot become exact script evidence', async (t) => {
  const fx = await fixture(t, { acknowledge: false });
  await fx.page.waitForFunction(
    ({ slot, scope }) =>
      window[slot]
        ?.query(document.getElementById('created'), { scope, anchorGeneration: 3 })
        .availability.some((item) => item.reason === 'script-callsite-unmapped'),
    { slot: fx.transport.domSlot, scope },
  );
  const packet = await fx.query('created');
  assert.equal(packet.facts.length, 0);
  assert.equal(packet.sourceRefs.length, 0);
});

test('inline document script proof uses the actual parsed CRLF-normalized implementation', async (t) => {
  const fx = await fixture(t, { inline: true });
  const packet = await fx.proved('created');
  assert.equal(packet.sourceRefs[0].kind, 'webtemplate');
  assert.equal(packet.sourceRefs[0].region.start, fx.authoredHTML.indexOf('createElement'));
  assert.equal(packet.sourceRefs[0].relationship, 'created-by');
});

test('Xray presents a proven implementation independently of unknown ownership and disables it after source revision changes', async (t) => {
  const fx = await fixture(t);
  await fx.proved('created');
  const data = {
    origin: fx.origin,
    token: 'invented-dom-inspection',
    domProvenanceSlot: fx.transport.domSlot,
    sourceRevision: scope.sourceRevision,
    inspection: { active: true, version: 1 },
  };
  await fx.page.evaluate(xrayUi, data);
  await fx.page.evaluate(
    ({ data, proof }) => {
      const api = document.getElementById('paqvilo-xray').__px;
      api.update(data, { sourceRevision: proof.sourceRevision, sourceRefs: proof.sourceRefs });
      api.toggle(true);
      api.select(document.getElementById('created'));
    },
    { data, proof: fx.proof },
  );
  const selection = () => fx.page.evaluate(() => document.getElementById('paqvilo-xray').__px.selection());
  const identity = await selection();
  assert.equal(identity.evidence.source.status, 'exact');
  assert.equal(identity.evidence.owner.status, 'unavailable');
  const card = fx.page.locator('#paqvilo-xray');
  assert.equal(await card.getByRole('button', { name: 'Open source', exact: true }).isEnabled(), true);
  assert.match(await card.locator('.card').innerText(), /Observed script creation callsite/);
  const timings = await fx.page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px,
      node = document.getElementById('created'),
      times = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      api.identify(node, api.getSelectionScope(node));
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { p50: times[49], p95: times[94], max: times[99] };
  });
  t.diagnostic(
    `Observed-script selection, 100 warm queries: p50 ${timings.p50.toFixed(2)} ms; p95 ${timings.p95.toFixed(2)} ms; max ${timings.max.toFixed(2)} ms`,
  );
  await fx.page.evaluate(
    (data) =>
      document.getElementById('paqvilo-xray').__px.update({ ...data, sourceRevision: 'invented-next-revision' }),
    data,
  );
  assert.equal((await selection()).evidence.source.status, 'stale');
  assert.equal(await card.getByRole('button', { name: 'Open source', exact: true }).isDisabled(), true);
});

test('actual frame and popup script callsites remain document-local and detach removes future instrumentation', async (t) => {
  const fx = await fixture(t);
  await fx.proved('created');
  await fx.page.evaluate((origin) => {
    const iframe = document.createElement('iframe');
    iframe.src = origin + '/child';
    document.body.append(iframe);
  }, fx.origin);
  const child = await new Promise((resolve) => {
    const existing = fx.page.frames().find((frame) => frame.url() === fx.origin + '/child');
    if (existing) resolve(existing);
    else
      fx.page.on('framenavigated', (frame) => {
        if (frame.url() === fx.origin + '/child') resolve(frame);
      });
  });
  await fx.proved('created', child);
  const popupReady = fx.page.waitForEvent('popup');
  await fx.page.evaluate((origin) => window.open(origin + '/popup'), fx.origin);
  const popup = await popupReady;
  await popup.waitForLoadState();
  await fx.proved('created', popup);
  await fx.detach();
  await fx.page.goto(fx.origin + '/after-detach');
  assert.equal(await fx.query('created'), null);
});

test('page calls and malformed authenticated binding packets cannot crash the observer or manufacture evidence', async (t) => {
  const fx = await fixture(t);
  await fx.proved('created');
  await fx.page.evaluate(() => {
    const binding = Object.getOwnPropertyNames(window).find((name) => name.startsWith('__paqviloDomEvent_'));
    for (const value of ['null', '0', '[]', '{}', 'false', '"invented"']) window[binding](value);
  });
  fx.malformedBinding();
  await fx.page.evaluate(() => window.cloneWidget());
  assert.equal((await fx.proved('clone')).sourceRefs[0].relationship, 'cloned-by');
  assert.equal((await fx.query('created')).facts.length, 1);
});

test('a burst beyond the transport budget remains bounded and reports the omitted evidence', async (t) => {
  const fx = await fixture(t, { bulk: 3000 });
  await fx.page.waitForFunction(
    ({ slot, scope }) =>
      window[slot].query(document.getElementById('created'), { scope, anchorGeneration: 3 }).limits.truncated,
    { slot: fx.transport.domSlot, scope },
  );
  const packet = await fx.query('created');
  assert.ok(packet.limits.reasons.includes('dom-evidence-transport-limit'));
  assert.equal(await fx.page.locator('#created').count(), 3001, 'instrumentation preserves all native DOM operations');
});
