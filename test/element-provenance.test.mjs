import test from 'node:test';
import assert from 'node:assert/strict';
import { elementSourceHints, scriptSourceHints } from '../lense/element-provenance.mjs';

test('markup hints keep source lines and escaped selectors without parsing script, comments or dynamic IDs', () => {
  const hints = elementSourceHints('<div id="hero:card">\n<input id="fx_title" value="secret">\n<!-- <b id="comment"> -->\n<script>const html = `<b id="script">`</script><b id="{{ dynamic }}"></b>', { sourceFile: '/source.html', name: 'Partial' });
  assert.deepEqual(hints.map(row => [row.selector, row.line, row.certainty]), [['#hero\\3a card', 1, 'candidate'], ['#fx_title', 2, 'candidate']]);
  assert.doesNotMatch(JSON.stringify(hints), /secret|comment|script|dynamic/);
});
test('script selectors retain candidate evidence and actual source lines, with dynamic references excluded', () => {
  const hints = scriptSourceHints('document.getElementById("fx_title");\nroot.querySelector("#hero button");\nroot.querySelector("{{ dynamic }}");\nroot.querySelector(variable);', { sourceFile: '/feature.js' });
  assert.deepEqual(hints.map(row => [row.selector, row.line, row.evidence]), [['#fx_title', 1, 'script-selector'], ['#hero button', 2, 'script-selector']]);
  assert.equal(hints.every(row => row.certainty === 'candidate'), true);
});
test('duplicate IDs, large bodies and extraction caps remain explicit and bounded', () => {
  assert.equal(elementSourceHints('<b id="same"></b><b id="same"></b>', {})[0].occurrences, 2);
  assert.equal(elementSourceHints('x'.repeat(1024 * 1024 + 1), {}).length, 0);
  assert.equal(elementSourceHints('<b id="one"></b><b id="two"></b>', {}, { limit: 1 }).length, 1);
  assert.equal(elementSourceHints('<b id="one"></b>', { sourceFile: '/component.xml' })[0].line, undefined);
});
test('markup without IDs retains intrinsic source selectors and marks repeated source locations', () => {
  const hints=elementSourceHints('<aside class="summary-card"><h2 class="heading">Summary</h2><p class="note">One</p><p class="note">Two</p></aside>', {sourceFile:'/partial.html'});
  assert.equal(hints.find(row=>row.selector==='aside.summary-card').matchKind,'class');
  assert.equal(hints.find(row=>row.selector==='p.note').occurrences,2);
  assert.equal(hints.some(row=>/nth-child|>/.test(row.selector)),false,'positional selectors must not change ownership when a region is moved');
});
