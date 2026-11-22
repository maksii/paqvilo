import fs from 'node:fs';

// The links macOS installs above every user folder, and where each one points. Nothing else is trusted: a check on
// ownership alone would also pass every link a project or archive creates when the tool runs as root (a container, CI,
// sudo).
const MACOS_SYSTEM_LINKS = new Map([
  ['/tmp', 'private/tmp'],
  ['/var', 'private/var'],
  ['/etc', 'private/etc'],
]);

/**
 * Whether `file` (its lstat `stat`) is one of the links macOS installs above every user folder (/tmp, /var and /etc,
 * links into /private): that exact path, pointing at its fixed target and owned by root. No link is trusted elsewhere.
 */
export function systemLink(file, stat, platform = process.platform) {
  if (platform !== 'darwin' || !stat.isSymbolicLink() || stat.uid !== 0) return false;
  const target = MACOS_SYSTEM_LINKS.get(file);
  if (!target) return false;
  try {
    return fs.readlinkSync(file) === target;
  } catch {
    return false;
  }
}
