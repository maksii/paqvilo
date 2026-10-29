import { currentRequest } from './request-context.mjs';
import { systemIds } from './runtime-clock.mjs';
import { DataError } from './data-error.mjs';
import { uuidV5 } from './dataverse-security.mjs';
import { organizationPrincipalContext } from './dataverse-principal-context.mjs';
import { parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';
import { createDataverseHandler } from './dataverse-api.mjs';
import { isSecuredField } from './dataverse-fls.mjs';
import { plainDataObject } from './state-clone.mjs';
import { immutableFieldRights } from './field-rights.mjs';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';

/** The in-process Web API behind Xrm.WebApi.execute/executeMultiple in the model-driven host: the organization's own
 * router (custom APIs, actions, functions, CRUD, $batch change sets) answers as the selected staff principal. The
 * principal comes from the signed staff session, never from a bearer token, so this works with HTTP Dataverse disabled.
 * organization: the runtime or a getter. Returns async ({ method, path, headers, body, principal, host }) → { status, headers, body }. */
export function createModelDrivenWebApi({ organization }) {
  const current = () => (typeof organization === 'function' ? organization() : organization);
  const handlers = new WeakMap();
  const handlerFor = (runtime, hostname) => {
    let byHost = handlers.get(runtime);
    if (!byHost) handlers.set(runtime, (byHost = new Map()));
    if (!byHost.has(hostname)) {
      // The staff session already authenticated the caller: the bearer check accepts only this request's marker.
      const authority = {
        verifyBearer: (header) =>
          header?.startsWith('Mirage-Staff ')
            ? { ok: true, claims: { staff: header.slice(13) } }
            : { ok: false, reason: 'missing' },
      };
      const principals = {
        ...runtime.principals,
        resolve: (claims) => {
          const user = runtime.principals.byId(claims.staff);
          return user
            ? { user, reason: user.isdisabled === true ? 'disabled' : null }
            : { user: null, reason: 'unknown' };
        },
      };
      byHost.set(
        hostname,
        createDataverseHandler({
          store: runtime.store,
          change: runtime.change,
          settings: runtime.settings,
          operations: runtime.registry,
          routes: runtime.routes,
          api: runtime.api,
          authority,
          principals,
          metadata: runtime.metadata,
          recordHandlers: runtime.records,
          changes: runtime.changes,
          tenantId: runtime.tenantId,
          organizationId: runtime.organizationId,
          environmentId: runtime.environmentId,
          host: hostname,
          clock: runtime.clock,
          limits: runtime.limits,
        }),
      );
    }
    return byHost.get(hostname);
  };
  // privilegeError({ principal, entity, operation }): the error the organization's privilege check (principals.authorize, no
  // row) answers for the staff user, or null when the user holds the privilege. Mobile offline snapshots it per table.
  const privilegeError = ({ principal, entity, operation }) => {
    const runtime = current(),
      user = runtime?.principals.byId(principal?.principalId);
    if (!user) return null;
    try {
      runtime.principals.authorize({ user, entity, operation, mapping: runtime.store.resolveMapping(entity) });
      return null;
    } catch (error) {
      if ([401, 403].includes(error.status)) return error;
      throw error;
    }
  };
  return Object.assign(
    async ({ method, path, headers = {}, body, principal, host }) => {
      const runtime = current();
      if (!runtime) throw new DataError('The organization runtime is unavailable.', 503, 'OrganizationUnavailable');
      // Never bare SYSTEM: only a resolved staff session or the explicit local administrator (staff-session.mjs resolve) acts.
      if (!['staff', 'local-admin'].includes(principal?.kind))
        throw new DataError(
          'The Web API bridge needs a staff session or the local administrator.',
          401,
          'StaffPrincipalUnavailable',
        );
      const user = runtime.principals.byId(principal?.principalId);
      if (!user || user.applicationid || (user.accessmode === 4 && principal.kind !== 'local-admin'))
        throw new DataError('The selected staff user is unavailable or disabled.', 401, 'StaffPrincipalUnavailable');
      const hostname = /^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/i.test(new URL(`http://${host ?? 'localhost'}`).hostname)
        ? new URL(`http://${host ?? 'localhost'}`).hostname
        : 'localhost';
      const req = Readable.from(body ? [Buffer.from(body)] : []);
      Object.assign(req, {
        method,
        url: path,
        socket: {},
        headers: { ...headers, host: host ?? 'localhost', authorization: `Mirage-Staff ${user.systemuserid}` },
      });
      const out = { status: 200, headers: {}, chunks: [] };
      await new Promise((resolve, reject) => {
        const listeners = [];
        const res = {
          headersSent: false,
          setHeader: (name, value) => {
            out.headers[name.toLowerCase()] = value;
          },
          set statusCode(value) {
            out.status = value;
          },
          get statusCode() {
            return out.status;
          },
          on: (event, listener) => {
            if (event === 'finish') listeners.push(listener);
            return res;
          },
          end: (payload) => {
            if (payload !== undefined) out.chunks.push(Buffer.from(payload));
            res.headersSent = true;
            for (const listener of listeners) listener();
            resolve();
          },
          destroy: () => reject(new DataError('The Web API request failed.', 500, 'WebApiExecuteFailed')),
        };
        handlerFor(runtime, hostname)(req, res).catch(reject);
      });
      let payload = Buffer.concat(out.chunks);
      if (out.headers['content-encoding'] === 'gzip') {
        payload = gunzipSync(payload);
        delete out.headers['content-encoding'];
      }
      return { status: out.status, headers: out.headers, body: payload.toString('utf8') };
    },
    { privilegeError },
  );
}

/** Local administration uses the organization record pipeline, including its
 * validation, plug-ins, workflows, audit and optimistic concurrency. The host
 * supplies the principal and the outer serialized transaction; this adapter
 * neither authenticates portal visitors nor opens an HTTP connection. */
export function createModelDrivenRecordService({
  organization,
  store = organization?.store,
  records = organization?.records,
  principal = () => organization.principals.byId(uuidV5(organization.organizationId, 'systemuser:SYSTEM')),
  origin = () => 'http://organization.local',
  run = (fn) => organization.runOwned(() => organization.runAtomic(fn)),
}) {
  const read = (fn) =>
    organization?.read
      ? organization.read(fn)
      : store.transact(fn, { nested: true, skipSaveIfUnchanged: true, cloneResult: false, lazyReadSnapshot: true });
  const context = (options) => {
    const selected = options && Object.hasOwn(options, 'principalId');
    const user = selected ? organization?.principals.byId(options.principalId) : principal();
    // Revalidate after admission to the serialized store boundary: a queued
    // request must not retain interactive rights after this user is converted
    // to an application/noninteractive account.
    if (selected && (user?.applicationid || (user?.accessmode === 4 && options.kind !== 'local-admin')))
      throw new DataError('The selected staff user is unavailable or disabled.', 401, 'StaffPrincipalUnavailable');
    return organizationPrincipalContext(store, user);
  };
  // Convert the canonical, already-authorized JSON projection to the shell's
  // field bindings. Never enrich it from raw table rows or undo FLS masking.
  const rowOf = (body) =>
    Object.fromEntries(
      Object.entries(body ?? {})
        .filter(([key]) => !key.startsWith('@odata.'))
        .map(([key, value]) => {
          const lookup = /^_(.+)_value(@.*)?$/.exec(key);
          return [lookup ? lookup[1] + (lookup[2] ?? '') : key, value];
        }),
    );
  const request = (method, entity, id, options = {}, body) => {
    const mapping = store.resolveMapping(entity),
      url = new URL(`/api/data/v9.2/${mapping.entitySet}${id ? `(${id})` : ''}`, origin());
    if (options.fetchXml) url.searchParams.set('fetchXml', options.fetchXml);
    if (options.query) url.search = options.query;
    return records.handle({
      method,
      url,
      origin: url.origin,
      version: 'v9.2',
      route: parseDataverseRoute(url.pathname),
      prefer: parsePrefer(
        'return=representation,odata.include-annotations="*"' +
          (options.pageSize ? `,odata.maxpagesize=${options.pageSize}` : ''),
      ),
      headers: { ...(options.etag ? { 'if-match': options.etag } : {}) },
      body,
      ...context(options),
      requestId:
        currentRequest()?.requestId ?? currentRequest()?.correlationId ?? (organization?.ids ?? systemIds).uuid(),
    });
  };
  const get = (entity, id, options = {}) =>
    read(async () => {
      const response = await request('GET', entity, id, options);
      return { row: rowOf(response.body), etag: response.body?.['@odata.etag'] };
    });
  const retrieve = (entity, id, query, options = {}) =>
    read(async () => (await request('GET', entity, id, { ...options, query })).body);
  const query = (entity, fetchXml, options = {}) =>
    read(async () => {
      const response = await request('GET', entity, null, { ...options, fetchXml });
      return {
        rows: (response.body?.value ?? []).map(rowOf),
        total: response.body?.['@odata.count'] ?? -1,
        ...(response.body?.['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'] === true
          ? { totalLimitExceeded: true }
          : {}),
        more:
          response.body?.['@Microsoft.Dynamics.CRM.morerecords'] === true ||
          Boolean(response.body?.['@odata.nextLink']),
      };
    });
  // Reuse the organization's OData/FetchXML implementation for Solution code.
  // The shell's selected view must not narrow a script's table query.
  const list = (entity, query, options = {}) =>
    read(async () => {
      const response = await request('GET', entity, null, { ...options, query });
      return {
        entities: response.body?.value ?? [],
        ...(response.body?.['@odata.nextLink'] ? { nextLink: response.body['@odata.nextLink'] } : {}),
        ...(response.body?.['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie']
          ? { fetchXmlPagingCookie: response.body['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'] }
          : {}),
      };
    });
  // The stored row with this exact id (case-insensitive), found through the store's primary-key index:
  // a grid page asks once per row, so a table scan per row would make the page O(pageSize x rows).
  const storedRow = (entity, mapping, id) => {
    const wanted = String(id).toLowerCase(),
      same = (row) => String(row[mapping.idColumn]).toLowerCase() === wanted,
      rows = store.tableRows(entity);
    const subset =
      typeof id === 'string' &&
      rows === store.state.tables?.[mapping.logicalName] &&
      typeof store.primaryKeySubset === 'function'
        ? store.primaryKeySubset(mapping, [id])
        : null;
    return subset ? subset.find(same) : rows.find(same);
  };
  const capabilities = (entity, options = {}, { id, fields = {}, compact = false } = {}) => {
    const { user } = context(options),
      mapping = store.resolveMapping(entity);
    // Values remain internal to authorization. Only rights for the requested
    // row leave this boundary, and every row right includes its read check.
    const row = id ? storedRow(entity, mapping, id) : undefined;
    const permits = (operation) => {
      try {
        organization.principals.authorize({
          user,
          entity,
          operation,
          mapping,
          row: operation === 'create' ? undefined : row,
        });
        return !id || operation === 'create' || Boolean(row);
      } catch (error) {
        if ([401, 403, 404].includes(error.status)) return false;
        throw error;
      }
    };
    const storage = store.storageAdapter?.recordCapabilities?.(entity) ?? {};
    const canRead = permits('read'),
      canCreate = permits('create') && storage.create !== false;
    const canUpdate = permits('update') && (!id || canRead) && storage.update !== false;
    const canDelete = permits('delete') && (!id || canRead) && storage.delete !== false;
    const fls = organization.api.fieldSecurity;
    const names = Object.keys(fields);
    const fieldRights = names.length ? fls?.capabilities?.(user, entity, names, id, { compact: true }) : {};
    // Field security and the secured marker share a synchronous table read.
    // Resolving the whole imported definition again for every marker made a
    // wide catalogue allocate O(fields²) metadata. Never cache across calls.
    const metadataFields = typeof store.fieldDefinition === 'function' ? organization.api.metadataFields : undefined;
    const definitions =
      names.length && typeof metadataFields === 'function' ? metadataFields(mapping.logicalName ?? entity) : undefined;
    const metadata = typeof metadataFields === 'function' ? () => definitions : undefined;
    const projected = plainDataObject(),
      property = { value: undefined, writable: true, enumerable: true, configurable: true };
    for (const [name, field] of Object.entries(fields)) {
      const secured = isSecuredField(store.fieldDefinition?.(entity, name, metadata) ?? field);
      const read = canRead && (fieldRights ? fieldRights[name].read : fls?.canRead(user, entity, name, id) !== false);
      const create =
        canCreate &&
        !field.isPrimaryId &&
        (field.validForCreate ?? field.columnMetadata?.validForCreate) !== false &&
        (fieldRights ? fieldRights[name].create : fls?.canWrite(user, entity, name, 'create') !== false);
      const update =
        canUpdate &&
        !field.isPrimaryId &&
        (field.validForUpdate ?? field.columnMetadata?.validForUpdate) !== false &&
        (fieldRights ? fieldRights[name].update : fls?.canWrite(user, entity, name, 'update', id) !== false);
      property.value = compact
        ? immutableFieldRights(secured, read, create, update)
        : { secured, read, create, update };
      Object.defineProperty(projected, name, property);
    }
    return {
      read: canRead,
      create: canCreate,
      update: canUpdate,
      delete: canDelete,
      ...(storage.reason ? { reason: storage.reason } : {}),
      fields: projected,
    };
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
        const existing = storedRow(entity, mapping, id)?.[name];
        const same =
          String(existing?.id ?? '')
            .replace(/[{}]/g, '')
            .toLowerCase() === String(targetId).replace(/[{}]/g, '').toLowerCase();
        if (same) targetEntity = existing?.logical_name ?? existing?.logicalName ?? existing?.entity;
      }
      const target = targetEntity && store.resolveMapping(targetEntity);
      const navigation =
        Object.entries(mapping.relationships ?? {}).find(
          ([, relationship]) =>
            relationship.many === false &&
            relationship.from === name &&
            (!targetEntity || relationship.entity === targetEntity),
        )?.[0] ?? name;
      if (value == null || value === '') body[`${navigation}@odata.bind`] = null;
      else {
        if (!target || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(String(targetId)))
          throw new DataError(
            `Choose a record${targets.length > 1 ? ' and its table' : ''} for ${name}.`,
            400,
            'InvalidLookup',
          );
        body[`${navigation}@odata.bind`] = `/${target.entitySet}(${targetId})`;
      }
    }
    const method = remove ? 'DELETE' : id ? 'PATCH' : 'POST';
    const response = await run(() =>
      request(method, entity, id, { etag, ...(principalId === undefined ? {} : { principalId, kind }) }, body),
    );
    return remove
      ? { deleted: true }
      : {
          id: id ?? response.body?.[mapping.idColumn],
          row: rowOf(response.body),
          etag: response.body?.['@odata.etag'],
        };
  };
  // The service itself is callable as write().
  return Object.assign(write, { write, get, retrieve, query, list, capabilities });
}
