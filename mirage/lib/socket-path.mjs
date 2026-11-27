// Unix socket paths are limited by sun_path; only Node built-ins are imported, so the start channel can use this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The longest Unix socket path this toolkit uses, in bytes: sun_path (108 on Linux, 104 elsewhere) less one for a NUL. */
const unixSocketPathLimit = (platform = process.platform) => (platform === 'linux' ? 107 : 103);

/**
 * This account's private folder in the shared /tmp: created closed to others (mode 700) and used only when it is a real
 * folder owned by this account that no one else can enter, so another local account can neither place nor read a socket
 * in it.
 */
function privateSocketFolder(base, uid) {
  if (!Number.isInteger(uid)) throw new Error('A private socket folder needs a POSIX account id.');
  const folder = path.posix.join(base, `paqvilo-${uid}`);
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = fs.lstatSync(folder);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw Object.assign(
      new Error(
        `The socket folder ${folder} must be a folder owned by this account and closed to other accounts (mode 700); remove it or set a shorter TMPDIR.`,
      ),
      { code: 'SocketFolderUnsafe' },
    );
  return folder;
}

/**
 * The folder to put a Unix socket in, `tail` bytes (its name, and any folder of its own) below it: the temporary folder
 * when the path fits, else `shared`: by default this account's private folder in `base` (/tmp). A longer path cannot be listened on
 * (EINVAL), and macOS's per-user temporary folder already takes about 50 of the 103 bytes, so a longer TMPDIR (a sandbox,
 * a CI runner) would leave too little.
 */
export function unixSocketFolder(
  tail,
  {
    platform = process.platform,
    tmpdir = os.tmpdir(),
    base = '/tmp',
    uid = process.getuid?.(),
    shared = () => privateSocketFolder(base, uid),
  } = {},
) {
  return Buffer.byteLength(tmpdir) + 1 + tail <= unixSocketPathLimit(platform) ? tmpdir : shared();
}
