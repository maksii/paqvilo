import net from 'node:net';
import { randomInt } from 'node:crypto';

// A browser debugging port must be chosen before the browser binds it. A port from listen(0)
// lies in the operating system's ephemeral range (Windows 49152-65535, Linux 32768-60999),
// which a busy host hands to other sockets within seconds; dev reported such a port "already in
// use" after a 15 s Mirage startup. Pick below both ranges instead and confirm it is free now.
const FIRST = 20_000;
const END = 32_000;

export async function freeDebugPort() {
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
  throw new Error(`No free loopback debugging port found in ${FIRST}-${END}`);
}
