// The nuspec identity read of a NuGet plug-in package: a whitespace run after the id must not block the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { zipOf } from '../lib/dataverse-solutions.mjs';

const READER = new URL('../lib/clr-assembly-reader.mjs', import.meta.url).href;
// The reader runs in a worker because a synchronous regex on the main thread cannot be interrupted by the test.
const WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';
const { inspectPackage } = await import(workerData.reader);
const { id, version } = inspectPackage(workerData.bytes);
parentPort.postMessage({ id, version });
`;
const WORKER_URL = new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`);
const packageWith = (nuspec) => zipOf([{ name: 'p.nuspec', data: Buffer.from(nuspec) }]);

// The test's own signal stops the worker when the test is cancelled by --test-timeout, so a hang cannot outlive it.
async function inspectInWorker(bytes, signal) {
  const worker = new Worker(WORKER_URL, { workerData: { bytes, reader: READER } });
  try {
    const [result] = await once(worker, 'message', { signal });
    return result;
  } finally {
    await worker.terminate();
  }
}

// @test-kind security: an uploaded nuspec must not freeze the Mirage process through a whitespace run after its id
test('a NuGet nuspec whose id has a whitespace run and no closing tag returns a null id', async (t) => {
  const hostile = packageWith(`<package><metadata><id>${' '.repeat(200_000)}</metadata></package>`);
  assert.deepEqual(await inspectInWorker(hostile, t.signal), { id: null, version: null });
});

// @test-kind contract: the nuspec id and version are returned trimmed, and a missing id is null
test('NuGet nuspec id and version values are trimmed and a missing id is null', async (t) => {
  const padded = packageWith(
    '<package><metadata><id>  Contoso.Padded\n </id><version>\t1.2.3 </version></metadata></package>',
  );
  assert.deepEqual(await inspectInWorker(padded, t.signal), { id: 'Contoso.Padded', version: '1.2.3' });
  const missing = packageWith('<package><metadata><version>1.0.0</version></metadata></package>');
  assert.deepEqual(await inspectInWorker(missing, t.signal), { id: null, version: '1.0.0' });
});
