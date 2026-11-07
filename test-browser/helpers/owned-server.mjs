import { once } from 'node:events';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';

/** Own both shutdown steps before starting a synthetic loopback HTTP fixture. */
export async function listenOwnedServer(t, server) {
  const owner = ownedFixture(t);
  owner.add(() => server.closeAllConnections());
  owner.add(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
