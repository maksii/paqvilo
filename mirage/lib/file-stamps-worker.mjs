// This worker has no portal, project, environment or module-preload inputs.
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const stamps = [];
let checked = 0;
let failureDetails;
for (const file of workerData.files) {
  checked++;
  try {
    const stat = fs.statSync(file, { bigint: true });
    stamps.push({ size: stat.size, ino: stat.ino, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
  } catch (error) {
    if (error.code === 'ENOENT') stamps.push(null);
    else {
      failureDetails = { name: error.name, message: error.message };
      for (const key of ['code', 'errno', 'syscall', 'path'])
        if (typeof error[key] === 'string' || typeof error[key] === 'number') failureDetails[key] = error[key];
      break;
    }
  }
}
parentPort.postMessage({
  version: 1,
  id: workerData.id,
  checked,
  ...(failureDetails ? { error: failureDetails } : { stamps }),
});
