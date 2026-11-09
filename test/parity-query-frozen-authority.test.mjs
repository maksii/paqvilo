// @test-kind tooling: trusted committed query authority resists recomputed working-source guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  assertFrozenQueryAuthority,
  assertQueryWriteAuthority,
  extractQueryAuthority,
} from '../scripts/parity-query-frozen-authority.mjs';
const receiptBytes = gunzipSync(
    fs.readFileSync(new URL('./fixtures/query53-trusted-authority.json.gz', import.meta.url)),
  ),
  trustedSource = gunzipSync(fs.readFileSync(new URL('./fixtures/query53-trusted-source.mjs.gz', import.meta.url))),
  pin = 'a902f37c89e6fb5143735e054f38ec998f0ec493a8d1bf30d1b16b8bc374cb87',
  sha = (x) => createHash('sha256').update(x).digest('hex');
function validate(currentSource, bytes = receiptBytes, pinnedReceiptSha256 = pin) {
  return assertFrozenQueryAuthority({ receiptBytes: bytes, pinnedReceiptSha256, trustedSource, currentSource });
}
function rewrite(source, query, descriptor) {
  const { queryRange, bindingRange } = extractQueryAuthority(source),
    edits = [
      { range: queryRange, text: JSON.stringify(query) },
      { range: bindingRange, text: JSON.stringify([descriptor]) },
    ].sort((a, b) => b.range[0] - a.range[0]);
  let text = String(source);
  for (const e of edits) text = text.slice(0, e.range[0]) + e.text + text.slice(e.range[1]);
  return text;
}
test('accepted frozen source retains all 53 cases, all proofs and prior witness', () =>
  assert.equal(validate(trustedSource), true));
test('removed prior proof and cases fail despite recomputing the current source guard', () => {
  const { query, descriptor } = extractQueryAuthority(trustedSource);
  query.selectedIndices = query.selectedIndices.filter((x) => ![0, 1].includes(x));
  descriptor.proofs.pop();
  descriptor.queryDescriptorSha256 = sha(JSON.stringify(query));
  const forged = rewrite(trustedSource, query, descriptor);
  assert.equal(extractQueryAuthority(forged).descriptor.queryDescriptorSha256, sha(JSON.stringify(query)));
  assert.throws(() => validate(forged), /invalid-frozen-query-authority/);
});
test('recomputed guard with replaced old authority and forged or older trust receipt fails', () => {
  const { query, descriptor } = extractQueryAuthority(trustedSource);
  descriptor.queryBridgeAuthoritySha256 = 'f'.repeat(64);
  descriptor.queryDescriptorSha256 = sha(JSON.stringify(query));
  assert.throws(() => validate(rewrite(trustedSource, query, descriptor)), /invalid-frozen-query-authority/);
  const forged = JSON.parse(receiptBytes);
  forged.proofs.pop();
  const bytes = Buffer.from(JSON.stringify(forged));
  assert.throws(() => validate(trustedSource, bytes), /invalid-frozen-query-authority/);
  assert.throws(() => validate(trustedSource, bytes, sha(bytes)), /invalid-frozen-query-authority/);
  assert.throws(() => validate(trustedSource, receiptBytes, '0'.repeat(64)), /invalid-frozen-query-authority/);
});
test('unselected original tuple change fails even after current guard is recomputed', () => {
  const { query, descriptor } = extractQueryAuthority(trustedSource);
  query.universe[13][1] = 'different';
  descriptor.queryDescriptorSha256 = sha(JSON.stringify(query));
  assert.throws(() => validate(rewrite(trustedSource, query, descriptor)), /invalid-frozen-query-authority/);
});
test('new writes require exact latest accepted source while identical post-write replay earns no write', () => {
  const { query, descriptor } = extractQueryAuthority(trustedSource);
  query.selectedIndices = [...query.selectedIndices, 13].sort((a, b) => a - b);
  descriptor.queryDescriptorSha256 = sha(JSON.stringify(query));
  const next = rewrite(trustedSource, query, descriptor),
    args = { receiptBytes, pinnedReceiptSha256: pin, trustedSource };
  assert.equal(assertQueryWriteAuthority({ ...args, beforeSource: trustedSource, afterSource: next }), true);
  assert.equal(assertQueryWriteAuthority({ ...args, beforeSource: next, afterSource: next }), true);
  const changedAgain = next + '\n';
  assert.throws(
    () => assertQueryWriteAuthority({ ...args, beforeSource: next, afterSource: changedAgain }),
    /invalid-frozen-query-authority/,
  );
});
test('stripping one newly qualified case and recomputing a guard cannot earn it again under old authority', () => {
  const { query, descriptor } = extractQueryAuthority(trustedSource);
  query.selectedIndices = [...query.selectedIndices, 13, 23].sort((a, b) => a - b);
  descriptor.queryDescriptorSha256 = sha(JSON.stringify(query));
  const qualified = rewrite(trustedSource, query, descriptor);
  query.selectedIndices = query.selectedIndices.filter((x) => x !== 23);
  descriptor.queryDescriptorSha256 = sha(JSON.stringify(query));
  const stripped = rewrite(trustedSource, query, descriptor);
  assert.throws(
    () =>
      assertQueryWriteAuthority({
        receiptBytes,
        pinnedReceiptSha256: pin,
        trustedSource,
        beforeSource: stripped,
        afterSource: qualified,
      }),
    /invalid-frozen-query-authority/,
  );
});
