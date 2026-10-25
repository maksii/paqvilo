import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { mirageCommandHint } from '../lense/stop-command.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const lenseCli = fileURLToPath(new URL('../lense/cli.mjs', import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
);

export function toolkitCommandHint(args) {
  return mirageCommandHint([args], { cli });
}

export function runToolkit(...args) {
  return withProcessSlot(
    () =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [lenseCli, ...args],
          { env, encoding: 'utf8', windowsHide: true, timeout: 150_000 },
          (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
        );
      }),
  );
}
