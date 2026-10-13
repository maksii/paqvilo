import { parseXmlDocument, xmlEscapeAttribute } from 'paqvilo/mirage/lib/fetchxml-engine.mjs';

const node = (name, attrs = {}, children = []) => ({ name, attrs, children, text: '' });
const id = value => String(value?.id ?? value ?? '').replace(/[{}]/g, '').toLowerCase();
const walk = function* (element) { yield element; for (const child of element.children) yield* walk(child); };
const filter = (children, attrs = {}) => node('filter', { type: 'and', ...attrs }, children);
const condition = (attribute, operator, value) => node('condition', { attribute, operator, ...(value != null ? { value } : {}) });
export const binaryOr = (nodes, direction = 'left') => {
  if (!nodes.length) return null;
  if (nodes.length === 1) return nodes[0];
  return direction === 'right' ? node('filter', { type: 'or' }, [nodes[0], binaryOr(nodes.slice(1), direction)])
    : nodes.slice(1).reduce((left, right) => node('filter', { type: 'or' }, [left, right]), nodes[0]);
};
export function serializeODataPermissionNode(element) {
  const attrs = Object.entries(element.attrs).map(([key, value]) => ` ${key}="${xmlEscapeAttribute(value)}"`).join('');
  return element.children.length ? `<${element.name}${attrs}>${element.children.map(serializeODataPermissionNode).join('')}</${element.name}>`
    : `<${element.name}${attrs} />`;
}

/** Diagnostic source-derived model for the witnessed Account OData filter
 * contract. This is deliberately separate from Liquid/FetchXML expansion and
 * is not used for authorization. Other parent directions/scopes stay explicit
 * unqualified cases until their actual native OData witnesses are available. */
export function buildODataPermissionFilter({ table, permissions, identity, mappings = {}, rules, grantOrder } = {}) {
  const byId = new Map(permissions.map(permission => [id(permission.id), permission]));
  const selected = (entity, operation = 'read') => rules ? rules(entity, operation, identity) : permissions.filter(permission =>
    permission.enabled !== false && permission.entity === entity && (permission.operations ?? []).includes(operation) &&
    (permission.roleIds ?? []).some(role => (identity.roleIds ?? []).map(id).includes(id(role))));
  const primary = entity => mappings[entity]?.idColumn ?? `${entity}id`;
  const diagnostics = [], results = [];
  let grants = selected(table);
  if (grantOrder) {
    const position = new Map(grantOrder.map((grant, index) => [id(grant), index]));
    if (position.size !== grantOrder.length || grants.some(grant => !position.has(id(grant.id))))
      throw new Error('An OData source-order hypothesis must contain every selected distinct grant.');
    grants = [...grants].sort((a, b) => position.get(id(a.id)) - position.get(id(b.id)));
  } else diagnostics.push({ code: 'ODATA_PERMISSION_ORDER_UNQUALIFIED', message: 'Source definition order is a hypothesis until native subset witnesses verify it.' });
  function render(grant, { anyallalias, visiting = new Set() } = {}) {
    if (visiting.has(id(grant.id))) { diagnostics.push({ code: 'ODATA_PERMISSION_CYCLE', permissionId: grant.id }); return null; }
    const currentPath = new Set([...visiting, id(grant.id)]);
    if (grant.enabled === false) return null;
    if (grant.scope === 'parent') {
      if (grant.observedOrphanParent) { diagnostics.push({ code: 'ODATA_ORPHAN_PROFILE_UNQUALIFIED', permissionId: grant.id }); return null; }
      const parent = byId.get(id(grant.parentPermissionId ?? grant.parentId));
      if (!parent || !selected(parent.entity).some(candidate => id(candidate.id) === id(parent.id))) {
        diagnostics.push({ code: 'ODATA_PARENT_READ_OR_ROLE_UNQUALIFIED', permissionId: grant.id }); return null;
      }
      const relationship = grant.relationship;
      if (relationship?.intersect) {
        const edge = relationship.intersect;
        const nested = render(parent, { anyallalias: edge.entity + '1', visiting: currentPath });
        if (!nested) return null;
        return filter([node('link-entity', { name: edge.entity, to: relationship.from, from: edge.from, 'link-type': 'any' },
          [node('link-entity', { name: relationship.entity, to: edge.to, from: relationship.to, 'link-type': 'inner' }, [nested])])]);
      }
      if (relationship?.entity === grant.entity && parent.entity === grant.entity) {
        const nested = render(parent, { anyallalias, visiting: currentPath });
        return nested ? filter([condition(relationship.from, 'not-null'), nested]) : null;
      }
      diagnostics.push({ code: 'ODATA_DIFFERENT_TABLE_PARENT_UNQUALIFIED', permissionId: grant.id }); return null;
    }
    if (grant.scope === 'global') { diagnostics.push({ code: 'ODATA_GLOBAL_SCOPE_UNQUALIFIED', permissionId: grant.id }); return null; }
    if (grant.identityRelationship) { diagnostics.push({ code: 'ODATA_IDENTITY_RELATIONSHIP_UNQUALIFIED', permissionId: grant.id }); return null; }
    const value = grant.scope === 'account' ? identity.accountId : identity.contactId ?? identity.id;
    if (!value || !['contact', 'account', 'self'].includes(grant.scope)) return null;
    if (grant.scope !== 'contact' || !anyallalias)
      diagnostics.push({ code: 'ODATA_DIRECT_OR_NONCONTACT_TERMINAL_UNQUALIFIED', permissionId: grant.id });
    return filter([condition(primary(grant.entity), 'not-null'),
      condition(grant.field ?? primary(grant.entity), 'eq', `{${id(value).toUpperCase()}}`)], anyallalias ? { anyallalias } : {});
  }
  for (const grant of grants) {
    const expression = render(grant);
    if (expression) results.push({ permissionId: grant.id, expression, xml: serializeODataPermissionNode(expression) });
  }
  const expression = binaryOr(results.map(result => result.expression));
  return { table, expression, xml: expression ? serializeODataPermissionNode(expression) : null,
    alternatives: results, diagnostics, qualification: 'diagnostic-source-model', nativeQualified: false };
}

/** Preserve actual binary tree and alternative order. Flattening is only for
 * source-path diagnostics, never the serialized query comparison. */
export function inspectNativeODataPermissionFilter(xml) {
  const fetch = parseXmlDocument(xml, { root: 'fetch' }), root = fetch.children.find(element => element.name === 'entity');
  const candidates = root.children.filter(element => element.name === 'filter');
  let expression = candidates.at(-1);
  const permissionAlias = element => [...walk(element)].some(child => child.attrs.anyallalias);
  // The witnessed OData root wraps authored and permission filters in AND.
  // Strip only that wrapper; retain Parent's lookup-not-null AND predicate.
  while (expression?.name === 'filter' && expression.attrs.type === 'and' && expression.children.length > 1 &&
      expression.children.every(child => child.name === 'filter') && permissionAlias(expression.children.at(-1)) &&
      expression.children.slice(0, -1).every(child => !permissionAlias(child))) expression = expression.children.at(-1);
  const alternatives = [];
  function visit(element) {
    if (element.name === 'filter' && element.attrs.type === 'or') { for (const child of element.children) visit(child); return; }
    alternatives.push({ expression: element, xml: serializeODataPermissionNode(element),
      links: [...walk(element)].filter(child => child.name === 'link-entity').length,
      terminalAttributes: [...walk(element)].filter(child => child.name === 'condition' && child.attrs.operator === 'eq').map(child => child.attrs.attribute) });
  }
  if (expression) visit(expression);
  return { table: root.attrs.name, fetchAttributes: fetch.attrs, expression, alternatives,
    qualification: 'one-native-query-diagnostic', nativeQualified: false };
}

/** Source-graph admission hypothesis used to choose native calibration cases.
 * It never returns an authorization decision. The documented multi-level CDS
 * issue does not justify denying every Parent permission: a single N:N Parent
 * hop and same-table Parent wrappers have actual backend witnesses. */
export function sourceODataAdmissionFeatures({ table, permissions, identity, rules } = {}) {
  const selected = entity => rules ? rules(entity, 'read', identity) : permissions.filter(permission => permission.entity === entity &&
    permission.enabled !== false && (permission.operations ?? []).includes('read') &&
    (permission.roleIds ?? []).some(role => (identity.roleIds ?? []).map(id).includes(id(role))));
  const byId = new Map(permissions.map(permission => [id(permission.id), permission]));
  const grants = selected(table), paths = [];
  for (const leaf of grants) {
    const path = { permissionId: leaf.id, parentHops: 0, intersectHops: 0, crossTableLookupHops: 0, sameTableLookupHops: 0,
      terminalScope: null, unresolved: false }, visited = new Set();
    let current = leaf;
    while (current?.scope === 'parent') {
      if (visited.has(id(current.id)) || current.observedOrphanParent) { path.unresolved = true; break; }
      visited.add(id(current.id));
      const parent = byId.get(id(current.parentPermissionId ?? current.parentId));
      if (!parent || !selected(parent.entity).some(candidate => id(candidate.id) === id(parent.id)) ||
          !current.relationship || current.relationship.entity !== parent.entity) { path.unresolved = true; break; }
      path.parentHops++;
      if (current.relationship.intersect) path.intersectHops++;
      else if (current.entity === parent.entity) path.sameTableLookupHops++;
      else path.crossTableLookupHops++;
      current = parent;
    }
    path.terminalScope = current?.scope ?? null;
    path.identityRelationship = Boolean(current?.identityRelationship);
    paths.push(path);
  }
  const global = grants.some(grant => grant.scope === 'global');
  const multiLevelCrossTable = paths.some(path => !path.unresolved && path.crossTableLookupHops > 0 && path.parentHops > 1);
  const simple = paths.length > 0 && paths.every(path => !path.unresolved &&
    ['contact', 'account', 'self', 'global'].includes(path.terminalScope) && path.crossTableLookupHops === 0 && !path.identityRelationship);
  return { table, paths, globalGrant: global, multiLevelCrossTable,
    admissionPrediction: global ? 'global-bypass-calibration-required' : multiLevelCrossTable ? 'native-cds-error-candidate'
      : simple ? 'backend-query-candidate' : 'requires-native-calibration',
    qualification: 'source-derived-hypothesis-only', nativeQualified: false,
    evidenceRequired: ['Frozen graph and actual role memberships', 'Both cache controls and two stable native repeats',
      'Correct source metadata/property authoring', 'Actual HTTP outcome and final-observer presence/absence'] };
}
