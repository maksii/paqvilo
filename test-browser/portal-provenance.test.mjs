import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { installPortalProvenanceRegistry } from '../lense/portal-element-provider.mjs';
import { createPortalRenderer } from '../mirage/lib/liquid.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPortalProvenanceTransport } from '../lense/portal-provenance-transport.mjs';
import { resolveInspectionEvidence } from '../lense/inspection-evidence.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true, args: ['--disable-background-networking'] }));
});
after(() => browser?.close());
const scope = { documentId: 'document', frameId: 'frame', uiEpoch: 1, sourceRevision: 'current' };
async function pageFixture(t, script = '', { csp = false, source: authoredSource = null, templates = {} } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const slot = '__inventedPortalProvenance',
    secret = 'backend-only-invented-nonce';
  await context.addInitScript(installPortalProvenanceRegistry, { slot, secret });
  const source =
    authoredSource ??
    '<!doctype html><html><body><div id="box"><button id="original">Invented</button></div></body></html>';
  const metadata = { id: 'main', kind: 'webtemplate', name: 'Main' };
  const renderer = createPortalRenderer({
    sourceDir: null,
    website: {},
    templates: { Main: { id: 'main', name: 'Main', metadata, source }, ...templates },
    records: [],
    pages: [],
    snippets: {},
  });
  const ref = renderer.sourceIndex().templates.get('main');
  const result = await renderer.renderStringWithProvenance(source, {}, ref);
  await context.route('http://127.0.0.1:34567/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: csp ? { 'content-security-policy': "script-src 'none'" } : {},
      body: result.html.replace('</body>', `<script>${script}</script></body>`),
    }),
  );
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:34567/');
  const writer = await page.evaluateHandle(({ slot, secret }) => window[slot].claim(secret), { slot, secret });
  await writer.evaluate((writer, proof) => writer.publish(proof), result.provenance);
  const query = (id = 'original') =>
    writer.evaluate(
      (writer, { id, scope }) => writer.query(document.getElementById(id), { scope, anchorGeneration: 7 }),
      { id, scope },
    );
  return { page, writer, query, proof: result.provenance };
}

test('early private registry admits actual parser originals and echoes caller lifecycle scope', async (t) => {
  const fixture = await pageFixture(t, '', { csp: true });
  const result = await fixture.query();
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].kind, 'render-literal');
  assert.deepEqual(result.scope, scope);
  assert.equal(result.anchorGeneration, 7);
  assert.equal(result.sourceRefs.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /Invented|innerHTML|textContent|backend-only/);
});

test('public query edits cannot change private literal or include-invocation source regions', async (t) => {
  const fixture = await pageFixture(t, '', {
    source: '<!doctype html><html><body>{% include "Partial" %}</body></html>',
    templates: {
      Partial: {
        id: 'partial',
        name: 'Partial',
        metadata: { id: 'partial', kind: 'webtemplate', name: 'Partial' },
        source: '<button id="original">Invented</button>',
      },
    },
  });
  const result = await fixture.page.evaluate(
    ({ scope }) => {
      const reader = window.__inventedPortalProvenance;
      const node = document.getElementById('original');
      const first = reader.query(node, { scope, anchorGeneration: 7 });
      const expected = structuredClone(first);
      for (const fact of first.facts)
        if (fact.region) {
          fact.region.start = 999999;
          fact.region.end = 1000000;
        }
      for (const ref of first.sourceRefs) if (ref.region) ref.region.start = 999999;
      return { expected, actual: reader.query(node, { scope, anchorGeneration: 7 }) };
    },
    { scope },
  );
  assert.ok(result.expected.facts.some((fact) => fact.kind === 'render-literal' && fact.region));
  assert.ok(result.expected.facts.some((fact) => fact.kind === 'render-invocation' && fact.region));
  assert.deepEqual(
    result.actual,
    result.expected,
    'query consumers receive detached regions for both selected and enclosing source evidence',
  );
});

test('clone and original removal before DOMContentLoaded cannot transfer source identity', async (t) => {
  const fixture = await pageFixture(
    t,
    `const original=document.getElementById('original');const clone=original.cloneNode(true);original.replaceWith(clone);`,
  );
  const result = await fixture.query();
  assert.equal(result.facts.length, 0);
  assert.ok(result.availability.some((item) => item.reason === 'node-identity-revoked'));
});

test('early template content moves preserve actual originals while cloned inert contents never gain ownership', async (t) => {
  const source =
    '<!doctype html><html><body><template id="deferred"><button id="original">Later</button></template></body></html>';
  const moved = await pageFixture(t, "document.body.append(document.getElementById('deferred').content);", { source });
  assert.equal((await moved.query()).facts[0]?.kind, 'render-literal');
  const cloned = await pageFixture(
    t,
    "const template=document.getElementById('deferred');const clone=template.content.cloneNode(true);template.remove();document.body.append(clone);",
    { source },
  );
  assert.equal((await cloned.query()).facts.length, 0);
  const restored = await moved.writer.evaluate((writer) => {
    const before = Object.getOwnPropertyDescriptor(HTMLTemplateElement.prototype, 'content').get;
    writer.dispose();
    return Object.getOwnPropertyDescriptor(HTMLTemplateElement.prototype, 'content').get !== before;
  });
  assert.equal(restored, true, 'dispose restores the native getter when no later author override replaced it');
});

test('marker removal before MutationObserver callback cannot produce late false admission', async (t) => {
  const fixture = await pageFixture(
    t,
    `const original=document.getElementById('original');const clone=original.cloneNode(true);original.removeAttribute('data-paqvilo-source');original.replaceWith(clone);`,
  );
  assert.equal((await fixture.query()).facts.length, 0);
});

test('visual toggles and reparenting retain original creation source; identity repurposing invalidates it', async (t) => {
  const fixture = await pageFixture(t);
  await fixture.page.evaluate(() => {
    const button = document.getElementById('original');
    button.classList.add('active');
    button.style.display = 'inline';
    button.setAttribute('aria-expanded', 'true');
    document.body.append(button);
  });
  assert.equal((await fixture.query()).facts.length, 1);
  await fixture.page.evaluate(() => {
    document.getElementById('original').id = 'repurposed';
  });
  assert.equal((await fixture.query('repurposed')).facts.length, 0);
});

test('untrusted page markers and public reader cannot publish fabricated proof', async (t) => {
  const fixture = await pageFixture(t);
  await fixture.page.evaluate(() => {
    const forged = document.createElement('button');
    forged.id = 'forged';
    forged.setAttribute('data-paqvilo-source', 'untrusted');
    document.body.append(forged);
  });
  assert.equal((await fixture.query('forged')).facts.length, 0);
  assert.equal(await fixture.page.evaluate(() => typeof window.__inventedPortalProvenance.publish), 'undefined');
  assert.equal(await fixture.page.evaluate(() => window.__inventedPortalProvenance.claim('wrong')), null);
});

test('authored prototype overrides cannot replace the registry reader or fabricate publication', async (t) => {
  const fixture = await pageFixture(
    t,
    `Map.prototype.get=function(){return null};Map.prototype.set=function(){return this};Array.prototype.find=function(){return null};window.structuredClone=function(){return {forged:true}};Element.prototype.getAttribute=function(){return 'forged'};`,
  );
  const result = await fixture.query();
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].kind, 'render-literal');
  assert.equal(result.sourceRefs[0].recordId, 'main');
});

test('a detached original is unavailable and reattachment preserves its unchanged creation source', async (t) => {
  const fixture = await pageFixture(t);
  const node = await fixture.page.locator('#original').elementHandle();
  await node.evaluate((node) => node.remove());
  const detached = await fixture.writer.evaluate((writer, { node, scope }) => writer.query(node, { scope }), {
    node,
    scope,
  });
  assert.equal(detached.facts.length, 0);
  await node.evaluate((node) => document.body.append(node));
  assert.equal((await fixture.query()).facts.length, 1);
});

test('native browser navigation to a bare template receives trace proof while fetch callers retain unmarked bytes', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.writeFileSync(
    path.join(fx.portal, 'web-templates/Partial.webtemplate.source.html'),
    '<article><button id="actual">Local</button></article>',
  );
  const app = await createSimulator({
    sourceDir: fx.portal,
    stateFile: path.join(fx.work, 'state.json'),
    watch: false,
  });
  t.after(() => app.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const slot = '__actualPortalProof',
    secret = 'actual-backend-nonce';
  await context.addInitScript(installPortalProvenanceRegistry, { slot, secret });
  const page = await context.newPage();
  const response = await page.goto(app.url);
  const proofId = await response.headerValue('x-paqvilo-provenance');
  assert.ok(proofId);
  const descriptor = await context.request.get(
    app.url + '/_sim/api/page-provenance?proof=' + encodeURIComponent(proofId),
    { headers: { 'x-paqvilo-provenance-access': await response.headerValue('x-paqvilo-provenance-access') } },
  );
  assert.equal(descriptor.status(), 200);
  const proof = await descriptor.json();
  const denied = await context.request.get(app.url + '/_sim/api/page-provenance?proof=' + encodeURIComponent(proofId));
  assert.equal(denied.status(), 404, 'public proof IDs cannot reveal future node capabilities');
  const mismatched = await context.request.get(
    app.url + '/_sim/api/page-provenance?proof=' + encodeURIComponent(proofId),
    { headers: { 'x-paqvilo-provenance-access': 'incorrect' } },
  );
  assert.equal(mismatched.status(), 404);
  assert.equal(JSON.stringify(proof).includes(await response.headerValue('x-paqvilo-provenance-access')), false);
  assert.equal(proof.channel, 'mirage-render');
  assert.doesNotMatch(JSON.stringify(proof), /Local<|<article>|sourceDir|sourceFile|"file"/);
  const writer = await page.evaluateHandle(({ slot, secret }) => window[slot].claim(secret), { slot, secret });
  await writer.evaluate((writer, proof) => writer.publish(proof), proof);
  const query = await writer.evaluate(
    (writer, scope) => writer.query(document.getElementById('actual'), { scope }),
    scope,
  );
  assert.ok(query.facts.some((fact) => fact.kind === 'render-literal'));
  assert.ok(query.sourceRefs.some((ref) => ref.recordId === 'partial'));
  const fetched = await context.request.get(app.url);
  assert.equal(fetched.headers()['x-paqvilo-provenance'], undefined);
  assert.doesNotMatch(await fetched.text(), /data-paqvilo-source/);
});

test('inline script proof hashes match actual CDP source after HTML newline and Unicode decoding', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const source =
    '<html><head><meta charset="utf-8"></head><body><script>const label="Ž🙂";\r\nwindow.provenanceUnicode=true;</script></body></html>';
  const metadata = { id: 'unicode', kind: 'webtemplate', name: 'Unicode' };
  const renderer = createPortalRenderer({
    sourceDir: null,
    website: {},
    templates: { Unicode: { id: 'unicode', name: 'Unicode', source, metadata } },
    records: [],
    pages: [],
    snippets: {},
  });
  const traced = await renderer.renderStringWithProvenance(source, {}, renderer.sourceIndex().templates.get('unicode'));
  await context.route('http://127.0.0.1:34568/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: traced.html }),
  );
  const page = await context.newPage(),
    cdp = await context.newCDPSession(page),
    scripts = [];
  cdp.on('Debugger.scriptParsed', (script) => {
    if (script.url === 'http://127.0.0.1:34568/') scripts.push(script);
  });
  await cdp.send('Debugger.enable');
  await page.goto('http://127.0.0.1:34568/');
  assert.equal(scripts.length, 1);
  const actual = await cdp.send('Debugger.getScriptSource', { scriptId: scripts[0].scriptId });
  assert.equal(
    traced.provenance.scriptProofs[0].generatedHash,
    createHash('sha256').update(actual.scriptSource).digest('hex'),
  );
  assert.equal(scripts[0].hash, createHash('sha256').update(actual.scriptSource, 'utf8').digest('hex'));
});

test('external script proofs match actual CDP decoding for BOM, Unicode and CRLF resources', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.writeFileSync(
    path.join(fx.portal, 'web-templates/Partial.webtemplate.source.html'),
    '<script src="/widget.js"></script><button id="asset-target">Local</button>',
  );
  fs.writeFileSync(
    path.join(fx.portal, 'web-files/widget.js'),
    '\uFEFFconst label="Ž🙂";\r\nwindow.resourceUnicode=true;',
  );
  const app = await createSimulator({
    sourceDir: fx.portal,
    stateFile: path.join(fx.work, 'state.json'),
    watch: false,
  });
  t.after(() => app.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(),
    cdp = await context.newCDPSession(page),
    scripts = [];
  cdp.on('Debugger.scriptParsed', (script) => {
    if (script.url.endsWith('/widget.js')) scripts.push(script);
  });
  await cdp.send('Debugger.enable');
  const loaded = page.waitForResponse((response) => response.url() === app.url + '/widget.js');
  await page.goto(app.url);
  const response = await loaded;
  const proofId = await response.headerValue('x-paqvilo-script-proof');
  assert.ok(proofId);
  const proof = await (
    await context.request.get(app.url + '/_sim/api/page-provenance?proof=' + encodeURIComponent(proofId), {
      headers: { 'x-paqvilo-provenance-access': await response.headerValue('x-paqvilo-provenance-access') },
    })
  ).json();
  assert.equal(proof.channel, 'mirage-resource');
  assert.equal(scripts.length, 1);
  const actual = await cdp.send('Debugger.getScriptSource', { scriptId: scripts[0].scriptId });
  assert.equal(proof.scriptProofs[0].generatedHash, createHash('sha256').update(actual.scriptSource).digest('hex'));
  assert.equal(proof.scriptProofs[0].generatedHash, scripts[0].hash);
});

test('actual PCF render hosts retain private semantic ownership through toolkit ID assignment while authored lookalikes cannot claim it', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const directory = path.join(fx.solution, 'Controls/x_Corpus.Card');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'ControlManifest.xml.data.xml'),
    '<CustomControl><Name>x_Corpus.Card</Name></CustomControl>',
  );
  fs.writeFileSync(
    path.join(directory, 'ControlManifest.xml'),
    '<manifest><control namespace="Corpus" constructor="Card" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound" required="true"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
  );
  fs.writeFileSync(
    path.join(directory, 'bundle.js'),
    'window.Corpus={Card:class{init(){}updateView(){}getOutputs(){return {}}destroy(){}}};',
  );
  fs.writeFileSync(
    path.join(fx.portal, 'web-templates/Partial.webtemplate.source.html'),
    '{% codecomponent name:"x_Corpus.Card" value:"invented" %}<div id="lookalike" data-pcf-schema="x_Corpus.Card"></div>',
  );
  const app = await createSimulator({
    sourceDir: fx.portal,
    solutionRoots: [fx.solution],
    stateFile: path.join(fx.work, 'state.json'),
    watch: false,
    sourceMaps: false,
  });
  t.after(() => app.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(),
    cdp = await context.newCDPSession(page);
  const transport = createPortalProvenanceTransport(context, [{ origin: app.url, mirage: true }]);
  const attached = await transport.onAttach({ cdp, configure: (method, params) => cdp.send(method, params) });
  t.after(() => attached.dispose());
  await cdp.send('Network.enable');
  const response = await page.goto(app.url);
  assert.equal(
    (await response.text()).includes('"sourceAssets"'),
    false,
    'private Node asset locators never enter the authored browser mount spec',
  );
  const proof = await (
    await context.request.get(
      app.url +
        '/_sim/api/page-provenance?proof=' +
        encodeURIComponent(await response.headerValue('x-paqvilo-provenance')),
      { headers: { 'x-paqvilo-provenance-access': await response.headerValue('x-paqvilo-provenance-access') } },
    )
  ).json();
  const currentScope = { ...scope, sourceRevision: proof.sourceRevision };
  assert.ok(
    proof.bindings.some((binding) => binding.mapping === 'platform'),
    'actual successful PCF render produces a private typed host binding',
  );
  await page.waitForFunction(
    ({ slot, scope }) =>
      window[slot]
        ?.query(document.querySelector('[data-mirage-component="codecomponent"][data-pcf-schema]'), { scope })
        ?.facts.some((fact) => fact.kind === 'render-platform'),
    { slot: transport.slot, scope: currentScope },
  );
  const read = () =>
    page.evaluate(
      ({ slot, scope }) => ({
        actual: window[slot].query(document.querySelector('[data-mirage-component="codecomponent"][data-pcf-schema]'), {
          scope,
        }),
        lookalike: window[slot].query(document.getElementById('lookalike'), { scope }),
      }),
      { slot: transport.slot, scope: currentScope },
    );
  let packets = await read();
  const actual = resolveInspectionEvidence({ ...packets.actual, mode: 'local' });
  assert.equal(actual.owner.status, 'exact');
  assert.equal(actual.owner.component.key, 'pcf:x_corpus.card');
  assert.equal(actual.source.status, 'exact');
  assert.ok(actual.source.refs.some((ref) => ref.relationship === 'definition'));
  assert.ok(actual.source.refs.some((ref) => ref.relationship?.startsWith('implementation:')));
  assert.equal(resolveInspectionEvidence({ ...packets.lookalike, mode: 'local' }).owner.status, 'unavailable');
  await page.evaluate(() => {
    const node = document.querySelector('[data-mirage-component="codecomponent"][data-pcf-schema]');
    node.setAttribute('data-pcf-schema', 'another-component');
    node.setAttribute('data-pcf-schema', 'x_Corpus.Card');
  });
  packets = await read();
  assert.equal(
    resolveInspectionEvidence({ ...packets.actual, mode: 'local' }).owner.status,
    'unavailable',
    'schema repurposing and restoration cannot retain the original component binding',
  );
});
