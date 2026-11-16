import http from 'node:http';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';

/** A health exchange whose body and socket lifetimes are separately observed.
 * Runtime termination can precede delivery of the client's socket-close event.
 * Keep this client owned until that event rather than leaving an implicit fetch
 * pool, or closing it before the runtime owner under test is exercised. */
export async function ownedHealthRequest(t, url) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let socket;
  const closed = Promise.withResolvers();
  const request = http.get(url, { agent, signal: t.signal });
  request.once('socket', (connected) => {
    socket = connected;
    socket.once('close', closed.resolve);
  });
  ownedFixture(t).add(async () => {
    request.destroy();
    agent.destroy();
    if (socket) await closed.promise;
  });
  const status = await new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (response) => {
      response.once('error', reject);
      response.once('end', () => resolve(response.statusCode));
      response.resume();
    });
  });
  return { status, closed: closed.promise };
}
