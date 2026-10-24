// /_sim/api/environment administration shared by both hosts: environment variable definitions with their local values
// and secret reference status, local overrides (PUT/DELETE /environment/variables/<schemaName>) and the deployment profile
// selection (PUT /environment/profiles). A host passes `environment`; a piece it cannot serve answers { supported: false, reason }.
import { parseSecretReference } from './secret-resolver.mjs';
import { sourceRecordId } from './source-record-id.mjs';

const TABLES = { definition: 'environmentvariabledefinition', value: 'environmentvariablevalue' };
const ROUTE = /^\/(?:_sim|__sim)\/api(\/environment(?:\/.*)?)$/;
/** The /_sim/api prefixes this router answers (status `routes`). */
export const routes = Object.freeze(['/environment']);
const key = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const lookupId = (value) => key(value && typeof value === 'object' ? (value.id ?? value.value) : value);
const fail = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const mappingOf = (store, entity) => {
  try {
    return store.resolveMapping(entity);
  } catch {
    return null;
  }
};

/**
 * Environment variable definitions joined with their current local values. Secret rows never carry a value: a Key Vault
 * Secret shows its reference and the resolver's describe() status; a value kept in a secret store (secretstore 1) shows nothing.
 * secrets: the organization's secret resolver (api.secrets) or null.
 */
export function environmentVariableTable(store, { secrets = null } = {}) {
  const definitionMapping = mappingOf(store, TABLES.definition),
    valueMapping = mappingOf(store, TABLES.value);
  if (!definitionMapping) return { available: false, valuesMapped: Boolean(valueMapping), definitions: [] };
  const tables =
    store.snapshot({ tables: [definitionMapping.logicalName, ...(valueMapping ? [valueMapping.logicalName] : [])] })
      .tables ?? {};
  const values = valueMapping ? (tables[valueMapping.logicalName] ?? []) : [];
  const overrides = store.state.simulator?.environmentVariables ?? {};
  const valueFor = (definitionId) =>
    values.find((row) =>
      [row.environmentvariabledefinitionid, row._environmentvariabledefinitionid_value].some(
        (candidate) => lookupId(candidate) === definitionId,
      ),
    );
  return {
    available: true,
    valuesMapped: Boolean(valueMapping),
    definitions: (tables[definitionMapping.logicalName] ?? []).map((row) => {
      const definitionId = key(row[definitionMapping.idColumn]);
      const current = valueFor(definitionId);
      const secret = Number(row.secretstore ?? 0) === 1 || Number(row.type) === 100000005;
      const reference =
        secret && Number(row.secretstore ?? 0) !== 1 ? (current?.value ?? row.defaultvalue ?? null) : null;
      return {
        id: definitionId,
        schemaName: row.schemaname ?? row.schemaName ?? null,
        displayName: row.displayname ?? row.displayName ?? row.schemaname ?? null,
        type: row.type ?? null,
        defaultValue: secret ? null : (row.defaultvalue ?? null),
        description: row.description ?? null,
        secret,
        valueId: current ? key(current[valueMapping.idColumn]) : null,
        ...(secret
          ? {
              reference,
              secretStatus: secrets
                ? secrets.describe(reference)
                : { bound: false, status: 'not-configured', version: null, expiresOn: null },
            }
          : { value: current?.value ?? null, effectiveValue: current?.value ?? row.defaultvalue ?? null }),
        overridden: Object.hasOwn(overrides, row.schemaname ?? row.schemaName ?? ''),
      };
    }),
  };
}

/**
 * Writes or removes (value null) the local value of one definition into `state` (a snapshot or the live state inside a
 * transaction). The value is kept as an override in state.simulator.environmentVariables, so Solution re-seeding keeps it.
 */
export function applyEnvironmentOverride(store, state, schemaName, value, { secrets = null } = {}) {
  if (value !== null && typeof value !== 'string')
    throw fail('Environment variable values are text, or null to remove the local value.');
  const definitionMapping = mappingOf(store, TABLES.definition),
    valueMapping = mappingOf(store, TABLES.value);
  if (!definitionMapping || !valueMapping)
    throw fail(
      'Environment variable tables are not available in this runtime state.',
      409,
      'ENVIRONMENT_VARIABLES_UNAVAILABLE',
    );
  const definition = environmentVariableTable(store, { secrets }).definitions.find(
    (item) => item.schemaName === schemaName,
  );
  if (!definition) throw fail('Environment variable definition not found.', 404);
  // A Secret definition holds a Key Vault reference, never the secret itself (the resolver reads the value at use).
  if (definition.secret && value !== null && !parseSecretReference(value))
    throw fail(
      'A Secret environment variable takes a Key Vault secret reference, not a plain value.',
      400,
      'SecretValueNotAccepted',
    );
  const overrides = { ...(state.simulator.environmentVariables ?? {}) };
  if (value === null) delete overrides[schemaName];
  else overrides[schemaName] = value;
  state.simulator.environmentVariables = overrides;
  const rows = (state.tables[valueMapping.logicalName] ??= []);
  const index = definition.valueId
    ? rows.findIndex((row) => key(row[valueMapping.idColumn]) === definition.valueId)
    : -1;
  if (value === null) {
    if (index >= 0) rows.splice(index, 1);
  } else if (index >= 0) rows[index] = { ...rows[index], value };
  // The id Solution seeding gives this definition's value, so re-seeding merges into this row instead of adding a second.
  else
    rows.push({
      [valueMapping.idColumn]: sourceRecordId(TABLES.value, definition.schemaName),
      schemaname: schemaName,
      value,
      environmentvariabledefinitionid: definition.id,
    });
}

/**
 * environment: { definitions(), profiles(), setOverride(schemaName, value|null) → definition, selectProfile?(body) → summary,
 * extra?() → host fields of GET /environment }. profiles() and a missing selectProfile answer { supported: false, reason }.
 * Errors are thrown with { status, code } for the host's error handler. Resolves true when it answered.
 */
export function createEnvironmentRoutes({
  csrf,
  change,
  json,
  jsonObjectBody,
  jsonBody = jsonObjectBody,
  environment,
}) {
  return async (req, res, url) => {
    const match = ROUTE.exec(url.pathname);
    if (!match) return false;
    const relative = match[1],
      method = req.method;
    if (!['GET', 'HEAD'].includes(method)) {
      const token = csrf();
      if (!token || req.headers['x-sim-csrf'] !== token) throw fail('Missing simulator CSRF token.', 403);
    }
    if (relative === '/environment' && method === 'GET') {
      json(res, 200, {
        ...(await environment.extra?.()),
        profileSelection: environment.profiles(),
        environmentVariables: environment.definitions(),
      });
      return true;
    }
    if (relative === '/environment/profiles' && method === 'PUT') {
      if (!environment.selectProfile) {
        json(res, 501, environment.profiles());
        return true;
      }
      await change(async () => json(res, 200, await environment.selectProfile(await jsonBody(req))));
      return true;
    }
    const variable = /^\/environment\/variables\/([^/]+)$/.exec(relative);
    if (variable && (method === 'PUT' || method === 'DELETE')) {
      let schemaName;
      try {
        schemaName = decodeURIComponent(variable[1]);
      } catch {
        throw fail('Administration identifier has invalid URL encoding.');
      }
      await change(async () => {
        const value = method === 'DELETE' ? null : (await jsonObjectBody(req)).value;
        if (value !== null && typeof value !== 'string')
          throw fail('Environment variable values are text, or null to remove the local value.');
        json(res, 200, await environment.setOverride(schemaName, value));
      });
      return true;
    }
    return false;
  };
}
