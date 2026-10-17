import path from 'node:path';
import { loadCatalogue, loadConfig, resolveMirageConfig } from './config.mjs';
import { resolveSolutionRoots } from '../mirage/lib/solution-roots.mjs';
import { loadProjectConfig, projectStateFile } from '../mirage/lib/project-config.mjs';
import { DEFAULT_PORT, miragePaths } from './commands/mirage.mjs';

/** JSON-safe resolved paths and provenance; no browser discovery or credentials. */
export async function resolveCatalogue(options = {}, processEnv = process.env) {
  const catalogue = loadCatalogue(options, processEnv), sites = [];
  for (const [name, site] of Object.entries(catalogue.sites)) {
    if (options.site && options.site !== name) continue;
    const cfg = await loadConfig({ ...options, site: name }, processEnv, { checkSource: false });
    const mirage = resolveMirageConfig(site.mirage, {...catalogue,sourceDir:cfg.sourceDir});
    const project = mirage.project ? await loadProjectConfig(mirage.project) : null;
    const portal = project?.portals.find(portal => portal.sourceDir === cfg.sourceDir) ?? project?.portals.find(portal => portal.id === project.defaultPortal);
    const roots = project ? portal.solutionRoots : (await resolveSolutionRoots({ sourceDir: cfg.sourceDir, catalogue: mirage })).roots;
    const stateRoot = miragePaths(cfg).discoveryRoot;
    sites.push({ name, sourceDir: portal?.sourceDir ?? cfg.sourceDir, solutionRoots: roots,
      mirage: { port: mirage.port ?? DEFAULT_PORT, stateFile: project ? projectStateFile(project, portal.id, path.join(stateRoot, 'projects')) : path.join(stateRoot, name, 'state.json') },
      provenance: { ...catalogue.provenance.sites[name], ...(project ? { sourceDir: 'Mirage project', solutionRoots: 'Mirage project', stateFile: 'Mirage project' } : {}) },
    });
  }
  return { schemaVersion: 1, configFile: catalogue.configFile, sourceRoot: catalogue.sourceRoot, provenance: { sourceRoot: catalogue.provenance.sourceRoot }, sites };
}
