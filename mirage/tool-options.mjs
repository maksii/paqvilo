import { parseArgs } from 'node:util';

const string = (label, extra = {}) => ({ type: 'string', label, ...extra });
const flag = () => ({ type: 'boolean' });
const catalogue = { config: string('FILE'), site: string('ID'), env: string('ID'), repo: string('DIR') };
/** The public help and parsers share these option tables. */
export const TOOL_OPTIONS = {
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
    from: string('TIME'),
    to: string('TIME'),
    kind: string('KIND'),
    module: string('NAME'),
    operation: string('NAME'),
    entity: string('LOGICAL_NAME'),
    'record-id': string('ID'),
    status: string('ok|error|denied|cancelled|running'),
    host: string('power-pages|standalone|model-driven|canvas|code-app|dataverse-api|tds|soap|job|sim'),
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
    utc: flag(),
    json: flag(),
    help: { ...flag(), short: 'h' },
  },
};

/** The parsed { values, positionals } of a tool that takes positional arguments (allowPositionals). */
export function parseToolCommand(name, args, { allowPositionals = false } = {}) {
  const options = Object.fromEntries(
    Object.entries(TOOL_OPTIONS[name]).map(([key, { label, ...definition }]) => [key, definition]),
  );
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : null;
    if (options[key]?.type === 'string' && (args[i + 1] == null || args[i + 1].startsWith('--')))
      throw new Error(`--${key} requires a value`);
  }
  const parsed = parseArgs({ args, options, tokens: true, allowPositionals });
  for (const token of parsed.tokens)
    if (token.kind === 'option' && options[token.name].type === 'string' && token.value === '')
      throw new Error(`--${token.name} requires a nonempty value`);
  return parsed;
}

export const parseToolArgs = (name, args) => parseToolCommand(name, args).values;

export function toolOptionsHelp(name) {
  return Object.entries(TOOL_OPTIONS[name])
    .filter(([key]) => key !== 'help')
    .map(([key, option]) => `[--${key}${option.label ? ` ${option.label}` : ''}]${option.multiple ? '...' : ''}`)
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
