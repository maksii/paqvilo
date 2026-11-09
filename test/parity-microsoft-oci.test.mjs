// @test-kind tooling: Microsoft OCI proof pins registry, manifest bytes and configuration digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyMicrosoftOci } from '../scripts/parity-microsoft-oci.mjs';
const body = fs.readFileSync(new URL('./fixtures/microsoft-sql-image-manifest.json', import.meta.url));
const sha = createHash('sha256').update(body).digest('hex');
const pkg = () => ({
  ecosystem: 'microsoft-oci',
  id: 'mssql/server',
  sha256: sha,
  source: `https://mcr.microsoft.com/v2/mssql/server/manifests/sha256:${sha}`,
  bodyBase64: body.toString('base64'),
});
test('accepts exact Microsoft registry digest and manifest bytes', () =>
  assert.match(verifyMicrosoftOci(pkg()).configDigest, /^sha256:[a-f0-9]{64}$/));
test('rejects spoofed source, wrong digest, extra base64 and altered bytes', () => {
  for (const value of [
    { ...pkg(), source: 'https://example.test/' },
    { ...pkg(), sha256: '0'.repeat(64) },
    { ...pkg(), bodyBase64: pkg().bodyBase64 + 'A' },
    { ...pkg(), bodyBase64: Buffer.from('{}').toString('base64') },
  ])
    assert.throws(() => verifyMicrosoftOci(value));
});
