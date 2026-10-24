// Shared protocol plumbing only. Each message keeps its own validation, privileges and transaction boundary.
import { contextUrl, parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';

const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export function idOf(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.match(GUID)?.[0] ?? null;
  if (typeof value !== 'object') return null;
  const direct = value.id ?? value['@odata.id'];
  if (direct != null) return idOf(direct);
  return Object.values(value).map(idOf).find(Boolean) ?? null;
}

const bodyOf = (context) =>
  typeof context.body === 'string' ? JSON.parse(context.body || '{}') : (context.body ?? {});
export const argsOf = (context) => ({ ...bodyOf(context), ...(context.params ?? {}) });

export function rowOf(store, logical, primaryKey, id) {
  if (id == null) return null;
  const key = String(id).toLowerCase();
  return (
    (store.state.tables[logical] ??= []).find((row) => String(row[primaryKey] ?? '').toLowerCase() === key) ?? null
  );
}

/** Read through the records adapter, preserving caller context even when an operation explicitly chooses SYSTEM. */
export async function readMessageRecords(api, context, url, effectiveUser = context.user) {
  const result = await api.records.handle({
    method: 'GET',
    route: parseDataverseRoute(url.pathname),
    url,
    origin: context.origin,
    version: context.version,
    prefer: parsePrefer(undefined),
    headers: {},
    user: effectiveUser,
    caller: context.caller,
    identity: context.identity,
    requestId: context.requestId,
  });
  return result.body;
}

/** Formatted collection read, including the caller's selection. Authorization remains in the records adapter. */
export async function messageCollection(api, context, logical, ids, effectiveUser = context.user) {
  const mapping = api.store.resolveMapping(logical);
  if (!ids.length)
    return {
      status: 200,
      body: {
        '@odata.context': contextUrl(context.origin, context.version, mapping.entitySet),
        value: [],
      },
    };
  const url = new URL(`/api/data/${context.version}/${mapping.entitySet}`, context.origin);
  url.searchParams.set('$filter', ids.map((id) => `${mapping.idColumn} eq ${id}`).join(' or '));
  if (context.url?.searchParams.has('$select'))
    url.searchParams.set('$select', context.url.searchParams.get('$select'));
  return { status: 200, body: await readMessageRecords(api, context, url, effectiveUser) };
}
