// @test-kind contract: per-insertion script-provenance limits and open-shadow-root observation are Paqvilo's designed registry behaviour, exercised with invented markup on a routed loopback address
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { installDomProvenance } from '../lense/dom-provenance.mjs';
import { installPortalProvenanceRegistry } from '../lense/portal-element-provider.mjs';
import { createPortalRenderer } from '../mirage/lib/liquid.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
const scope = { documentId: 'invented-document', frameId: 'top', uiEpoch: 1, sourceRevision: 'invented-source' };
const dom = {
  slot: '__inventedDomReader',
  secret: 'invented-dom-writer-secret',
  notifyKey: 'invented-notification-key',
  binding: '__inventedDomBinding',
};
const portal = { slot: '__inventedPortalReader', secret: 'invented-portal-writer-secret' };

/** Both registries on a rendered invented template; `script` runs in the document where the source puts it. */
async function registries(t, source, { transform = (proof) => proof } = {}) {
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
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
  const page = await context.newPage();
  await page.exposeBinding(dom.binding, () => {});
  await context.addInitScript({
    content: `(${installDomProvenance.toString()})(${JSON.stringify(dom)});(${installPortalProvenanceRegistry.toString()})(${JSON.stringify({ ...portal, domProvenanceSlot: dom.slot })});
//# sourceURL=paqvilo-tool://invented-registries`,
  });
  await context.route('http://127.0.0.1:34571/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: rendered.html }),
  );
  await page.goto('http://127.0.0.1:34571/');
  const writer = await page.evaluateHandle(({ slot, secret }) => window[slot].claim(secret), portal);
  await writer.evaluate((writer, proof) => writer.publish(proof), transform(rendered.provenance));
  // `select` is evaluated in the page and returns the node to query.
  const ask = (slot, select) =>
    page.evaluate(
      ({ slot, select, scope }) =>
        window[slot].query(new Function('return ' + select)(), { scope, anchorGeneration: 1 }),
      { slot, select, scope },
    );
  return {
    page,
    portal: (select) => ask(portal.slot, select),
    dom: (select) => ask(dom.slot, select),
    observed: (select) =>
      page.evaluate(({ slot, select }) => window[slot].isScriptObserved(new Function('return ' + select)()), {
        slot: dom.slot,
        select,
      }),
  };
}

const rows = (count) => {
  let html = '';
  for (let i = 0; i < count; i++) html += `<tr><td>a</td> <td>b</td> <td>c</td> <td>d</td> <td>e</td></tr>\n`;
  return html;
};

test('one insertion beyond its bound limits only what it left out; later parser and script nodes keep their evidence', async (t) => {
  // 500 rows of 6 elements: past the 2,000 elements one insertion records.
  const fx = await registries(
    t,
    '<!doctype html><html><body><table id="big"></table><table id="small"></table>' +
      `<script>document.getElementById('big').innerHTML=${JSON.stringify(rows(500))};` +
      `document.getElementById('small').innerHTML=${JSON.stringify(rows(100))};` +
      "window.later=document.createElement('section');document.body.append(later);</script>" +
      '<button id="after">Parser markup after the insertion</button></body></html>',
  );
  const after = await fx.portal("document.getElementById('after')");
  assert.equal(after.facts[0]?.kind, 'render-literal', JSON.stringify(after));
  assert.equal(after.limits.truncated, false);
  assert.equal(await fx.observed("document.getElementById('after')"), false, 'a later parser node is parser-made');
  assert.equal(await fx.observed('window.later'), true);
  const later = await fx.dom('window.later');
  assert.equal(later.availability[0].reason, 'creation-proof-pending');
  assert.equal(later.limits.truncated, false, 'a later script node is not reported as truncated');
  // A 100-row table with its text nodes is recorded whole: text nodes do not count against the bound.
  assert.equal(await fx.observed("document.querySelector('#small tr:last-child td:last-child')"), true);
  assert.equal((await fx.dom("document.querySelector('#small tr:last-child')")).limits.truncated, false);
  // The rows the big insertion left out were not recorded one by one, but the call that brought them was: they are
  // script-made, answered with that call's record (its callsite still pending here), and only they say so.
  const cut = "document.querySelector('#big tr:last-child td')";
  assert.equal(await fx.observed(cut), true);
  const row = await fx.dom(cut);
  assert.equal(row.availability[0].reason, 'creation-proof-pending');
  assert.equal(row.limits.truncated, true);
  assert.deepEqual(row.limits.reasons, ['dom-evidence-limit']);
  assert.equal(
    await fx.page.evaluate(
      (slot) => window[slot].isScriptCreated(document.querySelector('#big tr:last-child td')),
      dom.slot,
    ),
    true,
  );
  assert.equal(await fx.observed("document.querySelector('#big tr td')"), true, 'the first rows were recorded');
});

test('declarative and script-attached open shadow roots are observed; closed roots and script-written shadow markup are not proved', async (t) => {
  const fx = await registries(
    t,
    '<!doctype html><html><body>' +
      '<div id="open-host"><template shadowrootmode="open"><button id="inside">Open shadow</button></template></div>' +
      '<div id="closed-host"><template shadowrootmode="closed"><button id="hidden">Closed shadow</button></template></div>' +
      '<p id="moved">Parser paragraph</p><div id="script-host"></div><div id="forged-host"></div>' +
      '<script>const root=document.getElementById("script-host").attachShadow({mode:"open"});' +
      'const moved=document.getElementById("moved");root.appendChild(moved);' +
      // The registry removed the mark from the DOM: the script reads it from the response the portal served.
      'const x=new XMLHttpRequest();x.open("GET",location.href,false);x.send();' +
      'const tag=x.responseText.match(/<p [^>]*>/g).find((item)=>item.includes(`id="moved"`));' +
      'const marker=/data-paqvilo-source="([^"]+)"/.exec(tag)[1];' +
      'document.getElementById("forged-host").attachShadow({mode:"open"}).innerHTML=' +
      '`<b id="forged" data-paqvilo-source="${marker}">Forged</b>`;</script></body></html>',
  );
  const inside = await fx.portal("document.getElementById('open-host').shadowRoot.getElementById('inside')");
  // The registry reads the declarative content's marks: the content is the parser's, named at its own place. (The
  // answer never carries the mark itself.)
  assert.deepEqual(
    inside.facts.map((fact) => [fact.kind, fact.region?.start]),
    [['render-literal', '<!doctype html><html><body><div id="open-host"><template shadowrootmode="open">'.length]],
    'the declarative shadow content was read: ' + JSON.stringify(inside),
  );
  assert.equal(Object.hasOwn(inside.node, 'id'), false);
  const moved = await fx.portal("document.getElementById('script-host').shadowRoot.getElementById('moved')");
  assert.equal(moved.facts[0]?.kind, 'render-literal', 'a parser element moved into an open root keeps its identity');
  const forged = await fx.portal("document.getElementById('forged-host').shadowRoot.getElementById('forged')");
  assert.deepEqual(forged.facts, [], 'markup a script writes into a shadow root never gains literal identity');
  assert.equal(await fx.observed("document.getElementById('forged-host').shadowRoot.getElementById('forged')"), true);
  assert.equal(
    await fx.page.evaluate(() => document.getElementById('closed-host').shadowRoot),
    null,
    'the closed root stays a boundary',
  );
});

// @test-kind security: a script changing an element's identity attributes keeps neither its source binding nor its platform identity
test('a script changing id, name or type refuses the source binding, and a platform binding that names the changed attribute', async (t) => {
  const fx = await registries(
    t,
    '<!doctype html><html><body><button id="original" name="invented">Source</button><div id="grid">Platform</div></body></html>',
    {
      // The grid is bound as the portal's own element, named by its id (as a served-platform binding is).
      transform: (proof) => ({
        ...proof,
        bindings: proof.bindings.map((binding) =>
          binding.tag === 'div'
            ? { ...binding, mapping: 'platform', component: { kind: 'list', key: 'list:invented', name: 'Invented' } }
            : binding,
        ),
      }),
    },
  );
  assert.equal((await fx.portal("document.getElementById('original')")).facts[0]?.kind, 'render-literal');
  assert.equal((await fx.portal("document.getElementById('grid')")).facts[0]?.kind, 'render-platform');
  await fx.page.evaluate(() => {
    const button = document.getElementById('original');
    button.id = 'renamed-by-script';
    button.name = 'renamed';
    button.type = 'submit';
    document.getElementById('grid').id = 'renamed-grid';
  });
  // An element a script gave another identity is no longer proved the one the source wrote.
  const source = await fx.portal("document.getElementById('renamed-by-script')");
  assert.deepEqual(source.facts, [], JSON.stringify(source));
  assert.equal(source.availability[0].reason, 'response-proof-not-published');
  const platform = await fx.portal("document.getElementById('renamed-grid')");
  assert.deepEqual(platform.facts, []);
  assert.equal(platform.availability[0].reason, 'response-proof-not-published');
});
