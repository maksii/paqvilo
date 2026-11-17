import workerThreads from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

const METADATA_WALK_CHANNEL = 'paqvilo.metadata-walk';
const observations = channel(METADATA_WALK_CHANNEL);
const fields = ['size', 'ino', 'mtimeNs', 'ctimeNs'];
const failure = (message) => Object.assign(new Error(message), { code: 'MetadataWorkerFailed' });
const ownedWorker = (url, options) => new workerThreads.Worker(url, options);
const observe = (stage, count, checked) => {
  if (observations.hasSubscribers) observations.publish({ stage, count, checked, at: performance.now() });
};
function packetResult(packet, id, count) {
  if (
    packet?.version !== 1 ||
    packet.id !== id ||
    !Number.isSafeInteger(packet.checked) ||
    packet.checked < 0 ||
    packet.checked > count
  )
    throw failure('Metadata worker returned an invalid result.');
  if (packet.error) {
    if (typeof packet.error.message !== 'string' || typeof packet.error.name !== 'string')
      throw failure('Metadata worker returned an invalid error.');
    const error =
      packet.error.name === 'TypeError' ? new TypeError(packet.error.message) : new Error(packet.error.message);
    for (const key of ['name', 'code', 'errno', 'syscall', 'path'])
      if (typeof packet.error[key] === 'string' || typeof packet.error[key] === 'number')
        error[key] = packet.error[key];
    return { error, checked: packet.checked };
  }
  if (
    !Array.isArray(packet.stamps) ||
    packet.stamps.length !== count ||
    packet.checked !== count ||
    Array.from(packet.stamps).some(
      (stamp) => stamp !== null && (!stamp || fields.some((key) => typeof stamp[key] !== 'bigint')),
    )
  )
    throw failure('Metadata worker returned incomplete stamps.');
  return { stamps: packet.stamps, checked: packet.checked };
}

/** Native metadata reads run serially off the HTTP/event-loop thread. Every walk
 * owns a short-lived worker and settles only after a valid result AND its exit. */
export function statFiles(files, { workerFactory = ownedWorker } = {}) {
  const entries = Array.from(files);
  if (!entries.length) return Promise.resolve([]);
  const id = randomUUID();
  observe('started', entries.length, 0);
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = workerFactory(new URL('./file-stamps-worker.mjs', import.meta.url), {
        workerData: { version: 1, id, files: entries },
        execArgv: [],
        env: {},
      });
    } catch (error) {
      observe('failed', entries.length, 0);
      reject(error);
      return;
    }
    let result, firstError;
    worker.on('message', (packet) => {
      try {
        if (result) throw failure('Metadata worker returned multiple results.');
        result = packetResult(packet, id, entries.length);
      } catch (error) {
        firstError ??= error;
      }
    });
    worker.on('error', (error) => {
      firstError ??= error;
    });
    worker.on('exit', (code) => {
      let stopped = firstError;
      if (!stopped) {
        if (code !== 0) stopped = failure('Metadata worker exited unsuccessfully.');
        else if (!result) stopped = failure('Metadata worker exited without a result.');
        else stopped = result.error;
      }
      observe(stopped ? 'failed' : 'finished', entries.length, result?.checked ?? 0);
      if (stopped) reject(stopped);
      else resolve(result.stamps);
    });
  });
}
