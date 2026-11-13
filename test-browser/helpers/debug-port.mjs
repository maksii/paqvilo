import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// A port a consumer binds itself (Lense's --debug-port, a dev server's --strictPort) is chosen before that consumer
// starts. A port from listen(0) lies in the operating system's ephemeral range (Windows 49152-65535, Linux
// 32768-60999), which a busy host hands to other sockets within seconds, so pick below both ranges. Nothing can hold
// the port for the consumer, so another process may still take it before the consumer binds: `startOnFreePort`
// starts the consumer again on another port when the consumer reports exactly that.
const FIRST = 20_000;
const END = 32_000;
// A start that lost its port is repeated once on another port. A second loss in the same start needs two independent
// races; a third start would only delay a real failure's report past the test's own hang guard.
const STARTS = 2;
const POLL_MS = 50;

async function unusedPort() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = randomInt(FIRST, END);
    const server = net.createServer();
    const free = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (free) {
      await new Promise((resolve) => server.close(resolve));
      return port;
    }
  }
  throw new Error(`No free loopback port found in ${FIRST}-${END}`);
}

/**
 * True when `error` is Lense's report that the launched browser could not use `port`: it was taken before Lense
 * checked it, or between that check and the browser's bind (Lense then never finds its browser on the port). Lense
 * reports both only in its message, also when a child process prints it, so the message is matched here alone.
 */
function debugPortTaken(error, port) {
  return new RegExp(`Debugger port ${port} (?:is already in use|did not expose the selected browser profile)`).test(
    String(error?.message ?? error),
  );
}

/**
 * Runs `start(port)` on an unused port and returns its result. `start` resolves once the consumer owns the port and
 * rejects with the consumer's failure otherwise; a failure that `taken(error, port)` attributes to another process
 * taking the port starts the consumer again on another port. Each start owns its own clean-up.
 */
export async function startOnFreePort(start, taken = debugPortTaken) {
  for (let attempt = 1; ; attempt++) {
    const port = await unusedPort();
    try {
      return await start(port);
    } catch (error) {
      if (attempt >= STARTS || !taken(error, port)) throw error;
    }
  }
}

/** Browser arguments that let the browser itself choose a free debugging port when it binds; see `devToolsPort`. */
export const ANY_DEBUG_PORT_ARGS = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];

/**
 * The debugging port a browser launched with `ANY_DEBUG_PORT_ARGS` on the new profile `userDataDir` bound. The
 * browser writes it to DevToolsActivePort in the profile once it listens; the test's own timeout bounds the wait.
 */
export async function devToolsPort(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  for (;;) {
    // ENOENT: not written yet. EBUSY: Windows refuses the read while the browser has the file open to write it.
    const text = await fs.readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'EBUSY') return '';
      throw error;
    });
    // The first line is complete once the second (the browser's WebSocket path) has started.
    const [port, rest] = text.split('\n');
    if (rest !== undefined && /^\d+$/.test(port)) return Number(port);
    await delay(POLL_MS);
  }
}
