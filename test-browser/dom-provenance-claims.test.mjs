// @test-kind contract: X-ray credits a recorded DOM call only with the changes its own arguments name, and a region of a call past its bound never takes over a parser-made element moved into it, on an invented loopback portal page (Paqvilo's designed attribution rule)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dynamicPortal, settled, LAYOUT } from './helpers/dynamic-dom-portal.mjs';

const changes = (answer) =>
  answer.rows.filter((row) => row.relationship === 'changed-by').map((row) => [row.label, row.at?.file ?? null]);
const moves = (answer) =>
  answer.rows.filter((row) => row.relationship === 'moved-by').map((row) => [row.label, row.at?.file ?? null]);

test('a custom element reaction of another script inside a recorded setAttribute is not credited to the caller', async (t) => {
  // b.js defines the element; its reaction changes its host and another element through paths no wrapper follows
  // (ARIA reflection) while a.js's setAttribute runs.
  const b = [
    'customElements.define("x-tab", class extends HTMLElement {',
    '  static observedAttributes = ["state"];',
    '  attributeChangedCallback() { this.ariaSelected = "true"; this.role = "tab"; document.getElementById("other").ariaHidden = "true"; }',
    '});',
    '',
  ].join('\n');
  const a = 'document.getElementById("tab").setAttribute("state", "on");\n';
  const fx = await dynamicPortal(t, {
    template: [
      '<main id="content">',
      '  <x-tab id="tab">T</x-tab><p id="other">O</p>',
      '  <script src="/scripts/b.js"></script>',
      '  <script src="/scripts/a.js"></script>',
      '</main>',
    ].join('\n'),
    webFiles: { 'a.js': a, 'b.js': b },
  });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  const got = await settled(fx, { tab: '#tab', other: '#other' });
  assert.deepEqual(changes(got.tab), [
    ['Changed by this script: state', 'web-files/a.js'],
    ['Changed without a recorded script call: aria-selected, role', null],
  ]);
  assert.deepEqual(changes(got.other), [['Changed without a recorded script call: aria-hidden', null]]);
  for (const answer of [got.tab, got.other]) assert.equal(answer.source?.file, LAYOUT);
  assert.deepEqual(fx.errors, []);
});

test('a capture load listener that runs inside a recorded append is not credited to the append', async (t) => {
  const b =
    'document.addEventListener("load", (e) => { if (e.target.localName === "iframe") document.getElementById("victim").ariaHidden = "true"; }, true);\n';
  const a = 'document.getElementById("host").append(document.createElement("iframe"));\n';
  const fx = await dynamicPortal(t, {
    template: [
      '<main id="content">',
      '  <div id="host"></div><p id="victim">V</p>',
      '  <script src="/scripts/b.js"></script>',
      '  <script src="/scripts/a.js"></script>',
      '</main>',
    ].join('\n'),
    webFiles: { 'a.js': a, 'b.js': b },
  });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  const got = await settled(fx, { host: '#host', victim: '#victim' });
  assert.deepEqual(changes(got.victim), [['Changed without a recorded script call: aria-hidden', null]]);
  assert.deepEqual(changes(got.host), [['Changed by this script: children', 'web-files/a.js']]);
  assert.deepEqual(fx.errors, []);
});

test('a parser element moved into another script’s region past its bound stays the template’s element', async (t) => {
  // x.js writes 2100 rows with one innerHTML: the rows past the first 2000 are the call's region. y.js moves a server
  // paragraph into one of them (a recorded append), z.js another one through another realm's native appendChild (a
  // path the recorder does not follow).
  const x = 'document.getElementById("big").innerHTML = "<div class=r></div>".repeat(2100);\n';
  const y = 'document.querySelectorAll("#big > div")[2050].append(document.getElementById("srv"));\n';
  const z = [
    'const frame = document.createElement("iframe"); document.body.append(frame);',
    'frame.contentWindow.Node.prototype.appendChild.call(document.querySelectorAll("#big > div")[2060], document.getElementById("srv2"));',
    '',
  ].join('\n');
  const fx = await dynamicPortal(t, {
    template: [
      '<main id="content">',
      '  <div id="big"></div><p id="srv">Server <b id="inner">paragraph</b></p><p id="srv2">Second</p>',
      '  <script src="/scripts/x.js"></script>',
      '  <script src="/scripts/y.js"></script>',
      '  <script src="/scripts/z.js"></script>',
      '</main>',
    ].join('\n'),
    webFiles: { 'x.js': x, 'y.js': y, 'z.js': z },
  });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  const got = await settled(fx, { srv: '#srv', inner: '#inner', srv2: '#srv2', row: '#big > div:nth-child(2051)' });
  for (const id of ['srv', 'inner', 'srv2']) {
    assert.deepEqual(
      got[id].sources.map((ref) => [ref.file, ref.status]),
      [[LAYOUT, 'exact']],
      id + ' names the template only: ' + JSON.stringify(got[id].sources),
    );
    assert.equal(
      got[id].rows.some((row) => row.label === 'Created by this script'),
      false,
      id,
    );
  }
  assert.deepEqual(moves(got.srv), [['Moved by this script', 'web-files/y.js']]);
  // The region's own row is still the call's.
  assert.equal(got.row.source?.file, 'web-files/x.js');
  assert.equal(got.row.source?.how, 'Created by this script');
  assert.deepEqual(fx.errors, []);
});
