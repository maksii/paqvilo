import fs from 'node:fs/promises';
import { readLocalFile } from '../../lense/local-file.mjs';

/** A source path that no longer names a file: deleted, or replaced by a folder, since the portal was loaded. */
const GONE = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);
/** What the local file reader says when the file was replaced or rewritten while it read it. */
const CHANGED = /^Local file changed (?:before|during) reading$/;
/** What it says for anything that is not a regular file within its limit. */
const NOT_REGULAR = /^Local file is not regular/;
/** Reads of one response while a save or a checkout keeps replacing the file. */
const READS = 3;

function missing(file, pathname, cause) {
  return Object.assign(
    new Error(
      `The source file of web file ${pathname} is missing: ${file}. It is served again once the file is back.`,
      { cause },
    ),
    { status: 404, code: 'WEB_FILE_SOURCE_MISSING' },
  );
}

/**
 * The real paths of a web file's source and of its export root, for a response. Between a deletion or a checkout and
 * the source reload that follows it, the loaded portal still lists a file that is gone: that request answers 404, as
 * the reloaded portal will, instead of failing as a rendering error.
 */
export async function webFileSourcePaths(sourceDir, file, pathname, { realpath = fs.realpath } = {}) {
  try {
    return { root: await realpath(sourceDir), file: await realpath(file) };
  } catch (cause) {
    if (GONE.has(cause.code)) throw missing(file, pathname, cause);
    throw cause;
  }
}

/**
 * The bytes of a web file's source for a response. The reader refuses the bytes of a file that was replaced or
 * rewritten under it (a save, a checkout), so that read is made again; a file that keeps changing fails as before.
 * A file that is gone answers 404 (see webFileSourcePaths).
 */
export async function readWebFileSource(file, root, pathname, { read = readLocalFile, stat = fs.stat } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(file, { root, maxBytes: Number.MAX_SAFE_INTEGER });
    } catch (cause) {
      if (GONE.has(cause.code)) throw missing(file, pathname, cause);
      // The reader opens a folder where the platform allows it and then refuses it as not regular.
      if (NOT_REGULAR.test(cause.message) && (await stat(file).catch(() => null))?.isDirectory())
        throw missing(file, pathname, cause);
      if (attempt >= READS || !CHANGED.test(cause.message)) throw cause;
    }
  }
}
