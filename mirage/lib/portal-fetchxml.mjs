import { DataError } from './data-error.mjs';
import { hasValidFetchTop, parseXmlDocument } from './fetchxml-engine.mjs';
import { serializePermissionFetchXml } from './permission-query.mjs';

/**
 * Site-qualified portal authoring conversion, separate from Dataverse execution.
 * linkTypes "portal-classic": the observed link-type fallbacks (webApiFetchXmlLinkTypes, liquidFetchXmlLinkTypes).
 * dropValidTop: the Liquid-only observed top removal (liquidFetchTop "drop-valid").
 * authoring "portal-classic" (observed portalFetchXmlAuthoring): the portal re-serialises authored FetchXML through its own
 * object model before Dataverse sees it, on Liquid and on the Web API alike. Hosted session F1 (DATA-02b, two runs, the
 * queries the recorder saw attributed by content markers) showed `rowaggregate` removed from its attribute (the attribute
 * stays with its alias), `datasource` removed from fetch (`bin` read the ordinary rows) and a valid `top` removed (top="2"
 * returned every matching row). A malformed or out-of-range top was not observed; it still fails validation.
 */
export function preparePortalFetchXml(
  xml,
  { linkTypes, profile = 'webapi', dropValidTop = false, authoring = null } = {},
) {
  const rewriteLinks = linkTypes === 'portal-classic';
  const objectModel = authoring === 'portal-classic';
  if (!rewriteLinks && !dropValidTop && !objectModel) return xml;
  const tree = parseXmlDocument(xml, { root: 'fetch' });
  let changed = false;
  // The observed Liquid authoring conversion discards an otherwise valid top before paging is compiled.
  if ((dropValidTop || objectModel) && hasValidFetchTop(tree)) {
    delete tree.attrs.top;
    changed = true;
  }
  if (objectModel && tree.attrs.datasource != null) {
    delete tree.attrs.datasource;
    changed = true;
  }
  const visit = (node, parent) => {
    if (objectModel && node.name === 'attribute' && node.attrs.rowaggregate != null) {
      delete node.attrs.rowaggregate;
      changed = true;
    }
    if (rewriteLinks && node.name === 'link-entity') {
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
  if (rewriteLinks || objectModel) visit(tree);
  return changed ? serializePermissionFetchXml(tree) : xml;
}
