import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The file of a pack module entry (an absolute path or a file URL); null for anything else. */
function moduleFile(module) {
  if (module instanceof URL || /^file:/i.test(String(module))) {
    try {
      return fileURLToPath(String(module));
    } catch {
      return null;
    }
  }
  return typeof module === 'string' && path.isAbsolute(module) ? module : null;
}

export const packChangeNotice = (file) => ({
  code: 'PACK_FILE_CHANGED',
  severity: 'warning',
  file,
  message: `The data pack file ${file} changed after this runtime loaded its packs. Packs load at startup, so the runtime still runs the code it loaded: restart Mirage to use the change.`,
});

/**
 * Packs load once, at startup: a later save of a pack file changes nothing in the running runtime, and nothing says
 * so. This watches the folder of every project pack module (`modules`: absolute paths or file URLs) and calls
 * `onChange(file)` once per JavaScript or JSON file saved there. A folder that cannot be watched is passed over.
 * Returns a function that ends the watch.
 */
export function watchPackFiles(modules, onChange, { watch = fs.watch } = {}) {
  const folders = new Set(
    modules
      .map(moduleFile)
      .filter(Boolean)
      .map((file) => path.dirname(file)),
  );
  const reported = new Set();
  const watchers = [];
  for (const folder of folders) {
    try {
      const watcher = watch(folder, { persistent: false }, (_event, name) => {
        if (!name || !/\.(?:mjs|cjs|js|json)$/i.test(String(name))) return;
        const file = path.join(folder, String(name));
        if (reported.has(file)) return;
        reported.add(file);
        onChange(file);
      });
      watcher.on?.('error', () => {});
      watchers.push(watcher);
    } catch {
      /* The folder is gone or cannot be watched: there is nothing to report from it. */
    }
  }
  return () => {
    for (const watcher of watchers) watcher.close();
  };
}
