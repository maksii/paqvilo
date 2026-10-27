// Browser ESM shim for Power Apps code apps running against Mirage (/_apps/code/<name>/, see code-apps-http.mjs).
//
// For Mirage runs only, import this adapter in an application-owned service layer and proxy /_apps/code
// to Mirage (including Host/Origin handling; see mirage/docs/code-apps.md). Call configure({ app: '<name>' })
// once before the first call. Keep native Microsoft SDK imports and generated services in the native build.
//
// Documented surface: getContext() → IContext (https://learn.microsoft.com/power-apps/developer/code-apps/how-to/retrieve-context);
// generated services create/get/getAll/update/delete resolving to `{ data }`
// (https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-dataverse).
// The rest of the @microsoft/power-apps surface and the internal client the generated services call are not reproduced:
// this shim is not a drop-in for generated service files, which must call dataClient (below) when run against Mirage.

let base = null;
let csrf = null;
let generation = 0;

export function configure({ app, origin = '' }) {
  if (typeof app !== 'string' || !app.trim()) throw new Error('A non-empty app name is required.');
  if (typeof origin !== 'string')
    throw new Error('Origin must be an HTTP(S) origin without a path, query, or fragment.');
  let normalizedOrigin = '';
  if (origin) {
    let url;
    try {
      url = typeof location === 'undefined' ? new URL(origin) : new URL(origin, location.href);
    } catch {
      throw new Error('Origin must be an HTTP(S) origin without a path, query, or fragment.');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.href.includes('?') ||
      url.href.includes('#')
    )
      throw new Error('Origin must be an HTTP(S) origin without credentials, a path, query, or fragment.');
    if (typeof location !== 'undefined' && url.origin !== location.origin)
      throw new Error('Mirage code app requests must use the current origin.');
    normalizedOrigin = url.origin;
  }
  base = `${normalizedOrigin}/_apps/code/${encodeURIComponent(app)}/`;
  csrf = null;
  generation++;
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  if (!base) throw new Error('Call configure({ app }) before using the Mirage code app shim.');
  const configured = generation;
  // Every proxy call needs the token, GET included (code-apps-http.mjs); only context itself answers without it.
  if (!csrf && !path.startsWith('context')) await getContext();
  if (generation !== configured) throw new Error('Mirage code app configuration changed during the request.');
  const response = await fetch(base + path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(csrf ? { 'x-sim-csrf': csrf } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  // Reject stale results; an already-sent write cannot be rolled back by reconfiguration.
  if (generation !== configured) throw new Error('Mirage code app configuration changed during the request.');
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok) throw new Error(`Mirage returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok)
    throw Object.assign(new Error(data?.error?.message || response.statusText || `HTTP ${response.status}`), {
      status: response.status,
      code: data?.error?.code,
    });
  return { data, response };
}

export async function getContext() {
  const configured = generation;
  const { data, response } = await call('context' + (typeof location === 'undefined' ? '' : location.search));
  if (generation !== configured) throw new Error('Mirage code app configuration changed during the request.');
  csrf = response.headers.get('x-sim-csrf');
  return data;
}

export async function getToken(resource) {
  return (await call('token', { method: 'POST', body: { resource } })).data;
}

const entityPath = (name) => {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(name))
    throw new Error('Entity set must be a Dataverse identifier.');
  return name;
};
const key = (id) => `(${encodeURIComponent(String(id).replace(/[{}]/g, ''))})`;
// Mirage accepts documented query options plus its own skipToken continuation. Dataverse does not support $skip.
const query = (options = {}) => {
  if (options.skip != null) throw new Error('Mirage does not support skip; use skipToken to continue a page.');
  const supported = new Set(['select', 'filter', 'orderBy', 'top', 'skipToken', 'maxPageSize', 'count']);
  for (const option of Object.keys(options)) {
    if (!supported.has(option) && options[option] !== undefined)
      throw new Error(`Unsupported Mirage query option: ${option}`);
  }
  const params = new URLSearchParams();
  if (options.select) params.set('$select', [options.select].flat().join(','));
  if (options.filter) params.set('$filter', options.filter);
  if (options.orderBy) params.set('$orderby', [options.orderBy].flat().join(','));
  if (options.top != null) params.set('$top', String(options.top));
  if (options.skipToken) params.set('$skiptoken', options.skipToken);
  if (options.count != null) {
    if (typeof options.count !== 'boolean') throw new Error('count must be a boolean.');
    params.set('$count', String(options.count));
  }
  const text = params.toString();
  return text ? '?' + text : '';
};
const representation = { prefer: 'return=representation,odata.include-annotations="*"' };

/** Minimal data-service client over the Dataverse proxy; methods resolve to `{ data }` like generated services. */
export const dataClient = {
  create: async (entitySet, record) => ({
    data: (await call(`dataverse/${entityPath(entitySet)}`, { method: 'POST', body: record, headers: representation }))
      .data,
  }),
  get: async (entitySet, id, options) => ({
    data: (await call(`dataverse/${entityPath(entitySet)}${key(id)}${query(options)}`, { headers: representation }))
      .data,
  }),
  getAll: async (entitySet, options) => {
    const headers = { ...representation };
    if (options?.maxPageSize != null) {
      if (!Number.isSafeInteger(options.maxPageSize) || options.maxPageSize < 1)
        throw new Error('maxPageSize must be a positive integer.');
      headers.prefer += `,odata.maxpagesize=${options.maxPageSize}`;
    }
    const { data } = await call(`dataverse/${entityPath(entitySet)}${query(options)}`, { headers });
    return {
      data: data?.value ?? [],
      ...(typeof data?.['@odata.count'] === 'number' ? { count: data['@odata.count'] } : {}),
      ...(data?.['@odata.nextLink']
        ? { skipToken: new URL(data['@odata.nextLink'], 'http://localhost').searchParams.get('$skiptoken') }
        : {}),
    };
  },
  update: async (entitySet, id, changes) => ({
    data: (
      await call(`dataverse/${entityPath(entitySet)}${key(id)}`, {
        method: 'PATCH',
        body: changes,
        headers: representation,
      })
    ).data,
  }),
  delete: async (entitySet, id) => {
    await call(`dataverse/${entityPath(entitySet)}${key(id)}`, { method: 'DELETE' });
    return { data: undefined };
  },
  // Connector operation through a power.config.json connection reference; 501 ConnectorNotSimulated unless a hook answers.
  execute: async (reference, operationId, parameters) => ({
    data: (
      await call(`connectors/${encodeURIComponent(reference)}/${encodeURIComponent(operationId)}`, {
        method: 'POST',
        body: parameters ?? {},
      })
    ).data,
  }),
};
