import { createSimulator } from '../server.mjs';
import { DataStore } from './data.mjs';
import { initialState } from './bootstrap.mjs';
import { applySolutionData, importSolutionData } from './solution-data.mjs';
import { migrateScenarioState } from './state-migration.mjs';
import { discoverPacks, presetLibrary, presetDescriptor } from './preset-registry.mjs';
import { activatePackDeniedRoutes } from '../parity-suite.mjs';
import { importPortal } from './importer.mjs';
import { loadConfig } from '../../lense/config.mjs';
import { loadProjectConfig, projectSummary, projectOrigin } from './project-config.mjs';
import { resolveSolutionRoots } from './solution-roots.mjs';

/** Bind trusted project packs once. No implicit adjacent module discovery. */
export async function createMirageContext({ packs = [], config, site, portal, metadata, ...options } = {}) {
  const cfg = config ? await loadConfig({ config, site }, process.env) : null;
  const project = cfg?.mirageConfig.project ? await loadProjectConfig(cfg.mirageConfig.project) : null;
  const selected = project?.portals.find(item => item.sourceDir === cfg.sourceDir) ?? project?.portals.find(item => item.id === project.defaultPortal);
  const sourceDir = selected?.sourceDir ?? cfg?.sourceDir;
  const solutionRoots = selected?.solutionRoots ?? (cfg ? (await resolveSolutionRoots({ sourceDir, catalogue: cfg.mirageConfig })).roots : []);
  const solutionOrder = project?.solutionOrder ?? cfg?.mirageConfig.solutionOrder ?? 'derived';
  const origin = project ? projectOrigin(project, selected) ?? cfg.origin : cfg?.origin;
  metadata ??= solutionRoots.length ? await importSolutionData(solutionRoots, { order: solutionOrder }) : undefined;
  portal ??= sourceDir ? await importPortal(sourceDir, { dataModel: selected?.dataModel ?? cfg.mirageConfig?.dataModel }) : undefined;
  const loaded = await discoverPacks({ portal, packs, project, explicit: cfg?.mirageConfig?.dataPacks ?? [] });
  const library = presetLibrary({ packs: loaded, portal, metadata, options });
  class BoundDataStore extends DataStore {
    constructor(settings = {}) { super({ ...settings, presetLibrary: settings.presetLibrary ?? library }); }
    applyPreset(name, settings = {}) { return super.applyPreset(name, { generatedPresets: library, ...settings }); }
  }
  return Object.freeze({
    packs: Object.freeze([...loaded]), presetLibrary: library,
    DataStore: BoundDataStore,
    createSimulator: settings => createSimulator({
      ...(cfg ? { sourceDir, origin, solutionRoots, solutionOrder, observed: selected?.observed ?? cfg.mirageConfig.observed, localOverrides: cfg.mirageConfig.localOverrides } : {}),
      ...(project ? { project: projectSummary(project, selected.id), environmentVariables: project.environmentVariables } : {}),
      ...settings, packs: loaded,
    }),
    initialState: (source = portal, settings = {}) => initialState(source, { metadata, origin, ...settings, packs: loaded }),
    applySolutionData: (state, sourceMetadata = metadata, settings = {}) => applySolutionData(state, sourceMetadata, { ...settings, presetLibrary: library }),
    migrateScenarioState: (state, settings = {}) => migrateScenarioState(state, { ...settings, presetLibrary: library }),
    discoverPacks: async () => [...loaded],
    resolvePreset: name => { if (!presetDescriptor(library, name)) throw new Error(`Unknown preset '${name}'`); return library[name]; },
    activatePackDeniedRoutes: (source = portal, settings = {}) => activatePackDeniedRoutes(source, { ...settings, boundPacks: loaded }),
  });
}
