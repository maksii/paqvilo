import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SetupStore, setupError, setupDocs, setupVersion } from './store.mjs';

const assets = { '/_setup/': ['index.html', 'text/html'], '/_setup/app.mjs': ['app.mjs', 'text/javascript'], '/_setup/style.css': ['style.css', 'text/css'] };
const loopback = name => ['127.0.0.1', 'localhost', '[::1]'].includes(name);
const respond = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};
function requestOrigin(req) {
  let origin;
  try { origin = new URL(`http://${req.headers.host}`); } catch { throw setupError('Invalid setup Host.', 403); }
  if (!loopback(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.host !== req.headers.host) throw setupError('Setup accepts only loopback hosts.', 403);
  const address = req.socket.localAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) throw setupError('Setup accepts only loopback connections.', 403);
  if (Number(origin.port || 80) !== req.socket.localPort) throw setupError('Incorrect setup port.', 403);
  if (req.headers.origin && req.headers.origin !== origin.origin) throw setupError('Cross-origin setup requests are refused.', 403);
  const navigation = ['GET', 'HEAD'].includes(req.method) && ['/\u005fsetup', '/\u005fsetup/'].includes(req.url?.split('?')[0]) && req.headers['sec-fetch-mode'] === 'navigate' && !req.headers.origin;
  if (!navigation && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw setupError('Cross-site setup requests are refused.', 403);
  return origin.origin;
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw setupError('Send application/json.', 415);
  if (Number(req.headers['content-length']) > 512 * 1024) throw setupError('Setup request exceeds 512 KiB.', 413);
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) throw setupError('Setup request exceeds 512 KiB.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw setupError('Invalid JSON request.'); }
}

/** Mount before portal routing/audit/auth. Private fixed assets and same-origin configuration API. */
export async function createSetupHandler(options = {}) {
  const store = options.store ?? new SetupStore(options);
  const csrf = randomBytes(32).toString('hex');
  const initialRevision = await store.files().then(files => files.revision, () => null);
  const runtime = options.runtime ?? null;
  const snapshot = async () => {
    try {
      const value = await store.snapshot();
      return { ...value, canEdit: true, csrf, runtime: runtime ? { ...runtime, restartRequired: value.revision !== initialRevision } : null };
    } catch (error) {
      return { schemaVersion: 1, kind: store.kind, directory: store.directory, version: setupVersion, docs: setupDocs,
        ready: false, canEdit: false, csrf, revision: null, layers: { shared: { file: store.file, exists: true, text: '' } }, sites: [], settings: {},
        findings: [{ code: 'configuration', message: `${error.message} Repair the selected file path outside setup, then refresh.` }],
        runtime: runtime ? { ...runtime, restartRequired: true } : null };
    }
  };
  return async (req, res) => {
    const pathname = req.url?.split('?')[0];
    if (!/^\/_setup(?:\/|$)/.test(pathname ?? '')) return false;
    try {
      const origin = requestOrigin(req);
      if (pathname === '/_setup' && ['GET', 'HEAD'].includes(req.method)) { res.writeHead(302, { Location: '/_setup/', 'Cache-Control': 'no-store' }); res.end(); return true; }
      if (assets[pathname] && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = assets[pathname];
        const content = await fs.readFile(new URL(file, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
        res.end(req.method === 'HEAD' ? undefined : content); return true;
      }
      if (pathname === '/_setup/api/status' && req.method === 'GET') respond(res, 200, await snapshot());
      else if (pathname === '/_setup/api/config' && req.method === 'POST') {
        const token = req.headers['x-paqvilo-setup-csrf'];
        if (req.headers.origin !== origin || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) throw setupError('Reload setup before saving (invalid CSRF token/origin).', 403);
        await store.save(await body(req));
        respond(res, 200, await snapshot());
      } else respond(res, 404, { error: { message: 'Unknown setup endpoint.' } });
    } catch (error) { respond(res, error.status ?? 400, { error: { message: error.message } }); }
    return true;
  };
}

export async function startSetupServer({ port = 0, ...options } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw setupError('Setup port must be 0–65535.');
  const handler = await createSetupHandler(options);
  const server = http.createServer((req, res) => { handler(req, res).then(handled => { if (!handled) respond(res, 404, { error: { message: 'Open /_setup/.' } }); }).catch(() => { if (!res.headersSent) respond(res, 500, { error: { message: 'Setup request failed.' } }); }); });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { server.close(); throw error; }
  return { url: `http://127.0.0.1:${server.address().port}/_setup/`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
