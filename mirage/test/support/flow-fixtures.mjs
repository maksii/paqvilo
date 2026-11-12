// Serves flow routes on loopback for the flow HTTP suites (flow-http-callback, sim-flow-routes). The URL base is the request's own
// Host header, so the callback URL the routes issue (flowCallbackUrl reads url.origin) carries the port the test connects to.
import http from 'node:http';

/** Answers 404 for a request the routes do not take; the server closes after t. Resolves to the origin. */
export async function serveFlowRoutes(t, routes) {
  const server = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://' + req.headers.host)))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
