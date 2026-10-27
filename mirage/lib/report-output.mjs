import fs from 'node:fs/promises';
import path from 'node:path';
import { fileIdentity, sameFile } from '../../lense/file-identity.mjs';

// Resolve a not-yet-created output through its nearest existing ancestor as well.
async function canonicalOutput(file) {
  let current = path.resolve(file);
  const tail = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // realpath also reports ENOENT for a dangling link. Climbing past it
      // would resolve the wrong destination and could permit a source write.
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new Error('Report output must not use a dangling symbolic link', { cause: error });
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};

/** Keep generated reports outside the exports and distinct from the selected configuration. */
export async function assertReportOutput(file, { sourceRoots = [], inputFiles = [] } = {}) {
  const output = await fileIdentity(file);
  const canonical = await canonicalOutput(file);
  for (const input of inputFiles.filter(Boolean)) {
    if (sameFile(output, await fileIdentity(input)))
      throw new Error('Report output must not replace a configuration or source file');
  }
  for (const root of sourceRoots.filter(Boolean)) {
    const rootPath = path.resolve(root);
    if (inside(rootPath, output.resolved)) throw new Error('Report output must be outside portal and solution sources');
    let rootReal;
    try {
      rootReal = await fs.realpath(rootPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (inside(rootReal, canonical)) throw new Error('Report output must be outside portal and solution sources');
    // Only an existing output with multiple links can be an external hardlink to a source.
    if (!output.stat || output.stat.nlink <= 1n || !output.stat.ino) continue;
    const pending = [rootReal];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(candidate);
        else if (entry.isFile() || entry.isSymbolicLink()) {
          let stat;
          try {
            stat = await fs.stat(candidate, { bigint: true });
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
          if (stat.isFile() && stat.ino && stat.ino === output.stat.ino && stat.dev === output.stat.dev)
            throw new Error('Report output must not replace a configuration or source file');
        }
      }
    }
  }
}
