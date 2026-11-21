// Unix socket paths are limited by sun_path; only Node built-ins are imported, so the start channel can use this.
import os from 'node:os';

/** The longest Unix socket path, in bytes, before the terminating NUL of sun_path: 108 on Linux, 104 elsewhere. */
const unixSocketPathLimit = (platform = process.platform) => (platform === 'linux' ? 107 : 103);

/**
 * The folder to put a Unix socket in, `tail` bytes (its name, and any folder of its own) below it: the temporary folder
 * when the path fits, else /tmp. A longer path cannot be listened on (EINVAL), and macOS's per-user temporary folder
 * already takes about 50 of the 103 bytes, so a longer TMPDIR (a sandbox, a CI runner) would leave too little.
 */
export function unixSocketFolder(tail, { platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  return Buffer.byteLength(tmpdir) + 1 + tail <= unixSocketPathLimit(platform) ? tmpdir : '/tmp';
}
