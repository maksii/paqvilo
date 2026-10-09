import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

function discoveryDirectories(stateFile) {
  const directories = new Set([path.join(process.cwd(), '.paqvilo/simulator')]);
  let ancestor = path.dirname(path.resolve(stateFile));
  while (true) {
    directories.add(path.join(ancestor, '.paqvilo/simulator'));
    if (path.basename(ancestor) === '.paqvilo') directories.add(path.join(ancestor, 'simulator'));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return [...directories];
}
const samePath = (left, right) => {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
};
const running = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (cause) { return cause.code === 'EPERM'; }
};

/** Offline imports never replace an active runtime's independently held state. */
export async function assertOfflineState(stateFile, { directory, isRunning = running } = {}) {
  if (typeof stateFile !== 'string' || !stateFile) throw new Error('An existing state file is required.');
  for (const candidate of directory ? [directory] : discoveryDirectories(stateFile)) {
  let files;
  try { files = await fs.readdir(candidate); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
  for (const file of files.filter(name => /^session-\d+\.json$/.test(name))) {
    let session;
    try { session = JSON.parse(await fs.readFile(path.join(candidate, file), 'utf8')); }
    catch (cause) { if (cause.code === 'ENOENT' || cause instanceof SyntaxError) continue; throw cause; }
    const states = [session.stateFile, ...(session.portals ?? []).map(portal => portal.stateFile)].filter(value => typeof value === 'string');
    if (states.some(value => samePath(value, stateFile)) && isRunning(session.pid))
      throw new Error('Stop the Mirage using this state before importing reference records.');
  }
  }
}

export async function stateFileFingerprint(stateFile) {
  return createHash('sha256').update(await fs.readFile(stateFile)).digest('hex');
}
