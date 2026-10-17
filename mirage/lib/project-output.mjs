import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function canonical(file) {
  const tail = [];
  let parent = path.resolve(file);
  while (!fs.existsSync(parent)) {
    tail.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...tail);
}

/** Refuse generated cache/report output inside an npm installation, even via a junction. */
export function assertProjectOutput(file, root = packageRoot) {
  if (!file || !root.split(/[\\/]/).includes('node_modules')) return;
  const relative = path.relative(canonical(root), canonical(file));
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error(`Project output cannot be written inside the installed package: ${file}. Select a consumer catalogue or project output path.`);
}
