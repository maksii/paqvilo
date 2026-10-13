import { parseArgs } from 'node:util';

const string = (label, extra = {}) => ({ type: 'string', label, ...extra });
const flag = () => ({ type: 'boolean' });
const catalogue = { config: string('FILE'), site: string('ID'), env: string('ID'), repo: string('DIR') };
/** The public help and parsers share these option tables. */
export const TOOL_OPTIONS = {
  'liquid-inventory': {
    ...catalogue, portal: string('DIR'), out: string('FILE'), json: flag(),
    'include-inactive': flag(), sources: flag(), strict: flag(), help: { ...flag(), short: 'h' },
  },
  'webapi-inventory': {
    ...catalogue, portal: string('DIR'), 'solution-root': string('DIR', { multiple: true }),
    'client-wrapper': string('NAME', { multiple: true }), json: flag(), help: { ...flag(), short: 'h' },
  },
  'render-sweep': {
    ...catalogue, source: string('DIR'), 'solution-root': string('DIR', { multiple: true }),
    project: string('FILE'), portal: string('ID'), persona: string('NAME'), preset: string('NAME'),
    state: string('FILE'), out: string('DIR'), path: string('PREFIX'), limit: string('N'),
    json: flag(), ci: flag(), strict: flag(), help: { ...flag(), short: 'h' },
  },
  'portal-matrix': {
    config: string('FILE'), project: string('FILE'), samples: string('DIR'),
    portal: string('ID', { multiple: true }), sites: string('a,b'),
    env: string('SITE=ENV', { multiple: true }), repo: string('DIR'), out: string('DIR'),
    only: string('a,b'), skip: string('a,b'), personas: string('a,b'),
    'scaffold-personas': string('a,b'), 'scaffold-profile': string('NAME'), limit: string('N'),
    path: string('PREFIX'), preset: string('PORTAL=NAME', { multiple: true }),
    'use-state': flag(), json: flag(), strict: flag(), help: { ...flag(), short: 'h' },
  },
};

export function parseToolArgs(name, args) {
  const options = Object.fromEntries(Object.entries(TOOL_OPTIONS[name]).map(([key, { label, ...definition }]) => [key, definition]));
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : null;
    if (options[key]?.type === 'string' && (args[i + 1] == null || args[i + 1].startsWith('--')))
      throw new Error(`--${key} requires a value`);
  }
  return parseArgs({ args, options }).values;
}

export function toolOptionsHelp(name) {
  return Object.entries(TOOL_OPTIONS[name]).filter(([key]) => key !== 'help')
    .map(([key, option]) => `[--${key}${option.label ? ` ${option.label}` : ''}]${option.multiple ? '...' : ''}`).join(' ');
}

/** Resolve inventory sources from an explicit export or the same catalogue as lifecycle commands. */
export async function inventoryInputs(options) {
  if (options.portal && (options.config || options.site)) throw new Error('Use --portal DIR or --config FILE --site ID.');
  if (options.portal) return { sourceDir: options.portal, solutionRoots: options['solution-root'] ?? [] };
  const { loadConfig } = await import('../lense/config.mjs');
  const cfg = await loadConfig({ config: options.config, site: options.site, env: options.env, repo: options.repo });
  const { resolveSolutionRoots } = await import('./lib/solution-roots.mjs');
  const roots = await resolveSolutionRoots({ sourceDir: cfg.sourceDir, catalogue: cfg.mirageConfig, explicitRoots: options['solution-root'] });
  return { sourceDir: cfg.sourceDir, solutionRoots: roots.roots };
}
