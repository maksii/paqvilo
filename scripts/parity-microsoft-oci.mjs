// Prototype: binds exact OCI manifest bytes to a recognized Microsoft registry image.
import { createHash } from 'node:crypto';
// Digest independently retrieved from the Microsoft registry; new images require separate verification.
const REVIEWED = new Set(['cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718']);
export function verifyMicrosoftOci(pkg) {
  if (
    pkg?.ecosystem !== 'microsoft-oci' ||
    pkg.id !== 'mssql/server' ||
    !REVIEWED.has(pkg.sha256) ||
    pkg.source !== `https://mcr.microsoft.com/v2/mssql/server/manifests/sha256:${pkg.sha256}` ||
    typeof pkg.bodyBase64 !== 'string'
  )
    throw new Error('official-oci-provenance-required');
  const body = Buffer.from(pkg.bodyBase64, 'base64');
  if (body.toString('base64') !== pkg.bodyBase64 || createHash('sha256').update(body).digest('hex') !== pkg.sha256)
    throw new Error('official-oci-manifest-digest');
  const manifest = JSON.parse(body);
  if (
    manifest.schemaVersion !== 2 ||
    !['application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json'].includes(
      manifest.mediaType,
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest ?? '') ||
    !Array.isArray(manifest.layers) ||
    manifest.layers.length === 0 ||
    !manifest.layers.every(
      (x) => /^sha256:[a-f0-9]{64}$/.test(x.digest ?? '') && Number.isSafeInteger(x.size) && x.size >= 0,
    )
  )
    throw new Error('unsupported-oci-manifest');
  return { configDigest: manifest.config.digest };
}
