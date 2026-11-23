// What a page sees of the response's marks (data-paqvilo-source) and of the inline script proof ids, through a Lense
// overlay session on an invented loopback portal, compared with the same document served without Lense.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { listenOwnedServer } from './helpers/owned-server.mjs';
import { dynamicPortal, settled, answers, lineOf, LAYOUT } from './helpers/dynamic-dom-portal.mjs';

// The document shell the fake portal writes the template into (helpers/dynamic-dom-portal.mjs).
const shell = (template) =>
  '<!DOCTYPE html>\n<html lang="en-US"><head><title>Home</title></head><body>\n' + template + '\n</body></html>\n';

// Every record a page observer receives, as plain data: what changed, where (a path of tag, id and index from the
// document element), the old value, and the nodes added or removed. Lense's own panel (an element whose id starts
// with `paqvilo-`, added to the page after load) is not the page's and is left out of the comparison.
const RECORDER = `
window.__records = [];
const lense = (node) => {
  for (let n = node; n; n = n.parentNode) if (n.nodeType === 1 && /^paqvilo-/.test(n.id)) return true;
  return false;
};
const where = (node) => {
  if (!node) return null;
  if (node.nodeType !== 1) return node.nodeName + ' in ' + where(node.parentNode);
  let path = '';
  for (let n = node; n && n.nodeType === 1; n = n.parentNode) {
    const index = n.parentNode ? Array.prototype.indexOf.call(n.parentNode.children, n) : 0;
    path = n.localName + (n.id ? '#' + n.id : '') + ':' + index + '/' + path;
  }
  return path;
};
window.__record = (origin) => (records) => {
  for (const r of records) {
    if (lense(r.target) || [...r.addedNodes, ...r.removedNodes].some(lense)) continue;
    window.__records.push([origin, r.type, where(r.target), r.attributeName, r.oldValue,
      [...r.addedNodes].map((n) => n.nodeName), [...r.removedNodes].map((n) => n.nodeName)]);
  }
};
new MutationObserver(window.__record('page')).observe(document, { attributes: true, attributeOldValue: true, childList: true, characterData: true, subtree: true });
// An observer of a same-origin about:blank frame's realm, watching this document.
const frame = document.createElement('iframe');
frame.id = 'observer-frame';
document.body.append(frame);
new frame.contentWindow.MutationObserver(window.__record('frame')).observe(document, { attributes: true, attributeOldValue: true, subtree: true });
`;
const ROWS = 150;
const table =
  '<table id="grid"><tbody>' +
  Array.from({ length: ROWS }, (_, i) => `<tr id="r${i}" class="row"><td class="c">${i}</td><td>x</td></tr>`).join('') +
  '</tbody></table>';
// Changes the page makes while it loads and after: attributes of parser elements, rows it adds and removes.
const CHANGER = [
  "document.getElementById('r3').setAttribute('data-state', 'on');",
  "document.getElementById('r4').classList.add('seen');",
  "document.getElementById('r5').remove();",
  "document.getElementById('grid').tBodies[0].append(Object.assign(document.createElement('tr'), { id: 'added' }));",
  "window.__late = () => { document.getElementById('r7').title = 'late'; document.getElementById('r8').style.color = 'red'; };",
  '',
].join('\n');
const template = [
  '<script>' + RECORDER + '</script>',
  '<main id="content">',
  '  ' + table,
  '  <script src="/scripts/changer.js"></script>',
  '  <script>window.__inline = document.currentScript.getAttributeNames();</script>',
  '</main>',
].join('\n');

/** The page's records and what it read, without Lense: the same document from a bare loopback server. */
async function withoutLense(t) {
  const server = http.createServer((request, response) => {
    if (request.url === '/scripts/changer.js')
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end(CHANGER);
    if (request.url !== '/') return response.writeHead(404).end();
    return response.writeHead(200, { 'content-type': 'text/html' }).end(shell(template));
  });
  const origin = await listenOwnedServer(t, server);
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.evaluate(() => window.__late());
  return page.evaluate(() => ({ records: window.__records, inline: window.__inline }));
}

// @test-kind contract: a page mutation observer registered before the content is parsed (in this realm and in a same-origin about:blank frame) receives exactly the records it receives without Lense, while X-ray still names each element's place
test('page observers receive the same records with and without Lense while X-ray identifies the elements', async (t) => {
  const bare = await withoutLense(t);
  const fx = await dynamicPortal(t, { template, webFiles: { 'changer.js': CHANGER } });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  const got = await settled(fx, { r0: '#r0', r74: '#r74 > td', last: '#r' + (ROWS - 1), r3: '#r3' });
  await fx.page.evaluate(() => window.__late());
  const lense = await fx.page.evaluate(() => ({ records: window.__records, inline: window.__inline }));
  assert.ok(bare.records.length > ROWS * 3, 'the observer saw the rows parsed: ' + bare.records.length);
  assert.deepEqual(lense.records, bare.records);
  // The inline script's own attributes: Lense's script proof id is gone before it runs.
  assert.deepEqual(lense.inline, bare.inline);
  for (const [name, needle] of [
    ['r0', '<tr id="r0"'],
    ['r74', '<td class="c">74<'],
    ['last', `<tr id="r${ROWS - 1}"`],
    ['r3', '<tr id="r3"'],
  ])
    assert.deepEqual(
      [got[name].source?.file, got[name].source?.line, got[name].source?.how],
      [LAYOUT, lineOf(fx.text, needle), 'Found at this place in the served page'],
      name,
    );
  assert.equal(await fx.page.evaluate(() => document.documentElement.outerHTML.includes('data-paqvilo')), false);
  assert.deepEqual(fx.errors, []);
});

// @test-kind security: what page code can read of a mark while the parser inserts an element (a custom element's reaction) names nothing else and cannot be used to forge, take over or revoke an element's identity; the registries' answers never carry a mark, and the mark's removal never reaches a page hook
test('a mark read during parsing cannot forge, take over or revoke identity, and no answer carries a mark', async (t) => {
  const spy = [
    'window.__read = [];',
    'window.__removals = [];',
    // Page hooks on every removal a page can see: the registry's own removal never calls them.
    'for (const [proto, name] of [[Element.prototype, "removeAttribute"], [Element.prototype, "removeAttributeNode"], [Element.prototype, "toggleAttribute"], [NamedNodeMap.prototype, "removeNamedItem"]]) {',
    '  const native = proto[name];',
    '  proto[name] = function (...args) { __removals.push(name + " " + String(args[0]?.name ?? args[0])); return native.apply(this, args); };',
    '}',
    'customElements.define("x-spy", class extends HTMLElement {',
    '  connectedCallback() {',
    '    const mark = this.getAttribute("data-paqvilo-source");',
    '    __read.push(mark);',
    '    if (!mark) return;',
    // A copy made in another realm and inserted with that realm's native (a path the recorder does not follow), a copy
    // made here, and the mark written onto an element the parser made earlier.
    '    const frame = document.getElementById("realm");',
    '    const foreign = frame.contentDocument.createElement("span");',
    '    foreign.id = "foreign-" + this.id; foreign.setAttribute("data-paqvilo-source", mark);',
    '    frame.contentWindow.Node.prototype.appendChild.call(document.getElementById("dump"), foreign);',
    '    const local = document.createElement("span");',
    '    local.id = "local-" + this.id; local.setAttribute("data-paqvilo-source", mark);',
    '    document.getElementById("dump").append(local);',
    '    document.getElementById("earlier").setAttribute("data-paqvilo-source", mark);',
    '  }',
    '});',
    '',
  ].join('\n');
  const fx = await dynamicPortal(t, {
    template: [
      '<main id="content">',
      '  <iframe id="realm"></iframe><div id="dump"></div><p id="earlier">Earlier</p>',
      '  <script src="/scripts/spy.js"></script>',
      '  <x-spy id="one">One</x-spy>',
      '  <x-spy id="two">Two</x-spy>',
      '  <p id="after">After</p>',
      '</main>',
    ].join('\n'),
    webFiles: { 'spy.js': spy },
  });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  const ids = ['one', 'two', 'earlier', 'after', 'foreign-one', 'foreign-two', 'local-one', 'local-two'];
  const got = await settled(fx, Object.fromEntries(ids.map((id) => [id, '#' + id])));
  const read = await fx.page.evaluate(() => window.__read);
  assert.equal(read.length, 2);
  for (const mark of read) assert.match(mark, /^[A-Za-z0-9_-]{11}$/, 'an id of 64 random bits, nothing else');
  assert.notEqual(read[0], read[1]);
  // The parser's elements keep their own places; the copies are no source's.
  for (const [id, needle] of [
    ['one', '<x-spy id="one"'],
    ['two', '<x-spy id="two"'],
    ['earlier', '<p id="earlier"'],
    ['after', '<p id="after"'],
  ])
    assert.deepEqual(
      [got[id].source?.file, got[id].source?.line, got[id].source?.how],
      [LAYOUT, lineOf(fx.text, needle), 'Found at this place in the served page'],
      id + ' ' + JSON.stringify(got[id]),
    );
  for (const id of ['foreign-one', 'foreign-two', 'local-one', 'local-two'])
    assert.equal(
      got[id].sources.some((ref) => ref.file === LAYOUT && ref.how === 'Found at this place in the served page'),
      false,
      id + ' ' + JSON.stringify(got[id]),
    );
  const page = await fx.page.evaluate(
    ({ slots, marks }) => {
      const answers = [];
      for (const slot of slots)
        for (const id of ['one', 'two', 'earlier', 'after', 'foreign-one', 'local-one'])
          answers.push(JSON.stringify(window[slot].query(document.getElementById(id), {})));
      return {
        // No answer a page script can ask for carries a mark or a node id.
        leaked: answers.filter((text) => marks.some((mark) => text.includes(mark)) || /"node":\{[^}]*"id"/.test(text)),
        removals: window.__removals.filter((call) => /paqvilo/.test(call)),
        left: document.querySelectorAll('[data-paqvilo-source]').length,
      };
    },
    { slots: [fx.session.domProvenanceSlot, fx.session.provenanceSlot], marks: read },
  );
  assert.deepEqual(page, { leaked: [], removals: [], left: 0 });
  assert.deepEqual(fx.errors, []);
});

// @test-kind contract: marks of a declarative open shadow root, of a same-origin frame's own document and around document.write are removed and those elements are named at their places; document.write output carries none
test('declarative shadow content, a frame document and document.write output keep no mark', async (t) => {
  const fx = await dynamicPortal(t, {
    template: [
      '<main id="content">',
      '  <div id="ohost"><template shadowrootmode="open"><span id="oinner">Open</span></template></div>',
      '  <script>document.write("<p id=written>Written</p>")</script>',
      '  <iframe id="fr" src="/frame"></iframe>',
      '</main>',
    ].join('\n'),
    pages: { '/frame': '<!doctype html><body><p id="f">Frame</p></body>' },
  });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  const got = await settled(fx, { oinner: '#ohost >>> #oinner', written: '#written' });
  assert.deepEqual(
    [got.oinner.source?.file, got.oinner.source?.line, got.oinner.source?.how],
    [LAYOUT, lineOf(fx.text, '<span id="oinner"'), 'Found at this place in the served page'],
  );
  // The inline script wrote it: a creation of that script, never a place in the served page.
  assert.equal(got.written.source?.how, 'Created by this script');
  const left = await fx.page.evaluate(async () => {
    const frame = document.getElementById('fr');
    if (frame.contentDocument?.readyState !== 'complete')
      await new Promise((done) => frame.addEventListener('load', done));
    const marked = (root) => root.querySelectorAll('[data-paqvilo-source], [data-paqvilo-script]').length;
    return [
      marked(document),
      marked(document.getElementById('ohost').shadowRoot),
      marked(frame.contentDocument),
      document.getElementById('written').getAttributeNames(),
    ];
  });
  assert.deepEqual(left, [0, 0, 0, ['id']]);
  const again = await answers(fx.page, { oinner: '#ohost >>> #oinner' });
  assert.equal(again.oinner.source?.file, LAYOUT);
  assert.deepEqual(fx.errors, []);
});
