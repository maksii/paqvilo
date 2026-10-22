// RC4b-03: the vault key file is readable by the current user only (on Windows an icacls ACL without inheritance, verified)
// and a concurrent first use never reads an empty or partial key: every creator links a complete key file or reads the winner's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { flowVault, VAULT_KEY_FILE } from '../lib/flow-vault.mjs';

const temporary = async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-vault-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};

test('the key file grants the current user only', { skip: process.platform === 'win32' ? false : 'POSIX: mode 0600 is checked below; the icacls ACL applies on Windows only' }, async t => {
  const directory = await temporary(t);
  flowVault(directory).seal({ probe: 1 });
  const file = path.join(directory, VAULT_KEY_FILE);
  const shown = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [file], { encoding: 'utf8' });
  const entries = shown.stdout.split(/\r?\n/).map(line => line.replace(file, '').trim()).filter(line => /:\(.*\)$/.test(line));
  assert.equal(entries.length, 1, shown.stdout);
  assert.match(entries[0], /\\[^\\:]+:\(F\)$/, 'one entry: the current user with full control, nothing inherited');
  assert.deepEqual((await fs.readdir(directory)).sort(), [VAULT_KEY_FILE], 'no temporary file is left');
});

test('the key file has mode 0600 on POSIX', { skip: process.platform === 'win32' ? 'Windows ignores the mode; the ACL test covers it' : false }, async t => {
  const directory = await temporary(t);
  flowVault(directory).seal({ probe: 1 });
  assert.equal((await fs.stat(path.join(directory, VAULT_KEY_FILE))).mode & 0o777, 0o600);
});

test('concurrent first uses in separate threads agree on one complete key', async t => {
  const directory = await temporary(t);
  const source = `import { parentPort, workerData } from 'node:worker_threads';
    const { flowVault } = await import(workerData.module);
    try { parentPort.postMessage({ sealed: flowVault(workerData.directory).seal({ worker: workerData.index }) }); }
    catch (error) { parentPort.postMessage({ error: error.code ?? error.message }); }`;
  const module = new URL('../lib/flow-vault.mjs', import.meta.url).href;
  const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)), { workerData: { module, directory, index } });
    worker.once('message', resolve); worker.once('error', reject);
  })));
  assert.deepEqual(answers.filter(answer => answer.error), [], 'no creator saw an empty key (VaultKeyInvalid) or failed');
  const vault = flowVault(directory);
  assert.deepEqual(answers.map(answer => vault.open(answer.sealed)), Array.from({ length: 8 }, (_, worker) => ({ worker })), 'every thread sealed under the one key on disk');
  assert.deepEqual((await fs.readdir(directory)).sort(), [VAULT_KEY_FILE], 'no temporary file is left');
});
