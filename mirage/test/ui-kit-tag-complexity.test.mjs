// @test-kind security: sortable cell text handles long malformed markup while retaining visible text semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortable } from '../admin/ui-kit.mjs';

test('sortable cells preserve tag spacing and handle unterminated tags', () => {
  const [column] = sortable([{ label: 'Value', render: (item) => item }]);
  assert.equal(column.sortValue('<b>A</b><span>B &amp; C</span>'), 'A B & C');
  assert.equal(column.sortValue('<'.repeat(100_000)), '<'.repeat(100_000));
  assert.equal(column.sortValue('<p text <b>tail'), 'tail');
});
import { scenarioSlug } from '../admin/ui-kit.mjs';

test('scenario identifiers retain punctuation and trim long dash runs', () => {
  assert.equal(scenarioSlug('   Alpha + Beta---'), 'alpha-beta');
  const dashes = '-'.repeat(100_000);
  assert.equal(scenarioSlug(`x${dashes}y`), `x${dashes}`.slice(0, 80));
  assert.equal(scenarioSlug(`x${dashes}`), 'x');
});
