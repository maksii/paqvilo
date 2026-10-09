// Structured access to an explicitly owned paqvilo dev browser. Credentials stay in its
// ignored discovery file and are never printed or forwarded through HTTP redirects.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_JSON = 4 * 1024 * 1024;
const MAX_IMAGE = 32 * 1024 * 1024;
export const AGENT_ACTIONS = ['sessions', 'status', 'pages', 'events', 'state', 'snapshot', 'screenshot', 'viewport', 'navigate', 'reload', 'stop'];

function integer(value, name, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

export async function readDiscovery(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Session discovery must be a JSON file smaller than 64 KiB');
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new Error('Invalid session discovery JSON'); }
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw new Error('Invalid session endpoint'); }
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !value.id ||
      typeof value.token !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(value.token) ||
      endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Invalid paqvilo session discovery: expected version 1 and an authenticated loopback endpoint');
  }
  return { ...value, endpoint: endpoint.origin, discoveryFile: path.resolve(file) };
}

async function boundedBody(response, maximum) {
  const chunks = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error('Agent response exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function agentRequest(discovery, route, { body, timeout = 35_000, image = false } = {}) {
  if (!route.startsWith('/v1/') || route.startsWith('//') || route.includes('#')) throw new Error('Invalid agent route');
  let response;
  try {
    response = await fetch(`${discovery.endpoint}${route}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${discovery.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    const bytes = await boundedBody(response, image && response.ok ? MAX_IMAGE : MAX_JSON);
    if (image && response.ok) {
      if (!response.headers.get('content-type')?.startsWith('image/png') || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('Agent returned an invalid PNG screenshot');
      }
      return bytes;
    }
    let result;
    try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Agent returned invalid JSON'); }
    if (!response.ok) throw new Error(`Agent HTTP ${response.status}: ${String(result.error?.message ?? result.error ?? 'request failed').slice(0, 1000)}`);
    return result;
  } catch (error) {
    // Never include discovery objects or fetch options in an error (they contain the token).
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error(`Agent request timed out after ${timeout} ms`);
    if (error.message === 'fetch failed') throw new Error('Cannot reach the paqvilo agent session; it may have stopped');
    throw error;
  }
}

export async function listAgentSessions(stateDir) {
  const dir = path.join(stateDir, 'agents');
  let entries;
  try { entries = await fs.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return { schemaVersion: 1, sessions: [], invalidFiles: [], truncated: false }; throw err; }
  const names = entries.filter((entry) => entry.endsWith('.json')).sort();
  const sessions = [];
  const invalidFiles = [];
  // Bound concurrent connection attempts and do not remove stale files: a busy process may recover.
  for (let i = 0; i < Math.min(names.length, 64); i += 4) {
    await Promise.all(names.slice(i, Math.min(i + 4, 64)).map(async (name) => {
      const file = path.join(dir, name);
      let entry;
      try { entry = await readDiscovery(file); } catch { invalidFiles.push(file); return; }
      const item = { id: entry.id, pid: entry.pid, site: entry.site, environment: entry.environment,
        startedAt: entry.startedAt, portalOrigin: entry.portalOrigin, sourceDir: entry.sourceDir, discoveryFile: file };
      try {
        const status = await agentRequest(entry, '/v1/session', { timeout: 2000 });
        item.reachable = status.id === entry.id;
        if (!item.reachable) item.error = 'Session identity mismatch';
      } catch (err) { item.reachable = false; item.error = err.message; }
      sessions.push(item);
    }));
  }
  sessions.sort((a, b) => a.discoveryFile.localeCompare(b.discoveryFile));
  return { schemaVersion: 1, sessions, invalidFiles: invalidFiles.sort(), truncated: names.length > 64 };
}

export default async function agent(_cfg, args, positionals = []) {
  const action = positionals[0] ?? 'sessions';
  if (!AGENT_ACTIONS.includes(action)) throw new Error(`Unknown agent action "${action}". Expected ${AGENT_ACTIONS.join(', ')}`);
  const allowed = new Set(['config', 'json', 'help', ...(action === 'sessions' ? [] : ['session', 'timeout'])]);
  const pageActions = ['state', 'snapshot', 'screenshot', 'viewport', 'navigate', 'reload'];
  if (pageActions.includes(action)) allowed.add('page-id');
  for (const option of ({ events: ['after', 'limit'], snapshot: ['selector', 'limit', 'styles'], screenshot: ['output', 'full-page', 'include-panel'], viewport: ['width', 'height'], navigate: ['path'] }[action] ?? [])) allowed.add(option);
  for (const option of Object.keys(args)) if (!allowed.has(option)) throw new Error(`--${option} is not supported by agent ${action}`);
  const timeout = integer(args.timeout, '--timeout', 35_000, 100, 120_000);
  if (action === 'sessions') {
    const stateDir = path.join(args.config ? path.dirname(path.resolve(args.config)) : process.cwd(), '.paqvilo');
    console.log(JSON.stringify(await listAgentSessions(stateDir), null, 2));
    return 0;
  }
  if (!args.session) throw new Error(`agent ${action} requires --session <discovery-file>; use agent sessions to find it`);
  if (pageActions.includes(action) && !args['page-id']) throw new Error(`agent ${action} requires --page-id from agent pages`);
  if (action === 'navigate' && !args.path) throw new Error('agent navigate requires --path <portal-path>');
  if (action === 'screenshot' && (!args.output || path.extname(args.output).toLowerCase() !== '.png')) throw new Error('agent screenshot requires --output <file.png>');
  const discovery = await readDiscovery(args.session);
  const page = `/v1/pages/${encodeURIComponent(args['page-id'])}`;
  let route;
  let body;
  switch (action) {
    case 'status': route = '/v1/session'; break;
    case 'pages': route = '/v1/pages'; break;
    case 'events': route = `/v1/events?after=${integer(args.after, '--after', 0, 0, Number.MAX_SAFE_INTEGER)}&limit=${integer(args.limit, '--limit', 100, 1, 500)}`; break;
    case 'state': route = `${page}/state`; break;
    case 'snapshot': route = `${page}/dom`; body = { selector: args.selector, limit: integer(args.limit, '--limit', 100, 1, 200), styles: args.styles?.split(',').map((s) => s.trim()).filter(Boolean) }; break;
    case 'screenshot': route = `${page}/screenshot`; body = { fullPage: Boolean(args['full-page']), includePanel: Boolean(args['include-panel']) }; break;
    case 'viewport': route = `${page}/viewport`; body = { width: integer(args.width, '--width', 1440, 320, 4096), height: integer(args.height, '--height', 900, 240, 4096) }; break;
    case 'navigate': route = `${page}/navigate`; body = { url: args.path, timeoutMs: Math.min(60_000, Math.max(100, timeout - 1000)) }; break;
    case 'reload': route = `${page}/reload`; body = { timeoutMs: Math.min(60_000, Math.max(100, timeout - 1000)) }; break;
    case 'stop': route = '/v1/stop'; body = {}; break;
  }
  let handle;
  const output = args.output ? path.resolve(args.output) : null;
  if (output) { await fs.mkdir(path.dirname(output), { recursive: true }); handle = await fs.open(output, 'wx', 0o600); }
  try {
    const result = await agentRequest(discovery, route, { body, timeout, image: action === 'screenshot' });
    if (handle) {
      await handle.writeFile(result);
      console.log(JSON.stringify({ schemaVersion: 1, path: output, bytes: result.length }, null, 2));
    } else console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (handle) { await handle.close(); handle = null; await fs.rm(output, { force: true }); }
    throw err;
  } finally { await handle?.close(); }
  return 0;
}
