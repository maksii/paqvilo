// The channel on which a starting Mirage runtime tells the toolkit command that started it what happens: its start-up
// phases, that its event loop turns, and that it is ready. The command waits for these announcements instead of
// looking at files at intervals, so a start costs no polling and a slow host only delays the announcement.
//
// The command listens on a local endpoint of its own (a named pipe on Windows, a socket in a private temporary folder
// elsewhere) and names it to the runtime in START_CHANNEL_ENV. An announcement carries no authority: `ready` only makes
// the command read the discovery record and ask the runtime's status, which decide. Only Node built-ins are imported.
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runtimeStartupEvent } from './startup-progress.mjs';

/** The environment variable that names the command's endpoint to the runtime it starts. */
export const START_CHANNEL_ENV = 'MIRAGE_START_CHANNEL';

/**
 * Opens the command's endpoint. `next()` resolves with the next announcement ({ phase, elapsedMs }); repeated calls
 * before one arrives share the same wait, so a caller may race it against other events and ask again. `close()`
 * removes the endpoint; announcements a runtime still makes are then dropped on its side.
 * @returns {Promise<{address: string, next: () => Promise<{phase: string, elapsedMs: number}>, close: () => Promise<void>}>}
 */
export async function openStartChannel({ platform = process.platform } = {}) {
  let directory = null,
    address;
  if (platform === 'win32') address = String.raw`\\.\pipe\paqvilo-start-${randomBytes(16).toString('hex')}`;
  else {
    // mkdtemp creates the folder for this user only, so no other account can reach the socket in it.
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-start-'));
    address = path.join(directory, 'channel.sock');
  }
  const queue = [];
  let pending = null,
    wake = null;
  const announce = (event) => {
    if (!wake) return void queue.push(event);
    const resolve = wake;
    wake = null;
    pending = null;
    resolve(event);
  };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let rest = '';
    socket.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      // A line is bounded like a progress line of the start-up log.
      rest = lines.pop().slice(-2048);
      for (const line of lines) {
        const event = runtimeStartupEvent(line);
        if (event) announce(event);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, resolve);
    });
  } catch (error) {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // The command's own work keeps it running; a forgotten endpoint must not.
  server.unref();
  let closed = null;
  return {
    address,
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      pending ??= new Promise((resolve) => {
        wake = resolve;
      });
      return pending;
    },
    close() {
      closed ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      })();
      return closed;
    },
  };
}

/**
 * The runtime's side: returns `report(event)`, which sends one announcement to the command named by `address` and
 * does nothing when no command waits (a runtime started by hand) or the command has gone. Announcements made before
 * the connection is established are sent once it is. The connection never keeps the runtime running.
 */
export function startChannelReporter(address = process.env[START_CHANNEL_ENV]) {
  if (typeof address !== 'string' || !address) return () => {};
  let socket = net.connect(address);
  const gone = () => {
    socket = null;
  };
  socket.on('error', gone);
  socket.on('close', gone);
  socket.unref();
  return (event) => {
    socket?.write(`${JSON.stringify({ type: 'runtime-startup', ...event })}\n`);
  };
}
