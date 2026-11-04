// @test-kind contract: retain existing toolkit filter text output on malformed input without claiming native parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilters } from '../lib/liquid-filters.mjs';
import { NetDecimal } from '../lib/liquid-dotnet.mjs';

const filters = createFilters();

test('strip_html retains unmatched block text and removes later complete blocks', () => {
  assert.equal(filters.strip_html('İ<script broken<!--gone-->tail<style>gone</style><b>kept</b>'), 'İkept');
  const unmatched = '<script'.repeat(100_000);
  assert.equal(filters.strip_html(unmatched), unmatched);
  assert.equal(filters.strip_html('<'.repeat(100_000)), '<'.repeat(100_000));
});

test('search_filter_options preserves values and whitespace-only captures without a colon scan retry', () => {
  assert.deepEqual(filters.search_filter_options(':label: contact, account ;empty: ;tab:\t'), [
    { display_name: 'contact', value: 'contact,account' },
    { display_name: '', value: '' },
    { display_name: '\t', value: '\t' },
  ]);
  assert.equal(filters.search_filter_options('x'.repeat(100_000)), null);
  assert.equal(filters.search_filter_options(' '.repeat(100_000)), null);
});

// @test-kind security: caller-created arbitrary-size decimals retain every digit without suffix lookahead retries.
test('numeric grouping and optional zero suffixes preserve arbitrary-size decimal formatting', () => {
  const value = new NetDecimal(10n ** 15000n);
  const expected = ['1', ...Array(5000).fill('000')].join(',');
  assert.equal(filters.decimals(value, 0), expected);
  assert.equal(filters.max_decimals(new NetDecimal(123400n, 4), 6), '12.34');
  assert.equal(filters.format(new NetDecimal(123400n, 4), '0.######'), '12.34');
  assert.equal(filters.format(new NetDecimal(0n, 4), '0.00##'), '0.00');
});
