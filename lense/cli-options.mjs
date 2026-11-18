import { parseArgs } from 'node:util';

/**
 * Refuses a string option that is given twice unless its table entry is `multiple: true`, so a duplicated
 * `--env` cannot silently replace the value the reader saw first. Reads the `tokens` parseArgs reports.
 */
function refuseRepeatedOptions(tokens, options) {
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const declared = options[token.name];
    if (declared?.type !== 'string' || declared.multiple) continue;
    if (seen.has(token.name))
      throw Object.assign(new Error(`--${token.name} may be given only once`), { code: 'invalid_argument' });
    seen.add(token.name);
  }
}

/**
 * A parseArgs refusal as one line that says what to do. Node's unknown-option text explains positional values with
 * an unbalanced quote, and an ambiguous value spans several lines.
 */
export function parseFailureMessage(error) {
  const unknown = error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && /^Unknown option '([^']*)'/.exec(error.message);
  // Lines are split and trimmed rather than matched with a whitespace-run pattern, which backtracks.
  const what = unknown
    ? `Unknown option '${unknown[1]}'.`
    : error.message
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ');
  // Node ends some refusals without a full stop ("... argument missing", "... positional arguments").
  const sentence = /[.!?]$/.test(what) ? what : what + '.';
  return `${sentence} Run with --help to see supported options.`;
}

/** node:util parseArgs with the repeated-option check; takes and returns the same shapes. */
export function parseOptions(config) {
  let parsed;
  try {
    parsed = parseArgs({ ...config, tokens: true });
  } catch (error) {
    if (error.code?.startsWith('ERR_PARSE_ARGS_')) {
      error.message = parseFailureMessage(error);
      // Node's parse codes are not an output contract: an unknown option is `unsupported_option` in every command's
      // JSON error, and any other argument mistake (a missing value, a stray positional) is `invalid_argument`.
      error.code = error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'unsupported_option' : 'invalid_argument';
    }
    throw error;
  }
  refuseRepeatedOptions(parsed.tokens, config.options);
  return parsed;
}

/** The exit code of a finished command: its own non-zero code, else a failure that a cleanup step recorded, else 0. */
export const commandExitCode = (code, recorded) => code || recorded || 0;

/** Every option of the `paqvilo lense` command line (the Mirage lifecycle included); each command admits its own subset. */
export const LENSE_OPTIONS = {
  site: { type: 'string' },
  env: { type: 'string' },
  pick: { type: 'boolean' },
  url: { type: 'string' },
  source: { type: 'string' },
  repo: { type: 'string' },
  config: { type: 'string' },
  portals: { type: 'string' },
  browser: { type: 'string' },
  profile: { type: 'string' },
  'user-data-dir': { type: 'string' },
  'profile-directory': { type: 'string' },
  'cdp-url': { type: 'string' },
  scope: { type: 'string' },
  baseline: { type: 'string' },
  path: { type: 'string' },
  headless: { type: 'boolean' },
  headed: { type: 'boolean' },
  'signed-in': { type: 'boolean' },
  'no-reload': { type: 'boolean' },
  'no-write': { type: 'boolean' },
  'no-overrides': { type: 'boolean' },
  'debug-port': { type: 'string' },
  check: { type: 'boolean' },
  settings: { type: 'boolean' },
  all: { type: 'boolean' },
  page: { type: 'string' },
  kind: { type: 'string', multiple: true },
  search: { type: 'string' },
  changed: { type: 'boolean' },
  limit: { type: 'string' },
  offset: { type: 'string' },
  session: { type: 'string' },
  'page-id': { type: 'string' },
  selector: { type: 'string' },
  after: { type: 'string' },
  output: { type: 'string' },
  timeout: { type: 'string' },
  'full-page': { type: 'boolean' },
  'include-panel': { type: 'boolean' },
  width: { type: 'string' },
  height: { type: 'string' },
  styles: { type: 'string' },
  'sign-in-timeout': { type: 'string' },
  project: { type: 'string' },
  'resource-map': { type: 'string' },
  'event-cursor': { type: 'string' },
  'include-event-parameters': { type: 'boolean' },
  runtime: { type: 'string' },
  simulation: { type: 'string' },
  portal: { type: 'string' },
  port: { type: 'string' },
  state: { type: 'string' },
  preset: { type: 'string' },
  'preset-mode': { type: 'string' },
  'apply-configuration': { type: 'boolean' },
  'solution-root': { type: 'string', multiple: true },
  'startup-timeout': { type: 'string' },
  'local-simulation': { type: 'boolean' },
  'allow-live-writes': { type: 'boolean' },
  out: { type: 'string' },
  force: { type: 'boolean' },
  strict: { type: 'boolean' },
  mirage: { type: 'boolean' },
  'lint-profiles': { type: 'boolean' },
  'fail-on': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

/** Per-command operational options, shared by validation and command-specific help. */
const selection = ['site', 'env', 'url', 'source', 'repo', 'config', 'scope', 'baseline'];
const browserSelection = ['browser', 'profile', 'user-data-dir', 'profile-directory'];
export const LENSE_COMMAND_OPTIONS = {
  dev: [
    ...selection,
    ...browserSelection,
    'cdp-url',
    'portals',
    'pick',
    'path',
    'headless',
    'headed',
    'no-reload',
    'no-overrides',
    'debug-port',
  ],
  map: [...selection, 'pick', 'check', 'no-write', 'json'],
  status: [...selection, 'pick', 'json'],
  verify: [
    ...selection,
    ...browserSelection,
    'pick',
    'path',
    'headless',
    'headed',
    'signed-in',
    'json',
    'strict',
    'sign-in-timeout',
  ],
  doctor: [...selection, ...browserSelection, 'cdp-url', 'all', 'mirage', 'lint-profiles', 'fail-on', 'json'],
  analyze: ['site', 'env', 'source', 'repo', 'config', 'project', 'all', 'fail-on', 'json'],
  list: [...selection, ...browserSelection, 'cdp-url', 'portals', 'settings', 'json'],
  audit: [...selection, 'all', 'strict', 'json'],
  use: ['config', 'repo', 'site', 'env'],
  resources: [...selection, 'json', 'page', 'kind', 'search', 'changed', 'limit', 'offset'],
  agent: [
    'config',
    'session',
    'page-id',
    'selector',
    'limit',
    'after',
    'output',
    'timeout',
    'full-page',
    'include-panel',
    'width',
    'height',
    'styles',
    'path',
    'json',
  ],
  'model-driven': [
    'config',
    ...browserSelection,
    'cdp-url',
    'project',
    'env',
    'url',
    'path',
    'resource-map',
    'event-cursor',
    'include-event-parameters',
    'local-simulation',
    'startup-timeout',
    'headless',
    'headed',
    'no-reload',
    'debug-port',
    'timeout',
    'output',
    'json',
  ],
  mirage: [
    ...selection,
    ...browserSelection,
    'cdp-url',
    'portals',
    'project',
    'portal',
    'path',
    'port',
    'state',
    'preset',
    'preset-mode',
    'apply-configuration',
    'solution-root',
    'startup-timeout',
    'allow-live-writes',
    'headless',
    'headed',
    'no-reload',
    'debug-port',
    'out',
    'force',
    'json',
    'runtime',
    'simulation',
  ],
};

/** Every option of the `paqvilo dataverse` command line; each command admits its own subset. */
export const DATAVERSE_OPTIONS = {
  connection: { type: 'string' },
  manifest: { type: 'string' },
  catalogue: { type: 'string' },
  environment: { type: 'string' },
  name: { type: 'string' },
  role: { type: 'string' },
  out: { type: 'string' },
  solution: { type: 'string' },
  unpack: { type: 'string' },
  json: { type: 'boolean' },
  registration: { type: 'string' },
  'secret-file': { type: 'string' },
  'consume-secret-file': { type: 'boolean' },
  'allow-additional-application': { type: 'boolean' },
  'update-labels': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

/**
 * The options each `dataverse` command requires and accepts: its validation (lense/dataverse/cli.mjs) and its help
 * (lense/cli-help.mjs) both read this table, so a command refuses every option its help does not list.
 */
const manifestCommand = { required: ['manifest', 'connection'], optional: ['json'] };
export const DATAVERSE_COMMAND_OPTIONS = {
  register: {
    required: ['connection', 'name'],
    optional: ['role', 'environment', 'allow-additional-application', 'json'],
  },
  inspect: { required: ['connection'], optional: ['json'] },
  connect: {
    required: ['registration', 'secret-file', 'connection'],
    optional: ['role', 'consume-secret-file', 'json'],
  },
  verify: { required: ['connection'], optional: ['json'] },
  plan: { required: ['manifest'], optional: ['connection', 'out', 'json'] },
  apply: { required: ['manifest', 'connection'], optional: ['out', 'update-labels', 'json'] },
  publish: manifestCommand,
  keys: manifestCommand,
  'audit-lookups': manifestCommand,
  'scope-solutions': { required: ['manifest', 'connection'], optional: ['out', 'json'] },
  export: { required: ['connection', 'solution', 'out'], optional: ['unpack', 'json'] },
  'data-plan': { required: ['catalogue'], optional: ['connection', 'out', 'json'] },
  'data-apply': { required: ['catalogue', 'connection'], optional: ['out', 'json'] },
  'data-compare': { required: ['catalogue', 'connection'], optional: ['out', 'json'] },
  'data-query': { required: ['catalogue', 'connection'], optional: ['out', 'json'] },
};

/**
 * The options each `mirage` action accepts: its validation (lense/commands/mirage.mjs) and its help both read this table,
 * so an action refuses every option its help does not list. start opens no browser; init and stop take what selects
 * the runtime they write or stop.
 */
const mirageOptions = (excluded) => LENSE_COMMAND_OPTIONS.mirage.filter((option) => !excluded.includes(option));
export const MIRAGE_ACTION_OPTIONS = {
  init: [
    'site',
    'env',
    'url',
    'source',
    'repo',
    'config',
    'portals',
    'project',
    'portal',
    'runtime',
    'simulation',
    'solution-root',
    'port',
    'state',
    'preset',
    'preset-mode',
    'out',
    'force',
    'json',
  ],
  start: mirageOptions([
    ...browserSelection,
    'cdp-url',
    'path',
    'headless',
    'headed',
    'no-reload',
    'debug-port',
    'out',
    'force',
  ]),
  dev: mirageOptions(['out', 'force', 'json']),
  status: ['config', 'site', 'project', 'repo', 'json'],
  inspect: [
    'config',
    'repo',
    'site',
    'env',
    'source',
    'project',
    'portal',
    'solution-root',
    'runtime',
    'simulation',
    'json',
  ],
  stop: [
    'site',
    'env',
    'source',
    'repo',
    'config',
    'portals',
    'project',
    'portal',
    'port',
    'state',
    'solution-root',
    'runtime',
    'json',
  ],
};
