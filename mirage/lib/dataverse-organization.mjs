// Organization services independent of HTTP, portal rendering and transport authentication.
import { randomUUID } from 'node:crypto';
import { createPrincipals, ensureSecurityModel, uuidV5 } from './dataverse-security.mjs';
import { createMetadataService, objectTypeCode as typeCodeOf } from './dataverse-metadata.mjs';
import { createChangeLog } from './dataverse-changes.mjs';
import { hashSecret, verifySecret } from './dataverse-auth.mjs';
import { seedManagedIdentityRows } from './dataverse-managed-identity.mjs';
import { createOperationRegistry } from './dataverse-operations.mjs';
import { createServiceProtection } from './dataverse-limits.mjs';
import { standardGlobalOptionSets, fieldsWithStandard } from './dataverse-standard.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { DataError } from './data-error.mjs';
import { EXTENSIONS } from './dataverse-extensions.mjs';
import { ownsChange, runOwned, runAtomic } from './dataverse-transaction-context.mjs';
import { clockFunction, storeScheduler, systemClock, systemIds } from './runtime-clock.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { createCounters } from './runtime-counters.mjs';
import { QUEUE_MESSAGE_MAPPING, QUEUE_MESSAGE_TABLE } from './message-bus.mjs';
import { OUTBOX_MAPPING, OUTBOX_TABLE } from './outbox.mjs';
import { FLOW_RUN_TABLE } from './flow-runs.mjs';

// A stable number per state object: a replaced state (restore, reset) never reuses a cached derivation.
const stateIds = new WeakMap();
let nextStateId = 0;
const stateKey = (state) => {
  if (!stateIds.has(state)) stateIds.set(state, ++nextStateId);
  return stateIds.get(state);
};
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
// The organization's internal tables (the one registration seam): table -> its own mapping, or null for a standard table
// whose mapping the standard metadata supplies. The organization composes them in its startup transaction, before any
// simulation level captures the schema, so the first message, outbox capture or flow run writes rows, never the schema.
// Async operations (asyncoperation) are a seeded security-model table already.
const INTERNAL_TABLE_MAPPINGS = Object.freeze({
  [QUEUE_MESSAGE_TABLE]: QUEUE_MESSAGE_MAPPING,
  [OUTBOX_TABLE]: OUTBOX_MAPPING,
  [FLOW_RUN_TABLE]: null,
});
/** The internal table names, for the persistence layer (runtime-owned rows at every simulation level). */
export const INTERNAL_TABLES = Object.freeze(Object.keys(INTERNAL_TABLE_MAPPINGS));
function composeInternalTables(store) {
  for (const [table, mapping] of Object.entries(INTERNAL_TABLE_MAPPINGS)) {
    if (mapping) store.state.mappings[table] ??= structuredClone(mapping);
    store.state.tables[table] ??= [];
  }
}
const DATAVERSE_NAMESPACE = uuidV5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'paqvilo-dataverse');
export const dataverseOrganizationId = (settings) =>
  (settings.organizationId ?? uuidV5(DATAVERSE_NAMESPACE, `${settings.uniqueName}:organization`)).toLowerCase();
function seedRegistrations(store, settings, ids, clock) {
  const dv = (store.state.dataverse ??= {});
  Object.assign(dv, {
    tenantId: ids.tenantId,
    organizationId: ids.organizationId,
    uniqueName: settings.uniqueName,
    friendlyName: settings.friendlyName,
    version: settings.version,
    environmentId: ids.environmentId,
    datacenterId: ZERO_GUID,
    geo: 'NA',
  });
  dv.applications ??= [];
  for (const app of settings.applications ?? []) {
    const registration = {
      publicClient: app.publicClient ?? false,
      redirectUris: app.redirectUris ?? [],
      // Stored as configured (short names); dataverse-settings grantAllowed maps them at the token endpoint.
      allowedGrants: app.allowedGrants,
      federatedCredentials: app.federatedCredentials ?? [],
    };
    let entry = dv.applications.find((item) => String(item.appId).toLowerCase() === app.appId);
    if (!entry) {
      entry = {
        appId: app.appId,
        displayName: app.displayName,
        createdOn: new Date(clock()).toISOString(),
        secrets: [],
        certificates: [],
        ...registration,
      };
      dv.applications.push(entry);
    } else Object.assign(entry, registration);
    entry.secrets ??= [];
    const secret = app.secretEnvironmentVariable ? process.env[app.secretEnvironmentVariable] : undefined;
    if (secret && !entry.secrets.some((item) => verifySecret(secret, item))) {
      entry.secrets.push({ id: randomUUID(), ...hashSecret(secret), hint: secret.slice(0, 3), expiresOn: null });
    }
  }
}

// The providers object: every key present, each a provider or null.
const PROVIDER_KEYS = [
  'storage',
  'messaging',
  'outbox',
  'connectors',
  'secrets',
  'serviceFixtures',
  'powerFx',
  'localServices',
];
const providersOf = (providers = {}) =>
  Object.freeze(Object.fromEntries(PROVIDER_KEYS.map((key) => [key, providers?.[key] ?? null])));

/** The diagnostic sink extensions get. While held (install, reseed), repeated `*_NOT_SIMULATED` diagnostics of one code
 * become one summary with the tables they name; other diagnostics pass straight through. */
function extensionDiagnostics(forward) {
  let held = null;
  const sink = (entry) => {
    if (held && /_NOT_SIMULATED$/.test(String(entry?.code ?? ''))) {
      held.set(entry.code, [...(held.get(entry.code) ?? []), entry]);
      return;
    }
    forward(entry);
  };
  sink.hold = () => {
    held ??= new Map();
  };
  sink.flush = () => {
    const groups = held;
    held = null;
    for (const [code, entries] of groups ?? []) {
      if (entries.length === 1) {
        forward(entries[0]);
        continue;
      }
      const tables = [
        ...new Set(entries.map((entry) => entry.table ?? entry.entity ?? entry.logicalName).filter(Boolean)),
      ].sort();
      forward({
        code,
        severity: entries[0].severity ?? 'info',
        count: entries.length,
        tables,
        message: `${entries.length} ${code} diagnostics${tables.length ? ` for ${tables.length} tables` : ''}; the first: ${entries[0].message ?? code}`,
      });
    }
  };
  return sink;
}

function maxRowVersion(state) {
  let max = 0;
  for (const rows of Object.values(state.tables ?? {})) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const version = Number(row?.versionnumber);
      if (Number.isSafeInteger(version) && version > max) max = version;
    }
  }
  return max;
}

export async function createOrganizationRuntime(options) {
  let organization;
  try {
    // All registration/security/extension seeders join this private startup
    // transaction. Otherwise each installer clones and checkpoints the complete
    // business dataset, even during an unchanged-state restart. No listener is
    // published until this commits; failed composition restores the old state.
    return await options.store.transact(async () => (organization = await composeOrganizationRuntime(options)), {
      isolated: true,
      cloneResult: false,
      skipSaveIfUnchanged: true,
    });
  } catch (error) {
    if (organization) await organization.close().catch(() => {});
    else {
      const pending = pendingSchedulers.get(options.store);
      pendingSchedulers.delete(options.store);
      if (pending) releaseOrganizationScheduler(pending);
    }
    throw error;
  }
}

// Schedulers an organization opened, with the number of open organizations using each (composeOrganizationRuntime).
const organizationSchedulers = new WeakMap();
// Schedulers opened by a composition that has not returned yet (store → scheduler), released if that composition throws.
const pendingSchedulers = new WeakMap();
const releaseOrganizationScheduler = (scheduler) => {
  const users = organizationSchedulers.get(scheduler) - 1;
  organizationSchedulers.set(scheduler, users);
  if (!users) scheduler.close();
};

async function composeOrganizationRuntime({
  store,
  settings,
  change = (fn) => fn(),
  schema = () => null,
  metadataFields = () => undefined,
  readMetadata = (fn) => fn(),
  clock: clockOption,
  ids: idsOption,
  scheduler: schedulerOption,
  records = null,
  log = () => {},
  extensions = EXTENSIONS,
  providers = null,
  packs = [],
  secrets = undefined,
  diagnostic = () => {},
}) {
  // One clock, id and scheduler source (runtime-clock.mjs) for the store and the API: an option replaces the store's default,
  // otherwise the store's own drives the API too.
  if (clockOption && (!store.clock || store.clock === systemClock))
    store.clock = typeof clockOption === 'function' ? { now: clockOption } : clockOption;
  const clock = clockOption ? clockFunction(clockOption) : () => (store.clock ?? systemClock).now();
  if (idsOption && (!store.ids || store.ids === systemIds)) store.ids = idsOption;
  const ids = idsOption ?? store.ids ?? systemIds;
  // Organizations own the scheduler only when one of them opened it (no backend or caller supplied one): the last of them
  // closes it, so organizations hosted without a backend leave no timers. A backend-owned scheduler stays open for the backend.
  const previousScheduler = store.scheduler;
  const scheduler = storeScheduler(store, schedulerOption ?? null, { reopen: true });
  // Activity counters (runtime-counters.mjs) for the /_sim/ dashboard: one set per store, kept across organization restarts.
  store.counters ??= createCounters();
  if (!schedulerOption && scheduler !== previousScheduler) organizationSchedulers.set(scheduler, 0);
  const ownsScheduler = organizationSchedulers.has(scheduler);
  if (ownsScheduler) {
    organizationSchedulers.set(scheduler, organizationSchedulers.get(scheduler) + 1);
    pendingSchedulers.set(store, scheduler);
  }
  // Standard table columns under the Solution's own fields; the records and TDS layers both read this.
  const solutionFields = metadataFields;
  metadataFields = (logical) => fieldsWithStandard(store, logical, solutionFields(logical));
  const tenantId = (settings.tenantId ?? uuidV5(DATAVERSE_NAMESPACE, `${settings.uniqueName}:tenant`)).toLowerCase();
  const organizationId = dataverseOrganizationId(settings);
  const environmentId = `Default-${tenantId}`;
  const applications = settings.applications ?? [];

  const securitySettings = {
    organizationId,
    tenantId,
    uniqueName: settings.uniqueName,
    friendlyName: settings.friendlyName,
    version: settings.version,
    auditing: settings.auditing,
    duplicateDetection: settings.duplicateDetection,
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    localeId: settings.localeId,
    // A managed identity is an application user too: its token's appid is the clientId, and its roles are the user's roles.
    applications: [
      ...applications.map((app) => ({ appId: app.appId, displayName: app.displayName, roles: app.roles ?? [] })),
      ...(settings.managedIdentities ?? []).map((identity) => ({
        appId: identity.clientId,
        displayName: identity.displayName,
        roles: identity.roles ?? [],
      })),
    ],
    // Settings rows use domainname/fullname; the security model reads upn/displayName.
    users: (settings.users ?? []).map((user) => ({
      objectId: user.objectId,
      upn: user.domainname,
      displayName: user.fullname,
      roles: user.roles,
    })),
  };
  const registerApplications = () =>
    store.transact(() => {
      seedRegistrations(store, settings, { tenantId, organizationId, environmentId }, clock);
      seedManagedIdentityRows(store, { tenantId, identities: settings.managedIdentities ?? [] });
    });
  const seedSecurity = () => ensureSecurityModel(store, securitySettings, { schema });
  await change(registerApplications);
  await change(() => store.transact(() => composeInternalTables(store)));
  await change(seedSecurity);
  // Record writes from inside a $batch skip `change` (see inBatch); other record writes use the caller's change.
  // The slot owner is marked (runOwned), so a nested recordChange from inside the slot (a message handler called by a flow
  // run, a plug-in writing through the SDK) joins it instead of waiting on itself.
  const recordChange = (fn) => (ownsChange() ? fn() : change(() => runOwned(fn)));

  const principals = createPrincipals(store, { organizationId, tenantId, objectTypeCode: typeCodeOf, schema });
  // Extension operations (dataverse-operations.mjs) answer before the built-in functions and actions.
  const operations = createOperationRegistry();
  const metadata = createMetadataService({
    organizationId,
    lcid: settings.localeId,
    schema,
    // Private provider rows are composed before metadata capture, but are not organization entities.
    // Keep standard internal tables (the null registrations) visible through their normal metadata.
    mappings: () =>
      Object.fromEntries(
        Object.entries(store.state.mappings).filter(
          ([name]) => !(Object.hasOwn(INTERNAL_TABLE_MAPPINGS, name) && INTERNAL_TABLE_MAPPINGS[name]),
        ),
      ),
    virtualTables: () => store.virtualTables?.() ?? {},
    globalOptionSets: () => ({ ...standardGlobalOptionSets(), ...(store.state.dataverse?.globalOptionSets ?? {}) }),
    changeLog: () => store.state.dataverse?.metadataLog ?? [],
    extraCsdl: () => operations.csdlFragments(),
    // Commits advance dataRevision; a replaced state or a table added outside a commit changes the other parts.
    revision: () => `${store.dataRevision()}|${stateKey(store.state)}|${Object.keys(store.state.mappings).length}`,
  });
  // One change log per API: the record handlers read it, a rolled-back changeset rewinds it and a reset expires its tokens.
  const changes = createChangeLog(store, { clock });
  const { createRecordHandlers, createRecordHooks } = await import('./dataverse-records.mjs');
  const recordHooks = createRecordHooks();
  // fieldSecurity is read per request: the fls extension sets api.fieldSecurity when it installs, after the handlers exist.
  const recordHandlers =
    records ??
    createRecordHandlers({
      store,
      change: recordChange,
      principals,
      metadata,
      metadataFields,
      objectTypeCode: typeCodeOf,
      clock,
      changes,
      hooks: recordHooks,
      fieldSecurity: () => api.fieldSecurity,
    });

  // Extensions get the registry, the routes and the api object; security is re-seeded after they install, so tables
  // they seed get privileges and role grants (seedSecurity is idempotent).
  const routes = [];
  // Shared by the HTTP router and the TDS endpoint, so both admit requests against the same windows.
  const limits = createServiceProtection({ ...(settings.serviceProtection ?? {}), clock });
  const api = {
    store,
    change: recordChange,
    registry: operations,
    principals,
    metadata,
    metadataFields,
    readMetadata,
    records: recordHandlers,
    recordHooks,
    settings,
    schema,
    changes,
    clock,
    ids,
    scheduler,
    limits,
    tdsPort: null,
    log,
    addRoute: (match, handler, { anonymous = false } = {}) => {
      routes.push({ match, handler, anonymous });
    },
    // A changeset or a SOAP transaction runs fn as one unit against this api's store and change log (see runAtomic).
    runAtomic: (fn) => runAtomic(api, fn),
    dataRevision: () => store.dataRevision?.(),
    // Host providers (organization-host.mjs) and the runtime's packs, set before any extension installs.
    // An explicit `secrets` resolver option wins over providers.secrets; api.secrets stays its alias for the message handlers.
    providers: providersOf(secrets === undefined ? providers : { ...providers, secrets }),
    packs,
    packExport: (name) => collectPackExport(packs, name),
    diagnostic: extensionDiagnostics(diagnostic),
  };
  api.secrets = api.providers.secrets;
  // Metadata functions over the metadata service's response builders.
  const metadataFunction = (name, respond, csdl) =>
    operations.register({
      name,
      kind: 'function',
      binding: 'unbound',
      csdl,
      handle: (c) => {
        const response = respond(c.params);
        if (!response) throw new DataError(`${name} does not find the requested metadata.`, 404, 'NotFound');
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`),
            ...response,
          },
        };
      },
    });
  // The response property types (ComplexEntityMetadata, ComplexAttributeMetadata) are assumed; the EntityFilters flags are
  // Edm.Int32 here, not the mscrm enum.
  metadataFunction(
    'RetrieveEntity',
    (p) => metadata.retrieveEntityResponse(p.LogicalName ?? p.MetadataId ?? null, p.EntityFilters ?? null),
    `<ComplexType Name="RetrieveEntityResponse">
  <Property Name="EntityMetadata" Type="mscrm.ComplexEntityMetadata" />
</ComplexType>
<Function Name="RetrieveEntity">
  <Parameter Name="EntityFilters" Type="Edm.Int32" />
  <Parameter Name="LogicalName" Type="Edm.String" />
  <Parameter Name="MetadataId" Type="Edm.Guid" />
  <Parameter Name="RetrieveAsIfPublished" Type="Edm.Boolean" />
  <ReturnType Type="mscrm.RetrieveEntityResponse" Nullable="false" />
</Function>`,
  );
  metadataFunction(
    'RetrieveAllEntities',
    (p) => ({
      EntityMetadata: metadata
        .entities()
        .map((e) => metadata.retrieveEntityResponse(e.LogicalName, p.EntityFilters ?? null).EntityMetadata),
      Timestamp: metadata.versionStamp(),
    }),
    `<ComplexType Name="RetrieveAllEntitiesResponse"><Property Name="EntityMetadata" Type="Collection(mscrm.ComplexEntityMetadata)" /><Property Name="Timestamp" Type="Edm.String" /></ComplexType>
<Function Name="RetrieveAllEntities"><Parameter Name="EntityFilters" Type="Edm.Int32" /><Parameter Name="RetrieveAsIfPublished" Type="Edm.Boolean" /><ReturnType Type="mscrm.RetrieveAllEntitiesResponse" Nullable="false" /></Function>`,
  );
  metadataFunction(
    'RetrieveAttribute',
    (p) => metadata.retrieveAttributeResponse(p.EntityLogicalName ?? null, p.LogicalName ?? p.MetadataId ?? null),
    `<ComplexType Name="RetrieveAttributeResponse">
  <Property Name="AttributeMetadata" Type="mscrm.ComplexAttributeMetadata" />
</ComplexType>
<Function Name="RetrieveAttribute">
  <Parameter Name="EntityLogicalName" Type="Edm.String" />
  <Parameter Name="LogicalName" Type="Edm.String" />
  <Parameter Name="MetadataId" Type="Edm.Guid" />
  <ReturnType Type="mscrm.RetrieveAttributeResponse" Nullable="false" />
</Function>`,
  );
  const installed = [];
  let closed;
  const close = () =>
    (closed ??= (async () => {
      const results = await Promise.allSettled(
        installed.map((extension) => Promise.resolve().then(() => extension.close?.(api))),
      );
      try {
        await recordHandlers.close?.();
      } finally {
        changes.close();
        if (ownsScheduler) releaseOrganizationScheduler(scheduler);
      }
      const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Organization extension cleanup failed.');
    })());
  try {
    api.diagnostic.hold();
    for (const extension of extensions) {
      if (typeof extension?.install !== 'function')
        throw new Error('A Dataverse API extension needs an install(api) function.');
      // An installer may allocate resources before it fails. Give it the same
      // cleanup opportunity as successfully installed extensions.
      installed.push(extension);
      // The runtime's diagnostic sink; pack overrides and providers come from api.packExport / api.providers.
      await extension.install(api, { diagnostic: api.diagnostic });
    }
    api.diagnostic.flush();
    if (extensions.length) await change(seedSecurity);
  } catch (error) {
    await close().catch((cleanup) => log('organization-cleanup', cleanup));
    throw error;
  }
  // The organization the seeded organization row carries (settings.organizationId is null at runtime).
  const organizationRow = store
    .tableRows('organization')
    .find((row) => String(row.organizationid).toLowerCase() === organizationId);
  api.settings = { ...settings, organizationId: organizationRow?.organizationid ?? organizationId };
  // Query hierarchy operators resolve through the hierarchy module when it is installed: Dataverse callers through their
  // principal context (dataverse-principal-context.mjs), every other caller through the host query scope
  // (dataverse-conditions.mjs runWithQueryResolvers); the module then reports its query operators at behaviour.
  if (api.hierarchy?.resolve) {
    store.hierarchyResolver = (table, id, mode) => api.hierarchy.resolve(table, id, mode);
    api.hierarchyQueryWired = true;
  }
  // The organization's row-version counter starts above every stored row version, so the first write through the pipeline
  // (nextRowVersion) never stamps a row with a version at or below the one it carries (a seeded or restored state).
  store.state.rowVersion = Math.max(Number(store.state.rowVersion ?? 0), maxRowVersion(store.state));
  // Ready committed-event jobs saved before a restart run once the organization (and its registrations) exists.
  store.committedJobs?.resume();
  pendingSchedulers.delete(store);

  return {
    api,
    providers: api.providers,
    packs,
    packExport: api.packExport,
    store,
    settings,
    change,
    principals,
    metadata,
    records: recordHandlers,
    registry: operations,
    changes,
    routes,
    limits,
    clock,
    ids,
    scheduler,
    tenantId,
    organizationId,
    environmentId,
    requests: () => [],
    runOwned,
    runAtomic: (fn) => runAtomic(api, fn),
    read: (fn) =>
      store.transact(fn, { nested: true, skipSaveIfUnchanged: true, cloneResult: false, lazyReadSnapshot: true }),
    reseed: async () => {
      await registerApplications();
      await store.transact(() => composeInternalTables(store));
      api.diagnostic.hold();
      try {
        for (const extension of extensions) await extension.reset?.(api);
      } finally {
        api.diagnostic.flush();
      }
      await seedSecurity();
      await store.transact(() => {
        store.state.rowVersion = maxRowVersion(store.state);
      });
      await store.flushCommittedEvents?.();
      changes.reset();
    },
    close,
  };
}
