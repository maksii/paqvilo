import { verifyStateStorage } from './lib/state-storage-check.mjs';
if (process.argv.includes('--help') || process.argv.includes('-h'))
  console.log(
    'Usage: paqvilo mirage verify-storage [--json]\nChecks a disposable 600,000-row state, journal performance, restart and conflicts. Requires about 2 GiB free memory and 1 GiB temporary disk space.',
  );
else console.log(JSON.stringify(await verifyStateStorage()));
