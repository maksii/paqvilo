// A loopback HTTP server over one /_sim router, for the suites that call a router through real requests.
import { ownedFixture } from '../../testing/owned-fixture.mjs';
import http from 'node:http';

// Serves the request handler on loopback; closed after t. Resolves to the origin.
export async function serveHandler(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// Serves routes(req, res, url), answering 404 for a request it does not take; closed after t. Resolves to the origin.
export function serveRoutes(t, routes) {
  return serveHandler(t, async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://127.0.0.1')))) {
      res.writeHead(404);
      res.end();
    }
  });
}
