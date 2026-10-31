import { cloneStateData } from './state-clone.mjs';
import { DataError } from './data-error.mjs';
import { executeBulkRecords } from './plugin-bulk.mjs';
import { associationBinding, executeAssociation, executeAssociationAsync } from './plugin-association.mjs';
import { isExactNumeric, exactNumeric } from './exact-numeric.mjs';
import { isElastic, recordKey } from './dataverse-elastic.mjs';
import { odataToSdkQuery } from './plugin-query.mjs';
import { sdkQueryParameters } from './plugin-clr.mjs';
import { pluginStoreScope } from './plugin-execution-lifetime.mjs';

const fail = (message, code = 'LocalOrganizationServiceUnsupported', status = 501) => {
  throw new DataError(message, status, code);
};
// A missing row, in the words and code an SDK caller receives (recorded native sdkSurface: Update of a missing row).
// A refusal raised before the write starts (plugin transaction semantics: data.mjs markPluginTransactionFailure).
const beforeWrite = (check) => {
  try {
    return check();
  } catch (error) {
    if (error instanceof DataError) error.details = { ...error.details, refusedBeforeWrite: true };
    throw error;
  }
};
const notFound = (store, entity, id) => {
  throw new DataError(
    `Entity '${store.resolveMapping(entity).logicalName}' With Id = ${id?.id ?? id?.value ?? id} Does Not Exist`,
    404,
    'NotFound',
    { innerCode: '0x80040217' },
  );
};
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const own = (o, k) => o != null && Object.hasOwn(o, k);
const RESERVED_NAMES = ['constructor', 'prototype', '__proto__'];

/** Preserve typed SDK alternate keys; an elastic primary key is scoped by its opaque partition. */
export function sdkRecordKey(store, entity, target, partitionId) {
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
// The privilege an association checks on the row, as the Web API's $ref routes do.
const ROLE_OPERATION = { associate: 'appendto', disassociate: 'appendto' };
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

// The lower-case message names the organization's sdkmessagefilter rows cover for a table; null without a catalogue.
const lowerId = (value) => String(value && typeof value === 'object' ? value.id : (value ?? '')).toLowerCase();
function messageFilters(store, entity) {
  const filters = store.tableRows('sdkmessagefilter');
  if (!filters.length) return null;
  const names = new Map(store.tableRows('sdkmessage').map((row) => [lowerId(row.sdkmessageid), row.name]));
  return new Set(
    filters
      .filter((row) => row.primaryobjecttypecode === entity)
      .map((row) => String(names.get(lowerId(row.sdkmessageid)) ?? '').toLowerCase()),
  );
}

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
  if (
    profile.privileges !== undefined &&
    (!Array.isArray(profile.privileges) ||
      profile.privileges.some((value) => typeof value !== 'string' || !/^prv[A-Za-z0-9]+$/.test(value)))
  )
    fail(
      'Local backend privileges must name explicit source-qualified privilege names.',
      'LocalBackendIdentityRequired',
      409,
    );
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
  // A plug-in service of a Dataverse user (plugin-clr.mjs dispatchSdkCallCore): that user's security roles decide, as the
  // Web API decides for its callers; the SYSTEM user is not checked.
  const security = profile.dataverseSecurity;
  if (security === 'system') return logical;
  if (security) {
    const principals = store.recordPipeline?.organizationApi?.principals;
    if (!principals)
      fail('A Dataverse run-as user needs the organization security model.', 'LocalBackendIdentityRequired', 409);
    principals.authorize({
      user: security,
      entity: logical,
      operation: ROLE_OPERATION[operation] ?? operation,
      row: operation === 'create' ? undefined : row,
    });
    return logical;
  }
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
export function localOrganizationService(store, profile, records, { diagnostic = () => {}, requestOptions = {} } = {}) {
  const invocation = pluginStoreScope(store);
  store = invocation?.store ?? store;
  records ??= store.recordPipeline;
  validateServiceProfile(profile);
  // Bypass portal grants only AFTER the separate backend grant check below.
  const localIdentity = { id: profile.userId, admin: true };
  const authorize = (entity, operation, row) => authorizeGrant(store, profile, entity, operation, row);
  // A grant contains the effective main write, including changes made by
  // PreOperation steps and declarative rules. This one-use capability belongs
  // to one service invocation, never a recursive child or a deferred effect.
  const effectiveWrite = (entity, operation, run) => {
    const logical = store.resolveMapping(entity).logicalName;
    let active = true,
      consumed = false;
    const assertScope = (actualEntity, actualOperation) => {
      if (!active || consumed || actualEntity !== logical || actualOperation !== operation)
        fail(
          'Local backend effective write authorization is outside its invocation.',
          'LocalBackendPermissionDenied',
          403,
        );
    };
    const check = (row, previous) => {
      if (operation === 'update') authorize(logical, operation, previous);
      authorize(logical, operation, row);
    };
    const authorizeEffectiveWrite = (actualEntity, actualOperation, row, previous) => {
      assertScope(actualEntity, actualOperation);
      consumed = true;
      check(row, previous);
    };
    // Delete cascades can themselves invoke privileged SDK writes. Check once
    // before admitting those effects, then consume the capability only at the
    // actual root removal, after all cascaded steps have finished.
    authorizeEffectiveWrite.preflight = (actualEntity, actualOperation, row, previous) => {
      assertScope(actualEntity, actualOperation);
      check(row, previous);
    };
    try {
      const result = run(authorizeEffectiveWrite);
      if (typeof result?.then === 'function')
        return result.finally(() => {
          active = false;
        });
      active = false;
      return result;
    } catch (error) {
      active = false;
      throw error;
    }
  };
  // One context per call: the record hooks key per-write state on it. The SDK user is the profile's systemuser (SYSTEM
  // when the organization has no such user); the explicit grants above have authorized the call.
  const context = () => ({
    identity: localIdentity,
    userId: profile.userId,
    caller: null,
    method: 'SDK',
    headers: {},
    bypassCustomPlugins: requestOptions.bypassCustomPlugins === true,
    bypassCustomAsync: requestOptions.bypassCustomAsync === true,
    bypassStepIds: requestOptions.bypassStepIds,
    systemParameters: requestOptions.systemParameters,
    sdkFromSandbox: requestOptions.sdkFromSandbox === true,
  });
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
    if (!row) notFound(store, entity, id);
    authorize(entity, 'read', row);
    return row;
  };
  const get = (entity, id, columns, { responseToken, partitionId, unmask = false } = {}) => {
    const key = sdkRecordKey(store, entity, id, partitionId);
    const options = {
      sdkColumns: columns,
      sdkResponseToken: responseToken,
      bypassStepIds: requestOptions.bypassStepIds,
      bypassCustomPlugins: requestOptions.bypassCustomPlugins === true,
      sdkFromSandbox: requestOptions.sdkFromSandbox === true,
      ...(id?.$type === 'EntityReference' ? { sdkTarget: id } : {}),
      resolveTarget: (target) =>
        id && typeof id === 'object' && target.id !== id.id
          ? target.id
          : sdkRecordKey(store, entity, target, partitionId),
      authorizeRead: (row) => authorize(entity, 'read', row),
      ...(partitionId === undefined ? {} : { partitionId }),
    };
    const row = records
      ? records.readInternal(context(), entity, key, { ...options, unmask })
      : store.get(entity, key, localIdentity, options);
    if (!row) notFound(store, entity, id);
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
  const prepareCreate = (entity, values, sdkCreateId) => {
    const seeded = sdkCreateId && sdkCreateId !== '00000000-0000-0000-0000-000000000000';
    authorize(entity, 'create', seeded ? { ...values, [store.resolveMapping(entity).idColumn]: sdkCreateId } : values);
    writeGraph(values, entity);
  };
  const prepareUpdate = (entity, id, values) => {
    const key = sdkRecordKey(store, entity, id, values.partitionid);
    const previous = store.get(entity, key, localIdentity, { skipPluginRead: true });
    if (!previous) notFound(store, entity, id);
    beforeWrite(() => {
      authorize(entity, 'update', previous);
      authorize(entity, 'update', { ...previous, ...values });
    });
    writeGraph(values, entity);
    return key;
  };
  const prepareRemove = (entity, id, partitionId) => {
    const key = sdkRecordKey(store, entity, id, partitionId);
    const previous = store.get(entity, key, localIdentity, { skipPluginRead: true });
    if (!previous) notFound(store, entity, id);
    beforeWrite(() => authorize(entity, 'delete', previous));
    return key;
  };
  const association = (entity, id, relationship, related, associate, responseToken, awaitIo) => {
    const effectiveAssociation = {};
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
      bypassCustomPlugins: requestOptions.bypassCustomPlugins === true,
      bypassCustomAsync: requestOptions.bypassCustomAsync === true,
      bypassStepIds: requestOptions.bypassStepIds,
      onRebind: (binding) => Object.assign(effectiveAssociation, binding),
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
      return savepoint(() =>
        records[entry](context(), logical, rowId, via, ids, { authorized: true, write: run, effectiveAssociation }),
      );
    return savepoint(() =>
      internal(operation, entity, (opts) =>
        records[entry](context(), logical, rowId, via, ids, { ...opts, write: run, effectiveAssociation }),
      ),
    );
  };
  const readGrants = (logical) => {
    // A Dataverse run-as user reads the rows its roles admit (the Web API read filter); SYSTEM reads every row.
    if (profile.dataverseSecurity === 'system') return [{}];
    if (profile.dataverseSecurity) {
      const filter = store.recordPipeline?.organizationApi?.principals?.readFilter({
        user: profile.dataverseSecurity,
        entity: logical,
      });
      return [{ predicate: filter ? (row) => filter(row) : undefined }];
    }
    const grants = profile.grants.filter((g) => g.entity === logical && g.operations.includes('read'));
    if (!grants.length) fail('Local backend profile denied read on ' + logical, 'LocalBackendPermissionDenied', 403);
    return grants;
  };
  const service = {
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
      const virtualStatus = records?.virtualProviders?.status?.(logical);
      if (virtualStatus?.virtual && !virtualStatus.fallback) {
        const c = context();
        const execute = (params) => {
          const virtual = virtualRead(entity, {
            request: {
              select: params.$select ?? null,
              filter: params.$filter ?? null,
              orderby: params.$orderby ?? null,
              top: params.$top == null ? null : Number(params.$top),
            },
          });
          return {
            value: virtual.rows
              .filter((row) => !allowed || allowed(row))
              .map((row) => records.projectInternal(c, logical, row, { unmask, single: false })),
          };
        };
        if (
          !store.pluginPipeline ||
          !store.pluginPipelineActive({
            entity: logical,
            operation: 'retrievemultiple',
            bypassStepIds: requestOptions.bypassStepIds,
            bypassCustomPlugins: requestOptions.bypassCustomPlugins === true,
          })
        )
          return execute(p);
        return store.retrieveMultipleOperation(
          logical,
          sdkQuery ?? odataToSdkQuery(logical, p, store),
          localIdentity,
          (query) => {
            if (!['QueryExpression', 'QueryByAttribute'].includes(query.$type) || query.entityName !== logical)
              fail('Virtual RetrieveMultiple must retain its bound table and query type.');
            return execute(sdkQueryParameters(query));
          },
          'value',
          responseToken,
          {
            bypassCustomPlugins: requestOptions.bypassCustomPlugins === true,
            bypassStepIds: requestOptions.bypassStepIds,
          },
        );
      }
      // Column security as the Web API applies it: masked operands refused, hidden columns evaluated as null.
      const secured = records?.secureInternal?.(context(), logical, { params, unmask }) ?? {};
      const answer = store.query(entity, params, localIdentity, undefined, {
        dialect: 'dataverse',
        sdkResponseToken: responseToken,
        sdkQuery,
        bypassStepIds: requestOptions.bypassStepIds,
        bypassCustomPlugins: requestOptions.bypassCustomPlugins === true,
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
      const answer = store.fetchXml(
        xml,
        { ...localIdentity, dataverse: true, systemUserId: profile.userId },
        {
          ...options,
          bypassCustomPlugins: requestOptions.bypassCustomPlugins === true,
          bypassStepIds: requestOptions.bypassStepIds,
          backendRowsFilter,
          ...secured,
        },
      );
      return records && !answer.sdkCollection
        ? records.projectFetchedInternal({ ...context(), unmasked: unmask === true }, tables[0], answer)
        : answer;
    },
    create(entity, values, { responseToken, sdkCreateId } = {}) {
      prepareCreate(entity, values, sdkCreateId);
      return effectiveWrite(entity, 'create', (authorizeEffectiveWrite) =>
        store.sdkMutation(() =>
          records
            ? internal('create', entity, (options) =>
                records.createInternal(context(), entity, values, {
                  ...options,
                  writeOptions: {
                    sdkResponseToken: responseToken,
                    sdkCreateId,
                    authorizeEffectiveWrite,
                    sdkFromSandbox: requestOptions.sdkFromSandbox === true,
                  },
                }),
              )
            : store.createRecord(entity, values, localIdentity, {
                ...requestOptions,
                coerce: true,
                sdkResponseToken: responseToken,
                sdkCreateId,
                authorizeEffectiveWrite,
              }),
        ),
      );
    },
    update(entity, id, values, { responseToken, ifMatch, concurrencyBehavior } = {}) {
      const key = prepareUpdate(entity, id, values);
      return effectiveWrite(entity, 'update', (authorizeEffectiveWrite) =>
        store.sdkMutation(() =>
          records
            ? internal('update', entity, (options) =>
                records.updateInternal(context(), entity, key, values, {
                  ...options,
                  writeOptions: {
                    sdkResponseToken: responseToken,
                    authorizeEffectiveWrite,
                    sdkFromSandbox: requestOptions.sdkFromSandbox === true,
                    ...(ifMatch == null ? {} : { ifMatch }),
                    ...(concurrencyBehavior == null ? {} : { pluginConcurrencyBehavior: concurrencyBehavior }),
                  },
                }),
              )
            : store.updateRecord(entity, key, values, localIdentity, {
                ...requestOptions,
                coerce: true,
                sdkResponseToken: responseToken,
                authorizeEffectiveWrite,
                ...(ifMatch == null ? {} : { ifMatch }),
              }),
        ),
      );
    },
    // The Update a named message's main operation performs (plugin-platform-messages.mjs): the caller has authorized the
    // message; writeOptions shape its pipeline (skipPreValidation, omitConcurrencyBehavior, stateMessage).
    messageUpdate(entity, id, values, writeOptions = {}) {
      const key = sdkRecordKey(store, entity, id);
      const previous = store.get(entity, key, localIdentity, { skipPluginRead: true });
      if (!previous) notFound(store, entity, id);
      authorize(entity, 'update', previous);
      return store.sdkMutation(() =>
        records
          ? internal('update', entity, (options) =>
              records.updateInternal(context(), entity, key, values, { ...options, writeOptions }),
            )
          : store.updateRecord(entity, key, values, localIdentity, {
              ...requestOptions,
              coerce: true,
              ...writeOptions,
            }),
      );
    },
    remove(entity, id, { responseToken, partitionId, ifMatch, concurrencyBehavior } = {}) {
      const key = prepareRemove(entity, id, partitionId);
      return effectiveWrite(entity, 'delete', (authorizeEffectiveWrite) =>
        store.sdkMutation(() =>
          records
            ? internal('delete', entity, (options) =>
                records.removeInternal(context(), entity, key, {
                  ...options,
                  writeOptions: {
                    sdkResponseToken: responseToken,
                    sdkFromSandbox: requestOptions.sdkFromSandbox === true,
                    authorizeEffectiveWrite,
                    ...(ifMatch == null ? {} : { ifMatch }),
                    ...(concurrencyBehavior == null ? {} : { pluginConcurrencyBehavior: concurrencyBehavior }),
                  },
                }),
              )
            : store.removeRecord(entity, key, localIdentity, {
                ...requestOptions,
                sdkResponseToken: responseToken,
                authorizeEffectiveWrite,
                ...(ifMatch == null ? {} : { ifMatch }),
              }),
        ),
      );
    },
    // The same writes on the asynchronous pipeline, for a caller that is not nested inside a plug-in (a flow Dataverse
    // action): the internal entries without sync, inside one awaited SDK savepoint (store.sdkMutationAsync), so a
    // synchronous service endpoint step's post is awaited in process (never on the synchronous I/O bridge) and the
    // afterWrite hooks finish before the call returns. Each answers a promise of the stored row.
    createAsync(entity, values, { responseToken, sdkCreateId } = {}) {
      prepareCreate(entity, values, sdkCreateId);
      return effectiveWrite(entity, 'create', (authorizeEffectiveWrite) =>
        store.sdkMutationAsync(() =>
          records
            ? records.createInternal(context(), entity, values, {
                authorized: true,
                writeOptions: {
                  sdkResponseToken: responseToken,
                  sdkCreateId,
                  authorizeEffectiveWrite,
                  sdkFromSandbox: requestOptions.sdkFromSandbox === true,
                },
              })
            : store.createRecordAsync(entity, values, localIdentity, {
                ...requestOptions,
                coerce: true,
                sdkResponseToken: responseToken,
                sdkCreateId,
                authorizeEffectiveWrite,
              }),
        ),
      );
    },
    updateAsync(entity, id, values, { responseToken } = {}) {
      const key = prepareUpdate(entity, id, values);
      return effectiveWrite(entity, 'update', (authorizeEffectiveWrite) =>
        store.sdkMutationAsync(() =>
          records
            ? records.updateInternal(context(), entity, key, values, {
                authorized: true,
                writeOptions: {
                  sdkResponseToken: responseToken,
                  sdkFromSandbox: requestOptions.sdkFromSandbox === true,
                  authorizeEffectiveWrite,
                },
              })
            : store.updateRecordAsync(entity, key, values, localIdentity, {
                ...requestOptions,
                coerce: true,
                sdkResponseToken: responseToken,
                authorizeEffectiveWrite,
              }),
        ),
      );
    },
    removeAsync(entity, id, { responseToken, partitionId } = {}) {
      const key = prepareRemove(entity, id, partitionId);
      return effectiveWrite(entity, 'delete', (authorizeEffectiveWrite) =>
        store.sdkMutationAsync(() =>
          records
            ? records.removeInternal(context(), entity, key, {
                authorized: true,
                writeOptions: {
                  sdkResponseToken: responseToken,
                  sdkFromSandbox: requestOptions.sdkFromSandbox === true,
                  authorizeEffectiveWrite,
                },
              })
            : store.removeRecordAsync(entity, key, localIdentity, {
                ...requestOptions,
                sdkResponseToken: responseToken,
                authorizeEffectiveWrite,
              }),
        ),
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
      const message = operation === 'createmultiple' ? 'CreateMultiple' : 'UpdateMultiple';
      // Natively the table's sdkmessagefilter for the message makes it available (recorded native sdkSurface: a
      // plug-in's UpdateMultiple/CreateMultiple on custom tables); a profile's bulkTables entry is an optional extra.
      const granted = (profile.bulkTables ?? []).some(
        (table) => table.entity === entity && table.messages.includes(message),
      );
      const filters = granted ? null : messageFilters(store, entity);
      if (!granted && !filters?.has(message.toLowerCase())) {
        // A table whose filter catalogue lacks the message: the platform's MessageProcessor.Empty refusal (the recorded
        // native fault of Merge on a table without its filter; assumed the same for the bulk messages).
        if (filters?.size)
          throw new DataError(
            `The '${message}' method does not support entities of type '${entity}'. MessageProcessorCache returned MessageProcessor.Empty. `,
            400,
            'InvalidRequest',
            { innerCode: '0x80040800' },
          );
        fail(
          'Bulk requires explicit source-evidenced standard table and available SDK message capability.',
          'LocalPluginBulkUnsupported',
        );
      }
      // The elastic bulk semantics (per-target commits) are not implemented for SDK callers.
      if (tableName(entity) && isElastic(store.resolveMapping(entity)))
        fail('SDK bulk on an elastic table is not supported locally.', 'LocalPluginBulkUnsupported');
      const write = records
        ? (update, id, values, { postWriteEffects, ...writeOptions } = {}) =>
            internal(update ? 'update' : 'create', entity, (options) =>
              update
                ? records.updateInternal(context(), entity, id, values, { ...options, writeOptions, postWriteEffects })
                : records.createInternal(context(), entity, values, { ...options, writeOptions, postWriteEffects }),
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
          bypassCustomPlugins: requestOptions.bypassCustomPlugins === true,
          bypassCustomAsync: requestOptions.bypassCustomAsync === true,
          bypassStepIds: requestOptions.bypassStepIds,
          systemParameters: requestOptions.systemParameters,
          // A plug-in's bulk request is marked FromSandbox, and its UpdateMultiple carries the SDK's ConcurrencyBehavior
          // (Default) at every stage (native sdkSurface CreateMultiple/UpdateMultiple at Depth 2).
          sdkFromSandbox: requestOptions.sdkFromSandbox === true,
          ...(operation === 'updatemultiple' ? { concurrencyBehavior: 0 } : {}),
          write,
          runPostEffect: (effect) => internal(operation === 'updatemultiple' ? 'update' : 'create', entity, effect),
          authorize: authorizeRow,
        }),
      );
    },
    executeMessageSync(name, target, parameters) {
      // A Dataverse run-as user executes any message its privileges allow: the message's own execute privilege is checked
      // by the operation as that user, as on the Web API.
      const principal = profile.dataverseSecurity
        ? { ...profile, grants: [{ message: name, operations: ['execute'] }] }
        : profile;
      if (
        !principal.grants.some(
          (grant) =>
            typeof grant.message === 'string' &&
            grant.message.toLowerCase() === name.toLowerCase() &&
            grant.operations.includes('execute'),
        )
      )
        fail('Local backend profile denied execute on ' + name, 'LocalBackendPermissionDenied', 403);
      if (!records?.executeMessageSyncInternal)
        fail('Custom SDK messages require an organization message adapter.', 'LocalPluginSdkUnsupported', 501);
      return store.sdkMutation(() =>
        records.executeMessageSyncInternal({
          principal,
          name,
          target,
          parameters,
          systemParameters: requestOptions.systemParameters,
          sdkFromSandbox: requestOptions.sdkFromSandbox === true,
          bypassCustomPlugins: requestOptions.bypassCustomPlugins === true,
          bypassCustomAsync: requestOptions.bypassCustomAsync === true,
          bypassStepIds: requestOptions.bypassStepIds,
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
  for (const [name, operation] of Object.entries(service)) {
    if (typeof operation !== 'function') continue;
    const writes = [
      'create',
      'update',
      'remove',
      'createAsync',
      'updateAsync',
      'removeAsync',
      'associate',
      'associateAsync',
      'disassociateAsync',
      'bulk',
      'executeMessageSync',
      'messageUpdate',
    ].includes(name);
    service[name] = (...args) => {
      try {
        invocation?.assertActive();
        const result = operation(...args);
        const returned =
          invocation && result?.then
            ? result.then((value) => invocation.snapshot(value))
            : invocation
              ? invocation.snapshot(result)
              : result;
        return returned?.then
          ? returned.catch((error) => {
              if (writes) store.markPluginTransactionFailure?.(error);
              throw error;
            })
          : returned;
      } catch (error) {
        if (writes) store.markPluginTransactionFailure?.(error);
        throw error;
      }
    };
  }
  return service;
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
