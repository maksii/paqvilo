// @test-kind security: a page's callsite notification can name what a change changed only with bounded words from a closed pattern, never free text that a row's label would show
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeWords } from '../lense/dom-provenance-transport.mjs';

test('a change names at most eight distinct attribute names, "text" or "children"; a creation or a move names none', () => {
  assert.deepEqual(changeWords({ relationship: 'changed-by', what: ['class', 'data-state', 'text'] }), {
    words: ['class', 'data-state', 'text'],
    more: false,
  });
  assert.deepEqual(changeWords({ relationship: 'changed-by', what: ['xlink:href', 'aria-label'], more: true }), {
    words: ['xlink:href', 'aria-label'],
    more: true,
  });
  for (const relationship of ['created-by', 'cloned-by', 'attached-by', 'moved-by'])
    assert.deepEqual(changeWords({ relationship }), { words: [], more: false }, relationship);
});

test('free text, markup, too many or repeated names and a change without names are refused', () => {
  for (const what of [
    [],
    ['Class'],
    ['data-x y'],
    ['<img src=x onerror=alert(1)>'],
    ['a'.repeat(65)],
    ['class', 'class'],
    Array.from({ length: 9 }, (_, i) => 'data-' + i),
    'class',
    [1],
    null,
  ])
    assert.equal(changeWords({ relationship: 'changed-by', what }), null, JSON.stringify(what));
  assert.equal(changeWords({ relationship: 'changed-by', what: ['class'], more: 'yes' }), null);
  for (const relationship of ['created-by', 'moved-by']) {
    assert.equal(changeWords({ relationship, what: ['class'] }), null, relationship);
    assert.equal(changeWords({ relationship, more: true }), null, relationship);
  }
});
