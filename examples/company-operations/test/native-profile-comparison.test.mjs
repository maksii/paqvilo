import test from 'node:test';
import assert from 'node:assert/strict';
import {
  profileAuthoredRequestFingerprint,
  compareNativeReadProfiles,
} from '../portal-harness/native-profile-comparison.mjs';
const op = '10000000-0000-0000-0000-000000000001',
  other = '10000000-0000-0000-0000-000000000002';
const request = (operationId, filter) => ({
  operationId,
  caseId: 'invented',
  lane: 'webapi',
  url: `/_api/widgets?$filter=${encodeURIComponent(filter)}&$select=widgetid`,
});
const capture = (operationId, filter, body = '{"value":[]}') => ({
  requests: [request(operationId, filter)],
  backendEvents: [],
  liquidPages: [],
  results: [{ operationId, lane: 'webapi', status: 200, body }],
});
const manifest = {
  cases: [],
  odataPositiveVariants: [{ id: 'invented', fields: [{ name: 'widgetid', type: 'guid' }] }],
};
test('profile OData fingerprint normalizes complete quoted markers only', () => {
  const left = request(op, `name ne 'CO-OP:${op}' and name ne 'CO-UTC:2026-10-13T12:00:00.000Z'`),
    right = request(other, `name ne 'CO-OP:${other}' and name ne 'CO-UTC:2026-10-13T12:00:01.000Z'`);
  assert.equal(profileAuthoredRequestFingerprint(left), profileAuthoredRequestFingerprint(right));
  assert.notEqual(
    profileAuthoredRequestFingerprint(left),
    profileAuthoredRequestFingerprint({ ...right, url: right.url.replace('$select=widgetid', '$select=name') }),
  );
  assert.notEqual(
    profileAuthoredRequestFingerprint(request(op, `name eq 'prefix ''CO-OP:${op}'' suffix'`)),
    profileAuthoredRequestFingerprint(request(other, `name eq 'prefix ''CO-OP:${other}'' suffix'`)),
  );
  assert.throws(() => profileAuthoredRequestFingerprint({ lane: 'liquid', url: '/page' }), /authored query/);
});
test('native profile compares source OData outcomes and flat CDS error codes without fabricating backend work', () => {
  const filter = (id) => `name ne 'CO-OP:${id}'`,
    left = capture(op, filter(op)),
    right = capture(other, filter(other));
  assert.equal(compareNativeReadProfiles({ baseline: left, candidate: right, manifest }).qualified, true);
  left.results[0] = { ...left.results[0], status: 400, body: '{"error":{"code":"9004010D","cdscode":"alpha"}}' };
  right.results[0] = { ...right.results[0], status: 400, body: '{"error":{"code":"9004010D","cdscode":"beta"}}' };
  assert.equal(compareNativeReadProfiles({ baseline: left, candidate: right, manifest }).qualified, false);
});
test('missing native wire/source plans never qualify as two matching absences', () => {
  const left = capture(op, 'name ne null'),
    right = capture(other, 'name ne null');
  left.results = [];
  right.results = [];
  const result = compareNativeReadProfiles({ baseline: left, candidate: right, manifest });
  assert.equal(result.qualified, false);
  assert.ok(result.errors.includes('missing-webapi-outcome'));
  assert.equal(
    compareNativeReadProfiles({
      baseline: capture(op, 'name ne null'),
      candidate: capture(other, 'name ne null'),
      manifest: { cases: [] },
    }).qualified,
    false,
  );
});
