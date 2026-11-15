// @test-kind security: token-input parsing handles malformed untrusted attributes without repeated name scans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveInputAttributes } from '../lib/live-input-attributes.mjs';

test('live input attributes preserve quote and case behavior on long invalid names', () => {
  assert.deepEqual(
    liveInputAttributes(`<input ${'x'.repeat(100_000)}! name="__RequestVerificationToken" value='fixture' >`),
    { name: '__RequestVerificationToken', value: 'fixture' },
  );
  assert.deepEqual(liveInputAttributes(`name="first\nname='second'"`), { name: 'second' });
});
