/** Stable helpers for synthetic states and project-owned test fixtures. */
export { formatMockRecord } from './lib/data.mjs';
export { mergeDataset, findDanglingLookups } from './lib/data-generation.mjs';
export { schemaViolations, fieldIndexFromMappings, schemaFieldIndex, formatViolations } from './lib/schema-validation.mjs';
export { assertOfflineState, stateFileFingerprint } from './lib/offline-state.mjs';
export { importPortal } from './lib/importer.mjs';
export { createPortalRenderer } from './lib/liquid.mjs';
