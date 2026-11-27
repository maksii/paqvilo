// Invented pages whose scripts build or change thousands of elements (X-ray tests and the overhead measurement).
const SERVER_ROWS = 5000;
export const manyScript = [
  'const $ = (id) => document.getElementById(id);',
  'window.measure = {};',
  'const time = (name, run) => { const start = performance.now(); run(); window.measure[name] = performance.now() - start; };',
  "time('innerHTML-rows', () => { let html = ''; for (let i = 0; i < 5000; i++) html += '<tr id=\"h' + i + '\"><td>' + i + '</td><td>x</td></tr>'; $('h-rows').innerHTML = html; });",
  "time('innerHTML-tree', () => { let html = ''; for (let s = 0; s < 100; s++) { html += '<section id=\"ts' + s + '\">'; for (let u = 0; u < 10; u++) { html += '<ul>'; for (let l = 0; l < 19; l++) html += '<li id=\"t' + s + '-' + u + '-' + l + '\">x</li>'; html += '</ul>'; } html += '</section>'; } $('h-tree').innerHTML = html; });",
  "time('loop-rows', () => { const body = $('l-rows'); for (let i = 0; i < 5000; i++) { const row = document.createElement('tr'); row.id = 'l' + i; const cell = document.createElement('td'); cell.textContent = i; row.append(cell, document.createElement('td')); body.append(row); } });",
  "time('loop-tree', () => { const host = $('l-tree'); for (let s = 0; s < 100; s++) { const section = document.createElement('section'); section.id = 'ls' + s; for (let u = 0; u < 10; u++) { const list = document.createElement('ul'); for (let l = 0; l < 19; l++) { const item = document.createElement('li'); item.id = 'lt' + s + '-' + u + '-' + l; list.append(item); } section.append(list); } host.append(section); } });",
  "time('server-attributes', () => { const rows = $('s-rows').rows; for (let i = 0; i < rows.length; i++) { rows[i].setAttribute('data-i', i); rows[i].classList.add('seen'); rows[i].style.color = 'red'; } });",
  "let next = 0; window.scrollList = (steps) => { const list = $('v-list'); const start = performance.now(); for (let k = 0; k < steps; k++) { if (list.children.length >= 50) list.firstElementChild.remove(); const item = document.createElement('li'); item.id = 'v' + next++; item.textContent = 'row ' + next; list.append(item); } return performance.now() - start; };",
  'window.scrollList(50);',
  '',
].join('\n');
export const manyTemplate = (rows = SERVER_ROWS) =>
  [
    '<main id="content">',
    '  <table id="h-table"><tbody id="h-rows"></tbody></table>',
    '  <table id="l-table"><tbody id="l-rows"></tbody></table>',
    '  <div id="h-tree"></div><div id="l-tree"></div><ul id="v-list"></ul>',
    '  <table id="s-table"><tbody id="s-rows">' +
      Array.from({ length: rows }, (_, i) => `<tr id="s${i}"><td>${i}</td></tr>`).join('') +
      '</tbody></table>',
    '  <script src="/scripts/many.js"></script>',
    '</main>',
  ].join('\n');
