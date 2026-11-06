// Select declared local sources without loading a project module, provider or data pack.
import path from 'node:path';
import YAML from 'yaml';
import { readLocalFileSync } from '../local-file.mjs';
import { ANALYSIS_LIMITS } from './inventory.mjs';

function localProject(file) {
  try {
    const text = readLocalFileSync(file, { maxBytes: ANALYSIS_LIMITS.fileBytes, encoding: 'utf8' });
    const document = /\.json$/i.test(file) ? null : YAML.parseDocument(text, { uniqueKeys: true });
    if (document?.errors.length) throw new Error('Invalid project metadata');
    const value = document ? document.toJS({ maxAliasCount: 0 }) : JSON.parse(text);
    if (![1, 2].includes(value?.version)) throw new Error('Invalid project metadata');
    return value;
  } catch {
    throw new Error('Project metadata could not be read as a supported local project configuration.');
  }
}

function declaredPaths(values, select, add) {
  if (values === undefined) return;
  if (!Array.isArray(values)) throw new Error('Invalid source selection');
  for (const value of values) {
    const entry = select(value);
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('Invalid source selection');
    add(entry);
  }
}

/** Pure selectors plus bounded configuration reads; selected paths may be separate explicit checkouts. */
export function configuredAnalysisRoots(cfg) {
  const roots = [];
  const seen = new Set();
  const config = cfg.mirageConfig ?? {};
  const base = cfg.configDir;
  const add = (value, kind, relativeTo = base) => {
    const source = path.resolve(relativeTo, value);
    const key = process.platform === 'win32' ? source.toLowerCase() : source;
    if (seen.has(key)) return;
    if (roots.length >= ANALYSIS_LIMITS.roots) throw new Error('Too many configured source roots');
    seen.add(key);
    roots.push({ path: source, kind, id: kind + '-' + (roots.length + 1) });
  };
  if (cfg.sourceDir) add(cfg.sourceDir, cfg.analysisSourceKind ?? 'portal');
  let project = null;
  let projectBase = base;
  if (config.project) {
    project = localProject(config.project);
    if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('Invalid project metadata');
    projectBase = path.dirname(config.project);
    add(config.project, 'project');
    if (!cfg.sourceDir || cfg.analysisWholeProject)
      declaredPaths(
        project.portals,
        (entry) => (typeof entry === 'string' ? entry : (entry?.path ?? entry?.source ?? entry?.sourceDir)),
        (value) => add(value, 'portal', projectBase),
      );
    declaredPaths(
      project.solutions,
      (entry) => (typeof entry === 'string' ? entry : (entry?.path ?? entry?.source ?? entry?.root)),
      (value) => add(value, 'solution', projectBase),
    );
  } else {
    declaredPaths(
      config.solutionRoots,
      (entry) => entry,
      (value) => add(value, 'solution'),
    );
  }
  const apps = project?.codeApps ?? config.codeApps;
  declaredPaths(
    apps,
    (entry) => entry?.dir,
    (value) => add(value, 'code-app', projectBase),
  );
  const canvas = project?.canvas ?? config.canvas;
  declaredPaths(
    canvas?.sources,
    (entry) => entry,
    (value) => add(value, 'canvas', projectBase),
  );
  return roots;
}
