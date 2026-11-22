import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether `file` (its lstat `stat`) is a link the operating system installs above every user folder, such as macOS's
 * /var and /tmp (links into /private): owned by root, in a folder owned by root that no group or other user may write,
 * so neither a project nor another account can have placed or replaced it. Windows reports every owner as 0, so no link
 * counts there.
 */
export function systemLink(file, stat, platform = process.platform) {
  if (platform === 'win32' || !stat.isSymbolicLink() || stat.uid !== 0) return false;
  try {
    const parent = fs.statSync(path.dirname(file));
    return parent.uid === 0 && (parent.mode & 0o022) === 0;
  } catch {
    return false;
  }
}
