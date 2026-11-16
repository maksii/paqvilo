import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));

/**
 * The origins of the Mirage runtimes that `mirage status` reports as running for a project, sorted. `selection` is the
 * project choice (`['--config', file]` or `['--project', file]`); `options` go to the command (cwd, env, signal).
 *
 * A test that proves a runtime stopped asks this instead of requesting the runtime's old address: on a busy host
 * another process may already have been given the released port, and it answers.
 */
export async function runningRuntimeOrigins(selection, options = {}) {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'mirage', 'status', ...selection, '--json'], {
    windowsHide: true,
    ...options,
  });
  const status = JSON.parse(stdout);
  assert.equal(status.action, 'status');
  return status.sessions
    .filter((session) => session.processAlive && session.url)
    .map((session) => new URL(session.url).origin)
    .sort();
}
