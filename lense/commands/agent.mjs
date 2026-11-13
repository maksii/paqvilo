// Structured access to an explicitly owned paqvilo dev browser. Credentials stay in its
// ignored discovery file and are never printed or forwarded through HTTP redirects.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalFile } from '../local-file.mjs';

const MAX_JSON = 4 * 1024 * 1024;
const MAX_IMAGE = 32 * 1024 * 1024;
const argument = (message, code = 'invalid_argument') => Object.assign(new Error(message), { code });
export const AGENT_ACTIONS = [
  'sessions',
  'status',
  'pages',
  'events',
  'state',
  'snapshot',
  'screenshot',
  'viewport',
  'navigate',
  'reload',
  'stop',
];

function outputName(output, config) {
  const relative = path.relative(config ? path.dirname(path.resolve(config)) : process.cwd(), output);
  return (path.isAbsolute(relative) ? path.basename(output) : relative).replaceAll('\\', '/');
}

function integer(value, name, fallback, min, max) {
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  ) {
    throw Object.assign(new Error(`${name} must be an integer between ${min} and ${max}`), {
      code: 'invalid_argument',
    });
  }
  return Number(value);
}

export async function readDiscovery(file) {
  let value;
  try {
    value = JSON.parse(await readLocalFile(file, { maxBytes: 64 * 1024, encoding: 'utf8' }));
  } catch (cause) {
    throw Object.assign(
      new Error(
        cause.code === 'ENOENT'
          ? 'Session discovery file not found (session stopped?)'
          : 'Invalid session discovery JSON or file exceeds 64 KiB',
      ),
      {
        code: cause.code === 'ENOENT' ? 'session_not_found' : 'invalid_session',
        status: cause.code === 'ENOENT' ? 404 : 400,
      },
    );
  }
  let endpoint;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw argument('Invalid session endpoint', 'invalid_session');
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.token !== 'string' ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(value.token) ||
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw argument(
      'Invalid paqvilo session discovery: expected version 1 and an authenticated loopback endpoint',
      'invalid_session',
    );
  }
  return { ...value, endpoint: endpoint.origin, discoveryFile: path.resolve(file) };
}

async function boundedBody(response, maximum) {
  const chunks = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximum) throw argument('Agent response exceeds the size limit', 'response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function agentRequest(
  discovery,
  route,
  { body, timeout = 35_000, image = false, fetchImpl = fetch } = {},
) {
  if (!route.startsWith('/v1/') || route.startsWith('//') || route.includes('#')) throw argument('Invalid agent route');
  // The deadline covers the response body too. It aborts with the reason AbortSignal.timeout gives, so callers see
  // the same TimeoutError, and it is a timer rather than AbortSignal.timeout so a test can drive it.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    timeout,
  );
  let response;
  try {
    response = await fetchImpl(`${discovery.endpoint}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${discovery.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: deadline.signal,
    });
    const bytes = await boundedBody(response, image && response.ok ? MAX_IMAGE : MAX_JSON);
    return parseAgentResponse(response, bytes, image);
  } catch (error) {
    // Never include discovery objects or fetch options in an error (they contain the token).
    if (error.name === 'TimeoutError' || error.name === 'AbortError')
      throw Object.assign(new Error(`Agent request timed out after ${timeout} ms`), {
        code: 'request_timeout',
        status: 504,
      });
    if (error.message === 'fetch failed')
      throw Object.assign(new Error('Cannot reach the paqvilo agent session; it may have stopped'), {
        code: 'session_unavailable',
      });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseAgentResponse(response, bytes, image) {
  if (image && response.ok) {
    if (
      !response.headers.get('content-type')?.startsWith('image/png') ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      throw argument('Agent returned an invalid PNG screenshot', 'invalid_response');
    }
    return bytes;
  }
  let result;
  try {
    result = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw argument('Agent returned invalid JSON', 'invalid_response');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw argument('Agent returned invalid JSON: expected an object', 'invalid_response');
  if (!response.ok)
    throw Object.assign(
      new Error(
        `Agent HTTP ${response.status}: ${String(result.error?.message ?? result.error ?? 'request failed').slice(0, 1000)}`,
      ),
      { code: result.error?.code, status: response.status },
    );
  return result;
}

export async function listAgentSessions(stateDir, timeout = 35_000, { fetchImpl = fetch } = {}) {
  const dir = path.join(stateDir, 'agents');
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { schemaVersion: 1, sessions: [], invalidFiles: [], truncated: false };
    throw err;
  }
  const names = entries.filter((entry) => entry.endsWith('.json')).sort();
  const sessions = [];
  const invalidFiles = [];
  // Bound concurrent connection attempts and do not remove stale files: a busy process may recover.
  for (let i = 0; i < Math.min(names.length, 64); i += 4) {
    await Promise.all(
      names.slice(i, Math.min(i + 4, 64)).map(async (name) => {
        const file = path.join(dir, name);
        let entry;
        try {
          entry = await readDiscovery(file);
        } catch {
          invalidFiles.push(file);
          return;
        }
        const item = {
          id: entry.id,
          pid: entry.pid,
          site: entry.site,
          environment: entry.environment,
          startedAt: entry.startedAt,
          portalOrigin: entry.portalOrigin,
          sourceDir: entry.sourceDir,
          discoveryFile: file,
        };
        try {
          const status = await agentRequest(entry, '/v1/session', { timeout, fetchImpl });
          item.reachable = status.id === entry.id;
          if (!item.reachable) item.error = 'Session identity mismatch';
        } catch (err) {
          item.reachable = false;
          item.error = err.message;
        }
        sessions.push(item);
      }),
    );
  }
  sessions.sort((a, b) => a.discoveryFile.localeCompare(b.discoveryFile));
  return {
    schemaVersion: 1,
    sessions,
    invalidFiles: invalidFiles.sort(/* NOSONAR: preserve in-place default string sorting */),
    truncated: names.length > 64,
  };
}

export default async function agent(_cfg, args, positionals = [], { fetchImpl = fetch } = {}) {
  const action = positionals[0] ?? 'sessions';
  const pageActions = validateAgentAction(action, args);
  const timeout = integer(args.timeout, '--timeout', 35_000, 2000, 120_000);
  if (action === 'sessions') {
    const stateDir = path.join(args.config ? path.dirname(path.resolve(args.config)) : process.cwd(), '.paqvilo');
    console.log(JSON.stringify(await listAgentSessions(stateDir, timeout), null, 2));
    return 0;
  }
  assertAgentArguments(action, args, pageActions);
  const { route, body, guardMs } = agentActionRequest(action, args, timeout);
  const discovery = await readDiscovery(args.session);
  let handle;
  const output = args.output ? path.resolve(args.output) : null;
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    try {
      handle = await fs.open(output, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw argument(
          `Screenshot output already exists: ${outputName(output, args.config)}. Existing files are never replaced; choose a new --output.`,
        );
      }
      throw error;
    }
  }
  try {
    const result = await agentRequest(discovery, route, {
      body,
      timeout: guardMs,
      image: action === 'screenshot',
      fetchImpl,
    }).catch((error) => {
      // The guard is internal: its expiry reports the wait the client made, with the --timeout it adds to.
      if (error.code !== 'request_timeout') throw error;
      throw Object.assign(
        new Error(
          `The agent session did not answer within ${guardMs} ms (--timeout ${timeout} ms plus the ${AGENT_REQUEST_HANG_GUARD_MS} ms request hang guard)`,
        ),
        { code: 'request_timeout', status: 504 },
      );
    });
    if (handle) {
      await handle.writeFile(result);
      const displayPath = outputName(output, args.config);
      console.log(
        JSON.stringify(
          { schemaVersion: 1, path: displayPath, bytes: result.length, writesFiles: [displayPath] },
          null,
          2,
        ),
      );
    } else console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (handle) {
      await handle.close();
      handle = null;
      await fs.rm(output, { force: true });
    }
    throw err;
  } finally {
    await handle?.close();
  }
  return 0;
}

function assertAgentArguments(action, args, pageActions) {
  if (!args.session)
    throw argument(`agent ${action} requires --session <discovery-file>; use agent sessions to find it`);
  if (pageActions.has(action) && !args['page-id'])
    throw argument(`agent ${action} requires --page-id from agent pages`);
  if (action === 'navigate' && !args.path) throw argument('agent navigate requires --path <portal-path>');
  if (action === 'screenshot' && (!args.output || path.extname(args.output).toLowerCase() !== '.png'))
    throw argument('agent screenshot requires --output <file.png>');
  if (pageActions.has(action)) integer(args['page-id'], '--page-id', undefined, 1, Number.MAX_SAFE_INTEGER);
}

function validateAgentAction(action, args) {
  if (!AGENT_ACTIONS.includes(action))
    throw argument(`Unknown agent action "${action}". Expected ${AGENT_ACTIONS.join(', ')}`);
  const allowed = new Set(['config', 'json', 'help', 'timeout', ...(action === 'sessions' ? [] : ['session'])]);
  const pageActions = new Set(['state', 'snapshot', 'screenshot', 'viewport', 'navigate', 'reload']);
  if (pageActions.has(action)) allowed.add('page-id');
  for (const option of {
    events: ['after', 'limit'],
    snapshot: ['selector', 'limit', 'styles'],
    screenshot: ['output', 'full-page', 'include-panel'],
    viewport: ['width', 'height'],
    navigate: ['path'],
  }[action] ?? [])
    allowed.add(option);
  for (const option of Object.keys(args))
    if (!allowed.has(option)) throw argument(`--${option} is not supported by agent ${action}`, 'unsupported_option');
  return pageActions;
}

// Hang guard for the client's own HTTP request. The server answers at its action deadline (the --timeout the client
// sends), so the structured answer always arrives before this guard fires.
const AGENT_REQUEST_HANG_GUARD_MS = 30_000;

function agentActionRequest(action, args, timeout) {
  const page = `/v1/pages/${encodeURIComponent(args['page-id'])}`;
  let route;
  let body;
  switch (action) {
    case 'status':
      route = '/v1/session';
      break;
    case 'pages':
      route = '/v1/pages';
      break;
    case 'events':
      route = `/v1/events?after=${integer(args.after, '--after', 0, 0, Number.MAX_SAFE_INTEGER)}&limit=${integer(args.limit, '--limit', 100, 1, 500)}`;
      break;
    case 'state':
      route = `${page}/state`;
      break;
    case 'snapshot':
      route = `${page}/dom`;
      body = {
        selector: args.selector,
        limit: integer(args.limit, '--limit', 100, 1, 200),
        styles: args.styles
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        timeoutMs: timeout,
      };
      break;
    case 'screenshot':
      route = `${page}/screenshot`;
      body = {
        fullPage: Boolean(args['full-page']),
        includePanel: Boolean(args['include-panel']),
        timeoutMs: timeout,
      };
      break;
    case 'viewport':
      route = `${page}/viewport`;
      body = {
        width: integer(args.width, '--width', 1440, 320, 4096),
        height: integer(args.height, '--height', 900, 240, 4096),
        timeoutMs: timeout,
      };
      break;
    case 'navigate':
      route = `${page}/navigate`;
      // The server accepts at most 60 000 ms for a navigation, so a longer --timeout is clamped there.
      body = { url: args.path, timeoutMs: Math.min(60_000, timeout) };
      break;
    case 'reload':
      route = `${page}/reload`;
      body = { timeoutMs: Math.min(60_000, timeout) };
      break;
    case 'stop':
      route = '/v1/stop';
      body = {};
      break;
  }
  return { route, body, guardMs: timeout + AGENT_REQUEST_HANG_GUARD_MS };
}
