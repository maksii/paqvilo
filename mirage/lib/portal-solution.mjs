import { child, childText, descendants, parseSolutionXml } from './solution-xml.mjs';

export function enhancedPortalRecords(xml, name) {
  const root = parseSolutionXml(xml);
  return root.name === name ? [root] : descendants(root, name);
}

export function enhancedSiteLookup(record) {
  const lookup = child(record, 'powerpagesiteid');
  return childText(lookup, 'powerpagesiteid') || lookup?.text.trim();
}

export function assertSingleEnhancedSite(sourceDir, ids) {
  const unique = new Set(
    ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim().replace(/[{}]/g, '').toLowerCase()),
  );
  if (unique.size > 1) {
    const error = new Error(
      `The enhanced Solution at ${sourceDir} contains records for multiple Power Pages sites. Use an unpacked Solution containing only the intended site.`,
    );
    error.code = 'AMBIGUOUS_PORTAL_SITE';
    throw error;
  }
}
