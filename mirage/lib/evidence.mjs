import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { orderedMap } from '../../lense/async-map.mjs';
import { stateDigest } from './state-stream.mjs';

export const stateFingerprint = (state) => stateDigest({ config: state.config, data: state.data });

/** Loaded modules and files served on demand must both remain stable for evidence. */
export const implementationEvidence = (loaded, current) => ({
  loadedImplementationFingerprint: loaded,
  implementationFingerprint: createHash('sha256').update(loaded).update('\0').update(current).digest('hex'),
  implementationChanged: loaded !== current,
});

/** Hash observed export bytes, not a guessed deployed commit. Symlinks are never followed. */
export async function sourceFingerprint(sourceDir) {
  return fingerprint(sourceDir, false);
}

/** SDK build products are not runtime implementation inputs. Export/plugin hashes retain them. */
export async function implementationSourceFingerprint(sourceDir) {
  return fingerprint(sourceDir, true);
}

function excludedEntry(root, dir, entry, implementation) {
  if (entry.isSymbolicLink() || ['.git', '.portalconfig', 'node_modules', '.paqvilo'].includes(entry.name)) return true;
  const relative = path.relative(root, dir).split(path.sep);
  return implementation && entry.isDirectory() && relative[0] === 'test-sdk' && ['bin', 'obj'].includes(entry.name);
}

// A file or folder removed while the walk runs (a test or tool cleaning up) is not part of the fingerprint.
const gone = (error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
};

// One awaited read per file costs a thread-pool round trip each (seconds for the toolkit tree on a loaded Windows host),
// so files are read this many at a time, below the default descriptor limits, and hashed in walk order.
const READ_CONCURRENCY = 32;

/**
 * Files in sorted depth-first order. Each level's directories are read concurrently (the same round-trip cost as
 * file reads); a directory removed during the walk has no files.
 */
async function fingerprintFiles(root, implementation) {
  const children = new Map();
  let level = [root];
  while (level.length) {
    const nested = await orderedMap(level, READ_CONCURRENCY, async (dir) => {
      const entries = ((await fs.readdir(dir, { withFileTypes: true }).catch(gone)) ?? [])
        .filter((entry) => !excludedEntry(root, dir, entry, implementation))
        .sort((a, b) => a.name.localeCompare(b.name));
      children.set(dir, entries);
      return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
    });
    level = nested.flat();
  }
  const files = [];
  const flatten = (dir) => {
    for (const entry of children.get(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) flatten(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  flatten(root);
  return files;
}

async function fingerprint(sourceDir, implementation) {
  sourceDir = path.resolve(sourceDir);
  const files = await fingerprintFiles(sourceDir, implementation);
  const hash = createHash('sha256'),
    reads = [];
  const read = (index) => {
    if (index >= files.length) return;
    const content = fs.readFile(files[index]).catch(gone);
    content.catch(() => {}); // a read still in flight when an earlier one fails is not an unhandled rejection
    reads[index] = content;
  };
  for (let index = 0; index < READ_CONCURRENCY; index++) read(index);
  for (const [index, file] of files.entries()) {
    const content = await reads[index];
    reads[index] = null;
    read(index + READ_CONCURRENCY);
    if (!content) continue;
    hash.update(path.relative(sourceDir, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

const fingerprintCache = new Map();
// File times advance in ticks (Linux coarse clocks, Windows timer ticks, FAT 2 s), so a second same-size write in the
// tick of the first keeps every stat field. A digest is reused only when no file changed within this window of the walk.
const RACY_WINDOW_NS = 2_000_000_000n;
/**
 * The same digest as sourceFingerprint, recomputed only when a file is added, removed or
 * its size, modification/change time or identity differs. A file written within RACY_WINDOW_NS
 * of the walk could change again without a visible stat change, so its digest is never reused.
 */
export async function cachedSourceFingerprint(sourceDir) {
  return cachedFingerprint(sourceDir, false);
}

export async function cachedImplementationSourceFingerprint(sourceDir) {
  return cachedFingerprint(sourceDir, true);
}

async function cachedFingerprint(sourceDir, implementation) {
  const root = path.resolve(sourceDir);
  const walked = BigInt(Date.now()) * 1_000_000n;
  let newest = 0n;
  const files = await fingerprintFiles(root, implementation);
  const stamps = await orderedMap(files, 2 * READ_CONCURRENCY, async (file) => {
    const stat = await fs.stat(file, { bigint: true }).catch(gone);
    if (!stat) return null;
    for (const time of [stat.mtimeNs, stat.ctimeNs]) if (time > newest) newest = time;
    return `${path.relative(root, file)}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0${stat.ino}`;
  });
  const lines = stamps.filter((line) => line !== null);
  const key = createHash('sha256').update(lines.join('\n')).digest('hex');
  const cacheKey = `${implementation ? 'implementation' : 'source'}\0${root}`;
  const cached = fingerprintCache.get(cacheKey);
  if (cached?.signature === key) return cached.digest;
  const digest = await fingerprint(root, implementation);
  if (newest < walked - RACY_WINDOW_NS) fingerprintCache.set(cacheKey, { signature: key, digest });
  else fingerprintCache.delete(cacheKey);
  return digest;
}

export function observedEvidence(report, state) {
  if (!report) return null;
  const stale =
    report.simulator?.stateSha256 !== stateFingerprint(state) ||
    report.simulator?.sourceFingerprint !== state.status.sourceFingerprint ||
    !state.status.implementationFingerprint ||
    report.simulator?.implementationFingerprint !== state.status.implementationFingerprint ||
    report.localOrigin !== state.status.localOrigin;
  return {
    ...report,
    stale,
    passed: report.passed === true && !stale,
    verified: report.verified === true && !stale,
    originalPassed: report.passed,
  };
}
