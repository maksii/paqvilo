// @test-kind unproven: These local regression checks do not independently qualify original SQL cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callFunction } from '../lib/dataverse-tds-sql-functions.mjs';

test('FORMAT uses the invariant fallback for an unsupported well-formed culture', () => {
  assert.equal(callFunction('FORMAT', [1234.5, 'N2', 'xx-YY']), '1,234.50');
  assert.equal(callFunction('FORMAT', [1234.5, 'N2', 'en-US']), '1,234.50');
});

test('FORMAT reports an unsupported malformed culture as SQL error 9818', () => {
  assert.throws(() => callFunction('FORMAT', [1234.5, 'N2', 'not a culture']), { number: 9818 });
  assert.equal(callFunction('FORMAT', [1234.5, 'N2', null]), null);
});

test('SIGN preserves decimal scale for zero and nonzero inputs', () => {
  assert.deepEqual(callFunction('SIGN', [{ decimal: '0.0' }]), { decimal: '0.0' });
  assert.deepEqual(callFunction('SIGN', [{ decimal: '12.00' }]), { decimal: '1.00' });
  assert.deepEqual(callFunction('SIGN', [{ decimal: '-12.00' }]), { decimal: '-1.00' });
  assert.equal(callFunction('SIGN', [null]), null);
});
