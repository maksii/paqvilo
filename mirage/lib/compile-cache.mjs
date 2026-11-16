// A content-addressed cache of compiler outputs, shared by every runtime and test process of this toolkit checkout. An
// entry is a folder named by the hash of everything that decides the output (compiler identity, options, sources and
// references); it is published by one atomic rename of a privately built folder, so a reader sees a whole entry or none.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const META = 'compile-cache.json';

/** The toolkit's ignored .paqvilo area: outside every hashed source tree, next to the other tool caches. */
const defaultCompileCacheRoot = () => fileURLToPath(new URL('../../.paqvilo/cache/compile', import.meta.url));

/** The cache key of these parts (strings or bytes, in order): each part is length-prefixed, so parts never run together. */
export function compileCacheKey(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part), 'utf8');
    hash.update(String(bytes.length) + ':').update(bytes);
  }
  // 128 bits name an entry: the folder name stays short for compilers bound by the Windows path limit.
  return hash.digest('hex').slice(0, 32);
}

/** The SHA-256 of a file's bytes as they are now: no timestamp stands in for content. */
export const fileDigest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** What identifies a compiler without starting it: its file's bytes, or its name when it is resolved through PATH. */
export function compilerIdentity(file) {
  try {
    return 'file:' + fileDigest(file);
  } catch {
    return 'name:' + file;
  }
}

const readEntry = (directory) => {
  try {
    return { directory, meta: JSON.parse(fs.readFileSync(path.join(directory, META), 'utf8')).meta };
  } catch {
    return null; // absent, or not an entry this cache published
  }
};
/** Copies the named outputs of one folder into another folder the caller owns. */
const copyOutputs = (from, into, files) => {
  for (const name of files) fs.copyFileSync(path.join(from, name), path.join(into, name));
};
/** A new private folder under the cache root, or null when the root cannot be created (a read-only installation). */
const openScratch = (root) => {
  try {
    fs.mkdirSync(root, { recursive: true });
    return fs.mkdtempSync(path.join(root, 't-'));
  } catch {
    return null;
  }
};
const remove = (directory) => {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    /* A folder another process still reads stays; it is unreachable under a private name. */
  }
};

/**
 * The compiled output for `key`, placed in `into` (a folder the caller owns): `files` names the outputs to place there.
 * A published entry is copied without compiling. Otherwise build(folder) compiles into a private folder, returns the
 * entry's metadata (any JSON value) or throws; the folder is then published under the key. When another process
 * published the same key first, its entry is the one used and this build is discarded. A failed build publishes nothing.
 * The result is { meta, hit }: hit is true when no compiler ran in this call.
 *
 * Without a usable cache folder (root: false, or a folder that cannot be created) the build runs straight into `into`.
 */
export function compileCached({ root = defaultCompileCacheRoot(), key, files, into, build }) {
  const entry = root === false ? null : path.join(root, key);
  let found = entry && readEntry(entry),
    hit = Boolean(found);
  if (!found) {
    const scratch = entry && openScratch(root);
    if (!scratch) return { meta: build(into), hit: false };
    let meta;
    try {
      meta = build(scratch);
      fs.writeFileSync(path.join(scratch, META), JSON.stringify({ meta: meta ?? null, files }));
    } catch (error) {
      remove(scratch);
      throw error;
    }
    try {
      fs.renameSync(scratch, entry);
      found = { directory: entry, meta: meta ?? null };
    } catch {
      // The name is taken: a concurrent build of the same inputs won, and its output is the entry. Any other refusal
      // (a scanner holding the new files) leaves this build unpublished; it still serves this call.
      found = readEntry(entry);
      hit = Boolean(found);
      if (!found) {
        try {
          copyOutputs(scratch, into, files);
        } finally {
          remove(scratch);
        }
        return { meta: meta ?? null, hit: false };
      }
      remove(scratch);
    }
  }
  copyOutputs(found.directory, into, files);
  return { meta: found.meta, hit };
}
