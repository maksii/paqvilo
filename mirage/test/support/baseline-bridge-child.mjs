// Spawns `baseline-suite.mjs capture` for the live side of a one-scenario matrix whose bridge runs a test's server script, for
// the baseline bridge suites (baseline-bridge-complete, baseline-bridge-startup). The caller owns the child's exit and output.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../baseline-suite.mjs', import.meta.url));

/** Writes the matrix into `directory` and spawns its capture on `signal`; the run's receipt is written to `directory/out`. */
export async function spawnLiveCapture(signal, directory, server, marker) {
  const matrix = path.join(directory, 'matrix.json');
  await fs.writeFile(
    matrix,
    JSON.stringify({
      version: 1,
      origin: 'https://fixture.invalid',
      live: { command: process.execPath, args: [server, marker] },
      scenarios: [{ id: 'fixture/read', steps: [{ goto: '/' }] }],
    }),
  );
  return spawn(
    process.execPath,
    [script, 'capture', '--matrix', matrix, '--out', path.join(directory, 'out'), '--side', 'live', '--all-scenarios'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal },
  );
}
