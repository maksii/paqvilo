// @test-kind security: native grid sort and CSV headings handle unbounded malformed input in linear time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripMarkupTags } from '../lib/strip-markup-tags.mjs';
import { parseGridSortExpression } from '../lib/grid-sort-expression.mjs';

test('CSV heading stripping preserves malformed and complete markup', () => {
  assert.equal(stripMarkupTags('<b>Name</b> and <i>title</i>'), 'Name and title');
  assert.equal(stripMarkupTags('<'.repeat(100_000)), '<'.repeat(100_000));
});

test('grid sort parsing keeps case and direction with long invalid whitespace', () => {
  assert.deepEqual(parseGridSortExpression(' Name DESC,alias.Field asc ', null), [
    { attribute: 'Name', descending: true },
    { attribute: 'alias.Field', descending: false },
  ]);
  assert.deepEqual(parseGridSortExpression(`name${' '.repeat(100_000)}!`, null), []);
  assert.deepEqual(parseGridSortExpression('name,other DESC', new Set(['name'])), [
    { attribute: 'name', descending: false },
  ]);
});
