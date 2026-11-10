import { reportCliError } from './cli-output.mjs';
import { parseToolArgs } from './tool-options.mjs';
import { verifyStateStorage } from './lib/state-storage-check.mjs';

try {
  const values = parseToolArgs('verify-storage', process.argv.slice(2));
  if (values.help)
    console.log(
      'Usage: paqvilo mirage verify-storage [--json]\nChecks a disposable 600,000-row state, journal performance, restart and conflicts. Requires about 2 GiB free memory and 1 GiB temporary disk space.',
    );
  else console.log(JSON.stringify(await verifyStateStorage()));
} catch (error) {
  reportCliError(error);
  process.exitCode = 1;
}
