// Tests type-check through the pinned TypeScript command line and never load the compiler as a library: the
// command line is the interface every TypeScript major keeps.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

/**
 * Runs `tsc <args>` and returns its exit status with everything it printed; a non-zero status does not throw.
 * Diagnostics are always the plain `file(line,column): error TSnnnn: message` form, whatever the terminal or
 * FORCE_COLOR says.
 */
export function tsc(args, options = {}) {
  const result = spawnSync(process.execPath, [compiler, '--pretty', 'false', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`tsc was ended by ${result.signal}`);
  return { status: result.status, output: result.stdout + result.stderr };
}
