/** Stable helpers for synthetic states and project-owned test fixtures. */
export { formatMockRecord } from './lib/data.mjs';
export { mergeDataset, findDanglingLookups } from './lib/data-generation.mjs';
export { generateDataset } from './lib/dataset-generator.mjs';
export { summarizeDataset } from './lib/dataset-coverage.mjs';
export { comparePermissionModels } from './lib/permission-model-diff.mjs';
export { buildPermissionModel } from './lib/permissions.mjs';
export { remapDatasetIdentities } from './lib/dataset-identities.mjs';
export { comparePluginRegistrations } from './lib/plugin-registration-diff.mjs';
export { parsePluginDocument, importSolutionPlugins } from './lib/exported-plugins.mjs';
export { generateSchemaDeclarations } from './lib/schema-declarations.mjs';
export { inspectFlowExpression, evaluateFlowTriggerConditions } from './lib/flow-runtime.mjs';
export {
  schemaViolations,
  fieldIndexFromMappings,
  schemaFieldIndex,
  formatViolations,
} from './lib/schema-validation.mjs';
export { assertOfflineState, stateFileFingerprint } from './lib/offline-state.mjs';
export { readStateFile } from './lib/state-storage.mjs';
export { importPortal } from './lib/importer.mjs';
export { createPortalRenderer } from './lib/liquid.mjs';
