import { createHash } from 'node:crypto';
export const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function claimsValid(claims, { issuer, audience, tenant, now = Date.now() / 1000 }) {
  return (
    claims.iss === issuer &&
    claims.aud === audience &&
    claims.tid === tenant &&
    guid.test(claims.oid ?? '') &&
    Number.isFinite(claims.exp) &&
    claims.exp >= now - 120 &&
    (!claims.nbf || (Number.isFinite(claims.nbf) && claims.nbf <= now + 120)) &&
    Array.isArray(claims.roles) &&
    claims.roles.includes('LabCapture.Write')
  );
}
export function validateEnvelope(envelope) {
  if (
    envelope?.schemaVersion !== 1 ||
    !guid.test(envelope.operationId ?? '') ||
    !/^[a-f0-9]{64}$/.test(envelope.eventKey ?? '') ||
    typeof envelope.payload !== 'string' ||
    Buffer.byteLength(envelope.payload) > 2097152
  )
    throw new Error('InvalidEnvelope');
  const hash = createHash('sha256').update(envelope.payload).digest('hex');
  if (hash !== envelope.payloadHash) throw new Error('HashMismatch');
  const capture = JSON.parse(envelope.payload);
  if (
    capture.schemaVersion !== 1 ||
    capture.operationId !== envelope.operationId ||
    !guid.test(capture.spanId ?? '') ||
    typeof capture.artifact !== 'string' ||
    capture.artifact.length > 64 ||
    !capture.context ||
    typeof capture.context !== 'object'
  )
    throw new Error('InvalidCapture');
  return { capture, hash };
}
export function chunks(text) {
  const parts = [];
  for (let offset = 0; offset < text.length;) {
    let length = Math.min(128000, text.length - offset);
    if (offset + length < text.length && /[\uD800-\uDBFF]/.test(text[offset + length - 1])) length--;
    parts.push(text.slice(offset, offset + length));
    offset += length;
  }
  return parts;
}
