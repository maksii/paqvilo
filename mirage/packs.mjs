/** Stable helpers for explicitly registered, project-owned data packs. */
export { validatePack, configurationPresetDiagnostics, discoverPacks, loadPack, presetLibrary, presetDescriptor, defineLazyPreset } from './lib/preset-registry.mjs';
export { bootstrapPresetLibrary, compactBuiltinPresets, listPresets, resolvePreset } from './lib/presets.mjs';
export { assertReadOnlyPath, DENIED_ROUTE_PATTERNS, validatePlan, activatePackDeniedRoutes } from './parity-suite.mjs';
export { validatePersonaCatalog, mergePersonaCatalogs } from './lib/persona-catalog.mjs';
