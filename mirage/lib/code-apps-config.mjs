import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { isLoopbackUrl } from './dataverse-webhooks.mjs';
import { registerSettingParser } from './config-keys.mjs';

/*
 * Project `codeApps` setting and read-only `power.config.json` parsing for Power Apps code apps.
 * The file is owned by the Power Apps CLI. Mirage reads it and never writes it back.
 */

const CODE_APP_KEYS = new Set(['name', 'dir', 'localAppUrl', 'config', 'devServer']);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/i;
// The base directory each relative setting is resolved against, named in refusals.
const PROJECT_ROOT = 'the project root';
const APP_DIRECTORY = 'the app directory';

/**
 * The one local app URL rule, shared by the project entry, power.config.json and the dev-server supervisor: http or https to
 * a loopback host (localhost, 127.0.0.0/8, ::1 or *.localhost), with no username, password or fragment. Returns the URL
 * object, or null. A refusal never echoes the URL.
 */
export function codeAppLocalUrl(text) {
  if (!isLoopbackUrl(text)) return null;
  const url = new URL(text);
  return url.username || url.password || url.hash ? null : url;
}

/** The local app URL as status pages print it: credentials are removed, and an unparseable value shows as null. */
export function codeAppShownUrl(text) {
  if (text == null) return null;
  const url = URL.parse(String(text));
  if (!url) return null;
  if (!url.username && !url.password) return String(text);
  url.username = '';
  url.password = '';
  return url.href;
}

const LOOPBACK_ADDRESS = (address) => address.startsWith('127.') || address === '::1';
// A connect-level failure moves the probe to the next validated answer; any other error, and any HTTP response, ends it.
const NEXT_ANSWER_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

// The host resolves once: every answer must be loopback before any connection is made. The answers keep their order.
async function pinnedAddresses(url, lookup) {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const literal = net.isIP(host);
  const answers = literal ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!answers.length || !answers.every(({ address }) => LOOPBACK_ADDRESS(address)))
    throw new Error('Local app address does not resolve only to loopback.');
  return { addresses: answers.map(({ address }) => address), servername: literal ? undefined : host };
}

const connectLocal = (options, onResponse) =>
  (options.protocol === 'https:' ? https : http).request(options, onResponse);

// One attempt at one validated address: it settles with the HTTP status or with the connect-level error.
function requestAddress(connect, url, { address, servername, headers, init }) {
  return new Promise((resolve, reject) => {
    const request = connect(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
        servername,
        signal: init.signal,
      },
      (incoming) => {
        incoming.destroy();
        resolve(new Response(null, { status: incoming.statusCode }));
      },
    );
    request.once('error', reject);
    request.end();
  });
}

/**
 * Fetch-shaped probe of a loopback app URL. The name is resolved once and every answer must be loopback. The validated
 * answers are tried in order, moving on only after a connect-level refusal, with the original Host header (https keeps the
 * name for SNI and certificate checks). Redirects are reported with their status and never followed. `lookup` and `connect`
 * are injectable for tests.
 */
export async function pinnedLocalFetch(text, init = {}, { lookup = dns.promises.lookup, connect = connectLocal } = {}) {
  if (!isLoopbackUrl(text)) throw new Error('Local app URL is not loopback.');
  const url = new URL(text);
  const { addresses, servername } = await pinnedAddresses(url, lookup);
  const headers = { ...Object.fromEntries(new Headers(init.headers ?? {})), host: url.host };
  let lastError;
  for (const address of addresses) {
    try {
      return await requestAddress(connect, url, { address, servername, headers, init });
    } catch (error) {
      if (!NEXT_ANSWER_CODES.has(error.code)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** Validate the project `codeApps` array: `[{ name, dir, localAppUrl?, config? = 'power.config.json' }]`. */
export function codeAppSettings(value, label = 'codeApps') {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const names = new Set();
  return value.map((entry, index) => validateCodeAppEntry(entry, index, label, names));
}

function relativeCodeAppPath(at, field, text, base) {
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    path.isAbsolute(text) ||
    path.win32.isAbsolute(text) ||
    path.posix.normalize(text.replaceAll('\\', '/')).split('/')[0] === '..'
  )
    throw new Error(`${at}.${field} must be a path relative to ${base}`);
  return text;
}
function validateDevServerShape(dev, at) {
  if (!dev || typeof dev !== 'object' || Array.isArray(dev)) throw new Error(`${at}.devServer must be an object`);
  for (const key of Object.keys(dev))
    if (!['command', 'cwd', 'env', 'timeoutMs'].includes(key))
      throw new Error(`${at}.devServer.${key} is not a supported setting`);
}
// A NUL or a line break cannot survive the launcher's command line, so each one is refused in every element.
const UNSAFE_COMMAND_CHARACTERS = ['\0', '\r', '\n'];
const unsafeCommandElement = (value) => UNSAFE_COMMAND_CHARACTERS.some((character) => value.includes(character));
function validateDevServerCommand(command, at) {
  if (
    !Array.isArray(command) ||
    !command.length ||
    typeof command[0] !== 'string' ||
    !command[0].trim() ||
    command.some((value) => typeof value !== 'string' || unsafeCommandElement(value))
  )
    throw new Error(`${at}.devServer.command must be a nonempty array of nonempty strings`);
}
function validateDevServerEnv(env, at) {
  if (
    !isObject(env) ||
    Object.entries(env).some(
      ([key, value]) =>
        !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0'),
    )
  )
    throw new Error(`${at}.devServer.env must map environment names to strings`);
  return { ...env };
}
function validateDevServerTimeout(timeoutMs, at) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new Error(`${at}.devServer.timeoutMs must be an integer from 1000 to 300000`);
  return timeoutMs;
}
function validateDevServer(dev, at, relative) {
  validateDevServerShape(dev, at);
  validateDevServerCommand(dev.command, at);
  const server = { command: [...dev.command] };
  if (dev.cwd != null) server.cwd = relative('devServer.cwd', dev.cwd, APP_DIRECTORY);
  if (dev.env != null) server.env = validateDevServerEnv(dev.env, at);
  if (dev.timeoutMs != null) server.timeoutMs = validateDevServerTimeout(dev.timeoutMs, at);
  return server;
}
function validateConnectionFields(key, item, invalid) {
  for (const field of ['id', 'apiName', 'displayName'])
    if (item[field] != null && typeof item[field] !== 'string')
      invalid(`connectionReferences.${key}.${field}`, 'a string');
  if (
    item.dataSources != null &&
    (!Array.isArray(item.dataSources) || item.dataSources.some((value) => typeof value !== 'string'))
  )
    invalid(`connectionReferences.${key}.dataSources`, 'an array of strings');
}
function connectionReference(key, item) {
  if ((item.id != null && typeof item.id !== 'string') || (item.apiName != null && typeof item.apiName !== 'string'))
    return null;
  let id = '';
  if (typeof item.apiName === 'string') id = item.apiName;
  else if (typeof item.id === 'string') id = item.id;
  return {
    key,
    apiId: id.split('/').findLast(Boolean) ?? null,
    displayName: typeof item.displayName === 'string' ? item.displayName : null,
    dataSources: Array.isArray(item.dataSources) ? item.dataSources.filter((value) => typeof value === 'string') : [],
  };
}
function diagnoseConnectionBinding(key, reference, bindings, result) {
  const connectorId = reference.apiId ?? reference.key;
  let binding;
  if (Object.hasOwn(bindings, key)) binding = bindings[key];
  else if (Object.hasOwn(bindings, connectorId)) binding = bindings[connectorId];
  if (!isObject(binding) || (binding.connector && binding.connector !== connectorId))
    result.diagnostics.push({
      code: 'CODEAPP_CONNECTION_UNBOUND',
      message: `Connection reference '${key}'${reference.apiId ? ' (' + reference.apiId + ')' : ''} has no local binding.`,
      source: result.source,
    });
}
function validateConnectionReference(key, item, bindings, result, invalid) {
  if (!isObject(item)) {
    invalid(`connectionReferences.${key}`, 'an object');
    return;
  }
  validateConnectionFields(key, item, invalid);
  const reference = connectionReference(key, item);
  if (!reference) return;
  result.connectionReferences.push(reference);
  diagnoseConnectionBinding(key, reference, bindings, result);
}
function validateCodeAppEntry(entry, index, label, names) {
  const at = `${label}[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} must be an object`);
  for (const key of Object.keys(entry))
    if (!CODE_APP_KEYS.has(key)) throw new Error(`${at}.${key} is not a supported setting`);
  // The name is a URL segment under /_apps/code/<name>/.
  if (typeof entry.name !== 'string' || !NAME.test(entry.name))
    throw new Error(`${at}.name must be 1-64 letters, digits or hyphens`);
  const key = entry.name.toLowerCase();
  if (names.has(key)) throw new Error(`${at}.name '${entry.name}' is not unique`);
  names.add(key);
  const relative = (field, text, base) => relativeCodeAppPath(at, field, text, base);
  const app = {
    name: entry.name,
    dir: relative('dir', entry.dir, PROJECT_ROOT),
    config: entry.config == null ? 'power.config.json' : relative('config', entry.config, APP_DIRECTORY),
  };
  if (entry.devServer != null) app.devServer = validateDevServer(entry.devServer, at, relative);
  if (entry.localAppUrl != null) {
    if (!codeAppLocalUrl(entry.localAppUrl))
      throw new Error(`${at}.localAppUrl must be a loopback http(s) URL without credentials`);
    app.localAppUrl = entry.localAppUrl;
  }
  return app;
}

// CLI examples use maps keyed by reference identity. Preserve unknown fields in raw; validate
// only fields consumed by Mirage rather than treating this as a complete Microsoft schema.
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readConfigRaw(source, dir, file, result, diagnostic) {
  let text;
  try {
    text = fs.readFileSync(source, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    diagnostic('CODEAPP_CONFIG_MISSING', `${file} was not found in ${dir}.`);
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    // JSON parser messages can include source text; diagnostics are exposed by the public status page.
    diagnostic('CODEAPP_CONFIG_INVALID', `${file} is not valid JSON.`);
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostic('CODEAPP_CONFIG_INVALID', `${file} must contain a JSON object.`);
    return null;
  }
  result.raw = raw;
  return raw;
}
function applyConfigValues(raw, file, result, diagnostic) {
  for (const field of ['appId', 'environmentId', 'localAppUrl']) {
    if (raw[field] == null) continue;
    if (typeof raw[field] === 'string') result[field] = raw[field];
    else diagnostic('CODEAPP_CONFIG_INVALID', `${file} ${field} must be a string.`);
  }
  if (result.localAppUrl !== null && !codeAppLocalUrl(result.localAppUrl)) {
    diagnostic(
      'CODEAPP_CONFIG_INVALID',
      `${file} localAppUrl is not a loopback http(s) URL without credentials; Mirage will not frame it.`,
    );
    result.localAppUrl = null;
  }
  if (raw.appSettings != null) {
    if (isObject(raw.appSettings)) result.appSettings = raw.appSettings;
    else diagnostic('CODEAPP_CONFIG_INVALID', `${file} appSettings must be an object.`);
  }
}
function reportInvalidConfig(file, diagnostic, field, expected) {
  diagnostic('CODEAPP_CONFIG_INVALID', `${file} ${field} must be ${expected}.`);
}
function validateConnectionReferences(raw, bindings, result, invalid) {
  if (raw.connectionReferences == null) return;
  if (!isObject(raw.connectionReferences)) {
    invalid('connectionReferences', 'an object');
    return;
  }
  for (const [key, item] of Object.entries(raw.connectionReferences))
    validateConnectionReference(key, item, bindings, result, invalid);
}
function validateDataSourceTable(table, key, databaseKey, invalid) {
  const fieldPath = `databaseReferences.${databaseKey}.dataSources.${key}`;
  if (!isObject(table)) {
    invalid(fieldPath, 'an object');
    return;
  }
  for (const field of ['entitySetName', 'logicalName'])
    if (table[field] != null && typeof table[field] !== 'string') invalid(`${fieldPath}.${field}`, 'a string');
  if (table.isHidden != null && typeof table.isHidden !== 'boolean') invalid(`${fieldPath}.isHidden`, 'a boolean');
}
function validateDatabaseReference(database, key, invalid) {
  if (!isObject(database)) {
    invalid(`databaseReferences.${key}`, 'an object');
    return;
  }
  if (database.dataSources == null) return;
  if (!isObject(database.dataSources)) {
    invalid(`databaseReferences.${key}.dataSources`, 'an object');
    return;
  }
  for (const [name, table] of Object.entries(database.dataSources)) validateDataSourceTable(table, name, key, invalid);
}
function validateDatabaseReferences(raw, result, invalid) {
  if (raw.databaseReferences == null) return;
  if (!isObject(raw.databaseReferences)) {
    invalid('databaseReferences', 'an object');
    return;
  }
  result.databaseReferences = raw.databaseReferences;
  for (const [key, database] of Object.entries(raw.databaseReferences))
    validateDatabaseReference(database, key, invalid);
}
function addEntitySetMappings(database, mappings, ambiguous) {
  if (!isObject(database) || !isObject(database.dataSources)) return;
  for (const [alias, table] of Object.entries(database.dataSources)) {
    if (!isObject(table) || typeof table.entitySetName !== 'string' || !table.entitySetName.trim()) continue;
    for (const name of [alias, table.logicalName].filter((value) => typeof value === 'string' && value.trim())) {
      if (mappings.has(name) && mappings.get(name) !== table.entitySetName) ambiguous.add(name);
      else mappings.set(name, table.entitySetName);
    }
  }
}
function buildEntitySets(result, diagnostic) {
  const mappings = new Map(),
    ambiguous = new Set();
  for (const database of Object.values(result.databaseReferences)) addEntitySetMappings(database, mappings, ambiguous);
  for (const name of ambiguous) {
    mappings.delete(name);
    diagnostic('CODEAPP_DATASOURCE_AMBIGUOUS', `Data source '${name}' maps to multiple entity sets.`);
  }
  result.entitySets = Object.fromEntries(mappings);
}

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
    entitySets: {},
    appSettings: {},
    raw: null,
    diagnostics: [],
  };
  const diagnostic = (code, message) => result.diagnostics.push({ code, message, source });
  const raw = readConfigRaw(source, dir, file, result, diagnostic);
  if (!raw) return result;
  applyConfigValues(raw, file, result, diagnostic);
  const invalid = (field, expected) => reportInvalidConfig(file, diagnostic, field, expected);
  validateConnectionReferences(raw, bindings, result, invalid);
  validateDatabaseReferences(raw, result, invalid);
  buildEntitySets(result, diagnostic);
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
    return {
      ...config,
      name: entry.name,
      dir,
      localAppUrl,
      ...(entry.devServer ? { devServer: entry.devServer } : {}),
    };
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
