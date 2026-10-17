import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { DataStore } from './data.mjs';
import { initialState } from './bootstrap.mjs';
import { applySolutionData, importSolutionData } from './solution-data.mjs';
import { migrateScenarioState } from './state-migration.mjs';
import { discoverPacks, presetLibrary, presetDescriptor, packModules } from './preset-registry.mjs';
import { activatePackDeniedRoutes } from '../parity-suite.mjs';
import { importPortal } from './importer.mjs';
import { loadConfig } from '../../lense/config.mjs';
import { loadProjectConfig, projectSummary, projectOrigin } from './project-config.mjs';
import { resolveSolutionRoots } from './solution-roots.mjs';
import { fileURLToPath } from 'node:url';
import { loadCatalogue, resolveMirageConfig } from '../../lense/config.mjs';
import { resolveDeploymentProfiles, loadDeploymentProfiles } from './deployment-profiles.mjs';

/** Bind trusted project packs once. No implicit adjacent module discovery. */
export async function createMirageContext({ packs = [], config, site, portal, metadata, ...options } = {}) {
  if (config instanceof URL) config = fileURLToPath(config);
  // A catalogue without a selected site is a pack binding for project tests. Do not
  // import an arbitrary default portal or require its checkout to exist.
  const allEntries = [];
  if (config && site === undefined) {
    const catalogue = loadCatalogue({ config }, process.env);
    for (const settings of Object.values(catalogue.sites)) {
      const mirage = resolveMirageConfig(settings.mirage, catalogue);
      allEntries.push(...mirage.dataPacks);
      if (mirage.project) {
        const project = await loadProjectConfig(mirage.project);
        allEntries.push(...await packModules({ project }));
      }
    }
  }
  const cfg = config && site !== undefined ? await loadConfig({ config, site }, process.env) : null;
  const project = cfg?.mirageConfig.project ? await loadProjectConfig(cfg.mirageConfig.project) : null;
  const selected = project?.portals.find(item => item.sourceDir === cfg.sourceDir) ?? project?.portals.find(item => item.id === project.defaultPortal);
  const sourceDir = selected?.sourceDir ?? cfg?.sourceDir;
  const solutionRoots = selected?.solutionRoots ?? (cfg ? (await resolveSolutionRoots({ sourceDir, catalogue: cfg.mirageConfig })).roots : []);
  const solutionOrder = project?.solutionOrder ?? cfg?.mirageConfig.solutionOrder ?? 'derived';
  const configuredOrigin = project ? projectOrigin(project, selected) ?? cfg.origin : cfg?.origin;
  // A local-only catalogue target is not a live reference (same rule as mirage/cli.mjs).
  const origin = /^https:\/\//i.test(configuredOrigin ?? '') ? configuredOrigin : null;
  metadata ??= solutionRoots.length ? await importSolutionData(solutionRoots, { order: solutionOrder }) : undefined;
  const profileConfig = resolveDeploymentProfiles(cfg?.mirageConfig.deploymentProfiles ?? selected?.deploymentProfiles);
  if (selected?.deploymentProfile && Object.keys(profileConfig.profiles).length) throw new Error('Use deploymentProfiles or legacy deploymentProfile, not both.');
  const activeProfiles = sourceDir ? await loadDeploymentProfiles(profileConfig) : null;
  portal ??= sourceDir ? await importPortal(sourceDir, { deploymentProfile: activeProfiles.pagesFile ? activeProfiles.profile : selected?.deploymentProfile, deploymentProfileFile: activeProfiles.pagesFile, dataModel: selected?.dataModel ?? cfg.mirageConfig?.dataModel }) : undefined;
  const loaded = await discoverPacks({ portal, packs, project, explicit: cfg?.mirageConfig?.dataPacks ?? allEntries });
  const library = presetLibrary({ packs: loaded, portal, metadata, options });
  class BoundDataStore extends DataStore {
    constructor(settings = {}) { super({ platform: cfg?.mirageConfig.platform ?? selected?.platform, ...settings, presetLibrary: settings.presetLibrary ?? library }); }
    applyPreset(name, settings = {}) { return super.applyPreset(name, { generatedPresets: library, ...settings }); }
  }
  return Object.freeze({
    packs: Object.freeze([...loaded]), presetLibrary: library,
    DataStore: BoundDataStore,
    createSimulator: settings => createSimulator({
      platform: cfg?.mirageConfig.platform ?? selected?.platform,
      render: cfg?.mirageConfig.render,
      dataModel: selected?.dataModel ?? cfg?.mirageConfig.dataModel,
      contentPolicyDefaults:{...selected,...cfg?.mirageConfig},
      personaContexts: cfg?.mirageConfig.personaContexts,
      identityProvider: cfg?.mirageConfig.identityProvider,
      ...(cfg?.configFile?{projectRoot:path.dirname(cfg.configFile)}:{}),
      ...(cfg ? { sourceDir, origin, solutionRoots, solutionOrder, deploymentProfile: selected?.deploymentProfile, deploymentProfiles: profileConfig, observed: selected?.observed ?? cfg.mirageConfig.observed, localOverrides: cfg.mirageConfig.localOverrides } : {}),
      ...(project ? { project: projectSummary(project, selected.id), environmentVariables: project.environmentVariables } : {}),
      ...settings, packs: loaded,
      ...(settings?.sourceDir === undefined && settings?.solutionRoots === undefined && portal ? {importedSources:{sourceDir,portal,solutionData:metadata,solutionRoots,solutionOrder,pagesFile:activeProfiles?.pagesFile,deploymentProfile:selected?.deploymentProfile,dataModel:selected?.dataModel ?? cfg?.mirageConfig.dataModel}} : {}),
    }),
    initialState: (source = portal, settings = {}) => initialState(source, { metadata, origin, platform: cfg?.mirageConfig.platform ?? selected?.platform, ...settings, packs: loaded }),
    applySolutionData: (state, sourceMetadata = metadata, settings = {}) => applySolutionData(state, sourceMetadata, { ...settings, presetLibrary: library }),
    migrateScenarioState: (state, settings = {}) => migrateScenarioState(state, { ...settings, presetLibrary: library }),
    discoverPacks: async () => [...loaded],
    resolvePreset: name => { if (!presetDescriptor(library, name)) throw new Error(`Unknown preset '${name}'`); return library[name]; },
    activatePackDeniedRoutes: (source = portal, settings = {}) => activatePackDeniedRoutes(source, { ...settings, boundPacks: loaded }),
  });
}
