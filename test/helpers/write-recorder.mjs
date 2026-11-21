import fs from 'node:fs';
import path from 'node:path';
import { tempDirSync } from '../fixture.mjs';

const preload = new URL('./record-writes-preload.mjs', import.meta.url).href;

/**
 * Records the file-system writes that commands started with `env()` attempt inside `roots`.
 *
 * A folder listing taken before and after a command cannot tell the command's writes from those of another process:
 * the checkout's `.paqvilo` is also written by the validation lanes that run beside a test. The recorder observes the
 * command's own process (and the Node processes it starts, which inherit the environment) instead.
 */
export function writeRecorder(t, roots) {
  const directory = tempDirSync('paqvilo-write-recorder-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'writes.ndjson');
  return {
    /** The environment of a recorded command, from the environment it would otherwise run in. */
    env(base = process.env) {
      return {
        ...base,
        NODE_OPTIONS: [base.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' '),
        PAQ_TEST_WRITE_LOG: log,
        PAQ_TEST_WRITE_ROOTS: JSON.stringify(roots),
      };
    },
    /** The writes recorded so far, in order: `{ operation, file }`. */
    writes() {
      if (!fs.existsSync(log)) return [];
      return fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}
