// A loopback TCP server that accepts connections and never answers, for the emulator preflight suites (message-bus-servicebus,
// storage-azurite-transport): the probe must end by its own idle window, not by a refused or closed connection.
import { ownedFixture } from '../../testing/owned-fixture.mjs';
import net from 'node:net';

/** Starts the silent server; its sockets and the server close after t. Resolves to the port. */
export async function silentEndpointPort(t) {
  const sockets = new Set();
  const silent = net.createServer((socket) => sockets.add(socket)); // accepts, never answers
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  });
  return silent.address().port;
}
