import fs from 'node:fs';
import path from 'node:path';

// The legacy Windows resolver walks every path component with synchronous lstat.
// Native resolution keeps the same canonical-path boundary without that walk.
export function realLocalPath(file) {
  return process.platform === 'win32' ? fs.realpathSync.native(file) : fs.realpathSync(file);
}

const identity = (stat) => `${stat.dev}:${stat.ino}`;
const version = (stat) => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function checkSize(stat, maxBytes) {
  if (!stat.isFile() || stat.size > maxBytes || !Number.isSafeInteger(Number(stat.size)))
    throw new Error('Local file is not regular or exceeds its read limit');
}

/** Read one validated file descriptor, bounded even if a writer grows the file.
 * Confinement checks use resolved roots; identity checks reject path swaps. Files
 * may legitimately change during editing: callers retry rather than using mixed bytes.
 */
export async function readLocalFile(file, { root, maxBytes = 32 * 1024 * 1024, encoding } = {}) {
  const real = await fs.promises.realpath(file);
  if (root && !inside(await fs.promises.realpath(root), real)) throw new Error('Local file is outside its source root');
  const handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    // Windows file IDs can exceed Number's exact range. Keep identities and
    // timestamps exact; convert only the validated byte length for Buffer APIs.
    const before = await handle.stat({ bigint: true });
    checkSize(before, maxBytes);
    const expectedSize = Number(before.size);
    if (
      (await fs.promises.realpath(file)) !== real ||
      identity(await fs.promises.stat(real, { bigint: true })) !== identity(before)
    )
      throw new Error('Local file changed before reading');
    const buffer = Buffer.allocUnsafe(expectedSize + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (
      size !== expectedSize ||
      version(await handle.stat({ bigint: true })) !== version(before) ||
      (await fs.promises.realpath(file)) !== real ||
      identity(await fs.promises.stat(real, { bigint: true })) !== identity(before)
    )
      throw new Error('Local file changed during reading');
    const body = buffer.subarray(0, size);
    return encoding ? body.toString(encoding) : body;
  } finally {
    await handle.close();
  }
}

export function readLocalFileSync(file, { root, maxBytes = 32 * 1024 * 1024, encoding, expectedRealPath } = {}) {
  const real = realLocalPath(file);
  // An opt-in caller validation boundary also refuses a link inserted before this reader's first realpath.
  if (expectedRealPath !== undefined && real !== expectedRealPath) throw new Error('Local file changed before reading');
  if (root && !inside(realLocalPath(root), real)) throw new Error('Local file is outside its source root');
  const descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    checkSize(before, maxBytes);
    const expectedSize = Number(before.size);
    if (realLocalPath(file) !== real || identity(fs.statSync(real, { bigint: true })) !== identity(before))
      throw new Error('Local file changed before reading');
    const buffer = Buffer.allocUnsafe(expectedSize + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (
      size !== expectedSize ||
      version(fs.fstatSync(descriptor, { bigint: true })) !== version(before) ||
      realLocalPath(file) !== real ||
      identity(fs.statSync(real, { bigint: true })) !== identity(before)
    )
      throw new Error('Local file changed during reading');
    const body = buffer.subarray(0, size);
    return encoding ? body.toString(encoding) : body;
  } finally {
    fs.closeSync(descriptor);
  }
}
