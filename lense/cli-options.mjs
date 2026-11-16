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

/** node:util parseArgs with the repeated-option check; takes and returns the same shapes. */
export function parseOptions(config) {
  const parsed = parseArgs({ ...config, tokens: true });
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
