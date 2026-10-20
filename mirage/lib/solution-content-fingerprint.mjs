import path from 'node:path';
import { createHash } from 'node:crypto';

/** A logical source name; absolute checkout/archive locations never enter this identity. */
export function solutionContentPath(layer, file) {
  const normalized = String(file).replaceAll('\\', '/');
  const directory = String(layer.dir).replaceAll('\\', '/').replace(/\/$/, '');
  const archivePrefix = directory + '!/';
  if (normalized.startsWith(archivePrefix)) return normalized.slice(archivePrefix.length);
  return path.posix.relative(directory, normalized);
}

/** Ordered layer identities, relative file names and byte hashes. Retain physical cache keys separately. */
export function solutionContentFingerprint(layers, { lcid = 1033, files = [] } = {}) {
  const digest = createHash('sha256');
  digest.update(JSON.stringify(['solution-content-v1', lcid]));
  for (const [index, layer] of layers.entries()) {
    digest.update(JSON.stringify([index, layer.solution?.uniqueName ?? null, layer.solution?.version ?? null]));
    const documents = new Map((layer.documents ?? []).map(document => [document.file, document.hash ?? '']));
    const members = new Set((layer.files ?? []).map(file => file.path));
    for (const file of files) {
      if (members.has(file.path)) documents.set(file.path, file.hash ?? documents.get(file.path) ?? '');
    }
    const entries = [...documents].map(([file, hash]) => [solutionContentPath(layer, file), hash]);
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    for (const entry of entries) digest.update(JSON.stringify(entry));
  }
  return digest.digest('hex');
}
