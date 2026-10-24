import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { claimsValid, validateEnvelope, chunks } from '../collector/protocol.mjs';
const operation = '11111111-1111-4111-a111-111111111111',
  span = '22222222-2222-4222-a222-222222222222';
const cfg = { issuer: 'https://login.microsoftonline.com/test/v2.0', tenant: 'test', audience: 'lab', now: 1000 };
test('collector claims require signed-token shape and application role', () => {
  const good = {
    iss: cfg.issuer,
    aud: cfg.audience,
    tid: cfg.tenant,
    oid: operation,
    exp: 1500,
    roles: ['LabCapture.Write'],
  };
  assert.equal(claimsValid(good, cfg), true);
  for (const bad of [
    { roles: 'LabCapture.Write' },
    { oid: 'forged' },
    { aud: 'other' },
    { exp: 100 },
    { roles: ['PrefixLabCapture.WriteSuffix'] },
    { nbf: 1500 },
  ])
    assert.equal(claimsValid({ ...good, ...bad }, cfg), false);
});
test('worker verifies payload hash and envelope identity before evidence writes', () => {
  const payload = JSON.stringify({
    schemaVersion: 1,
    operationId: operation,
    spanId: span,
    artifact: 'PluginReceivedQuery.Stage20.Late',
    context: { MessageName: 'RetrieveMultiple' },
  });
  const envelope = {
    schemaVersion: 1,
    operationId: operation,
    eventKey: 'a'.repeat(64),
    payload,
    payloadHash: createHash('sha256').update(payload).digest('hex'),
  };
  assert.equal(validateEnvelope(envelope).capture.operationId, operation);
  assert.throws(() => validateEnvelope({ ...envelope, payload: payload + ' ' }), /HashMismatch/);
  const wrong = JSON.stringify({ ...JSON.parse(payload), operationId: span });
  assert.throws(
    () =>
      validateEnvelope({ ...envelope, payload: wrong, payloadHash: createHash('sha256').update(wrong).digest('hex') }),
    /InvalidCapture/,
  );
});
test('event chunking preserves UTF16 surrogate pairs and exact content', () => {
  const value = 'x'.repeat(127999) + '😀' + 'y'.repeat(128001);
  const parts = chunks(value);
  assert.equal(parts.join(''), value);
  assert.ok(parts.every((p) => p.length <= 128000 && !/[\uD800-\uDBFF]$/.test(p)));
  assert.equal(
    createHash('sha256').update(parts.join('')).digest('hex'),
    createHash('sha256').update(value).digest('hex'),
  );
});
