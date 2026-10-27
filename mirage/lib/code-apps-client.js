// Browser ESM shim for Power Apps code apps running against Mirage (/_apps/code/<name>/, see code-apps-http.mjs).
//
// For Mirage runs only, import this adapter in an application-owned service layer and proxy /_apps/code
// to Mirage (including Host/Origin handling; see mirage/docs/code-apps.md). Call configure({ app: '<name>' })
// once before the first call. Keep native Microsoft SDK imports and generated services in the native build.
//
// Documented surface: getContext() → IContext (https://learn.microsoft.com/power-apps/developer/code-apps/how-to/retrieve-context);
// generated services create/get/getAll/update/delete resolving to `{ data }`
// (https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-dataverse).
// Generated services retain the real SDK when the optional executor or Vite integration installs local data execution.
// This lower-level throwing client is also available for application-owned service layers.

let base = null;
let csrf = null;
let generation = 0;
let sessionId = null;
let observer = null;
let appName = null;

export function configure({ app, origin = '', onEvent } = {}) {
  if (typeof app !== 'string' || !app.trim()) throw new Error('A non-empty app name is required.');
  if (typeof origin !== 'string')
    throw new Error('Origin must be an HTTP(S) origin without a path, query, or fragment.');
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new Error('onEvent must be a function.');
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
  appName = app;
  csrf = null;
  sessionId = crypto.randomUUID();
  observer = onEvent ?? null;
  generation++;
}

async function call(path, { method = 'GET', body, headers = {}, binaryBody = false, binaryResponse = false } = {}) {
  if (!base) throw new Error('Call configure({ app }) before using the Mirage code app shim.');
  const configured = generation;
  // Every proxy call needs the token, GET included (code-apps-http.mjs); only context itself answers without it.
  if (!csrf && path !== 'status' && !path.startsWith('context')) await getContext();
  if (generation !== configured) throw new Error('Mirage code app configuration changed during the request.');
  const started = performance.now();
  const report = observer;
  const eventPath = `/_apps/code/${encodeURIComponent(appName)}/${path.split('?')[0].replace(/\([^)]*\)?/g, '(...)')}`;
  let status = 0;
  const notify = (kind) => {
    try {
      report?.({ kind, method, path: eventPath, status, durationMs: Math.round(performance.now() - started) });
    } catch {
      /* Debug observers never change an application request's result. */
    }
  };
  try {
    const response = await fetch(base + path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'x-paqvilo-code-app-session': sessionId,
        ...(csrf ? { 'x-sim-csrf': csrf } : {}),
        ...(body === undefined ? {} : { 'content-type': binaryBody ? 'application/octet-stream' : 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: binaryBody ? body : JSON.stringify(body) }),
    });
    status = response.status;
    const bytes = binaryResponse && response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    const text = bytes === null ? await response.text() : '';
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
    notify('request');
    return { data: bytes ?? data, response };
  } catch (error) {
    notify('request-error');
    throw error;
  }
}

/** Configuration and feature status does not require a staff session. */
export async function getStatus() {
  return (await call('status')).data;
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
  uploadFile: async (entitySet, id, column, fileName, data) => {
    if (typeof fileName !== 'string' || !fileName || /[\r\n]/.test(fileName))
      throw new Error('A valid file name is required.');
    const params = new URLSearchParams({ 'x-ms-file-name': fileName });
    await call(`dataverse/${entityPath(entitySet)}${key(id)}/${entityPath(column)}?${params}`, {
      method: 'PATCH',
      body: data,
      binaryBody: true,
    });
    return { data: undefined };
  },
  downloadFile: async (entitySet, id, column, fullSize = false) => {
    const { data, response } = await call(
      `dataverse/${entityPath(entitySet)}${key(id)}/${entityPath(column)}/$value${fullSize ? '?size=full' : ''}`,
      { binaryResponse: true },
    );
    const fileName = response.headers.get('x-ms-file-name');
    return { data, ...(fileName ? { fileName } : {}) };
  },
  deleteFile: async (entitySet, id, column) => {
    await call(`dataverse/${entityPath(entitySet)}${key(id)}/${entityPath(column)}`, { method: 'DELETE' });
    return { data: undefined };
  },
  executeDataverseAction: async (operationName, body) => ({
    data: (
      await call(`dataverse/${entityPath(operationName)}`, {
        method: 'POST',
        body: body ?? {},
        headers: { 'x-sim-code-app-operation': 'customapi' },
      })
    ).data,
  }),
  // SDK table metadata, routed through the local Dataverse metadata API.
  getEntityMetadata: async (tableName, options = {}) => {
    const logical = entityPath(tableName);
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((name) => !['metadata', 'schema'].includes(name))
    )
      throw new Error('Unsupported metadata options.');
    const schema = options.schema ?? {};
    if (
      !schema ||
      typeof schema !== 'object' ||
      Array.isArray(schema) ||
      Object.keys(schema).some((name) => !['columns', 'oneToMany', 'manyToOne', 'manyToMany'].includes(name))
    )
      throw new Error('Unsupported metadata schema options.');
    if (
      options.metadata !== undefined &&
      (!Array.isArray(options.metadata) ||
        options.metadata.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(name)))
    )
      throw new Error('Metadata selections must be an array of identifiers.');
    if (
      schema.columns !== undefined &&
      schema.columns !== 'all' &&
      (!Array.isArray(schema.columns) ||
        schema.columns.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(name)))
    )
      throw new Error('Metadata columns must be all or an array of identifiers.');
    for (const name of ['oneToMany', 'manyToOne', 'manyToMany'])
      if (schema[name] !== undefined && typeof schema[name] !== 'boolean')
        throw new Error('Metadata relationship options must be boolean.');
    const params = new URLSearchParams();
    if (options.metadata?.length) params.set('$select', options.metadata.join(','));
    const expand = [];
    if (schema.columns !== undefined) expand.push('Attributes');
    if (schema.oneToMany) expand.push('OneToManyRelationships');
    if (schema.manyToOne) expand.push('ManyToOneRelationships');
    if (schema.manyToMany) expand.push('ManyToManyRelationships');
    if (expand.length) params.set('$expand', expand.join(','));
    const search = params.toString();
    const { data } = await call(`dataverse/EntityDefinitions(LogicalName='${logical}')${search ? '?' + search : ''}`);
    if (Array.isArray(schema.columns) && Array.isArray(data?.Attributes)) {
      const selected = new Set(schema.columns.map((name) => name.toLowerCase()));
      data.Attributes = data.Attributes.filter((attribute) =>
        selected.has(String(attribute.LogicalName).toLowerCase()),
      );
    }
    return { data };
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
