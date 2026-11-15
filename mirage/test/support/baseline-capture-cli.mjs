import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../baseline-suite.mjs', import.meta.url));

/**
 * Runs `baseline-suite.mjs capture ...args` as a child on the test's abort signal (a test timeout stops it) and resolves
 * with its exit code and combined output once its output streams have closed.
 */
export function runBaselineCapture(args, signal) {
  const child = spawn(process.execPath, [script, 'capture', ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once('close', (code) => resolve({ code, output }));
    child.once('error', reject);
  });
}
