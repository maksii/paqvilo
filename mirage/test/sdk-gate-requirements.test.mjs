import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeTemporaryDirectorySync } from '../testing/owned-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const preload = new URL('./support/sdk-tooling-unavailable.mjs', import.meta.url).href;

for (const [name, path, pattern, missing] of [
  [
    'Python Dataverse SDK',
    'mirage/test-sdk/python-dataverse/gate.test.mjs',
    'Python Dataverse SDK gate',
    'PAQ_TEST_MISSING_PYTHON',
  ],
  [
    'WebAPIService SDK',
    'mirage/test-sdk/webapi-samples/gate.test.mjs',
    'PowerApps-Samples WebAPIService',
    'PAQ_TEST_MISSING_DOTNET',
  ],
  [
    'MSAL.NET certificate SDK',
    'mirage/test-sdk/cert-auth/gate.test.mjs',
    'MSAL.NET WithCertificate',
    'PAQ_TEST_MISSING_DOTNET',
  ],
]) {
  for (const required of [false, true]) {
    test(`${name} ${required ? 'fails required verification' : 'reports an explicit optional skip'} without its client tooling`, () => {
      const env = { ...process.env, [missing]: '1', PAQ_TEST_REQUIRE_SDK_GATES: required ? '1' : '0' };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(
        process.execPath,
        ['--import', preload, '--test', '--test-reporter=tap', '--test-name-pattern', pattern, path],
        {
          cwd: root,
          env,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000,
        },
      );
      assert.equal(result.error, undefined, 'the controlled SDK gate process must finish');
      assert.equal(
        result.status === 0,
        !required,
        required
          ? 'required client verification cannot turn into a skipped success'
          : 'optional unavailable tooling remains an explicit skip',
      );
      if (!required) assert.match(result.stdout, /# skipped 1\b/);
    });
  }
}

test('Python gate aborts its owned SDK child when the test signal is cancelled', () => {
  const directory = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paq-python-gate-abort-'));
  const preload = path.join(directory, 'abort-python.mjs');
  fs.writeFileSync(
    preload,
    `import cp from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports, registerHooks } from 'node:module';
    const controller = new AbortController();
    globalThis.__paqSdkAbort = controller.signal;
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      return url.endsWith('/python-dataverse/gate.test.mjs')
        ? { ...result, source: String(result.source).replace('runGate(gate, t.signal)', 'runGate(gate, globalThis.__paqSdkAbort)') }
        : result;
    } });
    const exists = fs.existsSync;
    fs.existsSync = file => String(file).includes('.venv') ? true : exists(file);
    const spawn = cp.spawn;
    cp.spawn = (command, args, options) => {
      if (!String(command).includes('.venv')) return spawn(command, args, options);
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(23),1500)'], options);
      child.once('spawn', () => controller.abort());
      child.once('close', (code, signal) => console.log('INVENTED_PYTHON_EXIT:' + code + ':' + signal));
      return child;
    };
    syncBuiltinESMExports();`,
  );
  const env = { ...process.env, PAQ_TEST_REQUIRE_SDK_GATES: '1' };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        '--test',
        '--test-reporter=tap',
        'mirage/test-sdk/python-dataverse/gate.test.mjs',
      ],
      {
        cwd: root,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 150_000,
      },
    );
    assert.equal(result.error, undefined, 'cancellation must not leave the gate process hanging');
    assert.notEqual(result.status, 0, 'a cancelled gate cannot qualify verification');
    assert.match(
      result.stdout,
      /INVENTED_PYTHON_EXIT:null:/,
      'the SDK child is stopped by cancellation rather than its own exit',
    );
    assert.match(result.stdout, /ABORT_ERR/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
