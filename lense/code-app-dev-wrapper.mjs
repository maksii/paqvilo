// Windows-owned root remains alive after its app exits so the supervisor can drain its descendants.
import { spawn } from 'node:child_process';
process.once('message', ({ command, cwd }) => {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', (error) => process.send?.({ type: 'error', message: error.message }));
  child.once('exit', (code, signal) => process.send?.({ type: 'exit', code, signal }));
});
// IPC keeps this owner alive until the supervisor terminates the whole tree.
