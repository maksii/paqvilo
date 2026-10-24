import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readLocalFileSync } from '../../lense/local-file.mjs';
import { readSolutionAssetEntries, SOLUTION_ASSET_LIMITS } from './dataverse-solution-assets.mjs';

/**
 * Top-level Solution folders that runtime importers read outside the schema scan: workflow XAML and cloud-flow JSON,
 * web resources, custom APIs, duplicate rules, PCF controls, portal components and plug-in assemblies.
 */
export const SOLUTION_SIDE_FOLDERS =
  /^(?:workflows|webresources|customapis|fxexpressions|duplicaterules|controls|powerpagecomponents|pluginassemblies)$/i;
const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stampOf = (file) => {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
};

function directoryFiles(dir, folders) {
  const files = [];
  const visit = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name,
        file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (prefix || folders.test(entry.name)) visit(file, name);
      } else if (prefix && entry.isFile()) files.push({ name, file });
    }
  };
  visit(dir, '');
  return files.sort(byName);
}

// ponytail: the last 16 ZIP layers keep their selected entries in memory; switch to an LRU by bytes if layers grow huge.
const zipListings = new Map();
function zipLayerFiles(layer, folders) {
  const stamp = stampOf(layer.dir),
    key = `${folders.source}/${folders.flags}`;
  let cached = zipListings.get(layer.dir);
  zipListings.delete(layer.dir);
  if (cached?.stamp !== stamp) cached = { stamp, listings: new Map() };
  zipListings.set(layer.dir, cached);
  if (zipListings.size > 16) zipListings.delete(zipListings.keys().next().value);
  if (!cached.listings.has(key)) {
    const selected = (name) => name.includes('/') && folders.test(name.split('/')[0]);
    cached.listings.set(
      key,
      readSolutionAssetEntries(readLocalFileSync(layer.dir, { maxBytes: SOLUTION_ASSET_LIMITS.archiveBytes }), {
        include: selected,
      })
        .map((entry) => ({
          name: entry.name,
          read: (maxBytes = Infinity) => {
            if (entry.data.length > maxBytes) throw new Error('Solution archive entry exceeds its read limit');
            return entry.data;
          },
        }))
        .sort(byName),
    );
  }
  return [...cached.listings.get(key)];
}

/**
 * Files below the top-level `folders` of one Solution layer, sorted by Solution-relative name. A ZIP layer is read
 * through readSolutionAssetEntries (only the selected entries are inflated; one listing per ZIP stamp is memoised); any other layer is the directory `layer.dir` (symbolic links are skipped).
 * Each entry is { name, read(maxBytes) }; read returns the bytes and throws above maxBytes.
 */
export function solutionLayerFiles(layer, folders = SOLUTION_SIDE_FOLDERS) {
  if (!layer?.dir) return [];
  if (layer.type === 'zip') return zipLayerFiles(layer, folders);
  return directoryFiles(layer.dir, folders).map(({ name, file }) => ({
    name,
    read: (maxBytes = SOLUTION_ASSET_LIMITS.entryBytes) => readLocalFileSync(file, { root: layer.dir, maxBytes }),
  }));
}

// ponytail: one entry per physical side file or archive this process has hashed; prune by root if a host watches unbounded source sets.
const sideHashes = new Map();
const cachedHash = (key, stamp, compute) => {
  const hit = sideHashes.get(key);
  if (hit?.stamp === stamp) return hit.value;
  const value = compute();
  sideHashes.set(key, { stamp, value });
  return value;
};

/** [relative name, byte hash] of the side files of one scanned layer; unchanged files reuse their hash by stat stamp. */
function sideFileHashes(layer) {
  if (!layer.type || !layer.dir) return [];
  try {
    if (layer.type === 'zip') {
      return cachedHash(layer.dir, stampOf(layer.dir), () =>
        solutionLayerFiles(layer).map((file) => [file.name, sha256(file.read())]),
      );
    }
    return directoryFiles(layer.dir, SOLUTION_SIDE_FOLDERS).map(({ name, file }) => {
      try {
        return [
          name,
          cachedHash(file, stampOf(file), () =>
            sha256(readLocalFileSync(file, { root: layer.dir, maxBytes: SOLUTION_ASSET_LIMITS.entryBytes })),
          ),
        ];
      } catch {
        return [name, 'unreadable'];
      }
    });
  } catch {
    return [['', 'unreadable']];
  }
}

/** A logical source name; absolute checkout/archive locations never enter this identity. */
export function solutionContentPath(layer, file) {
  const normalized = String(file).replaceAll('\\', '/');
  const directory = String(layer.dir).replaceAll('\\', '/').replace(/\/$/, '');
  const archivePrefix = directory + '!/';
  if (normalized.startsWith(archivePrefix)) return normalized.slice(archivePrefix.length);
  return path.posix.relative(directory, normalized);
}

/**
 * Ordered layer identities, relative file names and byte hashes of the scanned documents and of the side files the
 * runtime imports (SOLUTION_SIDE_FOLDERS). Retain physical cache keys separately.
 */
export function solutionContentFingerprint(layers, { lcid = 1033, files = [] } = {}) {
  const digest = createHash('sha256');
  digest.update(JSON.stringify(['solution-content-v2', lcid]));
  for (const [index, layer] of layers.entries()) {
    digest.update(JSON.stringify([index, layer.solution?.uniqueName ?? null, layer.solution?.version ?? null]));
    const documents = new Map((layer.documents ?? []).map((document) => [document.file, document.hash ?? '']));
    const members = new Set((layer.files ?? []).map((file) => file.path));
    for (const file of files) {
      if (members.has(file.path)) documents.set(file.path, file.hash ?? documents.get(file.path) ?? '');
    }
    const entries = new Map([...documents].map(([file, hash]) => [solutionContentPath(layer, file), hash]));
    for (const [name, hash] of sideFileHashes(layer)) if (!entries.has(name)) entries.set(name, hash);
    const sorted = [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (const entry of sorted) digest.update(JSON.stringify(entry));
  }
  return digest.digest('hex');
}
