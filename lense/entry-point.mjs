// Whether a module is the script Node was started with. Only Node built-ins are imported, so the dependency bootstrap
// can use it before the toolkit's dependencies are installed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `moduleUrl` (its `import.meta.url`) is the process entry point. Node loads the entry script
 * from its real path, so `import.meta.url` names the file behind every symbolic link while `process.argv[1]` keeps the
 * path as typed: on macOS `/tmp` and `/var` are links into `/private`, and a script started as `/tmp/x/run.mjs` has
 * the URL `file:///private/tmp/x/run.mjs`. The started path matches as typed (also under --preserve-symlinks-main, which
 * keeps the linked path) or resolved the same way.
 */
export function isEntryPoint(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  const self = fileURLToPath(moduleUrl);
  if (path.resolve(entry) === self) return true;
  try {
    return fs.realpathSync(entry) === self;
  } catch {
    return false;
  }
}
