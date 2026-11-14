// Writes the one-scenario live matrix for the baseline bridge suites (baseline-bridge-complete, baseline-bridge-startup), whose
// bridge runs a test's server script. The arguments run it through runBaselineCapture.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Writes the matrix into `directory` and returns the `capture` arguments that run it; the run's receipt is written to `directory/out`. */
export async function liveCaptureArgs(directory, server, marker) {
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
  return ['--matrix', matrix, '--out', path.join(directory, 'out'), '--side', 'live', '--all-scenarios'];
}
