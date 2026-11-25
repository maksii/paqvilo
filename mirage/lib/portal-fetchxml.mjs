import { DataError } from './data-error.mjs';
import { hasValidFetchTop, parseXmlDocument } from './fetchxml-engine.mjs';
import { serializePermissionFetchXml } from './permission-query.mjs';

/** Site-qualified portal authoring conversion, separate from Dataverse execution. */
export function preparePortalFetchXml(xml, { linkTypes, profile = 'webapi', dropValidTop = false } = {}) {
  const rewriteLinks = linkTypes === 'portal-classic';
  if (!rewriteLinks && !dropValidTop) return xml;
  const tree = parseXmlDocument(xml, { root: 'fetch' });
  let changed = false;
  // The observed Liquid authoring conversion discards an otherwise valid top before paging is compiled.
  if (dropValidTop && hasValidFetchTop(tree)) {
    delete tree.attrs.top;
    changed = true;
  }
  const visit = (node, parent) => {
    if (node.name === 'link-entity') {
      const type = node.attrs['link-type'];
      // This portal transport admits these authored variants as ordinary joins.
      // Do not apply this conversion to compiler-generated permission subqueries.
      if (['exists', 'in', 'matchfirstrowusingcrossapply'].includes(type)) {
        delete node.attrs['link-type'];
        changed = true;
      }
      if (parent?.name === 'filter' && ['not any', 'all', 'not all'].includes(type)) {
        if (profile === 'webapi')
          throw new DataError('Invalid link type in a FetchXML filter.', 400, 'InvalidFetchXml', {
            innerCode: '0x8004111c',
          });
        delete node.attrs['link-type'];
        changed = true;
      }
    }
    for (const child of node.children) visit(child, node);
  };
  if (rewriteLinks) visit(tree);
  return changed ? serializePermissionFetchXml(tree) : xml;
}
