// Windows-owned root remains alive after its app exits so the supervisor can drain its descendants.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopCodeAppDevServer } from './code-app-dev-stop.mjs';

// After a disconnect process.send still exists but cannot deliver, so reports are sent only while connected.
function reportWhileConnected(source, message) {
  if (source.connected) source.send(message);
}

/**
 * Runs the launch the supervisor sends over IPC. `source` is the wrapper's process (or a double with the same events),
 * `spawnChild` and `stop` are the launch and the tree stop.
 */
export function runWrapper({ source = process, spawnChild = spawn, stop = stopCodeAppDevServer } = {}) {
  source.once('message', ({ command, cwd, verbatim = false }) => {
    const child = spawnChild(command[0], command.slice(1), {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    const report = (message) => reportWhileConnected(source, message);
    child.once('error', (error) => report({ type: 'error', message: error.message }));
    child.once('exit', (code, signal) => report({ type: 'exit', code, signal }));
    // The supervisor's IPC channel closes when the supervisor exits, so nothing owns the launched tree; it is ended here.
    // A tree that does not close is still a live child, which keeps this wrapper alive.
    source.once('disconnect', () => {
      // The supervisor has gone, so a stop that fails has no receiver to report it to.
      if (child.exitCode === null && child.signalCode === null) stop(child, closed).catch(() => {});
    });
  });
}

// IPC keeps this owner alive until the supervisor terminates the whole tree. Both paths are resolved, so a linked or
// differently spelled path to this file still runs it.
const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
if (entry === fs.realpathSync(fileURLToPath(import.meta.url))) runWrapper();
