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
import { organizationContext, runOwned, runAtomic } from './dataverse-transaction-context.mjs';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
export const DATAVERSE_NAMESPACE = uuidV5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'paqvilo-dataverse');
export const dataverseOrganizationId = settings => (settings.organizationId ?? uuidV5(DATAVERSE_NAMESPACE, `${settings.uniqueName}:organization`)).toLowerCase();
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
    geo: "NA",
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
      entry = { appId: app.appId, displayName: app.displayName, createdOn: new Date(clock()).toISOString(), secrets: [], certificates: [], ...registration };
      dv.applications.push(entry);
    } else Object.assign(entry, registration);
    entry.secrets ??= [];
    const secret = app.secretEnvironmentVariable ? process.env[app.secretEnvironmentVariable] : undefined;
    if (secret && !entry.secrets.some((item) => verifySecret(secret, item))) {
      entry.secrets.push({ id: randomUUID(), ...hashSecret(secret), hint: secret.slice(0, 3), expiresOn: null });
    }
  }
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
    return await options.store.transact(async () => organization = await composeOrganizationRuntime(options),
      { isolated: true, cloneResult: false, skipSaveIfUnchanged: true });
  } catch (error) {
    await organization?.close().catch(() => {});
    throw error;
  }
}

async function composeOrganizationRuntime({ store, settings, change = fn => fn(), schema = () => null, metadataFields = () => undefined, clock = () => Date.now(), records = null, log = () => {}, extensions = EXTENSIONS }) {
  // Standard table columns under the Solution's own fields (plan 3.2); the records and TDS layers both read this.
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
      ...(settings.managedIdentities ?? []).map((identity) => ({ appId: identity.clientId, displayName: identity.displayName, roles: identity.roles ?? [] })),
    ],
    // Settings rows use domainname/fullname; the security model reads upn/displayName.
    users: (settings.users ?? []).map((user) => ({ objectId: user.objectId, upn: user.domainname, displayName: user.fullname, roles: user.roles })),
  };
  const registerApplications = () => store.transact(() => {
    seedRegistrations(store, settings, { tenantId, organizationId, environmentId }, clock);
    seedManagedIdentityRows(store, { tenantId, identities: settings.managedIdentities ?? [] });
  });
  const seedSecurity = () => ensureSecurityModel(store, securitySettings, { schema });
  await change(registerApplications);
  await change(seedSecurity);
  // Record writes from inside a $batch skip `change` (see inBatch); other record writes use the caller's change.
  const recordChange = (fn) => (organizationContext.getStore() ? fn() : change(fn));

  const principals = createPrincipals(store, { organizationId, tenantId, objectTypeCode: typeCodeOf, schema });
  // Extension operations (dataverse-operations.mjs) answer before the built-in functions and actions.
  const operations = createOperationRegistry();
  const metadata = createMetadataService({
    organizationId,
    lcid: settings.localeId,
    schema,
    mappings: () => store.state.mappings,
    virtualTables: () => store.virtualTables?.() ?? {},
    globalOptionSets: () => ({ ...standardGlobalOptionSets(), ...(store.state.dataverse?.globalOptionSets ?? {}) }),
    changeLog: () => store.state.dataverse?.metadataLog ?? [],
    extraCsdl: () => operations.csdlFragments(),
  });
  // One change log per API: the record handlers read it, a rolled-back changeset rewinds it and a reset expires its tokens.
  const changes = createChangeLog(store, { clock });
  const { createRecordHandlers, createRecordHooks } = await import("./dataverse-records.mjs");
  const recordHooks = createRecordHooks();
  // fieldSecurity is read per request: the fls extension sets api.fieldSecurity when it installs, after the handlers exist.
  const recordHandlers =
    records ??
    createRecordHandlers({
      store, change: recordChange, principals, metadata, metadataFields, objectTypeCode: typeCodeOf, clock, changes, hooks: recordHooks,
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
    records: recordHandlers,
    recordHooks,
    settings,
    schema,
    changes,
    clock,
    limits,
    tdsPort: null,
    log,
    addRoute: (match, handler, { anonymous = false } = {}) => {
      routes.push({ match, handler, anonymous });
    },
    // A changeset or a SOAP transaction runs fn as one unit against this api's store and change log (see runAtomic).
    runAtomic: (fn) => runAtomic(api, fn),
    dataRevision: () => store.dataRevision?.(),
  };
  // Metadata functions over the metadata service's response builders.
  const metadataFunction = (name, respond, csdl) =>
    operations.register({
      name, kind: "function", binding: "unbound", csdl,
      handle: (c) => {
        const response = respond(c.params);
        if (!response) throw new DataError(`${name} does not find the requested metadata.`, 404, "NotFound");
        return { status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), ...response } };
      },
    });
  // unverified: the response property types (the metadata CSDL's ComplexEntityMetadata and ComplexAttributeMetadata); the
  // EntityFilters flags are Edm.Int32 here, not the mscrm enum.
  metadataFunction("RetrieveEntity", (p) => metadata.retrieveEntityResponse(p.LogicalName ?? p.MetadataId ?? null, p.EntityFilters ?? null), `<ComplexType Name="RetrieveEntityResponse">
  <Property Name="EntityMetadata" Type="mscrm.ComplexEntityMetadata" />
</ComplexType>
<Function Name="RetrieveEntity">
  <Parameter Name="EntityFilters" Type="Edm.Int32" />
  <Parameter Name="LogicalName" Type="Edm.String" />
  <Parameter Name="MetadataId" Type="Edm.Guid" />
  <Parameter Name="RetrieveAsIfPublished" Type="Edm.Boolean" />
  <ReturnType Type="mscrm.RetrieveEntityResponse" Nullable="false" />
</Function>`);
  metadataFunction("RetrieveAllEntities", (p) => ({
    EntityMetadata: metadata.entities().map((e) => metadata.retrieveEntityResponse(e.LogicalName, p.EntityFilters ?? null).EntityMetadata),
    Timestamp: metadata.versionStamp(),
  }), `<ComplexType Name="RetrieveAllEntitiesResponse"><Property Name="EntityMetadata" Type="Collection(mscrm.ComplexEntityMetadata)" /><Property Name="Timestamp" Type="Edm.String" /></ComplexType>
<Function Name="RetrieveAllEntities"><Parameter Name="EntityFilters" Type="Edm.Int32" /><Parameter Name="RetrieveAsIfPublished" Type="Edm.Boolean" /><ReturnType Type="mscrm.RetrieveAllEntitiesResponse" Nullable="false" /></Function>`);
  metadataFunction("RetrieveAttribute", (p) => metadata.retrieveAttributeResponse(p.EntityLogicalName ?? null, p.LogicalName ?? p.MetadataId ?? null), `<ComplexType Name="RetrieveAttributeResponse">
  <Property Name="AttributeMetadata" Type="mscrm.ComplexAttributeMetadata" />
</ComplexType>
<Function Name="RetrieveAttribute">
  <Parameter Name="EntityLogicalName" Type="Edm.String" />
  <Parameter Name="LogicalName" Type="Edm.String" />
  <Parameter Name="MetadataId" Type="Edm.Guid" />
  <ReturnType Type="mscrm.RetrieveAttributeResponse" Nullable="false" />
</Function>`);
  const installed = [];
  let closed;
  const close = () => closed ??= (async () => {
    const results = await Promise.allSettled(installed.map(extension => Promise.resolve().then(() => extension.close?.(api))));
    try { await recordHandlers.close?.(); } finally { changes.close(); }
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Organization extension cleanup failed.');
  })();
  try {
    for (const extension of extensions) {
      if (typeof extension?.install !== "function") throw new Error("A Dataverse API extension needs an install(api) function.");
      // An installer may allocate resources before it fails. Give it the same
      // cleanup opportunity as successfully installed extensions.
      installed.push(extension);
      await extension.install(api);
    }
    if (extensions.length) await change(seedSecurity);
  } catch (error) {
    await close().catch(cleanup => log('organization-cleanup', cleanup));
    throw error;
  }
  // H6: the organization the seeded organization row carries (settings.organizationId is null at runtime).
  const organizationRow = store.tableRows("organization").find((row) => String(row.organizationid).toLowerCase() === organizationId);
  api.settings = { ...settings, organizationId: organizationRow?.organizationid ?? organizationId };

  return { api, store, settings, change, principals, metadata, records: recordHandlers, registry: operations, changes, routes, limits, clock, tenantId, organizationId, environmentId,
    requests: () => [],
    runOwned, runAtomic: fn => runAtomic(api, fn),
    read: fn => store.transact(fn, { nested: true, skipSaveIfUnchanged: true, cloneResult: false, lazyReadSnapshot: true }),
    reseed: async () => {
      await registerApplications();
      for (const extension of extensions) await extension.reset?.(api);
      await seedSecurity();
      await store.transact(() => { store.state.rowVersion = maxRowVersion(store.state); });
      await store.flushCommittedEvents?.(); changes.reset();
    },
    close,
  };
}
