import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackUrl } from './dataverse-webhooks.mjs';
import { registerSettingParser } from './config-keys.mjs';

/*
 * Project `codeApps` setting and read-only `power.config.json` parsing for Power Apps code apps.
 * The file is owned by the Power Apps CLI. Mirage reads it and never writes it back.
 */

const CODE_APP_KEYS = ['name', 'dir', 'localAppUrl', 'config'];
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** Validate the project `codeApps` array: `[{ name, dir, localAppUrl?, config? = 'power.config.json' }]`. */
export function codeAppSettings(value, label = 'codeApps') {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const names = new Set();
  return value.map((entry, index) => {
    const at = `${label}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} must be an object`);
    for (const key of Object.keys(entry))
      if (!CODE_APP_KEYS.includes(key)) throw new Error(`${at}.${key} is not a supported setting`);
    // The name is a URL segment under /_apps/code/<name>/.
    if (typeof entry.name !== 'string' || !NAME.test(entry.name))
      throw new Error(`${at}.name must be 1-64 letters, digits or hyphens`);
    const key = entry.name.toLowerCase();
    if (names.has(key)) throw new Error(`${at}.name '${entry.name}' is not unique`);
    names.add(key);
    const relative = (field, text) => {
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        path.isAbsolute(text) ||
        path.win32.isAbsolute(text) ||
        path.posix.normalize(text.replaceAll('\\', '/')).split('/')[0] === '..'
      )
        throw new Error(`${at}.${field} must be a path relative to the project root`);
      return text;
    };
    const app = {
      name: entry.name,
      dir: relative('dir', entry.dir),
      config: entry.config == null ? 'power.config.json' : relative('config', entry.config),
    };
    if (entry.localAppUrl != null) {
      if (!isLoopbackUrl(entry.localAppUrl)) throw new Error(`${at}.localAppUrl must be a loopback http(s) URL`);
      app.localAppUrl = entry.localAppUrl;
    }
    return app;
  });
}

// CLI examples use maps keyed by reference identity. Preserve unknown fields in raw; validate
// only fields consumed by Mirage rather than treating this as a complete Microsoft schema.
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Read `<dir>/<file>` READ-ONLY. Returns the fields Mirage uses plus `raw` (the parsed document, never written back)
 * and diagnostics: CODEAPP_CONFIG_MISSING, CODEAPP_CONFIG_INVALID, CODEAPP_CONNECTION_UNBOUND (a connection reference
 * absent from `bindings`, a map of reference key to local connection binding).
 */
export function readCodeAppConfig(dir, file = 'power.config.json', { bindings = {} } = {}) {
  const source = path.join(dir, file);
  const result = {
    source,
    appId: null,
    environmentId: null,
    localAppUrl: null,
    connectionReferences: [],
    databaseReferences: {},
    raw: null,
    diagnostics: [],
  };
  const diagnostic = (code, message) => result.diagnostics.push({ code, message, source });
  let text;
  try {
    text = fs.readFileSync(source, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    diagnostic('CODEAPP_CONFIG_MISSING', `${file} was not found in ${dir}.`);
    return result;
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    // JSON parser messages can include source text; diagnostics are exposed by the public status page.
    diagnostic('CODEAPP_CONFIG_INVALID', `${file} is not valid JSON.`);
    return result;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostic('CODEAPP_CONFIG_INVALID', `${file} must contain a JSON object.`);
    return result;
  }
  result.raw = raw;
  for (const field of ['appId', 'environmentId', 'localAppUrl']) {
    if (raw[field] == null) continue;
    if (typeof raw[field] === 'string') result[field] = raw[field];
    else diagnostic('CODEAPP_CONFIG_INVALID', `${file} ${field} must be a string.`);
  }
  if (result.localAppUrl !== null && !isLoopbackUrl(result.localAppUrl)) {
    diagnostic(
      'CODEAPP_CONFIG_INVALID',
      `${file} localAppUrl is not a loopback http(s) URL; Mirage will not frame it.`,
    );
    result.localAppUrl = null;
  }
  const invalid = (field, expected) => diagnostic('CODEAPP_CONFIG_INVALID', `${file} ${field} must be ${expected}.`);
  if (raw.connectionReferences != null) {
    if (!isObject(raw.connectionReferences)) invalid('connectionReferences', 'an object');
    else
      for (const [key, item] of Object.entries(raw.connectionReferences)) {
        if (!isObject(item)) {
          invalid(`connectionReferences.${key}`, 'an object');
          continue;
        }
        for (const field of ['id', 'apiName', 'displayName'])
          if (item[field] != null && typeof item[field] !== 'string')
            invalid(`connectionReferences.${key}.${field}`, 'a string');
        if (
          item.dataSources != null &&
          (!Array.isArray(item.dataSources) || item.dataSources.some((v) => typeof v !== 'string'))
        )
          invalid(`connectionReferences.${key}.dataSources`, 'an array of strings');
        // Do not fall back to the reference key when an explicitly supplied connector id is malformed.
        if (
          (item.id != null && typeof item.id !== 'string') ||
          (item.apiName != null && typeof item.apiName !== 'string')
        )
          continue;
        const id = typeof item.apiName === 'string' ? item.apiName : typeof item.id === 'string' ? item.id : '';
        const reference = {
          key,
          apiId: id.split('/').filter(Boolean).at(-1) ?? null,
          displayName: typeof item.displayName === 'string' ? item.displayName : null,
          dataSources: Array.isArray(item.dataSources) ? item.dataSources.filter((v) => typeof v === 'string') : [],
        };
        result.connectionReferences.push(reference);
        const connectorId = reference.apiId ?? reference.key;
        const binding = Object.hasOwn(bindings, key)
          ? bindings[key]
          : Object.hasOwn(bindings, connectorId)
            ? bindings[connectorId]
            : undefined;
        if (!isObject(binding) || (binding.connector && binding.connector !== connectorId))
          diagnostic(
            'CODEAPP_CONNECTION_UNBOUND',
            `Connection reference '${key}'${reference.apiId ? ` (${reference.apiId})` : ''} has no local binding.`,
          );
      }
  }
  if (raw.databaseReferences != null) {
    if (!isObject(raw.databaseReferences)) invalid('databaseReferences', 'an object');
    else {
      result.databaseReferences = raw.databaseReferences;
      for (const [key, database] of Object.entries(raw.databaseReferences)) {
        if (!isObject(database)) {
          invalid(`databaseReferences.${key}`, 'an object');
          continue;
        }
        if (database.dataSources != null) {
          if (!isObject(database.dataSources)) invalid(`databaseReferences.${key}.dataSources`, 'an object');
          else
            for (const [name, table] of Object.entries(database.dataSources)) {
              if (!isObject(table)) {
                invalid(`databaseReferences.${key}.dataSources.${name}`, 'an object');
                continue;
              }
              for (const field of ['entitySetName', 'logicalName'])
                if (table[field] != null && typeof table[field] !== 'string')
                  invalid(`databaseReferences.${key}.dataSources.${name}.${field}`, 'a string');
              if (table.isHidden != null && typeof table.isHidden !== 'boolean')
                invalid(`databaseReferences.${key}.dataSources.${name}.isHidden`, 'a boolean');
            }
        }
      }
    }
  }
  return result;
}

/** Combine validated project entries with their read-only power.config.json into the records the HTTP handler serves. */
export function loadCodeApps(entries, projectRoot, { bindings = {} } = {}) {
  return entries.map((entry) => {
    const dir = path.resolve(projectRoot, entry.dir),
      config = readCodeAppConfig(dir, entry.config, { bindings });
    const localAppUrl = entry.localAppUrl ?? config.localAppUrl;
    if (!localAppUrl)
      config.diagnostics.push({
        code: 'CODEAPP_LOCAL_URL_MISSING',
        message: 'No loopback localAppUrl is configured for this code app.',
        source: config.source,
      });
    return { ...config, name: entry.name, dir, localAppUrl };
  });
}

/** Capability/inventory record for a configured code app (level `contract`: documented client surface, mock player). */
export function codeAppInventoryRecord(app) {
  return {
    component: 'codeapp',
    id: app.appId ?? null,
    name: app.name,
    source: app.source ?? null,
    level: 'contract',
    operations: ['context', 'token', 'dataverse', 'connectors', 'loader'],
    dependencies: (app.connectionReferences ?? []).map((reference) => ({
      component: 'connectionreference',
      name: reference.key,
      apiId: reference.apiId,
    })),
    diagnostics: (app.diagnostics ?? []).map(({ code }) => code),
  };
}

registerSettingParser('codeApps', codeAppSettings);
