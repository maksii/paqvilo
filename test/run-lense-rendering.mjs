import { spawnSync } from 'node:child_process';

const engine = process.argv[2];
if (!['firefox', 'webkit'].includes(engine)) throw new Error('Select firefox or webkit for the Lense rendering suite.');

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--import=./test/browser-bootstrap.mjs',
    '--test-concurrency=2',
    '--test-timeout=300000',
    'test-browser/panel-chrome.test.mjs',
    'test-browser/panel-placement.test.mjs',
    'test-browser/rewrite.test.mjs',
    'test-browser/setup-quick.test.mjs',
    'test-browser/xray-card-placement.test.mjs',
  ],
  { env: { ...process.env, LENSE_TEST_ENGINE: engine }, stdio: 'inherit', windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
