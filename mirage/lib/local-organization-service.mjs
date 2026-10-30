import { cloneStateData } from './state-clone.mjs';
import { DataError } from './data-error.mjs';
import { executeBulkRecords } from './plugin-bulk.mjs';
import { associationBinding, executeAssociation, executeAssociationAsync } from './plugin-association.mjs';
import { isExactNumeric, exactNumeric } from './exact-numeric.mjs';
import { isElastic, recordKey } from './dataverse-elastic.mjs';

const fail = (message, code = 'LocalOrganizationServiceUnsupported', status = 501) => {
  throw new DataError(message, status, code);
};
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const own = (o, k) => o != null && Object.hasOwn(o, k);
const RESERVED_NAMES = ['constructor', 'prototype', '__proto__'];

/** Preserve typed SDK alternate keys; an elastic primary key is scoped by its opaque partition. */
function sdkRecordKey(store, entity, target, partitionId) {
  const mapping = store.resolveMapping(entity);
  const keys = target && typeof target === 'object' ? target.keyAttributes : null;
  if (keys && Object.keys(keys).length) {
    const values = Object.fromEntries(Object.entries(keys).map(([name, value]) => [name, sdkValueToRecord(value)]));
    if (isElastic(mapping) && !own(values, mapping.idColumn) && uuid.test(target.id ?? ''))
      values[mapping.idColumn] = target.id;
    return Object.entries(values)
      .map(([name, value]) => {
        if (!/^[a-z][\w]*$/i.test(name) || RESERVED_NAMES.includes(name)) fail('Invalid SDK key attribute.');
        if (typeof value === 'string')
          return `${name}=${uuid.test(value) ? value : `'${value.replaceAll("'", "''")}'`}`;
        if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean')
          return `${name}=${value}`;
        fail('SDK key attributes require scalar values.');
      })
      .join(',');
  }
  const id = target && typeof target === 'object' ? (target.id ?? target.value) : target;
  return isElastic(mapping) && partitionId != null
    ? recordKey(mapping, { [mapping.idColumn]: id, partitionid: partitionId })
    : id;
}

const OPERATIONS = ['read', 'create', 'update', 'delete', 'associate', 'disassociate'];
const BULK_MESSAGES = ['CreateMultiple', 'UpdateMultiple'];
const tableName = (value) => /^[a-z][a-z0-9_]*$/i.test(value ?? '');
const evidenced = (value) => typeof value === 'string' && Boolean(value.trim());
// A message grant ({ message, operations: ['execute'] }) authorizes executeMessageInternal (dataverse-customapi.mjs).
const messageGrant = (grant) =>
  typeof grant?.message === 'string' &&
  Boolean(grant.message) &&
  grant.entity === undefined &&
  Array.isArray(grant.operations) &&
  grant.operations.length > 0 &&
  grant.operations.every((op) => op === 'execute') &&
  grant.predicate === undefined;
const invalidGrant = (grant) =>
  !messageGrant(grant) &&
  (!grant ||
    !tableName(grant.entity) ||
    !Array.isArray(grant.operations) ||
    grant.operations.some((op) => !OPERATIONS.includes(op)) ||
    (grant.predicate !== undefined && typeof grant.predicate !== 'function'));
const invalidBulkTable = (table) =>
  !table ||
  !tableName(table.entity) ||
  table.tableType !== 'standard' ||
  !evidenced(table.evidence) ||
  !Array.isArray(table.messages) ||
  !table.messages.length ||
  table.messages.some((message) => !BULK_MESSAGES.includes(message));

/** Explicit local backend grants are independent of portal roles. No default system user. */
export function validateServiceProfile(profile) {
  if (!profile || !uuid.test(profile.userId ?? '') || !evidenced(profile.evidence) || !Array.isArray(profile.grants))
    fail(
      'A project-supplied backend user ID, evidence and explicit grants are required.',
      'LocalBackendIdentityRequired',
      409,
    );
  for (const grant of profile.grants) {
    if (invalidGrant(grant)) fail('Invalid local backend grant.', 'LocalBackendIdentityRequired', 409);
  }
  const bulk = profile.bulkTables;
  if (
    bulk !== undefined &&
    (!Array.isArray(bulk) ||
      new Set(bulk.map((table) => table?.entity)).size !== bulk.length ||
      bulk.some(invalidBulkTable))
  )
    fail(
      'Bulk capabilities require unique source-evidenced standard tables and explicit supported message names.',
      'LocalBackendIdentityRequired',
      409,
    );
  return profile;
}

/** One explicit local backend grant check (the SDK service and the organization entries a flow connector calls with the
 * same profile: dataverse-files.mjs fileContentInternal, dataverse-customapi.mjs executeMessageInternal): a grant on the
 * table for the operation whose predicate (when it has one) accepts the row; otherwise 403 LocalBackendPermissionDenied. */
export function authorizeGrant(store, profile, entity, operation, row) {
  const logical = store.resolveMapping(entity).logicalName;
  const grants = profile.grants.filter((g) => g.entity === logical && g.operations.includes(operation));
  if (!grants.some((g) => !g.predicate || g.predicate(cloneStateData(row), operation) === true))
    fail(`Local backend profile denied ${operation} on ${logical}.`, 'LocalBackendPermissionDenied', 403);
  return logical;
}

/** The SDK IOrganizationService of an explicit local backend profile. Writes and reads go through the organization's
 * internal entries (records, default store.recordPipeline: dataverse-records.mjs createInternal/updateInternal/removeInternal/
 * readInternal) after the explicit-grant checks, so an SDK write runs the Web API rules (state defaults, record hooks, audit
 * and version columns, alternate-key answers) and an SDK read the shared read projection. createAsync, updateAsync and
 * removeAsync run the same writes on the asynchronous pipeline for a caller outside any plug-in (a flow Dataverse action). The other calls are synchronous (the CLR
 * bridge runs inside the store's synchronous plug-in pipeline): a pre-operation (beforeWrite) record hook that answers a
 * promise refuses the write with 501 SdkAsyncPreOperationUnsupported before anything is stored; an afterWrite hook's
 * asynchronous remainder finishes after the call returns and its failure is reported to the diagnostic option as
 * SDK_DEFERRED_EFFECT. Reads take an unmask option (the request's UnMaskedData: Retrieve, RetrieveMultiple and FetchXML),
 * which unmasks only with CanReadUnmasked, as on the Web API. A virtual table is read through its provider's synchronous
 * operations (dataverse-virtual-providers.mjs readSync), never from its local mirror: 501 VirtualProviderMissing without a
 * provider, 501 SdkVirtualReadUnsupported without the synchronous operation. Without an organization on the store the
 * service writes the store directly (no organization rules exist). */
export function localOrganizationService(
  store,
  profile,
  records = store.recordPipeline,
  { diagnostic = () => {} } = {},
) {
  validateServiceProfile(profile);
  // Bypass portal grants only AFTER the separate backend grant check below.
  const localIdentity = { id: profile.userId, admin: true };
  const authorize = (entity, operation, row) => authorizeGrant(store, profile, entity, operation, row);
  // One context per call: the record hooks key per-write state on it. The SDK user is the profile's systemuser (SYSTEM
  // when the organization has no such user); the explicit grants above have authorized the call.
  const context = () => ({ identity: localIdentity, userId: profile.userId, caller: null, method: 'SDK', headers: {} });
  const internal = (operation, entity, run) => {
    const deferred = [];
    const result = run({ sync: true, deferred, authorized: true });
    for (const effect of deferred) {
      Promise.resolve(effect).catch((error) =>
        diagnostic({
          code: 'SDK_DEFERRED_EFFECT',
          severity: 'warning',
          entity: store.resolveMapping(entity).logicalName,
          operation,
          message:
            'An asynchronous record hook of a synchronous SDK ' +
            operation +
            ' failed after the call returned: ' +
            String(error?.message ?? error),
        }),
      );
    }
    return result;
  };
  // A virtual table's synchronous provider read ({ rows }), or null when the table is read locally.
  const virtualRead = (entity, options) =>
    records?.virtualProviders?.readSync(context(), store.resolveMapping(entity).logicalName, options) ?? null;
  const rawGet = (entity, id) => {
    const row = store.get(entity, id, localIdentity, { skipPluginRead: true });
    if (!row) fail('Record not found.', 'NotFound', 404);
    authorize(entity, 'read', row);
    return row;
  };
  const get = (entity, id, columns, { responseToken, partitionId, unmask = false } = {}) => {
    const key = sdkRecordKey(store, entity, id, partitionId);
    const virtual = virtualRead(entity, { single: true, id: key });
    if (virtual) {
      const row = virtual.rows[0];
      if (!row) fail('Record not found.', 'NotFound', 404);
      row[store.resolveMapping(entity).idColumn] ??= key;
      authorize(entity, 'read', row);
      return cloneStateData(records.projectInternal(context(), entity, row, { unmask, single: true }));
    }
    const raw = store.get(entity, key, localIdentity, { skipPluginRead: true });
    if (!raw) fail('Record not found.', 'NotFound', 404);
    authorize(entity, 'read', raw);
    const options = { sdkColumns: columns, sdkResponseToken: responseToken };
    const row = records
      ? records.readInternal(context(), entity, key, { ...options, unmask })
      : store.get(entity, key, localIdentity, options);
    return cloneStateData(row);
  };
  const isChoiceList = (entity, key) => {
    const definition = store.fieldDefinition(entity, key);
    return String(definition?.dataverseType ?? definition?.type ?? '').toLowerCase() === 'multiselectpicklist';
  };
  const invalidChoice = (options, option) =>
    typeof option !== 'number' ||
    !Number.isInteger(option) ||
    option < -2147483648 ||
    option > 2147483647 ||
    (options?.length && !options.some((allowed) => Number(allowed.value) === option));
  const writeGraph = (values, entity) => {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (key.endsWith('@odata.bind')) {
        for (const binding of [value].flat()) {
          if (binding === null) continue;
          const match = /^\/?([a-z][\w]*)\((.+)\)$/i.exec(binding ?? '');
          if (!match) fail('Unsupported backend lookup binding.');
          rawGet(match[1], match[2]);
        }
      } else if (value && typeof value === 'object' && value.logical_name && (value.id || value.keyAttributes)) {
        const target = store.resolveMapping(value.logical_name);
        const partition = value.partitionid ?? values[`${key}pid`];
        const reference = sdkRecordKey(store, value.logical_name, value, partition);
        const found = store.get(value.logical_name, reference, localIdentity, { skipPluginRead: true });
        if (found) {
          authorize(value.logical_name, 'read', found);
          value.id = found[target.idColumn];
          if (isElastic(target)) {
            value.partitionid = found.partitionid ?? null;
            values[`${key}pid`] = value.partitionid;
          }
        } else if (isElastic(target) && partition == null && !value.keyAttributes) {
          authorize(value.logical_name, 'read');
          value.partitionid = null;
          values[`${key}pid`] = null;
        } else fail('Record not found.', 'NotFound', 404);
      } else if (Array.isArray(value) && isChoiceList(entity, key)) {
        const options = store.fieldDefinition(entity, key)?.options;
        if (value.some((option) => invalidChoice(options, option)))
          fail('Backend choices require source-valid Int32 option values.');
      } else if (value && typeof value === 'object' && !isExactNumeric(value))
        fail('Backend deep writes require an explicit security adapter.');
    }
  };
  // The explicit-grant checks of a write, shared by the synchronous and asynchronous drives; answer the store key.
  const prepareCreate = (entity, values) => {
    authorize(entity, 'create', values);
    writeGraph(values, entity);
  };
  const prepareUpdate = (entity, id, values) => {
    const key = sdkRecordKey(store, entity, id, values.partitionid);
    const previous = store.get(entity, key, localIdentity, { skipPluginRead: true });
    if (!previous) fail('Record not found.', 'NotFound', 404);
    authorize(entity, 'update', previous);
    authorize(entity, 'update', { ...previous, ...values });
    writeGraph(values, entity);
    return key;
  };
  const prepareRemove = (entity, id, partitionId) => {
    const key = sdkRecordKey(store, entity, id, partitionId);
    const previous = store.get(entity, key, localIdentity, { skipPluginRead: true });
    if (!previous) fail('Record not found.', 'NotFound', 404);
    authorize(entity, 'delete', previous);
    return key;
  };
  const association = (entity, id, relationship, related, associate, responseToken, awaitIo) => {
    const options = {
      store,
      entity,
      id,
      relationship,
      related,
      identity: localIdentity,
      authorize,
      associate,
      responseToken,
    };
    const run = () => (awaitIo ? executeAssociationAsync : executeAssociation)(options);
    const savepoint = awaitIo ? (fn) => store.sdkMutationAsync(fn) : (fn) => store.sdkMutation(fn);
    if (!records) return savepoint(run);
    if (!uuid.test(id)) fail('SDK association requires a valid source ID.', 'LocalSdkRelationshipInput', 400);
    const { mapping, navigation, rel } = associationBinding(store, entity, relationship, related, localIdentity);
    const operation = associate ? 'associate' : 'disassociate';
    const [logical, rowId, via, ids] =
      rel.many !== false
        ? [mapping.logicalName, id, navigation, related.values.map((ref) => ref.id)]
        : [rel.entity, related.values[0].id, rel.partner, [id]];
    const entry = associate ? 'associateInternal' : 'disassociateInternal';
    // records' association steps yield the write's promise without sync (dataverse-records.mjs associationSteps).
    if (awaitIo)
      return savepoint(() => records[entry](context(), logical, rowId, via, ids, { authorized: true, write: run }));
    return savepoint(() =>
      internal(operation, entity, (opts) =>
        records[entry](context(), logical, rowId, via, ids, { ...opts, write: run }),
      ),
    );
  };
  const readGrants = (logical) => {
    const grants = profile.grants.filter((g) => g.entity === logical && g.operations.includes('read'));
    if (!grants.length) fail('Local backend profile denied read on ' + logical, 'LocalBackendPermissionDenied', 403);
    return grants;
  };
  return {
    get,
    query(entity, params = {}, { responseToken, sdkQuery, unmask = false } = {}) {
      if (params instanceof URLSearchParams ? params.has('$expand') : params.$expand)
        fail('Backend query expansion requires an explicit security adapter.');
      const logical = store.resolveMapping(entity).logicalName;
      const grants = readGrants(logical);
      const constrained = !grants.some((g) => !g.predicate);
      const p = params instanceof URLSearchParams ? Object.fromEntries(params) : params;
      const navigates = (name) => String(p[name] ?? '').includes('/');
      if (constrained && (p.$apply || navigates('$filter') || navigates('$select') || navigates('$orderby')))
        fail(
          'Predicate-backed queries support direct root fields only; navigation/aggregate needs a row-security adapter.',
        );
      const allowed = constrained
        ? (row) => grants.some((g) => g.predicate(cloneStateData(row), 'read') === true)
        : undefined;
      const virtual = virtualRead(entity, {
        request: {
          select: p.$select ?? null,
          filter: p.$filter ?? null,
          orderby: p.$orderby ?? null,
          top: p.$top == null ? null : Number(p.$top),
        },
      });
      if (virtual) {
        const c = context();
        return {
          value: virtual.rows
            .filter((row) => !allowed || allowed(row))
            .map((row) => records.projectInternal(c, logical, row, { unmask, single: false })),
        };
      }
      // Column security as the Web API applies it: masked operands refused, hidden columns evaluated as null.
      const secured = records?.secureInternal?.(context(), logical, { params, unmask }) ?? {};
      const answer = store.query(entity, params, localIdentity, undefined, {
        dialect: 'dataverse',
        sdkResponseToken: responseToken,
        sdkQuery,
        backendRowFilter: allowed,
        ...secured,
      });
      if (records && !answer.sdkCollection && Array.isArray(answer.value)) {
        const c = context();
        for (const row of answer.value) records.projectInternal(c, logical, row, { unmask, single: false });
      }
      return answer;
    },
    fetch(xml, { unmask = false, ...options } = {}) {
      if (typeof xml !== 'string') fail('FetchXML must be a string.');
      const tables = [...xml.matchAll(/<(?:entity|link-entity)\s[^>]*name=["']([\w]+)["']/gi)].map((m) => m[1]);
      if (!tables.length) fail('FetchXML entity is missing.');
      const grants = new Map();
      for (const name of tables) {
        const logical = store.resolveMapping(name).logicalName;
        grants.set(logical, readGrants(logical));
      }
      // A virtual table in the query is refused before the store reads its mirror (no request shape carries FetchXML).
      for (const name of tables) virtualRead(name, { fetchXml: true });
      const backendRowsFilter = (logical, row) =>
        (grants.get(logical) ?? []).some((g) => !g.predicate || g.predicate(cloneStateData(row), 'read') === true);
      const secured = records?.secureInternal?.(context(), tables[0], { fetchXml: xml, unmask }) ?? {};
      const answer = store.fetchXml(xml, localIdentity, { ...options, backendRowsFilter, ...secured });
      return records && !answer.sdkCollection
        ? records.projectFetchedInternal({ ...context(), unmasked: unmask === true }, tables[0], answer)
        : answer;
    },
    create(entity, values, { responseToken } = {}) {
      prepareCreate(entity, values);
      return store.sdkMutation(() =>
        records
          ? internal('create', entity, (options) =>
              records.createInternal(context(), entity, values, {
                ...options,
                writeOptions: { sdkResponseToken: responseToken },
              }),
            )
          : store.createRecord(entity, values, localIdentity, { coerce: true, sdkResponseToken: responseToken }),
      );
    },
    update(entity, id, values, { responseToken } = {}) {
      const key = prepareUpdate(entity, id, values);
      return store.sdkMutation(() =>
        records
          ? internal('update', entity, (options) =>
              records.updateInternal(context(), entity, key, values, {
                ...options,
                writeOptions: { sdkResponseToken: responseToken },
              }),
            )
          : store.updateRecord(entity, key, values, localIdentity, { coerce: true, sdkResponseToken: responseToken }),
      );
    },
    remove(entity, id, { responseToken, partitionId } = {}) {
      const key = prepareRemove(entity, id, partitionId);
      return store.sdkMutation(() =>
        records
          ? internal('delete', entity, (options) =>
              records.removeInternal(context(), entity, key, {
                ...options,
                writeOptions: { sdkResponseToken: responseToken },
              }),
            )
          : store.removeRecord(entity, key, localIdentity, { sdkResponseToken: responseToken }),
      );
    },
    // The same writes on the asynchronous pipeline, for a caller that is not nested inside a plug-in (a flow Dataverse
    // action): the internal entries without sync, inside one awaited SDK savepoint (store.sdkMutationAsync), so a
    // synchronous service endpoint step's post is awaited in process (never on the synchronous I/O bridge) and the
    // afterWrite hooks finish before the call returns. Each answers a promise of the stored row.
    createAsync(entity, values, { responseToken } = {}) {
      prepareCreate(entity, values);
      return store.sdkMutationAsync(() =>
        records
          ? records.createInternal(context(), entity, values, {
              authorized: true,
              writeOptions: { sdkResponseToken: responseToken },
            })
          : store.createRecordAsync(entity, values, localIdentity, { coerce: true, sdkResponseToken: responseToken }),
      );
    },
    updateAsync(entity, id, values, { responseToken } = {}) {
      const key = prepareUpdate(entity, id, values);
      return store.sdkMutationAsync(() =>
        records
          ? records.updateInternal(context(), entity, key, values, {
              authorized: true,
              writeOptions: { sdkResponseToken: responseToken },
            })
          : store.updateRecordAsync(entity, key, values, localIdentity, {
              coerce: true,
              sdkResponseToken: responseToken,
            }),
      );
    },
    removeAsync(entity, id, { responseToken, partitionId } = {}) {
      const key = prepareRemove(entity, id, partitionId);
      return store.sdkMutationAsync(() =>
        records
          ? records.removeInternal(context(), entity, key, {
              authorized: true,
              writeOptions: { sdkResponseToken: responseToken },
            })
          : store.removeRecordAsync(entity, key, localIdentity, { sdkResponseToken: responseToken }),
      );
    },
    // Associate/Disassociate: executeAssociation (explicit grants, the plug-in stages, the store association writes) runs as
    // the write of the organization's association pipeline (records.associateInternal/disassociateInternal), so the record
    // hooks (audit, security rules, committed work) see an SDK association exactly as a Web API $ref. A referencing (N:1)
    // relationship runs the hooks on the referenced row's collection partner, as the store write does.
    // associateAsync/disassociateAsync run the same steps on the asynchronous pipeline (a flow Relate/Unrelate rows action):
    // inside one awaited SDK savepoint, a synchronous service endpoint step's post is awaited in process, never on the bridge.
    associate(entity, id, relationship, related, associate = true, { responseToken } = {}) {
      return association(entity, id, relationship, related, associate, responseToken, false);
    },
    associateAsync(entity, id, relationship, related, { responseToken } = {}) {
      return association(entity, id, relationship, related, true, responseToken, true);
    },
    disassociateAsync(entity, id, relationship, related, { responseToken } = {}) {
      return association(entity, id, relationship, related, false, responseToken, true);
    },

    bulk(operation, targets, { responseToken } = {}) {
      const entity = targets?.[0]?.logicalName;
      const source = (profile.bulkTables ?? []).find((table) => table.entity === entity);
      if (!source || !source.messages.includes(operation === 'createmultiple' ? 'CreateMultiple' : 'UpdateMultiple'))
        fail(
          'Bulk requires explicit source-evidenced standard table and available SDK message capability.',
          'LocalPluginBulkUnsupported',
        );
      const write = records
        ? (update, id, values) =>
            internal(update ? 'update' : 'create', entity, (options) =>
              update
                ? records.updateInternal(context(), entity, id, values, options)
                : records.createInternal(context(), entity, values, options),
            )
        : undefined;
      const authorizeRow = (op, row, previous) => {
        if (previous) authorize(entity, op, previous);
        authorize(entity, op, row);
        writeGraph(row, entity);
      };
      return store.sdkMutation(() =>
        executeBulkRecords({
          store,
          entity,
          operation,
          targets: cloneStateData(targets),
          identity: localIdentity,
          responseToken,
          write,
          authorize: authorizeRow,
        }),
      );
    },
    mapping: (entity) => store.resolveMapping(entity),
    profile: {
      userId: profile.userId,
      evidence: profile.evidence,
      securityModel: 'Explicit project local backend grants; not inferred Dataverse security-role parity',
      pipeline: records
        ? {
            level: 'behaviour',
            asyncHookEffects: 'contract',
            description:
              'Create, Update, Delete and Retrieve run the organization record pipeline (state defaults, synchronous record hooks, audit and version columns, alternate-key answers, read projection). Synchronous service endpoint steps (web hooks, Service Bus emulator sends) post through the synchronous I/O bridge and fail the call when the post fails. An asynchronous pre-operation hook refuses the call (501 SdkAsyncPreOperationUnsupported); asynchronous post-operation remainders finish after the synchronous call returns (SDK_DEFERRED_EFFECT on failure).',
          }
        : {
            level: 'inventory',
            description: 'No organization on the store: writes go to the store without organization rules.',
          },
    },
  };
}

/** SDK wire values carry their .NET type instead of erasing Money/lookups/options. */
export function sdkValueToRecord(value) {
  if (isExactNumeric(value)) return cloneStateData(value);
  if (Array.isArray(value)) return value.map(sdkValueToRecord);
  if (!value || typeof value !== 'object') return value;
  switch (value.$type) {
    case 'Guid':
    case 'DateTime':
      return value.value;
    case 'Money':
    case 'Decimal':
      return exactNumeric(value.value, value.$type);
    case 'Int64':
      return exactNumeric(value.value, 'Int64');
    case 'Double': {
      const raw = value.value;
      const number =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(number)) fail('SDK Double requires a finite numeric value.');
      return number;
    }
    case 'OptionSetValueCollection':
      return value.values.map((v) => v.value ?? v);
    case 'OptionSetValue':
      return value.value;
    case 'EntityReference':
      return {
        id: value.id,
        logical_name: value.logicalName,
        ...(value.name ? { name: value.name } : {}),
        ...(value.keyAttributes ? { keyAttributes: sdkValueToRecord(value.keyAttributes) } : {}),
      };
    case 'AliasedValue':
      return sdkValueToRecord(value.value);
    case 'Entity':
      return Object.fromEntries(Object.entries(value.attributes ?? {}).map(([k, v]) => [k, sdkValueToRecord(v)]));
    default:
      if (own(value, '$type')) fail('Unsupported SDK value type: ' + value.$type);
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sdkValueToRecord(v)]));
  }
}
