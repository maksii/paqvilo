import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertSmokeProcess } from '../scripts/smoke-process.mjs';

test('consumer bootstrap timeout reports the spawn cause and captured output', () => {
  const result = spawnSync(process.execPath, ['-e', "console.log('preparing'); setInterval(() => {}, 1000)"], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 500,
  });
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.throws(
    () => assertSmokeProcess(result, 'Installed consumer bootstrap failed'),
    (error) => /ETIMEDOUT/.test(error.message) && /status=null/.test(error.message) && /signal=/.test(error.message),
  );
  assert.throws(
    () => assertSmokeProcess({ status: 1, stdout: 'preparing', stderr: 'failure' }, 'bootstrap'),
    /preparing\nfailure/,
  );
  assert.doesNotThrow(() => assertSmokeProcess({ status: 0 }, 'success'));
});
