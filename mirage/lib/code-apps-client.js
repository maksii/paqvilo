// Browser ESM shim for Power Apps code apps running against Mirage (/_apps/code/<name>/, see code-apps-http.mjs).
//
// For Mirage runs only, alias the client library in Vite and proxy /_apps/code to Mirage so calls stay same-origin:
//   resolve: { alias: { '@microsoft/power-apps/app': '<paqvilo>/mirage/lib/code-apps-client.js' } },
//   server: { proxy: { '/_apps/code': 'http://127.0.0.1:<mirage port>' } }
// and call configure({ app: '<name>' }) once before the first call.
//
// Documented surface: getContext() → IContext (https://learn.microsoft.com/power-apps/developer/code-apps/how-to/retrieve-context);
// generated services create/get/getAll/update/delete resolving to `{ data }`
// (https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-dataverse).
// unverified: the rest of the @microsoft/power-apps surface and the internal client the generated services call; this
// shim is not a drop-in for generated service files, which must call dataClient (below) when run against Mirage.

let base = null;
let csrf = null;

export function configure({ app, origin = '' }) {
  base = `${origin}/_apps/code/${encodeURIComponent(app)}/`;
  csrf = null;
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  if (!base) throw new Error('Call configure({ app }) before using the Mirage code app shim.');
  // Every proxy call needs the token, GET included (code-apps-http.mjs); only context itself answers without it.
  if (!csrf && !path.startsWith('context')) await getContext();
  const response = await fetch(base + path, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(csrf ? { 'x-sim-csrf': csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw Object.assign(new Error(data?.error?.message ?? response.statusText), { status: response.status, code: data?.error?.code });
  return { data, response };
}

export async function getContext() {
  const { data, response } = await call('context' + (typeof location === 'undefined' ? '' : location.search));
  csrf = response.headers.get('x-sim-csrf');
  return data;
}

export async function getToken(resource) {
  return (await call('token', { method: 'POST', body: { resource } })).data;
}

const key = id => `(${encodeURIComponent(String(id).replace(/[{}]/g, ''))})`;
// unverified: the exact IGetAllOptions names; select/filter/orderBy/top/skipToken map to the OData query options.
const query = (options = {}) => {
  const params = new URLSearchParams();
  if (options.select) params.set('$select', [options.select].flat().join(','));
  if (options.filter) params.set('$filter', options.filter);
  if (options.orderBy) params.set('$orderby', [options.orderBy].flat().join(','));
  if (options.top) params.set('$top', String(options.top));
  if (options.skipToken) params.set('$skiptoken', options.skipToken);
  const text = params.toString();
  return text ? '?' + text : '';
};
const representation = { prefer: 'return=representation,odata.include-annotations="*"' };

/** Minimal data-service client over the Dataverse proxy; methods resolve to `{ data }` like generated services. */
export const dataClient = {
  create: async (entitySet, record) => ({ data: (await call(`dataverse/${entitySet}`, { method: 'POST', body: record, headers: representation })).data }),
  get: async (entitySet, id, options) => ({ data: (await call(`dataverse/${entitySet}${key(id)}${query(options)}`, { headers: representation })).data }),
  getAll: async (entitySet, options) => {
    const { data } = await call(`dataverse/${entitySet}${query(options)}`, { headers: representation });
    return { data: data?.value ?? [], ...(data?.['@odata.nextLink'] ? { skipToken: new URL(data['@odata.nextLink'], 'http://localhost').searchParams.get('$skiptoken') } : {}) };
  },
  update: async (entitySet, id, changes) => ({ data: (await call(`dataverse/${entitySet}${key(id)}`, { method: 'PATCH', body: changes, headers: representation })).data }),
  delete: async (entitySet, id) => { await call(`dataverse/${entitySet}${key(id)}`, { method: 'DELETE' }); return { data: undefined }; },
  // Connector operation through a power.config.json connection reference; 501 ConnectorNotSimulated unless a hook answers.
  execute: async (reference, operationId, parameters) => ({ data: (await call(`connectors/${encodeURIComponent(reference)}/${encodeURIComponent(operationId)}`, { method: 'POST', body: parameters ?? {} })).data }),
};
