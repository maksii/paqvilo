import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SetupStore, setupError, setupDocs, setupStages, setupVersion } from './store.mjs';
import { setupTemplates } from './templates.mjs';
import { settingsCatalogue } from './settings-catalogue.mjs';
import { plannedTopology } from './topology.mjs';

// Browser files of this folder by allowlist (a new server-side module is never served), plus the shared, import-free admin modules.
const BROWSER_FILES = { '/_setup/': 'index.html', '/_setup/index.html': 'index.html', '/_setup/app.mjs': 'app.mjs', '/_setup/style.css': 'style.css',
  '/_setup/ui-kit.mjs': '../../mirage/admin/ui-kit.mjs', '/_setup/ui-kit.css': '../../mirage/admin/ui-kit.css', '/_setup/shell.css': '../../mirage/admin/shell.css',
  '/_setup/dashboard-view.mjs': '../../mirage/admin/dashboard-view.mjs', '/_setup/help-content.mjs': '../../mirage/admin/help-content.mjs',
  '/_setup/dashboard-map.mjs': '../../mirage/admin/dashboard-map.mjs', '/_setup/dashboard-icons.mjs': '../../mirage/admin/dashboard-icons.mjs', '/_setup/dashboard.css': '../../mirage/admin/dashboard.css' };
const TYPES = { mjs: 'text/javascript', css: 'text/css', html: 'text/html' };
const asset = pathname => (Object.hasOwn(BROWSER_FILES, pathname) ? BROWSER_FILES[pathname] : null);
const quote = value => (/^[\w./:\\-]+$/.test(value) ? value : `"${String(value).replace(/"/g, '')}"`);
// Commands that start a preview this page can be mounted in (the restart command repeats the one that ran).
const COMMANDS = new Set(['mirage dev', 'mirage start', 'mirage serve', 'lense dev']);
const SITE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
/**
 * The running product, site and command: the host's runtime, then the setup options a host spreads in
 * (site, command), then MIRAGE_SETUP_RUNTIME, which `paqvilo mirage dev|start` sets for the Mirage child it spawns.
 */
function runningRuntime(options, env = process.env) {
  if (!options.runtime) return null;
  let launched = {};
  try { launched = JSON.parse(env.MIRAGE_SETUP_RUNTIME ?? '{}') ?? {}; } catch { launched = {}; }
  const site = [options.runtime.site, options.site, launched.site].find(value => typeof value === 'string' && SITE.test(value));
  const command = [options.runtime.command, options.command, launched.command].find(value => COMMANDS.has(value));
  return { ...options.runtime, site, command: command ?? (options.runtime.product === 'Lense' ? 'lense dev' : options.store.kind === 'project' ? 'mirage serve' : 'mirage dev') };
}
/** The command that restarts the running preview with the saved configuration, run from the configuration folder. */
function commandArgs(runtime, store, value) {
  const name = quote(store.file.split(/[\\/]/).pop());
  if (store.kind === 'project') return { file: `--project ${name}`, site: '' };
  const ids = (value?.sites ?? []).map(site => site.id);
  const site = runtime?.site && (!ids.length || ids.includes(runtime.site)) ? runtime.site : value?.settings?.defaultSite || ids[0];
  return { file: `--config ${name}`, site: site ? `--site ${quote(site)}` : '' };
}
function restartCommand(runtime, store, value) {
  const { site } = commandArgs(runtime, store, value);
  return `npx paqvilo ${runtime.command} ${store.kind === 'project' ? '--project' : '--config'} ${quote(store.file)}${site ? ` ${site}` : ''}`;
}
// What the restart comparison covers, named in the banner (RU3-20).
const RESTART_SCOPE = { Mirage: 'Mirage runtime settings, sources, Solutions, packs, port and startup preset of the running target',
  Lense: 'the site environments, start page, scope, routes and browser settings Lense loaded, plus the Mirage runtime settings' };
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
  const runtime = runningRuntime({ ...options, store });
  // Restart drift compares what the preview loaded (store.runtimeIdentity), not the file revision (RB-08).
  // An identity that cannot be computed makes the comparison unknown (null with a reason), never a silent false (RU3-02).
  const identity = () => store.runtimeIdentity(runtime?.site, runtime?.product).then(value => ({ value }), error => ({ error: error.message }));
  const initialIdentity = runtime ? await identity() : null;
  const drift = async () => {
    const now = await identity(), failure = initialIdentity.error ?? now.error;
    return failure ? { restartRequired: null, restartReason: `identity unavailable: ${failure}` } : { restartRequired: now.value !== initialIdentity.value, restartReason: null };
  };
  const running = (value, state) => (runtime ? { ...runtime, ...state, restartScope: RESTART_SCOPE[runtime.product] ?? RESTART_SCOPE.Mirage, restartCommand: restartCommand(runtime, store, value) } : null);
  const templates = setupTemplates(store.kind), catalogue = settingsCatalogue(store.kind);
  const snapshot = async () => {
    try {
      const value = await store.snapshot();
      const current = running(value, runtime ? await drift() : {});
      return { ...value, canEdit: true, csrf, runtime: current, commandArgs: commandArgs(runtime, store, value), stages: setupStages(value, current), topology: plannedTopology(value), templates, settingsCatalogue: catalogue };
    } catch (error) {
      const value = { schemaVersion: 1, kind: store.kind, directory: store.directory, version: setupVersion, docs: setupDocs,
        ready: false, canEdit: false, csrf, revision: null, layers: { shared: { file: store.file, exists: true, text: '' } }, sites: [], settings: {},
        findings: [{ code: 'configuration', section: '#advanced', message: `${error.message} Repair the selected file path outside setup, then refresh.` }] };
      value.runtime = running(value, { restartRequired: null, restartReason: `identity unavailable: ${error.message}` });
      return { ...value, commandArgs: commandArgs(runtime, store, value), stages: setupStages(value, value.runtime), topology: plannedTopology(value), templates, settingsCatalogue: catalogue };
    }
  };
  return async (req, res) => {
    const pathname = req.url?.split('?')[0];
    if (!/^\/_setup(?:\/|$)/.test(pathname ?? '')) return false;
    try {
      const origin = requestOrigin(req);
      if (pathname === '/_setup' && ['GET', 'HEAD'].includes(req.method)) { res.writeHead(302, { Location: '/_setup/', 'Cache-Control': 'no-store' }); res.end(); return true; }
      const file = asset(pathname);
      const content = file && ['GET', 'HEAD'].includes(req.method) ? await fs.readFile(new URL(file, import.meta.url)).catch(() => null) : null;
      if (content) {
        const type = TYPES[file.split('.').pop()];
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
