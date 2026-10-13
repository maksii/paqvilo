import { DataError } from './data-error.mjs';
import { parseXmlDocument, xmlEscapeAttribute } from './fetchxml-engine.mjs';
import { permissionOrderGraphFingerprint } from './permission-query.mjs';
import { parseODataExpression } from './odata-query.mjs';
import { isExactNumeric } from './exact-numeric.mjs';

const key = value => String(value?.id ?? value ?? '').replace(/[{}]/g, '').toLowerCase();
const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const node = (name, attrs = {}, children = []) => ({ name, attrs, children, text: '' });
const filter = (children, attrs = {}) => node('filter', { type: 'and', ...attrs }, children);
const condition = (attribute, operator, value) => node('condition', { attribute, operator, ...(value != null ? { value } : {}) });
const walk = function* (element) { yield element; for (const child of element.children) yield* walk(child); };
const fail = message => { throw new DataError(message, 501, 'ODataPermissionQueryUnsupported'); };
const binaryOr = nodes => nodes.slice(1).reduce((left, right) => node('filter', { type: 'or' }, [left, right]), nodes[0]);
const braced = value => {
  if (!guid.test(key(value))) fail('A scoped OData identity must have an actual GUID.');
  return `{${key(value).toUpperCase()}}`;
};

/** Structural calibration features, not an authorization or admission result.
 * The documented multi-level CDS limitation must be evidenced independently of
 * the successful single-intersect conversion before a caller enables a fault. */
export function odataPermissionPathFeatures({ table, permissions = [], identity = {}, rules } = {}) {
  const roleIds = new Set((identity.roleIds ?? []).map(key)), roles = new Set(identity.roles ?? []);
  const selected = entity => rules ? rules(entity, 'read', identity) : permissions.filter(grant =>
    grant.enabled !== false && (grant.entity === entity || grant.entity === '*') && (grant.operations ?? ['read']).includes('read') &&
    (identity.roleSource === 'memberships' && (grant.imported || grant.roleIds?.length)
      ? (grant.roleIds ?? []).some(role => roleIds.has(key(role))) : !grant.roles?.length || grant.roles.some(role => roles.has(role))));
  const byId = new Map(permissions.map(grant => [key(grant.id), grant])), grants = selected(table), paths = [];
  for (const leaf of grants) {
    const path = { permissionId: key(leaf.id), parentHops: 0, intersectHops: 0, crossTableLookupHops: 0,
      sameTableLookupHops: 0, terminalScope: null, identityRelationship: false, unresolved: false };
    let current = leaf;
    const seen = new Set();
    while (current?.scope === 'parent') {
      if (seen.has(key(current.id)) || seen.size >= 64 || current.observedOrphanParent) { path.unresolved = true; break; }
      seen.add(key(current.id));
      const parent = byId.get(key(current.parentPermissionId ?? current.parentId)), relation = current.relationship;
      if (!parent || !selected(parent.entity).some(grant => key(grant.id) === key(parent.id)) ||
          relation?.entity !== parent.entity || !relation.from || !relation.to) { path.unresolved = true; break; }
      path.parentHops++;
      if (relation.intersect) path.intersectHops++;
      else if (current.entity === parent.entity) path.sameTableLookupHops++;
      else path.crossTableLookupHops++;
      current = parent;
    }
    path.terminalScope = current?.scope ?? null; path.identityRelationship = Boolean(current?.identityRelationship);
    paths.push(path);
  }
  return { table, paths, globalGrant: grants.some(grant => (grant.scope ?? 'global') === 'global'),
    multiLevelCrossTable: paths.some(path => !path.unresolved && path.parentHops > 1 && path.crossTableLookupHops > 0),
    qualification: 'source-calibration-features-only', nativeQualified: false };
}

/** OData's received FetchExpression has a separate compact XmlWriter contract.
 * Attribute insertion order is significant and must not use Liquid's serializer. */
export function serializeODataPermissionQuery(element) {
  const attrs = Object.entries(element.attrs).map(([name, value]) => ` ${name}="${xmlEscapeAttribute(value)}"`).join('');
  const text = String(element.text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return element.children.length || text ? `<${element.name}${attrs}>${text}${element.children.map(serializeODataPermissionQuery).join('')}</${element.name}>`
    : `<${element.name}${attrs} />`;
}

/** Convert authored OR terms to the witnessed right-nested OData writer tree. Routing through
 * QueryExpression introduces its independent 16-level SDK execution bound and
 * would reject valid, actually witnessed eighteen-term OData filters. */
export function authoredScalarODataFetch(table, params, { resolveAttribute } = {}) {
  const p = params instanceof URLSearchParams ? Object.fromEntries(params) : params;
  if (Object.keys(p).some(name => !['$select', '$filter', '$orderby', '$count'].includes(name)))
    fail('This scalar OData authoring adapter requires separately qualified top, navigation or continuation support.');
  const logical = value => {
    if (typeof value !== 'string' || !/^[_a-z][\w]*$/i.test(value)) fail('OData source columns must be scalar entity properties.');
    return resolveAttribute ? resolveAttribute(table, value) : value;
  };
  const expression = (ast, depth = 0) => {
    if (depth > 128) fail('OData boolean expression exceeds the bounded native conversion depth.');
    if (ast.type === 'or') return node('filter', { type: 'or' }, ast.left.type === 'or'
      ? [expression(ast.right, depth + 1), expression(ast.left, depth + 1)]
      : [expression(ast.left, depth + 1), expression(ast.right, depth + 1)]);
    if (ast.type === 'and') return node('filter', { type: 'and' }, [expression(ast.left, depth + 1), expression(ast.right, depth + 1)]);
    if (ast.type !== 'compare' || ast.left.type !== 'path' || ast.left.segments.length !== 1 || ast.right.type !== 'literal')
      fail('This scalar OData conversion requires a direct property/literal comparison.');
    const value = ast.right.value, operator = value === null ? ({ eq: 'null', ne: 'not-null' }[ast.op])
      : ({ eq: 'eq', ne: 'ne', gt: 'gt', ge: 'ge', lt: 'lt', le: 'le' }[ast.op]);
    if (!operator) fail('Unsupported scalar OData comparison.');
    return condition(logical(ast.left.segments[0]), operator, value === null ? undefined
      : ast.right.kind === 'guid' ? braced(value) : isExactNumeric(value) ? value.value : value);
  };
  const attrs = p.$select ? String(p.$select).split(',').map(value => node('attribute', { name: logical(value.trim()) })) : [node('all-attributes')];
  let authoredFilter = p.$filter ? expression(parseODataExpression(p.$filter)) : null;
  if (authoredFilter && authoredFilter.name !== 'filter') authoredFilter = filter([authoredFilter]);
  const orders = p.$orderby ? String(p.$orderby).split(',').map(value => {
    const match = /^\s*([_a-z][\w]*)(?:\s+(asc|desc))?\s*$/i.exec(value);
    if (!match) fail('Unsupported scalar OData order expression.');
    return node('order', { attribute: logical(match[1]), descending: match[2]?.toLowerCase() === 'desc' ? 'true' : 'false' });
  }) : [];
  return serializeODataPermissionQuery(node('fetch', {}, [node('entity', { name: table }, [...attrs, ...(authoredFilter ? [authoredFilter] : []), ...orders])]));
}

/** Construct the bounded, witnessed scalar OData query contract. The caller
 * supplies authored OData converted to an unexpanded Fetch AST. This compiler
 * never accepts a captured full query or a business-case response lookup.
 * Different-table Parent/identity traversal remains unsupported until its
 * native conversion and admission have independent evidence. */
export function compileODataPermissionQuery(authoredXml, {
  permissions = [], identity = {}, mappings = {}, rules, grantOrder,
  pageInfo = {}, returnTotal = true, bypass = false, resolveAttribute, columnType,
  sameTableParentAnchor,
} = {}) {
  const authored = parseXmlDocument(authoredXml, { root: 'fetch' });
  const root = authored.children.find(child => child.name === 'entity');
  if (!root || authored.children.filter(child => child.name === 'entity').length !== 1) fail('OData requires exactly one root entity.');
  if (authored.attrs.aggregate != null || authored.attrs.top != null || [...walk(root)].some(child => child.name === 'link-entity'))
    fail('OData aggregate, top and authored navigation conversions require a separately qualified adapter.');
  const table = root.attrs.name, mapping = mappings[table] ?? {};
  const primary = entity => mappings[entity]?.idColumn ?? `${entity}id`;
  const availableRoles = new Set(identity.roles ?? []), availableIds = new Set((identity.roleIds ?? []).map(key));
  const selected = entity => rules ? rules(entity, 'read', identity) : permissions.filter(grant =>
    grant.enabled !== false && (grant.entity === entity || grant.entity === '*') &&
    (grant.operations ?? ['read']).includes('read') &&
    (identity.roleSource === 'memberships' && (grant.imported || grant.roleIds?.length)
      ? (grant.roleIds ?? []).some(role => availableIds.has(key(role)))
      : !grant.roles?.length || grant.roles.some(role => availableRoles.has(role))));
  const byId = new Map(permissions.map(grant => [key(grant.id), grant]));
  let grants = selected(table);
  const global = bypass || identity.admin || grants.some(grant => (grant.scope ?? 'global') === 'global');
  if (!global && !grants.length) throw new DataError(`Table permission denies read on ${table}`, 403, 'PermissionDenied');
  if (grantOrder && !global) {
    if (grantOrder.normalizedGraphHash !== permissionOrderGraphFingerprint(permissions))
      throw new DataError('Observed OData permission order does not match the current source graph.', 501, 'PermissionGrantOrderUnqualified');
    const groups = grantOrder.tables?.[table];
    const ranks = new Map((groups ?? []).flatMap((group, index) => group.map(id => [key(id), index])));
    if (grants.some(grant => !ranks.has(key(grant.id))))
      throw new DataError('Observed OData order does not cover every selected grant.', 501, 'PermissionGrantOrderUnqualified');
    grants = [...grants].sort((left, right) => ranks.get(key(left.id)) - ranks.get(key(right.id)));
  } else if (!global && grants.length > 1)
    throw new DataError('Multiple OData grants require their own observed source order.', 501, 'PermissionGrantOrderUnqualified');

  const generated = new Set(), aliasFilters = new Set(), terminalConditions = [], paths = [], diagnostics = [];
  function render(grant, anyallalias, visiting = new Set()) {
    if (visiting.has(key(grant.id)) || visiting.size >= 64) fail('Cyclic or excessive OData permission parent path.');
    const visited = new Set([...visiting, key(grant.id)]);
    if (grant.enabled === false || grant.observedOrphanParent) fail('Inactive/orphan OData parent conversion requires native evidence.');
    if (grant.scope === 'parent') {
      const parent = byId.get(key(grant.parentPermissionId ?? grant.parentId));
      const relation = grant.relationship;
      if (!parent || !selected(parent.entity).some(candidate => key(candidate.id) === key(parent.id)) ||
          !relation?.entity || relation.entity !== parent.entity || !relation.from || !relation.to)
        fail('OData parent permission has no complete enabled Read path for this identity.');
      if (relation.intersect) {
        const edge = relation.intersect;
        if (!edge.entity || !edge.from || !edge.to) fail('OData permission intersect metadata is incomplete.');
        const nested = render(parent, edge.entity + '1', visited);
        const parentLink = node('link-entity', { name: relation.entity, to: edge.to, from: relation.to, 'link-type': 'inner' }, [nested]);
        const intersection = node('link-entity', { name: edge.entity, to: relation.from, from: edge.from, 'link-type': 'any' }, [parentLink]);
        generated.add(intersection); generated.add(parentLink);
        return filter([intersection]);
      }
      if (grant.entity === parent.entity) {
        if (sameTableParentAnchor !== 'shared-root') fail('Same-table Parent OData anchor behavior requires an explicit evidenced profile.');
        return filter([condition(relation.from, 'not-null'), render(parent, anyallalias, visited)]);
      }
      fail('Different-table Parent OData conversion and its CDS admission require native qualification.');
    }
    if (grant.scope === 'global' || grant.identityRelationship || !['contact', 'account', 'self'].includes(grant.scope))
      fail('This terminal OData scope/direction requires a separately qualified conversion.');
    const value = grant.scope === 'account' ? identity.accountId : identity.contactId ?? identity.id;
    if (!value) fail('OData permission terminal has no applicable identity GUID.');
    const field = grant.field ?? primary(grant.entity);
    const terminals = [condition(primary(grant.entity), 'not-null'), condition(field, 'eq', braced(value))];
    terminalConditions.push(...terminals.map(terminal => ({ ...terminal.attrs })));
    // Only Contact scoped terminals inside N:N paths have independent native
    // conversion evidence so far. Other classic scopes need calibration.
    if (grant.scope !== 'contact' || !anyallalias) diagnostics.push({ code: 'ODATA_TERMINAL_CONTRACT_UNQUALIFIED', permissionId: grant.id });
    const expression = filter(terminals, anyallalias ? { anyallalias } : {});
    if (anyallalias) aliasFilters.add(expression);
    return expression;
  }

  const logical = attribute => resolveAttribute ? resolveAttribute(table, attribute) : attribute;
  function normalize(element, preserveFilter = false) {
    const copy = node(element.name, { ...element.attrs }, element.children.map(child => normalize(child)));
    copy.text = element.name === 'value' || element.text?.trim() ? element.text ?? '' : '';
    if (copy.attrs.attribute) copy.attrs.attribute = logical(copy.attrs.attribute);
    if (copy.name === 'attribute') copy.attrs.name = logical(copy.attrs.name);
    if (copy.name === 'condition' && copy.attrs.value != null && guid.test(key(copy.attrs.value)) &&
        (copy.attrs.attribute === (mapping.idColumn ?? primary(table)) || ['guid', 'lookup'].includes(columnType?.(table, copy.attrs.attribute))))
      copy.attrs.value = braced(copy.attrs.value);
    if (copy.name === 'filter' && copy.children.length === 1 && !preserveFilter) return copy.children[0];
    return copy;
  }
  const attrs = root.children.filter(child => ['attribute', 'all-attributes'].includes(child.name)).map(child => normalize(child));
  const filters = root.children.filter(child => child.name === 'filter').map(child => normalize(child, true));
  const authoredFilter = filters.length > 1 ? filter(filters) : filters[0];
  const alternatives = global ? [] : grants.map(grant => {
    const expression = render(grant);
    paths.push({ permissionId: key(grant.id), expression });
    return expression;
  });
  const permissionFilter = alternatives.length ? binaryOr(alternatives) : null;
  const rootFilter = permissionFilter ? filter([...(authoredFilter ? [authoredFilter] : []), permissionFilter]) : authoredFilter;
  const orders = root.children.filter(child => child.name === 'order').map(child => {
    const order = normalize(child); order.attrs.descending ??= 'false'; return order;
  });
  const count = Number(pageInfo.count ?? authored.attrs.count ?? 5000), page = Number(pageInfo.pageNumber ?? authored.attrs.page ?? 1);
  if (!Number.isSafeInteger(count) || count < 1 || count > 5000 || !Number.isSafeInteger(page) || page < 1)
    fail('OData native page/count metadata is outside the qualified bounds.');
  const fetch = node('fetch', { distinct: 'false', useraworderby: 'true', 'no-lock': 'false', mapping: 'logical',
    page: String(page), count: String(count), returntotalrecordcount: returnTotal ? 'true' : 'false' }, [
    node('entity', { name: table }, [...attrs, ...(rootFilter ? [rootFilter] : []), ...orders])]);
  if (pageInfo.pagingCookie) fail('OData continuation-cookie conversion requires its native adapter.');
  const allLinks = [...walk(fetch)].filter(child => child.name === 'link-entity');
  const allFilters = [...walk(fetch)].filter(child => child.name === 'filter');
  return { xml: serializeODataPermissionQuery(fetch), authoredXml, table, transport: 'source-derived-scalar-odata',
    permissionGranted: global || alternatives.length > 0, globalPermissionGranted: global,
    authoredLinkCount: 0, permissionLinkCount: generated.size, totalLinkCount: generated.size,
    generatedLinkOrdinals: allLinks.flatMap((link, index) => generated.has(link) ? [index] : []), generatedLinkAliases: [],
    generatedAnyAllAliases: allFilters.flatMap((element, filterOrdinal) => aliasFilters.has(element)
      ? [{ filterOrdinal, alias: element.attrs.anyallalias }] : []),
    generatedTerminalConditions: terminalConditions, grantIds: grants.map(grant => key(grant.id)), paths, diagnostics,
    qualification: diagnostics.length ? 'modeled-unqualified-terminal' : 'bounded-source-derived-odata-contract', universalNativeParity: false };
}
