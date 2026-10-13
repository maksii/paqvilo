import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

export const PROFILE_SECTIONS = Object.freeze(['pages', 'environmentVariables', 'connectionReferences']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safe = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !['constructor', 'prototype', '__proto__'].includes(value.toLowerCase());
const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'InvalidDeploymentProfile' }); };
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} must be an object containing only ${allowed.join(', ')}.`);
}
function flags(value = {}, label = 'deploymentProfiles.enabled') {
  keys(value, PROFILE_SECTIONS, label);
  for (const entry of Object.values(value)) if (typeof entry !== 'boolean') fail(`${label} values must be boolean.`);
  return { ...value };
}

/** Explicit file mappings; relative paths belong to the config, never the portal checkout. */
export function resolveDeploymentProfiles(value = {}, base = process.cwd()) {
  keys(value, ['default', 'required', 'enabled', 'profiles'], 'deploymentProfiles');
  const required = value.required ?? [];
  if (!Array.isArray(required) || required.some(section => !PROFILE_SECTIONS.includes(section)) || new Set(required).size !== required.length) fail('deploymentProfiles.required must list distinct profile sections.');
  const enabled = flags(value.enabled);
  const profiles = value.profiles ?? {};
  if (!object(profiles)) fail('deploymentProfiles.profiles must map IDs to file mappings.');
  const resolved = Object.fromEntries(Object.entries(profiles).map(([id, sources]) => {
    if (!safe(id)) fail('Deployment profile IDs must be safe names.');
    keys(sources, PROFILE_SECTIONS, `deploymentProfiles.profiles.${id}`);
    if (!Object.keys(sources).length) fail(`Deployment profile '${id}' requires at least one file mapping.`);
    return [id, Object.fromEntries(Object.entries(sources).map(([section, file]) => {
      if (typeof file !== 'string' || !file.trim() || /[\x00-\x1f]/.test(file) || !/\.(?:json|ya?ml)$/i.test(file)) fail(`Profile '${id}' ${section} requires a JSON or YAML file path.`);
      return [section, path.resolve(base, file)];
    }))];
  }));
  const defaultProfile = value.default ?? null;
  if (defaultProfile !== null && !Object.hasOwn(resolved, defaultProfile)) fail('deploymentProfiles.default must name a configured profile.');
  const result = { default: defaultProfile, required: [...required], enabled, profiles: resolved };
  profileSelection(result);
  return result;
}

/** A null pin follows config defaults; {profile:null} explicitly selects no profile. */
export function profileSelection(config, pin = null) {
  if (pin !== null) {
    keys(pin, ['profile', 'enabled'], 'Deployment profile pin');
    if (!Object.hasOwn(pin, 'profile')) fail('Deployment profile pin requires profile (an ID or null).');
    flags(pin.enabled, 'Deployment profile pin.enabled');
  }
  const profile = pin === null ? config.default : pin.profile;
  if (profile !== null && (typeof profile !== 'string' || !Object.hasOwn(config.profiles, profile))) fail('Select a configured deployment profile.');
  const sources = profile === null ? {} : config.profiles[profile];
  const enabled = Object.fromEntries(PROFILE_SECTIONS.map(section => [section, (pin?.enabled?.[section] ?? config.enabled[section] ?? true) && Boolean(sources[section])]));
  for (const section of config.required) if (!enabled[section]) fail(`Deployment profile section '${section}' is required and must have an enabled file mapping.`);
  for (const section of PROFILE_SECTIONS) if (pin?.enabled?.[section] === true && !sources[section]) fail(`Selected profile has no '${section}' file mapping.`);
  return { profile, enabled, sources, pinned: pin !== null };
}

export async function loadDeploymentProfiles(config, pin = null) {
  const selection = profileSelection(config, pin);
  const loaded = new Map(), environmentVariables = {}, connectionReferences = [];
  const contents = {};
  for (const section of PROFILE_SECTIONS) {
    if (!selection.enabled[section]) continue;
    const file = selection.sources[section];
    if (!loaded.has(file)) {
      let source;
      try { source = await fs.readFile(file, 'utf8'); }
      catch { fail(`Cannot read deployment profile '${selection.profile}' ${section} file.`); }
      let parsed;
      try { parsed = /\.json$/i.test(file) ? JSON.parse(source) : YAML.parse(source); }
      catch { fail(`Deployment profile '${selection.profile}' ${section} file is invalid JSON/YAML.`); }
      if (!object(parsed)) fail(`Deployment profile '${selection.profile}' ${section} file must contain an object.`);
      loaded.set(file, { source, parsed });
    }
    const { source, parsed } = loaded.get(file);
    contents[section] = source;
    if (section === 'pages') {
      for (const [table, rows] of Object.entries(parsed)) {
        if (!safe(table) || !Array.isArray(rows) || rows.some(row => !object(row) || Object.keys(row).some(key => !safe(key)))) fail('Pages profiles must map table names to arrays of record patches.');
      }
      continue;
    }
    const key = section === 'environmentVariables' ? 'EnvironmentVariables' : 'ConnectionReferences';
    const rows = parsed[key];
    if (!Array.isArray(rows)) fail(`Profile '${selection.profile}' requires a ${key} array.`);
    const seen = new Set();
    for (const row of rows) {
      const name = section === 'environmentVariables' ? row?.SchemaName : row?.LogicalName;
      if (!safe(name) || seen.has(name.toLowerCase())) fail(`${key} requires distinct valid schema/logical names.`);
      seen.add(name.toLowerCase());
      if (section === 'environmentVariables') {
        if (!['string', 'number', 'boolean'].includes(typeof row.Value)) fail('EnvironmentVariables requires scalar Value fields.');
        environmentVariables[name] = String(row.Value);
      } else {
        for (const field of ['ConnectionId', 'ConnectorId']) if (typeof row[field] !== 'string' || !row[field].trim() || /[\x00-\x1f]/.test(row[field])) fail(`ConnectionReferences requires non-empty ${field} fields.`);
        connectionReferences.push({ logicalName: name, connectionId: row.ConnectionId, connectorId: row.ConnectorId });
      }
    }
  }
  return { ...selection, environmentVariables, connectionReferences,
    pagesFile: selection.enabled.pages ? selection.sources.pages : undefined,
    // Hash every active file so external settings changes participate in runtime evidence.
    fingerprint: createHash('sha256').update(JSON.stringify({ profile: selection.profile, enabled: selection.enabled, contents })).digest('hex'),
  };
}

/** Status contains file mappings and counts, never environment-variable values. */
export function deploymentProfilesSummary(config, active) {
  return { ...profileSelection(config, active.pinned ? { profile: active.profile, enabled: active.enabled } : null),
    default: config.default, defaults: config.enabled, required: config.required,
    profiles: Object.entries(config.profiles).map(([id, sources]) => ({ id, sources })),
    counts: { environmentVariables: Object.keys(active.environmentVariables).length, connectionReferences: active.connectionReferences.length },
  };
}
