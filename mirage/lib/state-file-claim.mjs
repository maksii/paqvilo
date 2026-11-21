import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/*
 * One runtime writes a state file. The writer lock beside the file is held only while a save runs, and the ownership
 * records of `mirage start` are per project folder and unknown to `mirage serve`, so two runtimes could open one state
 * file and overwrite each other's saves without either being told. A runtime that persists its state therefore claims
 * the file for as long as it runs: it listens on a local endpoint named after the file (a named pipe on Windows, a
 * socket in the temporary folder elsewhere). The operating system releases the endpoint when the process ends, however
 * it ends, so a claim never outlives its runtime and no process number has to be judged. A second runtime finds the
 * endpoint taken, reads from it who holds the file, and refuses to start.
 */

/** The option under which createSimulator hands a host the claim it took, for the host's close to release. */
export const STATE_CLAIM = Symbol('state file claim');

/** The endpoint of the claim on `stateFile`: the same for every spelling of the path that names the same file. */
export async function stateFileEndpoint(stateFile, { platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  const resolved = path.resolve(stateFile);
  // The folder may be reached through a link or another letter case; the file itself may not exist yet.
  const folder = await fs.realpath(path.dirname(resolved)).catch(() => path.dirname(resolved));
  const real = path.join(folder, path.basename(resolved));
  const key = crypto
    .createHash('sha256')
    .update(platform === 'win32' ? real.toLowerCase() : real)
    .digest('hex')
    .slice(0, 32);
  return platform === 'win32'
    ? String.raw`\\.\pipe\paqvilo-state-` + key
    : path.join(tmpdir, `paqvilo-state-${key}.sock`);
}

/** " (pid N, url)" of the runtime that holds a claim, as far as it said who it is. */
function holderText(holder) {
  if (!holder?.pid) return '';
  return holder.url ? ` (pid ${holder.pid}, ${holder.url})` : ` (pid ${holder.pid})`;
}

const inUse = (stateFile, holder) =>
  Object.assign(
    new Error(
      `The state file ${stateFile} is in use by another Mirage runtime${holderText(holder)}. Two runtimes cannot write one state file: each would overwrite the other's saves. Stop that runtime, or start this one with --state <other file>.`,
    ),
    { status: 409, code: 'StateFileInUse', holder: holder ?? null },
  );

/** What the holder of `endpoint` says about itself, or `{}` when it says nothing readable; null when nobody holds it. */
function askHolder(endpoint, { connect = net.connect, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let text = '';
    let connected = false;
    const socket = connect(endpoint);
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(connected ? {} : null));
    socket.on('connect', () => {
      connected = true;
    });
    socket.on('data', (chunk) => {
      text += chunk;
    });
    socket.on('error', () => finish(connected ? {} : null));
    socket.on('close', () => {
      if (!connected) return resolve(null);
      try {
        return resolve(JSON.parse(text));
      } catch {
        return resolve({});
      }
    });
  });
}

/**
 * Claims `stateFile` for this process until `release()`. Rejects with 409 `StateFileInUse`, naming the holder, when
 * another runtime holds it. `describe(info)` sets what this holder tells a later claimant (`{ pid, url }`).
 */
export async function claimStateFile(stateFile, { platform = process.platform, endpoint } = {}) {
  const address = endpoint ?? (await stateFileEndpoint(stateFile, { platform }));
  let info = { pid: process.pid };
  const listen = () =>
    new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.end(`${JSON.stringify(info)}\n`);
      });
      server.once('error', reject);
      server.listen(address, () => {
        server.off('error', reject);
        server.on('error', () => {});
        server.unref();
        resolve(server);
      });
    });
  let server;
  for (let attempt = 1; ; attempt++) {
    try {
      server = await listen();
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const holder = await askHolder(address);
      if (holder) throw inUse(stateFile, holder);
      // Nobody answers: a socket file left by a process that was killed (never a named pipe). It is removed once.
      if (attempt > 1 || platform === 'win32') throw inUse(stateFile, null);
      await fs.rm(address, { force: true });
    }
  }
  return {
    endpoint: address,
    describe: (next) => {
      info = { pid: process.pid, ...next };
    },
    release: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * A claim on `stateFile` that is taken when the runtime first needs the file (`take()`), so a start refused for another
 * reason (an invalid option) says that reason; `describe` and `release` do nothing before it is taken.
 */
export function deferredStateClaim(stateFile) {
  let taking = null;
  let info = null;
  return {
    take: () =>
      (taking ??= claimStateFile(stateFile).then((claim) => {
        if (info) claim.describe(info);
        return claim;
      })),
    describe: (next) => {
      info = next;
      void taking?.then(
        (claim) => claim.describe(next),
        () => {},
      );
    },
    release: async () => {
      const claim = await taking?.catch(() => null);
      taking = null;
      await claim?.release();
    },
  };
}
