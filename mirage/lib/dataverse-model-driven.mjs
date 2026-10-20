import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { uuidV5 } from './dataverse-security.mjs';
import { organizationPrincipalContext } from './dataverse-principal-context.mjs';
import { parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';

/** Local administration uses the organization record pipeline, including its
 * validation, plug-ins, workflows, audit and optimistic concurrency. The host
 * supplies the principal and the outer serialized transaction; this adapter
 * neither authenticates portal visitors nor opens an HTTP connection. */
export function createModelDrivenRecordService({ organization, store = organization?.store, records = organization?.records,
  principal = () => organization.principals.byId(uuidV5(organization.organizationId, 'systemuser:SYSTEM')),
  origin = () => 'http://organization.local', run = fn => organization.runOwned(() => organization.runAtomic(fn)) }) {
  const read = fn => organization?.read ? organization.read(fn) : store.transact(fn, { nested: true, skipSaveIfUnchanged: true, cloneResult: false, lazyReadSnapshot: true });
  const context = options => {
    const selected = options && Object.hasOwn(options, 'principalId');
    const user = selected ? organization?.principals.byId(options.principalId) : principal();
    // Revalidate after admission to the serialized store boundary: a queued
    // request must not retain interactive rights after this user is converted
    // to an application/noninteractive account.
    if (selected && (user?.applicationid || user?.accessmode === 4 && options.kind !== 'local-admin'))
      throw new DataError('The selected staff user is unavailable or disabled.', 401, 'StaffPrincipalUnavailable');
    return organizationPrincipalContext(store, user);
  };
  // Convert the canonical, already-authorized JSON projection to the shell's
  // field bindings. Never enrich it from raw table rows or undo FLS masking.
  const rowOf = body => Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => !key.startsWith('@odata.')).map(([key, value]) => {
    const lookup = /^_(.+)_value(@.*)?$/.exec(key);
    return [lookup ? lookup[1] + (lookup[2] ?? '') : key, value];
  }));
  const request = (method, entity, id, options = {}, body) => {
    const mapping = store.resolveMapping(entity), url = new URL(`/api/data/v9.2/${mapping.entitySet}${id ? `(${id})` : ''}`, origin());
    if (options.fetchXml) url.searchParams.set('fetchXml', options.fetchXml);
    return records.handle({ method, url, origin: url.origin, version: 'v9.2', route: parseDataverseRoute(url.pathname),
      prefer: parsePrefer('return=representation,odata.include-annotations="*"'),
      headers: { ...(options.etag ? { 'if-match': options.etag } : {}) }, body,
      ...context(options), requestId: randomUUID() });
  };
  const get = (entity, id, options = {}) => read(async () => {
    const response = await request('GET', entity, id, options);
    return { row: rowOf(response.body), etag: response.body?.['@odata.etag'] };
  });
  const query = (entity, fetchXml, options = {}) => read(async () => {
    const response = await request('GET', entity, null, { ...options, fetchXml });
    return { rows: (response.body?.value ?? []).map(rowOf), total: response.body?.['@odata.count'] ?? -1,
      more: response.body?.['@Microsoft.Dynamics.CRM.morerecords'] === true || Boolean(response.body?.['@odata.nextLink']) };
  });
  const capabilities = (entity, options = {}, { id, fields = {} } = {}) => {
    const { user } = context(options), mapping = store.resolveMapping(entity);
    // Values remain internal to authorization. Only rights for the requested
    // row leave this boundary, and every row right includes its read check.
    const row = id ? store.tableRows(entity).find(row => String(row[mapping.idColumn]).toLowerCase() === String(id).toLowerCase()) : undefined;
    const permits = operation => {
      try { organization.principals.authorize({ user, entity, operation, mapping, row: operation === 'create' ? undefined : row }); return !id || operation === 'create' || Boolean(row); }
      catch (error) { if ([401, 403, 404].includes(error.status)) return false; throw error; }
    };
    const storage = store.storageAdapter?.recordCapabilities?.(entity) ?? {};
    const canRead = permits('read'), canCreate = permits('create') && storage.create !== false;
    const canUpdate = permits('update') && (!id || canRead) && storage.update !== false;
    const canDelete = permits('delete') && (!id || canRead) && storage.delete !== false;
    const fls = organization.api.fieldSecurity;
    return { read: canRead, create: canCreate, update: canUpdate, delete: canDelete,
      ...(storage.reason ? { reason: storage.reason } : {}),
      fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, {
        read: canRead && fls?.canRead(user, entity, name, id) !== false,
        create: canCreate && !field.isPrimaryId && (field.validForCreate ?? field.columnMetadata?.validForCreate) !== false && fls?.canWrite(user, entity, name, 'create') !== false,
        update: canUpdate && !field.isPrimaryId && (field.validForUpdate ?? field.columnMetadata?.validForUpdate) !== false && fls?.canWrite(user, entity, name, 'update', id) !== false,
      }])) };
  };
  const write = async ({ entity, id, values = {}, remove = false, etag, principalId, kind }) => {
    const mapping = store.resolveMapping(entity);
    const body = {};
    for (const [name, value] of Object.entries(values)) {
      const field = store.fieldDefinition(entity, name, organization?.api.metadataFields);
      if (!['lookup', 'customer', 'owner'].includes(String(field?.dataverseType ?? field?.type).toLowerCase())) {
        body[name] = value;
        continue;
      }
      let targetEntity = value?.logical_name ?? value?.logicalName ?? value?.entity;
      const targetId = value?.id ?? value?.value ?? value;
      const targets = field.targets ?? [];
      targetEntity ??= targets.length === 1 ? targets[0] : undefined;
      if (!targetEntity && id && targetId) {
        // A legacy editor may resubmit an unchanged id without its type. The
        // stored reference is authoritative only for that exact existing id.
        const existing = store.tableRows(entity).find(row => String(row[mapping.idColumn]).toLowerCase() === String(id).toLowerCase())?.[name];
        const same = String(existing?.id ?? '').replace(/[{}]/g, '').toLowerCase() === String(targetId).replace(/[{}]/g, '').toLowerCase();
        if (same) targetEntity = existing?.logical_name ?? existing?.logicalName ?? existing?.entity;
      }
      const target = targetEntity && store.resolveMapping(targetEntity);
      const navigation = Object.entries(mapping.relationships ?? {}).find(([, relationship]) => relationship.many === false && relationship.from === name && (!targetEntity || relationship.entity === targetEntity))?.[0] ?? name;
      if (value == null || value === '') body[`${navigation}@odata.bind`] = null;
      else {
        if (!target || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(String(targetId)))
          throw new DataError(`Choose a record${targets.length > 1 ? ' and its table' : ''} for ${name}.`, 400, 'InvalidLookup');
        body[`${navigation}@odata.bind`] = `/${target.entitySet}(${targetId})`;
      }
    }
    const method = remove ? 'DELETE' : id ? 'PATCH' : 'POST';
    const response = await run(() => request(method, entity, id, { etag, ...(principalId === undefined ? {} : { principalId, kind }) }, body));
    return remove ? { deleted: true } : { id: id ?? response.body?.[mapping.idColumn], row: rowOf(response.body), etag: response.body?.['@odata.etag'] };
  };
  // Callable write preserves the original embedded administration contract.
  return Object.assign(write, { write, get, query, capabilities });
}
