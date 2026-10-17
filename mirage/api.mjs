/** Stable programmatic surface. See docs/public-api.md for compatibility policy. */
export { createSimulator } from './server.mjs';
export { DataStore, DataError } from './lib/data.mjs';
export { readStateFile } from './lib/state-storage.mjs';
export { initialState } from './lib/bootstrap.mjs';
export { discoverSolutionRoots, resolveSolutionRoots } from './lib/solution-roots.mjs';
export { importSolutionData, applySolutionData } from './lib/solution-data.mjs';
export { migrateScenarioState } from './lib/state-migration.mjs';
export { discoverPacks, loadPack, presetLibrary } from './lib/preset-registry.mjs';
export { createMirageContext } from './lib/mirage-context.mjs';
