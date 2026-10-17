export { runAcceptance } from './acceptance.mjs';
export { simulatorBackgroundRequest } from './lib/simulator-background-requests.mjs';
export { verifyParity } from './verify.mjs';
export { compareReferenceContracts } from './reference-parity.mjs';
export * from './lib/browser-launch.mjs';
export * from './lib/evidence.mjs';
export * from './lib/request-evidence.mjs';
export * from './lib/native-network-baseline.mjs';
export * from './lib/navigation-observations.mjs';
export { AssetCache } from './lib/asset-cache.mjs';
export { validateLivePath, decodePagingCookie } from './lib/live.mjs';
export { collectFetchXmlPages, escapeXmlAttribute } from './lib/paging-validation.mjs';
export { auditQuery } from './lib/audit-log.mjs';
export { richTextBody, resolveRichTextMode, settleHostModal, editRichText, assertRichText } from './lib/richtext-actions.mjs';

// Read-only baseline building blocks for project-owned observation tools.
export { extractManagedRichTextControls } from './lib/richtext-assets.mjs';
export { findRichTextResource, validateRichTextConfiguration } from './lib/richtext-config.mjs';
