import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { discoverSolutionTrees, scanSolutionSources } from './solution-schema.mjs';
import { INVENTORY_TREE_DIRS } from './solution-inventory.mjs';

/**
 * Discover unpacked Dataverse solution repositories next to a portal source.
 *
 * Starting at the Git repository that contains the portal export, every sibling
 * directory that holds an unpacked solution (Other/Solution.xml at its root or one
 * level below) is a candidate root. Nothing depends on repository names. The roots
 * are returned in the derived layer order: a root that exports the full definition
 * of a table (primary key and standard system columns) precedes roots that export
 * only columns of that table; independent roots keep name order. An explicit order
 * (CLI --solution-root or project configuration) always replaces this discovery.
 */
export async function discoverSolutionRoots(sourceDir, { cacheFile, diagnostics } = {}) {
  let current = path.resolve(sourceDir);
  while (true) {
    try {
      await fs.stat(path.join(current, '.git'));
      break;
    } catch {
      /* This ancestor is not a readable repository root; continue upward. */
    }
    const parent = path.dirname(current);
    if (parent === current) return [];
    current = parent;
  }
  const container = path.dirname(current);
  // The portal's own repository is skipped even when it is reached through another
  // spelling (junction, symbolic link or Windows 8.3 short name).
  const canonical = (dir) => fs.realpath(dir).catch(() => dir);
  const own = await canonical(current);
  let siblings;
  try {
    siblings = await fs.readdir(container, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = [];
  for (const entry of siblings
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const candidate = path.join(container, entry.name);
    if (candidate === current || (await canonical(candidate)) === own) continue;
    if ((await discoverSolutionTrees(candidate)).length) roots.push(candidate);
  }
  if (roots.length < 2) return roots;
  // Programmatic discovery without an explicit project cache stays read-only.
  const scan = await scanSolutionSources(roots, { cacheFile, order: 'derived' });
  await scan.cache.save({ prune: false });
  diagnostics?.push(...scan.diagnostics.filter((d) => d.code === 'SOLUTION_ORDER_CYCLE'));
  const ordered = [];
  for (const layer of scan.layers) if (!ordered.includes(layer.input)) ordered.push(layer.input);
  return ordered;
}

/**
 * Solution roots of a run, resolved alike by `serve`, `bootstrap-report` and project-less
 * tools: explicit --solution-root values, else the catalogue site's mirage
 * `solutionRoots`, else roots discovered next to the portal repository. The roots are a
 * set layered in derived order (definition before extension, independent roots by name)
 * unless the order is explicitly requested (`--solution-order explicit`, or the
 * catalogue site's `solutionOrder: explicit`), which keeps the listed order.
 */
export async function resolveSolutionRoots({ sourceDir, explicitRoots, explicitOrder, catalogue, cacheFile } = {}) {
  if (explicitOrder !== undefined && !['derived', 'explicit'].includes(explicitOrder))
    throw new Error('--solution-order must be derived or explicit');
  if (explicitRoots?.length)
    return {
      roots: explicitRoots.map((root) => path.resolve(root)),
      order: explicitOrder === 'explicit' ? 'explicit' : 'derived',
      source: 'cli',
    };
  if (catalogue?.solutionRoots?.length)
    return {
      roots: catalogue.solutionRoots.map((root) => path.resolve(root)),
      order: catalogue.solutionOrder === 'explicit' ? 'explicit' : 'derived',
      source: 'catalogue',
    };
  return { roots: await discoverSolutionRoots(sourceDir, { cacheFile }), order: 'derived', source: 'discovered' };
}

// Imported metadata folders, the listed inventory folders (solution-inventory.mjs) and a YAML repository's `solutions` folder.
const RELEVANT_TREE_NAMES = new Set([
  'appmodules',
  'appmodulesitemaps',
  'sitemaps',
  'entities',
  'formulas',
  'entityrelationships',
  'other',
  'optionsets',
  'environmentvariabledefinitions',
  'controls',
  'webresources',
  'appactions',
  'workflows',
  'powerpagecomponents',
  'pluginassemblies',
  'plugintypes',
  'sdkmessageprocessingsteps',
  'sdkmessages',
  'solutions',
  ...INVENTORY_TREE_DIRS,
]);
const RELEVANT_TREE_DIRS = { test: (name) => RELEVANT_TREE_NAMES.has(String(name).toLowerCase()) };
const SKIPPED = /(?:^|[\\/])(?:\.git|\.portalconfig|node_modules|bin|obj|\.paqvilo)(?:[\\/]|$)/i;

/**
 * chokidar `ignored` predicate limiting solution watching to metadata and declared runtime sources:
 * inside a known solution tree Entities, Other, OptionSets, environment variables,
 * Controls and Workflows; elsewhere under a root only
 * candidate solution directories and their Other/Solution.xml (new layers).
 */
export function solutionWatchFilter({ sourceDir, roots = [], layers = [], exclude = [] }) {
  const sep = path.sep;
  const key = (value) => path.resolve(value).toLowerCase();
  // chokidar reports paths in the spelling a root was given (for example a Windows
  // 8.3 short name), while scanned layer directories are real (long) paths. Every
  // prefix is therefore matched in both spellings.
  const real = (value) => {
    try {
      return fsSync.realpathSync.native(path.resolve(value));
    } catch {
      return path.resolve(value);
    }
  };
  const spellings = (value) => [...new Set([key(value), key(real(value))])];
  const rootPairs = roots.map((root) => ({ given: path.resolve(root), real: real(root) }));
  const treeKeys = [];
  for (const layer of layers.filter((item) => item.type === 'directory')) {
    treeKeys.push(...spellings(layer.dir));
    for (const pair of rootPairs) {
      const relative = path.relative(pair.real, path.resolve(layer.dir));
      const inside = relative !== '..' && !relative.startsWith('..' + sep) && !path.isAbsolute(relative);
      if (inside) treeKeys.push(key(path.join(pair.given, relative)));
    }
  }
  const sources = sourceDir ? spellings(sourceDir) : [];
  const rootKeys = roots.flatMap(spellings);
  // Runtime output (state, caches) never triggers a source reload.
  const excluded = exclude.filter(Boolean).flatMap(spellings);
  const within = (full, dir) => full === dir || full.startsWith(dir + sep);
  // Tool and build directories are skipped below a watched base, never because an
  // ancestor of the base carries such a name (for example a checkout under .paqvilo).
  const skipped = (full, base) => SKIPPED.test(full.slice(base.length));
  return (candidate, stats) => {
    const full = key(candidate);
    if (excluded.some((dir) => within(full, dir))) return true;
    const source = sources.find((dir) => within(full, dir));
    if (source) return skipped(full, source);
    const tree = treeKeys.filter((dir) => within(full, dir)).sort((a, b) => b.length - a.length)[0];
    if (tree) {
      if (full === tree) return false;
      if (skipped(full, tree)) return true;
      const segments = full.slice(tree.length + 1).split(sep);
      if (!RELEVANT_TREE_DIRS.test(segments[0])) return true;
      return (
        Boolean(stats?.isFile()) &&
        !(
          /^(?:controls|webresources)$/i.test(segments[0])
            ? /\.(?:xml|json|js|css|resx|png|jpe?g|svg|woff2?)$/i
            : /^(?:powerpagecomponents)$/i.test(segments[0])
              ? /\.(?:xml|js|sl)$/i
              : /\.(?:xml|json|ya?ml)$/i
        ).test(full)
      );
    }
    const root = rootKeys.find((dir) => within(full, dir));
    if (!root) return false;
    if (full === root) return false;
    if (skipped(full, root)) return true;
    const segments = full.slice(root.length + 1).split(sep);
    if (segments.length === 1) return Boolean(stats?.isFile());
    if (segments.length === 2) return !/^other$/i.test(segments[1]);
    if (segments.length === 3) return !(/^other$/i.test(segments[1]) && /^solution\.xml$/i.test(segments[2]));
    return true;
  };
}
