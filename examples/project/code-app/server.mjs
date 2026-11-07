// Minimal loopback app server and same-origin bridge proxy. No Microsoft host or deployment is involved.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
let target = new URL(process.env.PAQVILO_MIRAGE_URL || process.env.MIRAGE_URL || 'http://127.0.0.1:8787');
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  throw new Error('MIRAGE_URL must be loopback HTTP');
if (process.send)
  process.on('message', (value) => {
    const next = new URL(value);
    if (next.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(next.hostname))
      throw new Error('MIRAGE_URL must be loopback HTTP');
    target = next;
    process.send('ready');
  });
const files = {
  '/': new URL('./index.html', import.meta.url),
  '/app.js': new URL('./app.js', import.meta.url),
  '/mirage-client.js': new URL(
    process.env.CODE_APP_CLIENT || import.meta.resolve('paqvilo/mirage/lib/code-apps-client.js'),
  ),
};
const server = http.createServer(async (req, res) => {
  // Only origin-form paths may reach the proxy; absolute/protocol-relative targets could change its destination.
  if (!/^\/(?![\\/])/.test(req.url)) {
    res.writeHead(400);
    res.end('Expected a local path');
    return;
  }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/_apps/code/')) {
    const expected = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(expected).host || (req.headers.origin && req.headers.origin !== expected)) {
      res.writeHead(403);
      res.end('Invalid origin');
      return;
    }
    const destination = new URL(target.origin);
    const requested = new URL(req.url, target.origin);
    destination.pathname = requested.pathname;
    destination.search = requested.search;
    const upstream = http.request(
      destination,
      {
        method: req.method,
        headers: { ...req.headers, host: target.host, ...(req.headers.origin ? { origin: target.origin } : {}) },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        // A truncated upstream response must not leave the browser waiting indefinitely.
        response.on('error', () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502);
        res.end('Mirage bridge unavailable');
      }
    });
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
    return;
  }
  if (!files[pathname]) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  try {
    const body = await readFile(fileURLToPath(files[pathname]));
    res.writeHead(200, {
      'content-type': pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
    });
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end('Sample file unavailable');
  }
});
server.listen(Number(process.env.CODE_APP_PORT || 5199), '127.0.0.1', () =>
  console.log(`Code app: http://127.0.0.1:${server.address().port}/`),
);
