import fs from 'node:fs/promises';
import path from 'node:path';
import { hashStateFile } from './state-stream.mjs';
import { requiredArgument } from './required-argument.mjs';
import { lockHost } from '../../lense/process-identity.mjs';

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
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
};
const running = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === 'EPERM';
  }
};

/** The parsed discovery file, or null when it is gone or not complete yet. */
async function readDiscovery(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT' || cause instanceof SyntaxError) return null;
    throw cause;
  }
}

/**
 * The discovery file in `candidate` of a runtime that may use `stateFile`, or null. A runtime stamped with another
 * host than `host` may be running there: its PID says nothing here, so it counts as using the state.
 */
async function candidateUsesState(candidate, stateFile, isRunning, host) {
  let files;
  try {
    files = await fs.readdir(candidate);
  } catch (cause) {
    if (cause.code === 'ENOENT') return false;
    throw cause;
  }
  for (const file of files.filter((name) => /^session-\d+\.json$/.test(name))) {
    const session = await readDiscovery(path.join(candidate, file));
    if (!session) continue;
    const states = [session.stateFile, ...(session.portals ?? []).map((portal) => portal.stateFile)].filter(
      (value) => typeof value === 'string',
    );
    if (!states.some((value) => samePath(value, stateFile))) continue;
    const foreign = typeof session.host === 'string' && session.host !== host;
    if (foreign || isRunning(session.pid))
      return { file: path.join(candidate, file), host: foreign ? session.host : null };
  }
  return null;
}

/**
 * Offline writes never replace an active runtime's independently held state. `operation` names the attempted
 * operation in the refusal (for example "scaffolding data").
 */
export async function assertOfflineState(
  stateFile,
  { directory, isRunning = running, operation = 'importing reference records', host = lockHost() } = {},
) {
  // Only a call without arguments names the function; a command without --state passes undefined.
  if (arguments.length === 0) requiredArgument('assertOfflineState(stateFile)', 'a state file path');
  if (typeof stateFile !== 'string' || !stateFile) throw new Error('An existing state file is required.');
  for (const candidate of directory ? [directory] : discoveryDirectories(stateFile)) {
    const user = await candidateUsesState(candidate, stateFile, isRunning, host);
    if (user)
      throw new Error(
        `Stop the Mirage using this state (${path.resolve(stateFile)}) before ${operation}.` +
          (user.host
            ? ` It was started on ${user.host}; if it no longer runs there (the host was renamed or removed), delete ${user.file}.`
            : ''),
      );
  }
}

export async function stateFileFingerprint(
  stateFile = requiredArgument('stateFileFingerprint(stateFile)', 'a state file path'),
) {
  return hashStateFile(stateFile);
}
