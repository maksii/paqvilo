// A controlled gate for a source refresh that overlaps a running workflow handler: the handler's first record write is
// held until a reload has read the changed source, so the overlap is deterministic instead of timed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Starts a workflow request with `start()`, holds the store's first updateRecordAsync (the handler's write) until
 * `app.reload()` has read `sourcePath`, and answers the workflow response once the reload has finished.
 * `beforeReload()` runs while the handler is held (to change the source); `label` names the source in failures.
 */
export async function reloadDuringHandler(t, { app, sourcePath, start, beforeReload = () => {}, label }) {
  const wrote = Promise.withResolvers();
  const release = Promise.withResolvers();
  const publishing = Promise.withResolvers();
  t.signal.addEventListener('abort', release.resolve, { once: true });
  const update = app.store.updateRecordAsync.bind(app.store);
  const updateMock = t.mock.method(app.store, 'updateRecordAsync', async (...args) => {
    const result = await update(...args);
    wrote.resolve();
    await release.promise;
    return result;
  });
  const readFile = fs.readFile.bind(fs);
  const readMock = t.mock.method(fs, 'readFile', (file, ...args) => {
    if (path.resolve(String(file)).toLowerCase() === sourcePath.toLowerCase()) publishing.resolve();
    return readFile(file, ...args);
  });
  const pending = start();
  let reload;
  try {
    await Promise.race([
      wrote.promise,
      pending.then((response) => assert.fail(`The workflow never entered its handler (HTTP ${response.status})`)),
    ]);
    await beforeReload();
    reload = app.reload();
    await Promise.race([publishing.promise, reload.then(() => assert.fail(`Reload never read the ${label} source`))]);
  } finally {
    release.resolve();
  }
  const response = await pending;
  await reload;
  readMock.mock.restore();
  updateMock.mock.restore();
  return response;
}
