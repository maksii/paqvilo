// The project `codeApps` settings contract and the local app URL rule: validation only, no file or network access.
// code-apps-config.mjs re-exports both; settings-contracts.mjs registers the parser on the config-load path.
import path from 'node:path';
import { isLoopbackUrl } from './loopback-url.mjs';

const CODE_APP_KEYS = new Set(['name', 'dir', 'localAppUrl', 'config', 'devServer']);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/i;
// The base directory each relative setting is resolved against, named in refusals.
const PROJECT_ROOT = 'the project root';
const APP_DIRECTORY = 'the app directory';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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
    if (!['command', 'cwd', 'env', 'timeoutMs'].includes(key)) throw new Error(`Unknown ${at}.devServer key '${key}'`);
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
    throw new Error(
      `${at}.devServer.command must be a nonempty array of strings whose first element is not blank and none contains NUL or a line break`,
    );
}
function validateDevServerEnv(env, at) {
  if (
    !isObject(env) ||
    Object.entries(env).some(
      ([key, value]) =>
        !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0'),
    )
  )
    throw new Error(`${at}.devServer.env must map environment names (without = or NUL) to strings without NUL`);
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
function validateCodeAppEntry(entry, index, label, names) {
  const at = `${label}[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} must be an object`);
  for (const key of Object.keys(entry)) if (!CODE_APP_KEYS.has(key)) throw new Error(`Unknown ${at} key '${key}'`);
  // The name is a URL segment under /_apps/code/<name>/.
  if (typeof entry.name !== 'string' || !NAME.test(entry.name))
    throw new Error(`${at}.name must be 1-64 letters, digits or hyphens, starting with a letter or digit`);
  const key = entry.name.toLowerCase();
  if (names.has(key)) throw new Error(`${at}.name '${entry.name}' is not unique (names are compared ignoring case)`);
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
      throw new Error(`${at}.localAppUrl must be a loopback http(s) URL without credentials or fragment`);
    app.localAppUrl = entry.localAppUrl;
  }
  return app;
}
