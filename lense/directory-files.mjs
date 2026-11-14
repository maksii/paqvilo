import fs from 'node:fs/promises';
import path from 'node:path';
import { orderedMap } from './async-map.mjs';

// Code-unit name order: listing order differs between file systems and operating systems, and a locale-aware order
// differs between processes.
const byName = (a, b) => Number(a.name > b.name) - Number(a.name < b.name);

/** Read directories concurrently, then flatten in depth-first name order. Never follows symlinks. */
export async function directoryFiles(root, { skip = new Set(), concurrency = 32 } = {}) {
  const children = new Map();
  let level = [root];
  while (level.length) {
    const nested = await orderedMap(level, concurrency, async (current) => {
      const entries = (await fs.readdir(current, { withFileTypes: true })).filter(
        (entry) => !entry.isSymbolicLink() && !skip.has(entry.name),
      );
      entries.sort(byName);
      children.set(current, entries);
      return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(current, entry.name));
    });
    level = nested.flat();
  }
  const files = [];
  const flatten = (current) => {
    for (const entry of children.get(current) ?? []) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) flatten(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  flatten(root);
  return files;
}
