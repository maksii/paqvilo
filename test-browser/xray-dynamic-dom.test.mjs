// @test-kind contract: what X-ray answers for elements page scripts generate, move and change on an invented loopback portal page is Paqvilo's designed attribution rule
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dynamicPortal, settled, lineOf, LAYOUT } from './helpers/dynamic-dom-portal.mjs';

const GEN = 'web-files/gen.js';
// Every way a script makes elements, one per line; the line is what X-ray must name.
const gen = [
  "const host = document.getElementById('gen-host');",
  "const a = document.createElement('div'); a.id = 'ce'; host.append(a);",
  "host.insertAdjacentHTML('beforeend', '<p id=\"iah\">x</p>');",
  "const holder = document.createElement('div'); holder.id = 'holder'; holder.innerHTML = '<b id=\"ih\">x</b>'; host.append(holder);",
  "const swap = document.createElement('div'); host.append(swap); swap.outerHTML = '<em id=\"oh\">x</em>';",
  "const rc = document.createElement('div'); rc.id = 'rc'; host.append(rc); rc.replaceChildren(Object.assign(document.createElement('span'), { id: 'rc-child' }));",
  "const old = document.createElement('div'); host.append(old); old.replaceWith(Object.assign(document.createElement('kbd'), { id: 'rw' }));",
  'host.append(document.createRange().createContextualFragment(\'<u id="ccf">x</u>\'));',
  "const parsed = new DOMParser().parseFromString('<s id=\"dp\">x</s>', 'text/html'); host.append(document.adoptNode(parsed.getElementById('dp')));",
  "host.append(document.getElementById('tpl').content.cloneNode(true));",
  "document.getElementById('rows').append(document.getElementById('server-row').cloneNode(true)); document.querySelectorAll('#rows tr')[1].id = 'cloned-row';",
  'window.$h.add(host, \'<q id="helper">x</q>\');',
  "eval(\"host.append(Object.assign(document.createElement('i'), { id: 'evaled' }))\");",
  "new Function('host', \"host.append(Object.assign(document.createElement('dfn'), { id: 'fn-made' }))\")(host);",
  "setTimeout(() => host.append(Object.assign(document.createElement('div'), { id: 'timeout' })));",
  "Promise.resolve().then(() => host.append(Object.assign(document.createElement('div'), { id: 'promise' })));",
  "fetch('/data.json').then((r) => r.json()).then((d) => { host.insertAdjacentHTML('beforeend', '<div id=\"fetched\">' + d.name + '</div>'); });",
  "document.getElementById('clicker').addEventListener('click', () => host.append(Object.assign(document.createElement('div'), { id: 'clicked' })));",
  "requestAnimationFrame(() => host.append(Object.assign(document.createElement('div'), { id: 'raf' })));",
  "new MutationObserver((list, o) => { o.disconnect(); host.append(Object.assign(document.createElement('div'), { id: 'observed' })); }).observe(document.getElementById('watch'), { childList: true });",
  "document.getElementById('watch').append(document.createTextNode('go'));",
  'document.write(\'<p id="written">Written</p>\');',
  '',
].join('\n');
// A jQuery-style helper the export does not hold, two frames above its DOM call.
const helper =
  "window.$h = { add(parent, html) { return inner(parent, html); } };\nfunction inner(p, h) { p.insertAdjacentHTML('beforeend', h); }\n";
const inlineScript =
  "const made = document.createElement('p'); made.id = 'inline-made'; document.getElementById('inline-host').append(made);";
const genTemplate = [
  '<main id="content" class="wrapper">',
  '  <section id="gen-host" class="gen"></section>',
  '  <table id="grid"><tbody id="rows"><tr class="row" id="server-row"><td>Server</td></tr></tbody></table>',
  '  <template id="tpl"><div class="from-template" id="tpl-made"><span>T</span></div></template>',
  '  <div id="inline-host"></div><div id="watch"></div><button id="clicker" type="button">Go</button>',
  `  <script>${inlineScript}</script>`,
  '  <script src="/js/helper.js"></script>',
  '  <script src="{{external}}/vendor.js"></script>',
  '  <div id="write-host"><script src="/scripts/gen.js"></script></div>',
  '</main>',
].join('\n');

test('A: every element a script generates names the script line that made it, however and whenever it was made', async (t) => {
  const fx = await dynamicPortal(t, {
    template: genTemplate,
    webFiles: { 'gen.js': gen },
    other: { '/js/helper.js': helper },
    external: {
      '/vendor.js':
        "document.getElementById('gen-host').append(Object.assign(document.createElement('div'), { id: 'vendor' }));",
    },
    json: { '/data.json': { name: 'Invented' } },
  });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  await fx.page.waitForFunction(() => typeof globalThis.__paqviloXrayUi?.coverage === 'function');
  await fx.page.click('#clicker');
  const cases = {
    ce: ['created-by', "document.createElement('div'); a.id = 'ce'"],
    iah: ['created-by', "host.insertAdjacentHTML('beforeend', '<p id=\"iah\">"],
    holder: ['created-by', "holder.id = 'holder'"],
    ih: ['created-by', 'holder.innerHTML = \'<b id="ih">'],
    oh: ['created-by', 'swap.outerHTML = \'<em id="oh">'],
    rc: ['created-by', "rc.id = 'rc'"],
    'rc-child': ['created-by', "id: 'rc-child'"],
    rw: ['created-by', "id: 'rw'"],
    ccf: ['attached-by', 'createContextualFragment'],
    dp: ['attached-by', 'new DOMParser()'],
    'tpl-made': ['cloned-by', "getElementById('tpl')"],
    'cloned-row': ['cloned-by', "getElementById('server-row').cloneNode"],
    helper: ['created-by', 'window.$h.add'],
    timeout: ['created-by', "id: 'timeout'"],
    promise: ['created-by', "id: 'promise'"],
    fetched: ['created-by', '<div id="fetched">'],
    clicked: ['created-by', "id: 'clicked'"],
    raf: ['created-by', "id: 'raf'"],
    observed: ['created-by', "id: 'observed'"],
    written: ['created-by', 'document.write'],
  };
  const how = {
    'created-by': 'Created by this script',
    'attached-by': 'Inserted by this script',
    'cloned-by': 'Copied by this script',
  };
  const got = await settled(fx, {
    ...Object.fromEntries(Object.keys(cases).map((id) => [id, '#' + id])),
    evaled: '#evaled',
    'fn-made': '#fn-made',
    inline: '#inline-made',
    vendor: '#vendor',
    server: '#server-row',
  });
  for (const [id, [relationship, needle]] of Object.entries(cases)) {
    const answer = got[id];
    assert.equal(answer.title, 'gen.js · ' + answer.title.split(' · ').at(-1), id + ' ' + JSON.stringify(answer));
    assert.deepEqual(
      [answer.source?.file, answer.source?.line, answer.source?.how, answer.source?.relationship],
      [GEN, lineOf(gen, needle), how[relationship], relationship],
      id,
    );
  }
  // The helper the export does not hold is a step of the chain; the file named is the caller's.
  assert.deepEqual(
    got.helper.rows.filter((row) => row.relationship === 'dom-call').map((row) => row.label),
    ['DOM call in a script not found in your sources'],
  );
  // Code eval and new Function compiled is named by the line that evaluated it.
  for (const [id, needle] of [
    ['evaled', 'eval('],
    ['fn-made', 'new Function('],
  ])
    assert.deepEqual(
      [got[id].source?.file, got[id].source?.line, got[id].source?.how],
      [GEN, lineOf(gen, needle), 'Created by code that this script evaluated'],
      id,
    );
  // An inline script of the template: the template's line.
  assert.deepEqual(
    [got.inline.source?.file, got.inline.source?.line, got.inline.source?.how],
    [LAYOUT, lineOf(genTemplate, inlineScript), 'Created by this script'],
  );
  // A script of another site: named by that site, never as a file of the export, inside its identified container.
  assert.equal(got.vendor.source, null, JSON.stringify(got.vendor));
  assert.equal(got.vendor.title, 'Inside Layout · section · div');
  assert.ok(got.vendor.rows.some((row) => row.label === 'Created by a script from another site'));
  assert.deepEqual(got.server.source, {
    file: LAYOUT,
    line: 3,
    column: genTemplate.split('\n')[2].indexOf('<tr') + 1,
    how: 'Found at this place in the served page',
    relationship: null,
  });
  assert.deepEqual(fx.errors, []);
});

const CD = 'web-files/cd.js';
const cd = [
  'const $ = (id) => document.getElementById(id);',
  '$(\'region\').innerHTML = \'<p class="same" id="same">Same</p>\';',
  '$(\'region2\').innerHTML = \'<p class="other" id="other">Other</p>\';',
  "$('gone').remove(); $('host2').append(Object.assign(document.createElement('div'), { id: 'mine' }));",
  "const wrap = document.createElement('div'); wrap.id = 'wrap'; $('wrapped').before(wrap); wrap.append($('wrapped'));",
  "$('target').appendChild($('moved1'));",
  "$('target').insertBefore($('moved2'), $('target').firstChild);",
  "const box = document.createElement('section'); box.id = 'box'; document.body.append(box); box.append($('moved3'));",
  "const kept = $('later'); kept.remove(); setTimeout(() => $('target').append(kept));",
  '',
].join('\n');
const cdTemplate = [
  '<main id="content">',
  '  <div id="region"><p class="same" id="same">Same</p></div>',
  '  <div id="region2"><p class="first">First</p></div>',
  '  <div id="host2"><p id="gone">Gone</p></div>',
  '  <div id="wrapped">Wrapped</div>',
  '  <div id="target"><span>T</span></div>',
  '  <aside id="other-region"><p id="moved1">M1</p><p id="moved2">M2</p><p id="moved3">M3</p><p id="later">L</p></aside>',
  '  <script src="/scripts/cd.js"></script>',
  '</main>',
].join('\n');

// The same pages on a live portal through Lense and rendered by Mirage: the recorder and its transport are shared.
const MODES = [
  ['a live portal', false],
  ['Mirage', true],
];
for (const [mode, mirage] of MODES)
  test(
    'C on ' +
      mode +
      ': server markup a script re-renders, removes, wraps or moves: look-alikes are the script’s, moved tags stay the template’s',
    async (t) => {
      const fx = await dynamicPortal(t, { template: cdTemplate, webFiles: { 'cd.js': cd }, mirage });
      await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
      await fx.page.waitForFunction(() => document.querySelector('#target > #later'));
      const ids = [
        'region',
        'same',
        'other',
        'host2',
        'mine',
        'wrap',
        'wrapped',
        'target',
        'moved1',
        'moved2',
        'moved3',
      ];
      const got = await settled(fx, {
        ...Object.fromEntries(ids.map((id) => [id, '#' + id])),
        later: '#later',
        box: '#box',
      });
      const script = (answer) => [answer.source?.file, answer.source?.line, answer.source?.how];
      // Re-rendered with the same markup ("hydration") and with other markup: the script's elements, not the template's.
      assert.deepEqual(script(got.same), [CD, 2, 'Created by this script']);
      assert.deepEqual(script(got.other), [CD, 3, 'Created by this script']);
      assert.deepEqual(script(got.mine), [CD, 4, 'Created by this script']);
      assert.deepEqual(script(got.wrap), [CD, 5, 'Created by this script']);
      assert.deepEqual(script(got.box), [CD, 8, 'Created by this script']);
      // A moved server element is the template's tag at its line, and says where a script moved it.
      for (const [id, templateLine, scriptLine] of [
        ['wrapped', 5, 5],
        ['moved1', 7, 6],
        ['moved2', 7, 7],
        ['moved3', 7, 8],
        ['later', 7, 9],
      ]) {
        const answer = got[id];
        assert.deepEqual(
          [answer.title, answer.source?.file, answer.source?.line],
          ['Layout · ' + (id === 'wrapped' ? 'div' : 'p'), LAYOUT, templateLine],
          id + ' ' + JSON.stringify(answer),
        );
        const moved = answer.rows.filter((row) => row.relationship === 'moved-by');
        assert.deepEqual(
          moved.map((row) => [row.label, row.status, row.at?.file, row.at?.line]),
          [['Moved by this script', 'exact', CD, scriptLine]],
          id,
        );
      }
      // The template elements whose children the script replaced or moved say so, with the line.
      const children = (answer) =>
        answer.rows.filter((row) => row.label === 'Changed by this script: children').map((row) => row.at?.line);
      assert.deepEqual(children(got.region), [2]);
      assert.deepEqual(children(got.host2), [4, 4]);
      assert.deepEqual(children(got.target), [9, 7, 6]);
      assert.equal(got.region.source?.file, LAYOUT);
      assert.deepEqual(fx.errors, []);
    },
  );

const MV = 'web-files/mv.js';
const mv = [
  'const $ = (id) => document.getElementById(id);',
  "$('to').moveBefore($('mv1'), null);",
  "$('list').moveBefore($('last'), $('first'));",
  // One move into the shadow root: Edge 158 ends the page when a shadow root that just took one element by append
  // takes that element's next sibling by moveBefore (no Lense needed; Chromium 159 does not).
  "$('host').attachShadow({ mode: 'open' }).moveBefore($('mv2'), null);",
  '',
].join('\n');
const mvTemplate = [
  '<main id="content">',
  '  <div id="to"><span>T</span></div>',
  '  <p id="mv1">M1</p>',
  '  <ul id="list"><li id="first">1</li><li id="last">2</li></ul>',
  '  <div id="host"></div><p id="mv2">M2</p>',
  '  <script src="/scripts/mv.js"></script>',
  '</main>',
].join('\n');

for (const [mode, mirage] of MODES)
  test(
    'C2 on ' + mode + ': an element a script moves with moveBefore stays the template’s tag and names the moving line',
    async (t) => {
      const fx = await dynamicPortal(t, { template: mvTemplate, webFiles: { 'mv.js': mv }, mirage });
      await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
      // The move is the browser's own: the test browsers have it, and the page ends as the script left it.
      assert.deepEqual(
        await fx.page.evaluate(() => [
          typeof Element.prototype.moveBefore,
          document.querySelector('#to > #mv1') !== null,
          [...document.querySelectorAll('#list > li')].map((item) => item.id),
          [...document.getElementById('host').shadowRoot.children].map((item) => item.id),
        ]),
        ['function', true, ['last', 'first'], ['mv2']],
      );
      const got = await settled(fx, {
        to: '#to',
        list: '#list',
        mv1: '#mv1',
        last: '#last',
        first: '#first',
        mv2: '#host >>> #mv2',
      });
      const moves = (answer) =>
        answer.rows
          .filter((row) => row.relationship === 'moved-by')
          .map((row) => [row.label, row.status, row.at?.file, row.at?.line]);
      for (const [id, tag, templateLine, scriptLine] of [
        ['mv1', 'p', 3, 2],
        ['last', 'li', 4, 3],
        ['mv2', 'p', 5, 4],
      ]) {
        const answer = got[id];
        assert.deepEqual(
          [answer.title, answer.source?.file, answer.source?.line],
          ['Layout · ' + tag, LAYOUT, templateLine],
          id + ' ' + JSON.stringify(answer),
        );
        assert.deepEqual(moves(answer), [['Moved by this script', 'exact', MV, scriptLine]], id);
      }
      // The element the move went past was not moved.
      assert.deepEqual(moves(got.first), []);
      // The parents whose children the moves changed say so, with the line.
      const children = (answer) =>
        answer.rows.filter((row) => row.label === 'Changed by this script: children').map((row) => row.at?.line);
      assert.deepEqual(children(got.to), [2]);
      assert.deepEqual(children(got.list), [3]);
      assert.deepEqual(fx.errors, []);
    },
  );

const FR = 'web-files/fr.js';
const fr = [
  'const $ = (id) => document.getElementById(id);',
  "const f = document.createDocumentFragment(); f.append($('fa'), $('fb'));",
  "$('to').append(f);",
  "const w = document.createElement('div'); w.id = 'w'; w.append($('wa'));",
  "$('to').append(w);",
  "const r = document.createRange(); r.selectNode($('ra')); const cut = r.extractContents();",
  "$('to').append(cut);",
  "const d = document.createRange(); d.selectNode($('rd')); d.deleteContents();",
  '',
].join('\n');
const frTemplate = [
  '<main id="content">',
  '  <div id="to"></div>',
  '  <span id="fa">A</span><span id="fb">B</span>',
  '  <p id="wa">W<b id="wa-child">c</b></p>',
  '  <p id="rng">x<i id="ra">r</i><u id="rd">d</u></p>',
  '  <script src="/scripts/fr.js"></script>',
  '</main>',
].join('\n');

for (const [mode, mirage] of MODES)
  test(
    'C3 on ' +
      mode +
      ': template elements moved through a fragment, inside a new wrapper or out of a range stay the template’s and name the moving lines',
    async (t) => {
      const fx = await dynamicPortal(t, { template: frTemplate, webFiles: { 'fr.js': fr }, mirage });
      await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
      assert.deepEqual(
        await fx.page.evaluate(() => [
          [...document.getElementById('to').children].map((item) => item.id),
          [...document.getElementById('w').children].map((item) => item.id),
          document.getElementById('rng').innerHTML,
        ]),
        [['fa', 'fb', 'w', 'ra'], ['wa'], 'x'],
      );
      const ids = ['to', 'fa', 'fb', 'w', 'wa', 'wa-child', 'ra', 'rng'];
      const got = await settled(fx, Object.fromEntries(ids.map((id) => [id, '#' + id])));
      const moves = (answer) =>
        answer.rows
          .filter((row) => row.relationship === 'moved-by')
          .map((row) => [row.label, row.status, row.at?.file, row.at?.line]);
      const moved = (...lines) => lines.map((line) => ['Moved by this script', 'exact', FR, line]);
      // Newest first: the line that put the element where it is, then the line that took it into the fragment or wrapper.
      for (const [id, tag, templateLine, lines] of [
        ['fa', 'span', 3, [3, 2]],
        ['fb', 'span', 3, [3, 2]],
        ['wa', 'p', 4, [5, 4]],
        ['ra', 'i', 5, [7]],
      ]) {
        const answer = got[id];
        assert.deepEqual(
          [answer.title, answer.source?.file, answer.source?.line],
          ['Layout · ' + tag, LAYOUT, templateLine],
          id + ' ' + JSON.stringify(answer),
        );
        assert.deepEqual(moves(answer), moved(...lines), id);
      }
      // What lies below a moved template element came with it: the template's tag, no move of its own.
      assert.deepEqual(
        [got['wa-child'].title, got['wa-child'].source?.file, got['wa-child'].source?.line, moves(got['wa-child'])],
        ['Layout · b', LAYOUT, 4, []],
      );
      // The wrapper is the script's.
      assert.deepEqual([got.w.source?.file, got.w.source?.line, got.w.source?.how], [FR, 4, 'Created by this script']);
      const children = (answer) =>
        answer.rows.filter((row) => row.label === 'Changed by this script: children').map((row) => row.at?.line);
      assert.deepEqual(children(got.to), [7, 5, 3]);
      assert.deepEqual(children(got.rng), [8, 6]);
      assert.deepEqual(fx.errors, []);
    },
  );

const MK = 'web-files/makers.js';
const makers = [
  'const $ = (id) => document.getElementById(id);',
  "const row = $('grid').insertRow(); row.id = 'row';",
  "const cell = row.insertCell(); cell.id = 'cell'; cell.textContent = 'x';",
  "$('grid').createCaption().id = 'caption';",
  "$('grid').createTHead().id = 'thead'; $('grid').createTFoot().id = 'tfoot';",
  "$('grid').tHead.insertRow().id = 'head-row';",
  "const bare = $('bare').insertRow(); bare.id = 'bare-row'; bare.parentNode.id = 'bare-body';",
  "$('pick').add(new Option('Two', '2')); $('pick').options[1].id = 'opt-added';",
  "$('pick').options.add(new Option('Three', '3')); $('pick').options[2].id = 'opt-listed';",
  "$('pick').length = 5; $('pick').options[4].id = 'opt-length';",
  "$('pick').options[5] = new Option('Six', '6'); $('pick').options[5].id = 'opt-indexed';",
  "$('body').deleteRow(0);",
  "$('pick').remove(0);",
  "const off = document.createElement('table'); off.id = 'off'; off.insertRow().insertCell().id = 'off-cell'; off.rows[0].id = 'off-row';",
  "$('content').append(off);",
  "window.fixedCaption = $('fixed').createCaption(); $('fixed').createTHead();",
  "const img = new Image(); img.id = 'img'; $('content').append(img);",
  '',
].join('\n');
const makersTemplate = [
  '<main id="content">',
  '  <table id="grid"><tbody id="body"><tr id="server-row"><td>s</td></tr><tr id="kept"><td>k</td></tr></tbody></table>',
  '  <table id="bare"></table>',
  '  <select id="pick"><option id="opt-server">One</option></select>',
  '  <table id="fixed"><caption id="server-caption">C</caption><thead id="server-head"><tr><th>h</th></tr></thead></table>',
  '  <script src="/scripts/makers.js"></script>',
  '</main>',
].join('\n');

for (const [mode, mirage] of MODES)
  test(
    'F on ' +
      mode +
      ': rows, cells, sections and options that table and select calls make name the calling line; what the template wrote stays its own',
    async (t) => {
      const fx = await dynamicPortal(t, { template: makersTemplate, webFiles: { 'makers.js': makers }, mirage });
      await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
      const ids = [
        'grid',
        'body',
        'kept',
        'row',
        'cell',
        'caption',
        'thead',
        'tfoot',
        'head-row',
        'bare',
        'bare-row',
        'bare-body',
        'pick',
        'opt-added',
        'opt-listed',
        'opt-length',
        'opt-indexed',
        'off',
        'off-row',
        'off-cell',
        'fixed',
        'server-caption',
        'server-head',
        'img',
      ];
      // The caption the template wrote is the one createCaption returned (the script keeps it without changing it).
      assert.deepEqual(
        await fx.page.evaluate(() => [
          window.fixedCaption === document.querySelector('#fixed caption'),
          document.querySelectorAll('#fixed caption').length,
          window.fixedCaption.textContent,
        ]),
        [true, 1, 'C'],
      );
      const got = await settled(fx, Object.fromEntries(ids.map((id) => [id, '#' + id])));
      const script = (answer) => [answer.source?.file, answer.source?.line, answer.source?.how];
      // Made by the table or the select itself, in the document or outside it.
      for (const [id, tag, line] of [
        ['row', 'tr', 2],
        ['cell', 'td', 3],
        ['caption', 'caption', 4],
        ['thead', 'thead', 5],
        ['tfoot', 'tfoot', 5],
        ['head-row', 'tr', 6],
        ['bare-row', 'tr', 7],
        ['bare-body', 'tbody', 7],
        ['opt-length', 'option', 10],
        ['off', 'table', 14],
        ['off-row', 'tr', 14],
        ['off-cell', 'td', 14],
      ]) {
        assert.deepEqual(
          [got[id].title, ...script(got[id])],
          ['makers.js · ' + tag, MK, line, 'Created by this script'],
          id + ' ' + JSON.stringify(got[id]),
        );
      }
      // An option or image a constructor made is the script's from the line that put it into the page.
      for (const [id, tag, line] of [
        ['opt-added', 'option', 8],
        ['opt-listed', 'option', 9],
        ['img', 'img', 17],
      ])
        assert.deepEqual(
          [got[id].title, ...script(got[id])],
          ['makers.js · ' + tag, MK, line, 'Inserted by this script'],
          id + ' ' + JSON.stringify(got[id]),
        );
      // An option assigned by index has no call to record: X-ray says where it stands and names no line for it.
      assert.deepEqual(
        [got['opt-indexed'].title, got['opt-indexed'].source],
        ['Inside Layout · select · option', null],
        JSON.stringify(got['opt-indexed']),
      );
      // What the template wrote stays the template's, also when a table call returns it.
      for (const [id, tag, line] of [
        ['grid', 'table', 2],
        ['body', 'tbody', 2],
        ['kept', 'tr', 2],
        ['bare', 'table', 3],
        ['pick', 'select', 4],
        ['fixed', 'table', 5],
        ['server-caption', 'caption', 5],
        ['server-head', 'thead', 5],
      ])
        assert.deepEqual(
          [got[id].title, got[id].source?.file, got[id].source?.line],
          ['Layout · ' + tag, LAYOUT, line],
          id + ' ' + JSON.stringify(got[id]),
        );
      // The template elements whose children these calls changed say so, newest first.
      const children = (answer) =>
        answer.rows.filter((row) => row.label === 'Changed by this script: children').map((row) => row.at?.line);
      assert.deepEqual(children(got.grid), [5, 5, 4]);
      assert.deepEqual(children(got.body), [12, 2]);
      assert.deepEqual(children(got.bare), [7]);
      assert.deepEqual(children(got.pick), [13, 10, 9, 8]);
      assert.deepEqual(children(got.fixed), []);
      assert.deepEqual(fx.errors, []);
    },
  );

const D = 'web-files/adjust.js';
const adjust = [
  'const $ = (id) => document.getElementById(id);',
  "$('a1').setAttribute('data-state', 'on'); $('a1').toggleAttribute('hidden'); $('a1').removeAttribute('title');",
  "$('a2').classList.add('x'); $('a2').classList.replace('w', 'v'); $('a2').className += ' z';",
  "$('a3').style.color = 'red'; $('a3').style.cssText += 'margin: 1px'; $('a3').style.setProperty('padding', '1px');",
  "$('a4').dataset.mode = 'dark'; $('a4').id = 'a4b';",
  "$('i1').value = 'typed'; $('c1').checked = true; $('l1').href = '/x'; $('m1').src = '/m.png'; $('b1').disabled = true; $('h1').hidden = true;",
  "$('t1').textContent = 'new text'; $('t2').firstChild.data = 'changed'; $('t3').innerText = 'inner'; $('t4').firstChild.nodeValue = 'value'; $('t5').append('more'); $('t5').normalize();",
  "$('k1').replaceChildren(Object.assign(document.createElement('b'), { id: 'kid' }));",
  "for (let i = 0; i < 40; i++) $('many').setAttribute('data-n' + (i % 3), String(i));",
  '',
].join('\n');
const adjustTemplate = [
  '<main id="content">',
  '  <p id="a1" title="t">A1</p><p id="a2" class="w">A2</p><p id="a3">A3</p><p id="a4">A4</p>',
  '  <input id="i1"><input id="c1" type="checkbox"><a id="l1" href="/y">L</a><img id="m1" alt="m"><button id="b1" type="button">B</button><p id="h1">H</p>',
  '  <p id="t1">T1</p><p id="t2">T2</p><p id="t3">T3</p><p id="t4">T4</p><p id="t5">T5</p><div id="k1"><span>K</span></div>',
  '  <p id="many">Many</p><p id="untouched">Untouched</p>',
  '  <script src="/scripts/adjust.js"></script>',
  '</main>',
].join('\n');

for (const [mode, mirage] of MODES)
  test(
    'D on ' +
      mode +
      ': adjusted server elements stay the template’s tags and list what each script changed, newest first, bounded',
    async (t) => {
      const fx = await dynamicPortal(t, { template: adjustTemplate, webFiles: { 'adjust.js': adjust }, mirage });
      await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
      const ids = [
        'a1',
        'a2',
        'a3',
        'a4b',
        'i1',
        'c1',
        'l1',
        'm1',
        'b1',
        'h1',
        't1',
        't2',
        't3',
        't4',
        't5',
        'k1',
        'many',
      ];
      const got = await settled(fx, {
        ...Object.fromEntries(ids.map((id) => [id, '#' + id])),
        untouched: '#untouched',
      });
      const changes = (answer) =>
        answer.rows
          .filter((row) => row.relationship === 'changed-by')
          .map((row) => [row.label, row.at?.file, row.at?.line]);
      const line = (n) => (label) => [label, D, n];
      for (const id of ids) {
        if (id === 'a4b') continue;
        assert.equal(got[id].source?.file, LAYOUT, id + ' stays the template’s tag: ' + JSON.stringify(got[id]));
        assert.equal(
          got[id].source?.how,
          mirage ? 'Rendered from this file' : 'Found at this place in the served page',
          id,
        );
      }
      assert.deepEqual(
        changes(got.a1),
        ['Changed by this script: title', 'Changed by this script: hidden', 'Changed by this script: data-state'].map(
          line(2),
        ),
      );
      assert.deepEqual(changes(got.a2), Array(3).fill('Changed by this script: class').map(line(3)));
      // A named style or dataset write (`style.color = …`, `dataset.mode = …`) has no hook: the browser reports the
      // attribute change, and no script is named for it. The declaration's own cssText and setProperty are calls.
      const unattributed = (word) => ['Changed without a recorded script call: ' + word, undefined, undefined];
      assert.deepEqual(changes(got.a3), [
        ...Array(2).fill('Changed by this script: style').map(line(4)),
        unattributed('style'),
      ]);
      // A script that changes an element's id repurposes it: it is no longer proved the template's tag, and X-ray names
      // no source for it (only the template whose markup matches a parent, as a candidate), but still says what changed.
      assert.deepEqual(
        [got.a4b.title, got.a4b.source, got.a4b.sources.map((item) => [item.file, item.status])],
        ['Inside Layout · main · p', null, [[LAYOUT, 'candidate']]],
        JSON.stringify(got.a4b),
      );
      assert.deepEqual(changes(got.a4b), [line(5)('Changed by this script: id'), unattributed('data-mode')]);
      for (const [id, word] of [
        ['i1', 'value'],
        ['c1', 'checked'],
        ['l1', 'href'],
        ['m1', 'src'],
        ['b1', 'disabled'],
        ['h1', 'hidden'],
      ])
        assert.deepEqual(changes(got[id]), [line(6)('Changed by this script: ' + word)], id);
      for (const id of ['t1', 't2', 't3', 't4'])
        assert.deepEqual(changes(got[id]), [line(7)('Changed by this script: text')], id);
      assert.deepEqual(changes(got.t5), Array(2).fill('Changed by this script: text').map(line(7)));
      assert.deepEqual(changes(got.k1), [line(8)('Changed by this script: children')]);
      // 40 changes of one element from one line: 32 calls are recorded (one row per change they made, the older rows
      // dropped at four), the eight past the bound are listed by what they changed, without a script.
      assert.deepEqual(changes(got.many), [
        [
          'Changed by a script past the recording limit (its call was not recorded): data-n2, data-n0, data-n1',
          undefined,
          undefined,
        ],
        ...['data-n1', 'data-n0', 'data-n2'].map((name) => line(9)('Changed by this script: ' + name)),
      ]);
      assert.deepEqual(got.many.limits, ['dom-change-limit', 'dom-change-history-limit']);
      assert.deepEqual(got.untouched.rows, []);
      assert.deepEqual(fx.errors, []);
    },
  );

// @test-kind security: a page script cannot make X-ray name a file of the export for code that file did not run, and a change made past the recorder is never credited to a script
test('a forged sourceURL, a bypassed recorder and a page stack formatter never credit a script', async (t) => {
  const victim =
    "document.getElementById('victim-host').append(Object.assign(document.createElement('i'), { id: 'real' }));\n";
  const attack = [
    "eval(\"document.getElementById('victim-host').append(Object.assign(document.createElement('i'), { id: 'forged' }))\\n//# sourceURL=\" + location.origin + '/scripts/victim.js');",
    "const frame = document.createElement('iframe'); document.body.append(frame);",
    "frame.contentWindow.Element.prototype.setAttribute.call(document.getElementById('bypassed'), 'data-x', '1');",
    "Error.prepareStackTrace = () => 'PRIVATE_STACK_SENTINEL'; document.getElementById('formatted').setAttribute('data-y', '1'); delete Error.prepareStackTrace;",
    '',
  ].join('\n');
  const fx = await dynamicPortal(t, {
    template: [
      '<main id="content">',
      '  <div id="victim-host"></div><p id="bypassed">B</p><p id="formatted">F</p>',
      '  <script src="/scripts/attack.js"></script>',
      '  <script src="/scripts/victim.js"></script>',
      '</main>',
    ].join('\n'),
    webFiles: { 'victim.js': victim, 'attack.js': attack },
  });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  const got = await settled(fx, { real: '#real', forged: '#forged', bypassed: '#bypassed', formatted: '#formatted' });
  // The forged code reports the victim's address; the browser parsed two scripts there, so that frame names neither.
  // The element is the attacker's: its eval call is the innermost frame in the export's code.
  assert.deepEqual(
    [got.forged.source?.file, got.forged.source?.line, got.forged.source?.how],
    ['web-files/attack.js', 1, 'Created by this script'],
    JSON.stringify(got.forged),
  );
  assert.deepEqual(
    got.forged.rows.filter((row) => row.relationship === 'dom-call').map((row) => row.label),
    ['DOM call in a script version that could not be verified'],
  );
  // The victim's own element, made after the forgery was parsed at its address: unnamed, in its identified container.
  assert.equal(got.real.source, null, JSON.stringify(got.real));
  assert.equal(got.real.title, 'Inside Layout · div · i');
  for (const id of ['forged', 'real'])
    assert.ok(!got[id].sources.some((ref) => ref.file === 'web-files/victim.js' && ref.status === 'exact'), id);
  // A change through another realm's native method: seen, never credited.
  assert.deepEqual(
    got.bypassed.rows.filter((row) => row.relationship === 'changed-by').map((row) => [row.label, row.at]),
    [['Changed without a recorded script call: data-x', null]],
  );
  // A page stack formatter: the change is listed without a script, and the formatter is never called with its frames.
  assert.deepEqual(
    got.formatted.rows.filter((row) => row.relationship === 'changed-by').map((row) => [row.label, row.at]),
    [['Changed by a script whose call could not be located: data-y', null]],
  );
  assert.equal(got.bypassed.source?.file, LAYOUT);
  assert.deepEqual(fx.errors, []);
});

test('E: shadow roots, frames, bundles and a laid-over local file', async (t) => {
  const shadow = [
    "const open = document.getElementById('open-host').attachShadow({ mode: 'open' }); open.innerHTML = '<b id=\"in-open\">o</b>';",
    "window.closedRoot = document.getElementById('closed-host').attachShadow({ mode: 'closed' }); window.inClosed = closedRoot.appendChild(document.createElement('b'));",
    "const frame = document.getElementById('same-frame'); const fill = () => { const p = frame.contentDocument.createElement('p'); p.id = 'in-frame'; frame.contentDocument.body.append(p); window.inFrame = p; }; if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.URL.endsWith('/frame')) fill(); else frame.addEventListener('load', fill);",
    '',
  ].join('\n');
  const bundle =
    "(function(){document.getElementById('bundle-host').append(Object.assign(document.createElement('i'),{id:'bundled'}))})();\n//# sourceMappingURL=bundle.js.map\n";
  const minified =
    '(function(){var h=document.getElementById("min-host");h.append(Object.assign(document.createElement("i"),{id:"m1"}));h.append(Object.assign(document.createElement("i"),{id:"m2"}))})();';
  const local = [
    "const host = document.getElementById('local-host');",
    '// A line the developer added locally.',
    "host.append(Object.assign(document.createElement('u'), { id: 'local-made' }));",
    '',
  ].join('\n');
  const fx = await dynamicPortal(t, {
    template: [
      '<main id="content">',
      '  <div id="open-host"></div><div id="closed-host"></div>',
      '  <iframe id="same-frame" src="/frame"></iframe><iframe id="cross-frame" src="{{external}}/cross"></iframe>',
      '  <div id="bundle-host"></div><div id="min-host"></div><div id="local-host"></div>',
      '  <script src="/scripts/shadow.js"></script><script src="/scripts/bundle.js"></script>',
      '  <script src="/scripts/min.js"></script><script src="/scripts/local.js"></script>',
      '</main>',
    ].join('\n'),
    webFiles: {
      'shadow.js': shadow,
      'bundle.js': bundle,
      'min.js': minified,
      'local.js': local,
    },
    // The portal serves the published version of local.js; Lense lays the local one over it.
    served: {
      'local.js':
        "document.getElementById('local-host').append(Object.assign(document.createElement('u'), { id: 'local-made' }));\n",
    },
    pages: { '/frame': '<!doctype html><html><body><div id="frame-host"></div></body></html>' },
    external: { '/cross': '<!doctype html><html><body><p>Other site</p></body></html>' },
  });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  await fx.page.waitForFunction(() => window.inFrame);
  const got = await settled(fx, {
    open: '#open-host >>> #in-open',
    closed: 'window.inClosed',
    bundled: '#bundled',
    m1: '#m1',
    m2: '#m2',
    local: '#local-made',
    cross: '#cross-frame',
  });
  assert.deepEqual([got.open.source?.file, got.open.source?.line], ['web-files/shadow.js', 1]);
  assert.deepEqual([got.closed.source?.file, got.closed.source?.line], ['web-files/shadow.js', 2]);
  // A bundle is named by the generated file and line it ran from: no source map of the export proves an original.
  assert.deepEqual(
    got.bundled.sources.filter((ref) => ref.status === 'exact').map((ref) => [ref.file, ref.line, ref.status]),
    [['web-files/bundle.js', 1, 'exact']],
  );
  // One minified line: the column tells the two calls apart.
  assert.deepEqual(
    [got.m1.source, got.m2.source].map((source) => [source?.file, source?.line, source?.column]),
    [
      ['web-files/min.js', 1, minified.indexOf('createElement') + 1],
      ['web-files/min.js', 1, minified.lastIndexOf('createElement') + 1],
    ],
  );
  // The local file as served: its line, not the published one's.
  assert.deepEqual([got.local.source?.file, got.local.source?.line], ['web-files/local.js', 3]);
  assert.deepEqual([got.cross.title, got.cross.source?.file], ['Layout · iframe', LAYOUT]);
  // An element a page script creates in a same-origin frame: answered by that frame's own recorder.
  const inFrame = await fx.page.evaluate(() => {
    const found = globalThis.__paqviloXrayUi.identify(window.inFrame);
    return {
      title: found.title,
      source: found.evidence.source.refs.find((ref) => ref.status === 'exact')?.ref ?? null,
    };
  });
  assert.notEqual(inFrame.title, 'p element', JSON.stringify(inFrame));
  assert.deepEqual(fx.errors, []);
});
