import { parseOptions } from '../lense/cli-options.mjs';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const string = (label, extra = {}) => ({ type: 'string', label, ...extra });
const flag = () => ({ type: 'boolean' });
const catalogue = { config: string('FILE'), site: string('ID'), env: string('ID'), repo: string('DIR') };
// These tools historically reject empty strings; the other operational parsers accept them.
const NONEMPTY_VALUES = new Set(['liquid-inventory', 'webapi-inventory', 'render-sweep', 'portal-matrix', 'trace']);
/** The public help and parsers share these option tables. */
const TOOL_SCHEMAS = {
  'bootstrap-report': {
    site: { type: 'string' },
    env: { type: 'string' },
    repo: { type: 'string' },
    config: { type: 'string' },
    source: { type: 'string' },
    'solution-root': { type: 'string', multiple: true },
    'solution-order': { type: 'string' },
    project: { type: 'string' },
    portal: { type: 'string' },
    'deployment-profile': { type: 'string' },
    'data-model': { type: 'string' },
    lcid: { type: 'string' },
    json: { type: 'boolean' },
    output: { type: 'string' },
    'no-cache': { type: 'boolean' },
    'all-fields': { type: 'boolean' },
    help: { type: 'boolean' },
  },
  'parity-suite': {
    local: { type: 'string' },
    'local-owned': { type: 'boolean' },
    source: { type: 'string' },
    state: { type: 'string' },
    preset: { type: 'string' },
    site: { type: 'string' },
    env: { type: 'string' },
    repo: { type: 'string' },
    config: { type: 'string' },
    'pack-module': { type: 'string', multiple: true },
    origin: { type: 'string' },
    cdp: { type: 'string' },
    'anonymous-browser': { type: 'string' },
    scenarios: { type: 'string' },
    core: { type: 'boolean' },
    'no-core': { type: 'boolean' },
    pack: { type: 'string', multiple: true },
    packs: { type: 'string' },
    out: { type: 'string' },
    only: { type: 'string' },
    tags: { type: 'string' },
    'exclude-tags': { type: 'string' },
    label: { type: 'string' },
    'delay-ms': { type: 'string' },
    'work-dir': { type: 'string' },
    'persona-contact': { type: 'string' },
    'no-persona': { type: 'boolean' },
    browser: { type: 'string' },
    ids: { type: 'string' },
    'deployment-profile': { type: 'string' },
    reclassify: { type: 'string' },
    list: { type: 'boolean' },
  },
  'baseline-suite': {
    matrix: { type: 'string' },
    out: { type: 'string' },
    side: { type: 'string' },
    label: { type: 'string' },
    'allow-writes': { type: 'boolean' },
    'all-scenarios': { type: 'boolean' },
    ids: { type: 'string' },
    only: { type: 'string' },
    config: { type: 'string' },
    site: { type: 'string' },
    env: { type: 'string' },
    source: { type: 'string' },
    state: { type: 'string' },
    headed: { type: 'boolean' },
    'work-dir': { type: 'string' },
    live: { type: 'string' },
    mirage: { type: 'string' },
    allowlist: { type: 'string' },
    'second-live': { type: 'string' },
    'evidence-changes': { type: 'string' },
  },
  'liquid-conformance': {
    suite: { type: 'string' },
    rules: { type: 'string' },
    out: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
    markdown: { type: 'boolean' },
  },
  acceptance: {
    local: { type: 'string' },
    origin: { type: 'string' },
    cdp: { type: 'string' },
    plan: { type: 'string' },
    requires: { type: 'string', multiple: true },
    strict: { type: 'boolean', default: false },
    output: {
      type: 'string',
      default: '.paqvilo/simulator/acceptance/evidence',
    },
  },
  'enrich-reference': {
    state: { type: 'string' },
    origin: { type: 'string' },
    cdp: { type: 'string' },
    plan: { type: 'string' },
  },
  'reference-parity': {
    local: { type: 'string' },
    origin: { type: 'string' },
    cdp: { type: 'string' },
    plan: { type: 'string' },
    output: { type: 'string' },
    'local-contact': { type: 'string' },
    'local-role': { type: 'string', multiple: true },
    'local-configured-persona': { type: 'boolean' },
  },
  'query-inventory': { portal: { type: 'string' }, json: { type: 'boolean' } },
  verify: Object.fromEntries(['local', 'origin', 'cdp', 'path', 'output'].map((name) => [name, { type: 'string' }])),
  'verify-storage': { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  'capture-shell': {
    config: { type: 'string' },
    site: { type: 'string' },
    env: { type: 'string' },
    all: { type: 'boolean' },
    path: { type: 'string' },
    cdp: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
    strict: { type: 'boolean' },
    'no-rich-text': { type: 'boolean' },
  },

  'liquid-inventory': {
    ...catalogue,
    portal: string('DIR'),
    out: string('FILE'),
    json: flag(),
    'include-inactive': flag(),
    sources: flag(),
    strict: flag(),
    help: { ...flag(), short: 'h' },
  },
  'webapi-inventory': {
    ...catalogue,
    portal: string('DIR'),
    'solution-root': string('DIR', { multiple: true }),
    'client-wrapper': string('NAME', { multiple: true }),
    json: flag(),
    help: { ...flag(), short: 'h' },
  },
  'render-sweep': {
    ...catalogue,
    source: string('DIR'),
    'solution-root': string('DIR', { multiple: true }),
    project: string('FILE'),
    portal: string('ID'),
    persona: string('NAME'),
    preset: string('NAME'),
    state: string('FILE'),
    out: string('DIR'),
    path: string('PREFIX'),
    limit: string('N'),
    json: flag(),
    ci: flag(),
    strict: flag(),
    help: { ...flag(), short: 'h' },
  },
  'portal-matrix': {
    config: string('FILE'),
    project: string('FILE'),
    samples: string('DIR'),
    portal: string('ID', { multiple: true }),
    sites: string('a,b'),
    env: string('SITE=ENV', { multiple: true }),
    repo: string('DIR'),
    out: string('DIR'),
    only: string('a,b'),
    skip: string('a,b'),
    personas: string('a,b'),
    'scaffold-personas': string('a,b'),
    'scaffold-profile': string('NAME'),
    limit: string('N'),
    path: string('PREFIX'),
    preset: string('PORTAL=NAME', { multiple: true }),
    'use-state': flag(),
    json: flag(),
    strict: flag(),
    help: { ...flag(), short: 'h' },
  },
  // paqvilo mirage trace (trace.mjs): the runtime selector, the /_sim/api/trace filters, sort, the settings members, the
  // export format and limit, and the watch --count and --trace-end.
  trace: {
    origin: string('LOOPBACK_ORIGIN'),
    config: string('FILE'),
    site: string('ID'),
    project: string('FILE'),
    from: string('TIME'),
    to: string('TIME'),
    kind: string('KIND'),
    module: string('NAME'),
    operation: string('NAME'),
    entity: string('LOGICAL_NAME'),
    'record-id': string('ID'),
    status: string('ok|error|denied|cancelled|running'),
    host: string(
      'power-pages|standalone|model-driven|canvas|code-app|dataverse-api|tds|soap|job|sim|identity-provider|sharepoint',
    ),
    'actor-kind': string('KIND'),
    'actor-id': string('ID'),
    'session-key': string('KEY'),
    'visitor-id': string('ID'),
    portal: string('ID'),
    'audit-id': string('ID'),
    result: string('RESULT[,RESULT]'),
    search: string('TEXT'),
    'trace-id': string('ID'),
    'parent-span-id': string('ID'),
    depth: string('N'),
    'min-duration-ms': string('N'),
    'has-errors': string('true|false'),
    page: string('N'),
    'page-size': string('N'),
    order: string('desc|asc'),
    sort: string('start|duration|spans|errors'),
    'bucket-ms': string('N'),
    level: string('off|summary|full'),
    persist: string('true|false'),
    traces: string('N'),
    'spans-per-trace': string('N'),
    'payload-bytes': string('N'),
    format: string('json|ndjson|otlp|bundle'),
    limit: string('N'),
    count: string('N'),
    'trace-end': flag(),
    latest: flag(),
    utc: flag(),
    json: flag(),
    help: { ...flag(), short: 'h' },
  },
};

// Kept here with node:fs and node:url only: help loads this file (test/cli-help-guard.mjs) and never calls the check.
// pathToFileURL resolves a relative path against the working directory, as path.resolve does.
const resolvePath = (value) => fileURLToPath(pathToFileURL(value));
const ABSOLUTE = /^(?:[a-z]:)?[\\/]/i;
const NOUN = { file: 'file', 'file-list': 'file', dir: 'directory', module: 'module file' };

/**
 * Refuses a path option whose file or directory does not exist, in one line naming the option, the path and the
 * problem. `kinds` maps option names to 'file', 'dir' or 'module' (a module option given as a package specifier, not
 * a path, is left to the module loader); options without a value are skipped.
 */
export function assertPathOptions(values, kinds) {
  for (const [option, kind] of Object.entries(kinds))
    for (const value of pathValues(values[option], kind)) assertPathOption(option, kind, value);
}

// The paths an option names: a file-list option is a comma-separated list of files (parity-suite --scenarios); an
// empty value, and a module given as a package specifier rather than a path, name none.
function pathValues(value, kind) {
  const given = [value].flat();
  const list =
    kind === 'file-list'
      ? given.flatMap((item) =>
          String(item ?? '')
            .split(',')
            .map((part) => part.trim()),
        )
      : given;
  return list.filter(
    (item) =>
      typeof item === 'string' &&
      item !== '' &&
      (kind !== 'module' || /^\.{1,2}[\\/]/.test(item) || ABSOLUTE.test(item)),
  );
}

function assertPathOption(option, kind, value) {
  const resolved = resolvePath(value);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`--${option} ${NOUN[kind]} not found: ${resolved}. Pass an existing ${NOUN[kind]}.`);
  }
  if (kind === 'dir' ? !stats.isDirectory() : !stats.isFile())
    throw new Error(
      `--${option} must name a ${NOUN[kind]}, but ${resolved} is a ${stats.isDirectory() ? 'directory' : 'file'}.`,
    );
}

// The input path options of each tool that must name an existing file or directory (assertPathOptions).
const catalogueInputs = { config: 'file', repo: 'dir' };
const TOOL_PATHS = {
  'bootstrap-report': { ...catalogueInputs, source: 'dir', 'solution-root': 'dir', project: 'file' },
  'parity-suite': {
    ...catalogueInputs,
    source: 'dir',
    state: 'file',
    'pack-module': 'module',
    ids: 'file',
    reclassify: 'file',
    scenarios: 'file-list',
  },
  'baseline-suite': {
    config: 'file',
    matrix: 'file',
    source: 'dir',
    state: 'file',
    ids: 'file',
    allowlist: 'file',
    'evidence-changes': 'file',
  },
  'liquid-conformance': { suite: 'file', rules: 'file' },
  acceptance: { plan: 'file' },
  'enrich-reference': { state: 'file', plan: 'file' },
  'reference-parity': { plan: 'file' },
  'query-inventory': { portal: 'dir' },
  'capture-shell': { config: 'file' },
  'liquid-inventory': { ...catalogueInputs, portal: 'dir' },
  'webapi-inventory': { ...catalogueInputs, portal: 'dir', 'solution-root': 'dir' },
  'render-sweep': { ...catalogueInputs, source: 'dir', 'solution-root': 'dir', project: 'file' },
  'portal-matrix': { ...catalogueInputs, project: 'file', samples: 'dir' },
  trace: { config: 'file', project: 'file' },
};

/** Refuses a tool's missing input file or directory in one line naming the option and the path. */
export const assertToolPaths = (name, values) => assertPathOptions(values, TOOL_PATHS[name] ?? {});

// Preserve the catalogue-tool registry: consumers iterate this subset to run catalogue reports.
export const TOOL_OPTIONS = Object.fromEntries(
  ['liquid-inventory', 'webapi-inventory', 'render-sweep', 'portal-matrix', 'trace'].map((name) => [
    name,
    TOOL_SCHEMAS[name],
  ]),
);

/**
 * node:util parseArgs whose refusal is one line naming the option and pointing at --help, never parseArgs' own text,
 * and which refuses a single-value option given twice (`invalid_argument`), as the Lense command line does: the one
 * parse point of the direct Mirage commands and the public tools.
 */
export const parseRaw = (config) => parseOptions(config);

/**
 * The arguments with a negative number after a string option joined to it (`--rows -1` -> `--rows=-1`): parseArgs
 * refuses such a value as ambiguous, so the option's own validation would never report it.
 */
export function joinNegativeValues(args, options) {
  const joined = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') && !args[i].includes('=') ? args[i].slice(2) : null;
    if (options[key]?.type === 'string' && /^-\d/.test(args[i + 1] ?? '')) joined.push(`${args[i]}=${args[++i]}`);
    else joined.push(args[i]);
    if (args[i] === '--') return [...joined, ...args.slice(i + 1)];
  }
  return joined;
}

/** The parsed { values, positionals } of a tool that takes positional arguments (allowPositionals). */
export function parseToolCommand(name, args, { allowPositionals = false, help = false } = {}) {
  const options = Object.fromEntries(
    Object.entries(TOOL_SCHEMAS[name]).map(([key, { label, ...definition }]) => [key, definition]),
  );
  if (help) Object.assign(options, { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } });
  args = joinNegativeValues(args, options);
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : null;
    if (options[key]?.type === 'string' && (args[i + 1] == null || args[i + 1].startsWith('--')))
      throw new Error(`--${key} requires a value`);
  }
  const parsed = parseRaw({ args, options, tokens: true, allowPositionals });
  for (const token of parsed.tokens)
    if (
      NONEMPTY_VALUES.has(name) &&
      token.kind === 'option' &&
      options[token.name].type === 'string' &&
      token.value === ''
    )
      throw new Error(`--${token.name} requires a nonempty value`);
  return parsed;
}

export const parseToolArgs = (name, args) => parseToolCommand(name, args).values;

/** Syntax only: required operational inputs may be omitted, and no input is resolved. */
export function parseToolHelp(name, args) {
  const positional = name === 'baseline-suite' || name === 'trace';
  const parsed = parseToolCommand(name, args, { allowPositionals: positional, help: true });
  if (positional && parsed.positionals.length) {
    const [action, ...rest] = parsed.positionals;
    const actions =
      name === 'baseline-suite'
        ? ['capture', 'compare']
        : ['list', 'show', 'spans', 'stats', 'settings', 'clear', 'flush', 'export', 'watch'];
    if (!actions.includes(action) || rest.length > (name === 'trace' && action === 'show' ? 1 : 0))
      throw new Error(`Unexpected positional arguments for ${name}: ${parsed.positionals.join(' ')}`);
  }
  return parsed;
}

export function toolOptionsHelp(name) {
  return Object.entries(TOOL_SCHEMAS[name])
    .filter(([key]) => key !== 'help')
    .map(([key, option]) => `[--${key}${option.label ? ' ' + option.label : ''}]${option.multiple ? '...' : ''}`)
    .join(' ');
}

/** Resolve inventory sources from an explicit export or the same catalogue as lifecycle commands. */
export async function inventoryInputs(options) {
  if (options.portal && (options.config || options.site))
    throw new Error('Use --portal DIR or --config FILE --site ID.');
  if (options.portal) return { sourceDir: options.portal, solutionRoots: options['solution-root'] ?? [] };
  const { loadConfig } = await import('../lense/config.mjs');
  const cfg = await loadConfig({ config: options.config, site: options.site, env: options.env, repo: options.repo });
  const { resolveSolutionRoots } = await import('./lib/solution-roots.mjs');
  const roots = await resolveSolutionRoots({
    sourceDir: cfg.sourceDir,
    catalogue: cfg.mirageConfig,
    explicitRoots: options['solution-root'],
  });
  return { sourceDir: cfg.sourceDir, solutionRoots: roots.roots, configFile: cfg.configFile };
}
