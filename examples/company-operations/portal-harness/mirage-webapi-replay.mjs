import http from 'node:http';
import { handleWebApi } from 'paqvilo/mirage/lib/webapi-handler.mjs';
import { stringifyExactJson } from 'paqvilo/mirage/lib/exact-numeric.mjs';

/** Owned loopback transport for the real Mirage Web API handler. The explicit
 * frozen identity is the input to permission evaluation; this adapter does not
 * qualify the simulator's sign-in/session middleware or contact authentication.
 * No native credentials, headers or cookies are accepted or forwarded. */
export async function createWebApiReplayClient({ store, identity, portal, metadata }) {
  if (!store || !portal?.settings || !identity)
    throw new Error('Replay requires a frozen store, identity and source site settings.');
  const capturedIdentity = structuredClone(identity);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || !url.pathname.startsWith('/_api/')) {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      await handleWebApi(req, res, url, {
        store,
        identity: capturedIdentity,
        portal,
        metadata,
        origin: url.origin,
        origins: [url.origin],
        csrf: 'owned-loopback-replay',
        json(out, status, body, headers = {}) {
          out.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            ...headers,
          });
          out.end(status === 204 ? undefined : stringifyExactJson(body));
        },
      });
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    qualificationScope:
      'Real Mirage Web API handler and JSON serializer over owned loopback; explicitly supplied frozen identity',
    async request(path) {
      if (closed) throw new Error('Replay transport is closed.');
      if (typeof path !== 'string' || !path.startsWith('/_api/') || path.startsWith('//'))
        throw new Error('Replay accepts relative Web API read paths only.');
      const url = new URL(path, origin);
      if (url.origin !== origin || url.hash || !url.pathname.startsWith('/_api/'))
        throw new Error('Replay request escaped the owned Web API origin.');
      const response = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error' });
      return { status: response.status, body: await response.text(), mime: response.headers.get('content-type') };
    },
    async close() {
      if (closed) return;
      closed = true;
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
