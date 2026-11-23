// @test-kind contract: which frame of a DOM callsite's stack Lense names as the creator, and how it admits parsed scripts by content hash, is Paqvilo's designed attribution rule, exercised with invented scripts on loopback servers
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { createInspectionProvenanceTransport } from '../lense/inspection-provenance-transport.mjs';
import { resolveInspectionEvidence } from '../lense/inspection-evidence.mjs';
import { scriptSourceBody, scriptResourceProofFromSourceRefs } from '../lense/script-source-evidence.mjs';
import { listenOwnedServer } from './helpers/owned-server.mjs';
import { inventedScope as scope } from './helpers/script-provenance-page.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** An invented export source as the portal source index holds it (text included). */
const exportSource = (name, text, { kind = 'webfile', field = '$content', revision = scope.sourceRevision } = {}) => ({
  id: 'invented:' + name,
  key: 'invented:' + name,
  kind,
  fieldPath: [field],
  ref: name,
  file: name,
  sourceRevision: revision,
  contentRevision: hash(text),
  text,
});

// A library whose DOM call sits four frames deep: with the instrumentation's own frames that is beyond V8's default
// stack limit of ten, so the caller is only reached when the whole stack is captured.
const library = `window.lib={append(parent,html){one(parent,html)}};
function one(parent,html){two(parent,html)}
function two(parent,html){three(parent,html)}
function three(parent,html){parent.insertAdjacentHTML('beforeend',html)}`;

/**
 * A loopback page. `scripts` maps a path to its source; a path in `acknowledged` is fulfilled with the proof Lense sends
 * for a web file it serves, every other one is served by the page server as the portal would. `sources(route)` is the
 * export the transport may admit parsed scripts against (registerScriptSources).
 */
async function attributionPage(t, { html, scripts = {}, acknowledged = [], sources = null, external = null }) {
  let externalOrigin = null;
  if (external)
    externalOrigin = await listenOwnedServer(
      t,
      http.createServer((_request, response) =>
        response.writeHead(200, { 'content-type': 'application/javascript' }).end(external),
      ),
    );
  const origin = await listenOwnedServer(
    t,
    http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://invented.invalid').pathname;
      if (Object.hasOwn(scripts, pathname))
        response.writeHead(200, { 'content-type': 'application/javascript' }).end(scripts[pathname]);
      else
        response
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(typeof html === 'function' ? html(pathname, externalOrigin) : html);
    }),
  );
  const context = await browser.newContext();
  let detach;
  ownedFixture(t).add(async () => {
    await detach?.();
    await context.close();
  });
  const page = await context.newPage();
  const transport = createInspectionProvenanceTransport(context, [{ origin }]);
  if (sources) transport.registerScriptSources(origin, async (route) => sources(route));
  const losses = [];
  detach = await interceptOrigin(
    context,
    origin,
    (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (!acknowledged.includes(pathname)) return route.fallback();
      const bytes = Buffer.from(scripts[pathname]);
      const body = scriptSourceBody(bytes, pathname.slice(1), { sourceMaps: false });
      const ref = exportSource('web-files' + pathname, scripts[pathname]);
      const { text: _text, file: _file, ...sourceRef } = ref;
      return route.fulfill({
        body,
        headers: { 'content-type': 'application/javascript' },
        provenance: scriptResourceProofFromSourceRefs([sourceRef], body, scope.sourceRevision),
      });
    },
    { onAttach: async (options) => transport.onAttach({ ...options, report: (error) => losses.push(error.message) }) },
  );
  const query = (selector) =>
    page.evaluate(
      ({ selector, slot, scope }) =>
        window[slot].query(document.querySelector(selector), { scope, anchorGeneration: 1 }),
      { selector, slot: transport.domSlot, scope },
    );
  // Waits until the callsite of `selector` has a verdict: facts, or a reason other than a pending proof.
  const verdict = async (selector) => {
    await page.waitForFunction(
      ({ selector, slot, scope }) => {
        const packet = window[slot]?.query(document.querySelector(selector), { scope, anchorGeneration: 1 });
        return (
          packet?.facts.length > 0 || packet?.availability.some((item) => item.reason !== 'creation-proof-pending')
        );
      },
      { selector, slot: transport.domSlot, scope },
    );
    return query(selector);
  };
  await page.goto(origin + '/');
  return { origin, externalOrigin, page, transport, query, verdict, losses };
}

const sourceFacts = (packet) => packet.facts.filter((fact) => fact.dimension === 'source');
const contextFacts = (packet) => packet.facts.filter((fact) => fact.dimension === 'context');

test("a DOM call inside a library the export does not hold names the developer's calling line as the creator", async (t) => {
  const widget = `lib.append(document.body,'<p id="built">Invented</p>');`;
  const fx = await attributionPage(t, {
    html: '<!doctype html><body><script src="/lib.js"></script><script src="/widget.js"></script></body>',
    scripts: { '/lib.js': library, '/widget.js': widget },
    acknowledged: ['/widget.js'],
  });
  const packet = await fx.verdict('#built');
  const [creator] = sourceFacts(packet);
  assert.ok(creator, JSON.stringify(packet));
  assert.equal(creator.proof, 'observed-dom-callsite');
  assert.equal(creator.predicate, 'created-by');
  assert.equal(creator.label, 'Created by this script');
  assert.equal(creator.region.start, widget.indexOf('lib.append') + 'lib.'.length);
  assert.equal(packet.sourceRefs[0].ref, 'web-files/widget.js');
  const [domCall] = contextFacts(packet);
  assert.deepEqual(
    { predicate: domCall.predicate, label: domCall.label, reason: domCall.reason },
    {
      predicate: 'dom-call',
      label: 'DOM call in a script not found in your sources',
      reason: 'script-callsite-unmapped',
    },
  );
  assert.equal(contextFacts(packet).length, 1, 'the library frames are one step of the chain');
  const evidence = resolveInspectionEvidence(packet);
  assert.equal(evidence.source.status, 'exact');
  assert.equal(evidence.source.refs[0].ref, 'web-files/widget.js');
});

test("a library the export holds is the creator and the developer's code its caller; it is admitted by content hash", async (t) => {
  const widget = `lib.append(document.body,'<p id="built">Invented</p>');`;
  const lib = exportSource('web-files/lib.js', library);
  const fx = await attributionPage(t, {
    html: '<!doctype html><body><script src="/lib.js"></script><script src="/widget.js"></script></body>',
    scripts: { '/lib.js': library, '/widget.js': widget },
    acknowledged: ['/widget.js'],
    // The portal serves lib.js itself (unedited): only its parsed hash ties it to the export.
    sources: () => ({ sourceRevision: scope.sourceRevision, sources: new Map([[lib.id, lib]]) }),
  });
  const packet = await fx.verdict('#built');
  const [creator] = sourceFacts(packet);
  assert.ok(creator, JSON.stringify(packet));
  assert.deepEqual(creator.sourceRefIds, [lib.id]);
  assert.equal(creator.region.start, library.indexOf('parent.insertAdjacentHTML') + 'parent.'.length);
  assert.equal(packet.sourceRefs[0].ref, 'web-files/lib.js');
  const callers = contextFacts(packet).filter((fact) => fact.predicate === 'called-from');
  const widgetCaller = callers.find((fact) => fact.sourceRefIds?.[0] !== lib.id);
  assert.ok(widgetCaller, JSON.stringify(packet.facts));
  assert.equal(widgetCaller.label, 'Called from this script');
  assert.equal(widgetCaller.region.start, widget.indexOf('lib.append') + 'lib.'.length);
  const widgetRef = packet.sourceRefs.find((ref) => ref.id === widgetCaller.sourceRefIds[0]);
  assert.equal(widgetRef.ref, 'web-files/widget.js');
  assert.equal(widgetRef.relationship, 'called-from');
  assert.equal(resolveInspectionEvidence(packet).source.status, 'exact');
});

test('an unedited script the portal serves is identified by its content hash; a hash two sources share proves nothing', async (t) => {
  const app = `window.made=document.createElement('section');made.id='made';document.body.append(made);`;
  const one = exportSource('web-files/app.js', app),
    other = exportSource('web-files/copy-of-app.js', app, { revision: 'invented-conflicting-revision' });
  const fx = await attributionPage(t, {
    html: '<!doctype html><body><script src="/app.js"></script></body>',
    scripts: { '/app.js': app },
    sources: (route) =>
      route === '/conflict'
        ? {
            sourceRevision: 'invented-conflicting-revision',
            sources: new Map([
              [one.id, { ...one, sourceRevision: 'invented-conflicting-revision' }],
              [other.id, other],
            ]),
          }
        : { sourceRevision: scope.sourceRevision, sources: new Map([[one.id, one]]) },
  });
  const packet = await fx.verdict('#made');
  assert.equal(sourceFacts(packet).length, 1, JSON.stringify(packet));
  assert.equal(sourceFacts(packet)[0].region.start, app.indexOf('createElement'));
  assert.equal(packet.sourceRefs[0].ref, 'web-files/app.js');
  assert.equal(resolveInspectionEvidence(packet).source.status, 'exact');
  await fx.page.goto(fx.origin + '/conflict');
  const conflict = await fx.verdict('#made');
  assert.deepEqual(conflict.facts, []);
  assert.equal(conflict.availability[0].reason, 'script-hash-conflict');
  assert.deepEqual(fx.losses, []);
});

test('inline scripts equal to custom JavaScript or to a template script body are admitted by hash with their own place', async (t) => {
  // The export keeps CRLF line ends; the HTML parser hands the script LF ones.
  const custom =
    "window.fromPage=function(){\r\n  const node=document.createElement('aside');node.id='page-made';\r\n  document.body.append(node);\r\n};fromPage();";
  const templateBody = "const t=document.createElement('nav');t.id='template-made';document.body.append(t);";
  const template = `<!doctype html><body>{{ page.title }}<script>${templateBody}</script>{% include 'x' %}</body>`;
  const page = exportSource('web-pages/home/Home.customjs.js', custom, { kind: 'webpage', field: 'customjavascript' });
  const layout = exportSource('web-templates/Layout.webtemplate.source.html', template, {
    kind: 'webtemplate',
    field: 'source',
  });
  const fx = await attributionPage(t, {
    html: `<!doctype html><body><script>${templateBody}</script><script>${custom}</script></body>`,
    sources: () => ({
      sourceRevision: scope.sourceRevision,
      sources: new Map([
        [page.id, page],
        [layout.id, layout],
      ]),
    }),
  });
  const fromPage = await fx.verdict('#page-made');
  const [pageCreator] = sourceFacts(fromPage);
  assert.ok(pageCreator, JSON.stringify(fromPage));
  assert.deepEqual(pageCreator.sourceRefIds, [page.id]);
  assert.equal(pageCreator.region.start, custom.indexOf('createElement'), 'an offset in the CRLF source text');
  const fromTemplate = await fx.verdict('#template-made');
  const [templateCreator] = sourceFacts(fromTemplate);
  assert.ok(templateCreator, JSON.stringify(fromTemplate));
  assert.deepEqual(templateCreator.sourceRefIds, [layout.id]);
  assert.equal(templateCreator.region.start, template.indexOf('createElement'));
});

test("rows the portal runtime builds name its bundle; the developer's code that calls the runtime stays the creator", async (t) => {
  const preform = `window.jq={append(parent,html){parent.insertAdjacentHTML('beforeend',html)}};`;
  const grid = `window.renderGrid=function(){jq.append(document.getElementById('grid'),'<tr id="row"><td>Invented</td></tr>')};renderGrid();`;
  const widget = `jq.append(document.body,'<p id="own">Invented</p>');`;
  const fx = await attributionPage(t, {
    html:
      '<!doctype html><body><table id="grid"></table>' +
      '<script src="/resource/powerappsportal/dist/preform.bundle-5e6f7a8b.js"></script>' +
      '<script src="/resource/powerappsportal/dist/entity-grid.bundle-1a2b3c4d.js"></script>' +
      '<script src="/widget.js"></script></body>',
    scripts: {
      '/resource/powerappsportal/dist/preform.bundle-5e6f7a8b.js': preform,
      '/resource/powerappsportal/dist/entity-grid.bundle-1a2b3c4d.js': grid,
      '/widget.js': widget,
    },
    acknowledged: ['/widget.js'],
  });
  const row = await fx.verdict('#row');
  assert.deepEqual(sourceFacts(row), []);
  const [creator, caller] = contextFacts(row);
  assert.deepEqual(
    { binding: creator.binding, label: creator.label, proof: creator.proof, predicate: creator.predicate },
    {
      binding: { kind: 'platform-asset', key: 'platform-asset:preform.bundle.js', name: 'preform.bundle.js' },
      label: "Created by the portal's own script",
      proof: 'observed-dom-callsite',
      predicate: 'created-by',
    },
  );
  assert.equal(caller.predicate, 'called-from');
  assert.equal(caller.label, "Called from the portal's own script");
  assert.equal(caller.binding.key, 'platform-asset:entity-grid.bundle.js');
  assert.deepEqual(row.availability, []);
  const own = await fx.verdict('#own');
  assert.equal(sourceFacts(own)[0].region.start, widget.indexOf('jq.append') + 'jq.'.length);
  const [domCall] = contextFacts(own);
  assert.equal(domCall.predicate, 'dom-call');
  assert.equal(domCall.label, "DOM call in the portal's own script");
  assert.equal(domCall.binding.key, 'platform-asset:preform.bundle.js');
});

test('an element a script of another site creates is named by that site only', async (t) => {
  const fx = await attributionPage(t, {
    html: (_path, external) =>
      `<!doctype html><body><script src="${external}/vendor.js?PRIVATE_QUERY_SENTINEL"></script></body>`,
    external: `const v=document.createElement('div');v.id='vendor-made';document.body.append(v);`,
  });
  const packet = await fx.verdict('#vendor-made');
  const [creator] = contextFacts(packet);
  assert.deepEqual(creator.binding, {
    kind: 'external-resource',
    key: 'external-resource:' + fx.externalOrigin,
    name: new URL(fx.externalOrigin).host,
  });
  assert.equal(creator.label, 'Created by a script from another site');
  assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_QUERY_SENTINEL|vendor\.js/);
});
