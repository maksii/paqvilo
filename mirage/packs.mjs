/** Stable helpers for explicitly registered, project-owned data packs. */
export { validatePack, discoverPacks, loadPack, presetLibrary, presetDescriptor, defineLazyPreset } from './lib/preset-registry.mjs';
export { bootstrapPresetLibrary, compactBuiltinPresets, listPresets, resolvePreset } from './lib/presets.mjs';
export { assertReadOnlyPath, DENIED_ROUTE_PATTERNS, validatePlan, activatePackDeniedRoutes } from './parity-suite.mjs';
