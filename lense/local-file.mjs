import fs from 'node:fs';
import path from 'node:path';

const identity = (stat) => `${stat.dev}:${stat.ino}`;
const version = (stat) => `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function checkSize(stat, maxBytes) {
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Local file is not regular or exceeds its read limit');
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
    const before = await handle.stat();
    checkSize(before, maxBytes);
    if (await fs.promises.realpath(file) !== real || identity(await fs.promises.stat(real)) !== identity(before))
      throw new Error('Local file changed before reading');
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== before.size || version(await handle.stat()) !== version(before) ||
        await fs.promises.realpath(file) !== real || identity(await fs.promises.stat(real)) !== identity(before))
      throw new Error('Local file changed during reading');
    const body = buffer.subarray(0, size);
    return encoding ? body.toString(encoding) : body;
  } finally { await handle.close(); }
}

export function readLocalFileSync(file, { root, maxBytes = 32 * 1024 * 1024, encoding } = {}) {
  const real = fs.realpathSync(file);
  if (root && !inside(fs.realpathSync(root), real)) throw new Error('Local file is outside its source root');
  const descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    checkSize(before, maxBytes);
    if (fs.realpathSync(file) !== real || identity(fs.statSync(real)) !== identity(before))
      throw new Error('Local file changed before reading');
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== before.size || version(fs.fstatSync(descriptor)) !== version(before) ||
        fs.realpathSync(file) !== real || identity(fs.statSync(real)) !== identity(before))
      throw new Error('Local file changed during reading');
    const body = buffer.subarray(0, size);
    return encoding ? body.toString(encoding) : body;
  } finally { fs.closeSync(descriptor); }
}
