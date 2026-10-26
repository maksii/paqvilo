import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

async function fingerprint(sourceDir, implementation) {
  sourceDir = path.resolve(sourceDir);
  const hash = createHash('sha256');
  async function walk(dir) {
    const entries = ((await fs.readdir(dir, { withFileTypes: true }).catch(gone)) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (excludedEntry(sourceDir, dir, entry, implementation)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const content = await fs.readFile(file).catch(gone);
        if (!content) continue;
        hash.update(path.relative(sourceDir, file).replaceAll('\\', '/'));
        hash.update('\0');
        hash.update(content);
        hash.update('\0');
      }
    }
  }
  await walk(sourceDir);
  return hash.digest('hex');
}

const fingerprintCache = new Map();
/**
 * The same digest as sourceFingerprint, recomputed only when a file is added, removed or
 * its size, modification/change time or identity differs. Writing a file always changes
 * its change time, so served-on-demand edits still invalidate evidence immediately.
 */
export async function cachedSourceFingerprint(sourceDir) {
  return cachedFingerprint(sourceDir, false);
}

export async function cachedImplementationSourceFingerprint(sourceDir) {
  return cachedFingerprint(sourceDir, true);
}

async function cachedFingerprint(sourceDir, implementation) {
  const root = path.resolve(sourceDir);
  const lines = [];
  async function walk(dir) {
    const entries = ((await fs.readdir(dir, { withFileTypes: true }).catch(gone)) ?? [])
      .filter((entry) => !excludedEntry(root, dir, entry, implementation))
      .sort((a, b) => a.name.localeCompare(b.name));
    const stats = await Promise.all(
      entries.map((entry) =>
        entry.isFile() ? fs.stat(path.join(dir, entry.name), { bigint: true }).catch(gone) : null,
      ),
    );
    for (const [index, entry] of entries.entries()) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (stats[index]) {
        const stat = stats[index];
        lines.push(`${path.relative(root, file)}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0${stat.ino}`);
      }
    }
  }
  await walk(root);
  const key = createHash('sha256').update(lines.join('\n')).digest('hex');
  const cacheKey = `${implementation ? 'implementation' : 'source'}\0${root}`;
  const cached = fingerprintCache.get(cacheKey);
  if (cached?.signature === key) return cached.digest;
  const digest = await fingerprint(root, implementation);
  fingerprintCache.set(cacheKey, { signature: key, digest });
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
