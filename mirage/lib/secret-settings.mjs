// The `secrets` settings contract: validation only, no resolver. secret-resolver.mjs re-exports secretSettings;
// settings-contracts.mjs registers the parser on the config-load path. Values never live in config.

const KEY = /^[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/;
const VARIABLE = /^[A-Za-z_]\w{0,127}$/;
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

function secretSource(entry, at, normal, source) {
  if (source === 'environment') {
    if (typeof entry.variable !== 'string' || !VARIABLE.test(entry.variable))
      throw new Error(`${at}.variable must name an environment variable`);
    normal.variable = entry.variable;
  } else if (source === 'protected') {
    if (typeof entry.protectedValue !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.protectedValue))
      throw new Error(`${at}.protectedValue must be the base64 DPAPI blob`);
    normal.protectedValue = entry.protectedValue;
  } else throw new Error(`${at}.source must be 'environment' or 'protected'`);
}

function secretMetadata(entry, at, normal) {
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
    const time = Date.parse(entry.expiresOn instanceof Date ? entry.expiresOn.toISOString() : String(entry.expiresOn));
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
}

function secretSettingEntry(key, entry, label) {
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
  secretSource(entry, at, normal, source);
  secretMetadata(entry, at, normal);
  return normal;
}

/** Validates and normalises the project `secrets` config. Throws on a literal value: values never live in config. */
export function secretSettings(value, label = 'secrets') {
  if (value === undefined || value === null) return {};
  if (!plainObject(value)) throw new Error(`${label} must be an object keyed by <vault>/<secret>`);
  const result = {};
  for (const [key, entry] of Object.entries(value)) result[lower(key)] = secretSettingEntry(key, entry, label);
  return result;
}

/** The parser the config-key registry holds for `secrets`: an absent key stays absent. */
export const secretsSettingParser = (value, label) => (value == null ? value : secretSettings(value, label));
