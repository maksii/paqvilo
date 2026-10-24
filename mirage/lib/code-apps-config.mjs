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

// The connectionReferences entry shape is not documented. Sample files key entries by a reference id with
// `id` ('/providers/Microsoft.PowerApps/apis/<apiId>'), `displayName` and `dataSources`; an array is accepted too.
const references = (value) => {
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.name ?? item?.id ?? String(index), item])
    : Object.entries(value ?? {});
  return entries.map(([key, item]) => ({
    key,
    apiId:
      String(item?.apiName ?? item?.id ?? '')
        .split('/')
        .filter(Boolean)
        .at(-1) ?? null,
    displayName: item?.displayName ?? null,
    dataSources: Array.isArray(item?.dataSources) ? item.dataSources : [],
  }));
};

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
  } catch (error) {
    diagnostic('CODEAPP_CONFIG_INVALID', `${file} is not valid JSON: ${error.message}`);
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
  if (result.localAppUrl && !isLoopbackUrl(result.localAppUrl)) {
    diagnostic(
      'CODEAPP_CONFIG_INVALID',
      `${file} localAppUrl is not a loopback http(s) URL; Mirage will not frame it.`,
    );
    result.localAppUrl = null;
  }
  for (const field of ['connectionReferences', 'databaseReferences'])
    if (raw[field] != null && typeof raw[field] !== 'object')
      diagnostic('CODEAPP_CONFIG_INVALID', `${file} ${field} must be an object.`);
  result.connectionReferences =
    typeof raw.connectionReferences === 'object' ? references(raw.connectionReferences) : [];
  result.databaseReferences =
    raw.databaseReferences && typeof raw.databaseReferences === 'object' ? raw.databaseReferences : {};
  for (const reference of result.connectionReferences)
    if (!Object.hasOwn(bindings, reference.key))
      diagnostic(
        'CODEAPP_CONNECTION_UNBOUND',
        `Connection reference '${reference.key}'${reference.apiId ? ` (${reference.apiId})` : ''} has no local binding.`,
      );
  return result;
}

/** Combine validated project entries with their read-only power.config.json into the records the HTTP handler serves. */
export function loadCodeApps(entries, projectRoot, { bindings = {} } = {}) {
  return entries.map((entry) => {
    const dir = path.resolve(projectRoot, entry.dir),
      config = readCodeAppConfig(dir, entry.config, { bindings });
    return { ...config, name: entry.name, dir, localAppUrl: entry.localAppUrl ?? config.localAppUrl };
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
