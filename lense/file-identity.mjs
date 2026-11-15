import fs from 'node:fs/promises';
import path from 'node:path';

/** Observe a selected local path without reading its contents. Missing paths retain lexical identity. */
export async function fileIdentity(file) {
  const resolved = path.resolve(file);
  try {
    const [real, stat] = await Promise.all([fs.realpath(resolved), fs.stat(resolved, { bigint: true })]);
    return { resolved, real, stat };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { resolved };
  }
}

/** Compare spelling, resolved links and exact filesystem IDs, including hard-link aliases. */
export function sameFile(left, right) {
  const normalize = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
  return Boolean(
    normalize(left.resolved) === normalize(right.resolved) ||
    (left.real && right.real && normalize(left.real) === normalize(right.real)) ||
    (left.stat && right.stat && left.stat.ino && left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino),
  );
}
