// Key Vault reference semantics for Secret environment variables (type 100000005), resolved locally.
// A Secret environment variable value is a reference, never the secret:
//   /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.KeyVault/vaults/{vault}/secrets/{name}[/{version}]
//   https://{vault}.vault.azure.net/secrets/{name}[/{version}]
// The project `secrets` config binds a normalised `${vault}/${name}` key to where the value lives at resolve time
// (an operating-system environment variable, or a DPAPI-protected blob). Values never live in config, state,
// diagnostics, errors or /_sim payloads; describe() reports status only. No Key Vault is contacted.
import { registerSettingParser } from './config-keys.mjs';
import { systemClock } from './runtime-clock.mjs';

const SECRET_TYPE = 100000005;
const KEY_VAULT_STORE = 0;
const ARM =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.KeyVault\/vaults\/([^/]+)\/secrets\/([^/]+)(?:\/([^/]+))?\/?$/i;
const VAULT_URI = /^https:\/\/([^./]+)\.vault\.azure\.net(?::443)?\/secrets\/([^/?#]+)(?:\/([^/?#]+))?\/?$/i;
const KEY = /^[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_KEYS = new Set([
  'source',
  'variable',
  'protectedValue',
  'versions',
  'expiresOn',
  'allow',
  'disabled',
  'description',
]);
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const lower = (value) => String(value ?? '').toLowerCase();

/** The vault, secret name and optional version of a Key Vault reference, or null when it is not one. */
export function parseSecretReference(reference) {
  const text = typeof reference === 'string' ? reference.trim() : '';
  const match = ARM.exec(text) ?? VAULT_URI.exec(text);
  if (!match) return null;
  const [, vault, name, version = null] = match;
  return { vault: lower(vault), name: lower(name), version, key: `${lower(vault)}/${lower(name)}` };
}

/** Validates and normalises the project `secrets` config. Throws on a literal value: values never live in config. */
export function secretSettings(value, label = 'secrets') {
  if (value === undefined || value === null) return {};
  if (!plainObject(value)) throw new Error(`${label} must be an object keyed by <vault>/<secret>`);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const at = `${label}.${key}`;
    if (!KEY.test(key)) throw new Error(`${at}: keys are <vault>/<secret> (letters, digits and hyphens)`);
    if (!plainObject(entry)) throw new Error(`${at} must be an object`);
    if (Object.hasOwn(entry, 'value') || Object.hasOwn(entry, 'secret'))
      throw new Error(
        `${at}: secret values never live in config; name an environment variable (source: environment) or a protected value`,
      );
    for (const name of Object.keys(entry)) if (!ENTRY_KEYS.has(name)) throw new Error(`Unknown ${at} key '${name}'`);
    const source = entry.source ?? 'environment';
    const normal = { source, allow: [], disabled: false };
    if (source === 'environment') {
      if (typeof entry.variable !== 'string' || !VARIABLE.test(entry.variable))
        throw new Error(`${at}.variable must name an environment variable`);
      normal.variable = entry.variable;
    } else if (source === 'protected') {
      if (typeof entry.protectedValue !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.protectedValue))
        throw new Error(`${at}.protectedValue must be the base64 DPAPI blob`);
      normal.protectedValue = entry.protectedValue;
    } else throw new Error(`${at}.source must be 'environment' or 'protected'`);
    if (entry.versions !== undefined) {
      if (
        !plainObject(entry.versions) ||
        typeof entry.versions.current !== 'string' ||
        !entry.versions.current ||
        Object.keys(entry.versions).some((k) => k !== 'current')
      )
        throw new Error(`${at}.versions must be { current: <version> }`);
      normal.versions = { current: entry.versions.current };
    }
    if (entry.expiresOn !== undefined) {
      const time = Date.parse(
        entry.expiresOn instanceof Date ? entry.expiresOn.toISOString() : String(entry.expiresOn),
      );
      if (!Number.isFinite(time)) throw new Error(`${at}.expiresOn must be an ISO date`);
      normal.expiresOn = new Date(time).toISOString();
    }
    if (entry.allow !== undefined) {
      if (!Array.isArray(entry.allow) || entry.allow.some((id) => typeof id !== 'string' || !GUID.test(id)))
        throw new Error(`${at}.allow must be a list of principal ids (GUIDs)`);
      normal.allow = entry.allow.map(lower);
    }
    if (entry.disabled !== undefined) {
      if (typeof entry.disabled !== 'boolean') throw new Error(`${at}.disabled must be a boolean`);
      normal.disabled = entry.disabled;
    }
    if (entry.description !== undefined) normal.description = String(entry.description);
    result[lower(key)] = normal;
  }
  return result;
}

// Windows DPAPI, loaded only when a protected secret is read (lense/dataverse/connection.mjs refuses other hosts).
const dpapi = {
  unprotect: async (blob) => (await import('../../lense/dataverse/connection.mjs')).protectSecret(blob, true),
};

/** Resolves Key Vault references from the `secrets` config. resolve() is the only place a value is read. */
export function createSecretResolver({
  secrets = {},
  env = process.env,
  protect = dpapi,
  clock = systemClock.now,
  diagnostic = () => {},
} = {}) {
  const settings = secretSettings(secrets);
  const now = () => {
    const value = clock();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  // The status every caller shares; principal and value checks belong to resolve().
  const inspect = (reference) => {
    const parsed = parseSecretReference(reference);
    if (!parsed) return { parsed, status: 'unbound', reason: 'The value is not a Key Vault secret reference.' };
    const entry = settings[parsed.key];
    if (!entry) return { parsed, status: 'unbound', reason: `No secrets entry binds ${parsed.key}.` };
    const version = parsed.version ?? entry.versions?.current ?? null;
    const base = { parsed, entry, version, expiresOn: entry.expiresOn ?? null };
    if (entry.disabled) return { ...base, status: 'disabled', reason: `Secret ${parsed.key} is disabled.` };
    if (entry.expiresOn && Date.parse(entry.expiresOn) <= now())
      return { ...base, status: 'expired', reason: `Secret ${parsed.key} expired on ${entry.expiresOn}.` };
    if (parsed.version && parsed.version !== entry.versions?.current)
      return { ...base, status: 'missing', reason: `Secret ${parsed.key} has no version ${parsed.version}.` };
    if (entry.source === 'environment' && !env[entry.variable])
      return { ...base, status: 'missing', reason: `Environment variable ${entry.variable} is not set.` };
    return { ...base, status: 'available' };
  };
  const refuse = (state, purpose) => {
    diagnostic({
      code: `SECRET_${state.status.toUpperCase()}`,
      severity: 'warning',
      key: state.parsed?.key ?? null,
      purpose: purpose ?? null,
      message: state.reason,
    });
    return { status: state.status, reason: state.reason };
  };
  return {
    async resolve(reference, { principalId, purpose } = {}) {
      const state = inspect(reference);
      if (state.status !== 'available') return refuse(state, purpose);
      // Fail closed: an entry without an allow list is denied to everyone.
      if (!principalId || !state.entry.allow.includes(lower(principalId)))
        return refuse(
          { ...state, status: 'denied', reason: `The principal is not allowed to read ${state.parsed.key}.` },
          purpose,
        );
      let value;
      if (state.entry.source === 'environment') value = env[state.entry.variable];
      else {
        try {
          value = await protect.unprotect(state.entry.protectedValue);
        } catch {
          value = undefined;
        }
        if (!value)
          return refuse(
            {
              ...state,
              status: 'missing',
              reason: `The protected value of ${state.parsed.key} could not be read (Windows DPAPI, same user).`,
            },
            purpose,
          );
      }
      return {
        status: 'resolved',
        value,
        version: state.version,
        ...(state.expiresOn ? { expiresOn: state.expiresOn } : {}),
      };
    },
    /** Status only, never the value. */
    describe(reference) {
      const state = inspect(reference);
      return {
        bound: Boolean(state.entry),
        status: state.status,
        version: state.version ?? null,
        expiresOn: state.expiresOn ?? null,
      };
    },
    keys: () => Object.keys(settings),
  };
}

const rowsOf = (state, logical) => state?.tables?.[logical] ?? [];
const idOf = (value) => lower(value !== null && typeof value === 'object' ? (value.id ?? value.value) : value);

/** True when a definition holds secret material: the Secret type, or a value kept in a non-Key Vault secret store. */
const isSecretDefinition = (row) =>
  Number(row?.type) === SECRET_TYPE || Number(row?.secretstore ?? KEY_VAULT_STORE) === 1;

/**
 * The effective environment variables, keyed by lower-case schema name. Layers, lowest first: the definition default,
 * the value row (Solution value, already merged with profile, project and _sim/persona overrides by Solution seeding and
 * the _sim PUT), then `overrides` (one map, or a list of maps applied in order) for callers that hold unseeded layers.
 * Non-secret entries: { schemaName, id, type, value }. Secret entries: { schemaName, id, type, secret: true, reference }, where
 * reference is the Key Vault reference (null when the store holds the secret itself); resolve it with the resolver.
 */
export function effectiveEnvironmentVariables(state, { overrides = [] } = {}) {
  const layers = (Array.isArray(overrides) ? overrides : [overrides]).map(
    (layer) => new Map(Object.entries(layer ?? {}).map(([name, value]) => [lower(name), value])),
  );
  const values = rowsOf(state, 'environmentvariablevalue');
  const result = {};
  for (const definition of rowsOf(state, 'environmentvariabledefinition')) {
    const schemaName = definition.schemaname ?? definition.schemaName;
    if (!schemaName) continue;
    const id = idOf(definition.environmentvariabledefinitionid);
    const row = values.find(
      (v) => idOf(v.environmentvariabledefinitionid ?? v._environmentvariabledefinitionid_value) === id,
    );
    let value = row ? (row.value ?? null) : (definition.defaultvalue ?? null);
    for (const layer of layers) if (layer.has(lower(schemaName))) value = layer.get(lower(schemaName));
    const type = definition.type == null ? null : Number(definition.type);
    result[lower(schemaName)] = isSecretDefinition(definition)
      ? {
          schemaName,
          id,
          type,
          secret: true,
          reference:
            Number(definition.secretstore ?? KEY_VAULT_STORE) === 1 ? null : value == null ? null : String(value),
        }
      : { schemaName, id, type, value: value == null ? null : String(value) };
  }
  return result;
}

/** The workerData.environmentVariables map for server logic: lower-case schema name → text, or { secret: true }. */
export function environmentVariablePayload(state, options) {
  return Object.fromEntries(
    Object.entries(effectiveEnvironmentVariables(state, options)).map(([name, entry]) => [
      name,
      entry.secret ? { secret: true } : entry.value,
    ]),
  );
}

/**
 * Site settings bound to environment variables (importer `settingEnvironmentVariables`: setting name → schema name or
 * definition id). Non-secret bindings take the effective value; Secret bindings resolve through the resolver as
 * `principalId` (the portal service principal) and stay unset when no resolver exists. `secretNames` lists the
 * settings that carry resolved secrets: callers must keep them out of /_sim payloads.
 */
export async function bindSiteSettings(
  settings,
  bindings,
  effective,
  { resolver = null, principalId = null, diagnostic = () => {} } = {},
) {
  const next = { ...settings },
    secretNames = [];
  for (const [setting, target] of Object.entries(bindings ?? {})) {
    const entry = Object.values(effective).find((e) => lower(e.schemaName) === idOf(target) || e.id === idOf(target));
    if (!entry) {
      diagnostic({
        code: 'SITE_SETTING_ENVIRONMENT_VARIABLE_UNMATCHED',
        severity: 'warning',
        setting,
        message: `Site setting ${setting} names an environment variable that is not imported.`,
      });
      continue;
    }
    if (!entry.secret) {
      if (entry.value !== null) next[setting] = entry.value;
      continue;
    }
    secretNames.push(setting);
    const answer = resolver
      ? await resolver.resolve(entry.reference, { principalId, purpose: `site-setting:${setting}` })
      : { status: 'unbound' };
    if (answer.status === 'resolved') next[setting] = answer.value;
    else {
      delete next[setting];
      diagnostic({
        code: 'SITE_SETTING_SECRET_UNRESOLVED',
        severity: 'warning',
        setting,
        message: `Site setting ${setting} is bound to a Secret environment variable that is ${answer.status}.`,
      });
    }
  }
  return { settings: next, secretNames };
}

// The config-key registry validates `secrets` through this module once it is loaded; an absent key stays absent.
registerSettingParser('secrets', (value, label) => (value == null ? value : secretSettings(value, label)));
