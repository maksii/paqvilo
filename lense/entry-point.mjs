// Whether a module is the script Node was started with. Only Node built-ins are imported, so the dependency bootstrap
// can use it before the toolkit's dependencies are installed.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `moduleUrl` (its `import.meta.url`) is the process entry point. Node loads the entry script
 * from its real path, so `import.meta.url` names the file behind every symbolic link while `process.argv[1]` keeps the
 * path as typed: on macOS `/tmp` and `/var` are links into `/private`, and a script started as `/tmp/x/run.mjs` has
 * the URL `file:///private/tmp/x/run.mjs`. The started path is resolved the same way before the two are compared.
 */
export function isEntryPoint(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  let real;
  try {
    real = fs.realpathSync(entry);
  } catch {
    return false;
  }
  return real === fileURLToPath(moduleUrl);
}
