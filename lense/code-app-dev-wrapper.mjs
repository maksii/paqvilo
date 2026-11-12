// Windows-owned root remains alive after its app exits so the supervisor can drain its descendants.
import { spawn } from 'node:child_process';
import { stopCodeAppDevServer } from './code-app-dev-stop.mjs';
process.once('message', ({ command, cwd, verbatim = false }) => {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  // After a disconnect process.send still exists but cannot deliver, so reports are sent only while connected.
  const report = (message) => {
    if (process.connected) process.send(message);
  };
  child.once('error', (error) => report({ type: 'error', message: error.message }));
  child.once('exit', (code, signal) => report({ type: 'exit', code, signal }));
  // The supervisor's IPC channel closes when the supervisor exits, so nothing owns the launched tree; it is ended here.
  // A tree that does not close is still a live child, which keeps this wrapper alive.
  process.once('disconnect', () => {
    if (child.exitCode === null && child.signalCode === null) stopCodeAppDevServer(child, closed).catch(() => {});
  });
});
// IPC keeps this owner alive until the supervisor terminates the whole tree.
