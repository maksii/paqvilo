import { DataError } from './data-error.mjs';
import { parseXmlDocument, xmlEscapeAttribute } from './fetchxml-engine.mjs';
import { createHash } from 'node:crypto';

const key = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const node = (name, attrs = {}, children = []) => ({ name, attrs, children, text: '' });
// XmlWriter shape of native FetchExpression requests. Unknown
// attributes retain source order after known fields; their native ordering
// needs qualification when a project introduces a new query contract.
const attributeOrder = {
  fetch: [
    'mapping',
    'version',
    'count',
    'page',
    'paging-cookie',
    'utc-offset',
    'aggregate',
    'distinct',
    'min-active-row-version',
    'output-format',
    'returntotalrecordcount',
    'no-lock',
    'top',
  ],
  entity: ['name', 'alias'],
  attribute: ['name', 'alias', 'aggregate', 'groupby', 'dategrouping', 'usertimezone', 'distinct'],
  order: ['attribute', 'alias', 'descending', 'entityname'],
  filter: ['type', 'hint', 'isquickfindfields'],
  condition: ['entityname', 'attribute', 'operator', 'value', 'valueof', 'uiname', 'uitype', 'uihidden'],
  'link-entity': ['name', 'from', 'to', 'alias', 'link-type', 'visible', 'intersect'],
};
const escapeText = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function serializePermissionFetchXml(element, depth = 0, pretty = true) {
  const rank = attributeOrder[element.name] ?? [];
  const attrs = Object.entries(element.attrs)
    .sort(
      ([left], [right]) =>
        (rank.includes(left) ? rank.indexOf(left) : rank.length) -
        (rank.includes(right) ? rank.indexOf(right) : rank.length),
    )
    .map(
      ([name, value]) =>
        ` ${name}="${xmlEscapeAttribute(value).replaceAll('\r', '&#xD;').replaceAll('\n', '&#xA;').replaceAll('\t', '&#x9;')}"`,
    )
    .join('');
  const pad = pretty ? '  '.repeat(depth) : '',
    opening = `${pad}<${element.name}${attrs}`;
  let text = '';
  if (element.name === 'value') text = escapeText(element.text ?? '');
  else if (element.text?.trim()) text = escapeText(element.text);
  if (!element.children.length) return text ? `${opening}>${text}</${element.name}>` : `${opening} />`;
  const newline = pretty ? '\r\n' : '';
  return `${opening}>${text}${newline}${element.children.map((child) => serializePermissionFetchXml(child, depth + 1, pretty)).join(newline)}${newline}${pad}</${element.name}>`;
}
const walk = function* (element) {
  yield element;
  for (const child of element.children) yield* walk(child);
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => [name, canonical(item)]),
    );
  return value;
};
export function permissionOrderGraphFingerprint(permissions) {
  const graph = permissions
    .map((permission) => ({
      id: key(permission.id),
      name: permission.name ?? null,
      entity: permission.entity,
      scope: permission.scope ?? 'global',
      enabled: permission.enabled !== false,
      operations: [...(permission.operations ?? ['read'])].sort(), // NOSONAR: preserve default string coercion in fingerprints
      roles: [...(permission.roles ?? [])].sort(), // NOSONAR: preserve default string coercion in fingerprints
      roleIds: (permission.roleIds ?? []).map(key).sort(),
      imported: Boolean(permission.imported),
      field: permission.field ?? null,
      parentPermissionId: key(permission.parentPermissionId ?? permission.parentId) || null,
      relationship: permission.relationship ?? null,
      identityRelationship: permission.identityRelationship ?? null,
      observedOrphanParent: permission.observedOrphanParent ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(JSON.stringify(canonical(graph)))
    .digest('hex');
}

/**
 * Compile the root table's effective grants into executable FetchXML. The shape
 * models captured Power Pages outer permission joins, rather than claiming a
 * version-independent native SQL/query rewrite. Authored linked tables are not
 * independent permission roots; the caller selects their lane-specific policy.
 * SDK/internal reads must bypass this portal-only compiler.
 */
export function compilePermissionFetchXml(
  xml,
  {
    permissions = [],
    identity = {},
    mappings = {},
    operation = 'read',
    rules,
    bypass = false,
    maxPathDepth = 32,
    linkedPermissionOrdinals = [],
    grantOrder,
    unscopedCreate = false,
    defaultDistinct = true,
    defaultGlobalDistinct = defaultDistinct,
    forceScopedDistinct = false,
    seedAliasesFromAuthoredLinks = false,
  } = {},
) {
  const tree = parseXmlDocument(xml, { root: 'fetch' });
  const root = tree.children.find((element) => element.name === 'entity');
  if (!root?.attrs.name) throw new DataError('FetchXML entity is required.', 400, 'InvalidFetchXml');
  const context = {
    xml,
    tree,
    root,
    permissions,
    identity,
    mappings,
    operation,
    rules,
    grantOrder,
    unscopedCreate,
    defaultDistinct,
    defaultGlobalDistinct,
    forceScopedDistinct,
    seedAliasesFromAuthoredLinks,
    maxPathDepth,
    authoredLinkCount: [...walk(tree)].filter((element) => element.name === 'link-entity').length,
    authoredLinks: [...walk(tree)].filter((element) => element.name === 'link-entity'),
    generatedNodes: new Set(),
    diagnostics: [],
    grantPaths: [],
    normalizeQuery: false,
  };
  if (bypass || identity.admin) return finishPermissionQuery(context, true);
  context.normalizeQuery = true;
  // Native scoped FetchExpression serialization supplies these defaults and
  // writes order nodes before filters. Explicit DISTINCT is retained unless
  // the caller selects the scoped portal contract.
  tree.attrs.mapping ??= 'logical';

  const rank = { attribute: 0, 'all-attributes': 0, order: 1, filter: 2, 'link-entity': 3 };
  root.children.sort((left, right) => (rank[left.name] ?? 4) - (rank[right.name] ?? 4));
  context.availableRoles = new Set(identity.roles ?? []);
  context.availableIds = new Set((identity.roleIds ?? []).map(key));
  let grants = selectPermissionGrants(context, root.attrs.name, operation);
  // The Liquid Create right asserts table creation
  // eligibility and executes the authored read without scoped permission joins.
  // The caller opts into this contract only for its Liquid lane.
  if (unscopedCreate && operation === 'create') {
    if (grantOrder && grantOrder.normalizedGraphHash !== permissionOrderGraphFingerprint(permissions))
      throw new DataError(
        'Observed permission order does not match the current source graph.',
        501,
        'PermissionGrantOrderUnqualified',
      );
    return finishPermissionQuery(context, grants.length > 0, grants);
  }
  if (grantOrder) {
    if (grantOrder.normalizedGraphHash !== permissionOrderGraphFingerprint(permissions))
      throw new DataError(
        'Observed permission order does not match the current source graph.',
        501,
        'PermissionGrantOrderUnqualified',
      );
    grants = orderPermissionGrants(context, root.attrs.name, grants);
  }
  // The classic API lane constrains each authored linked table using
  // existential paths to its principal. Liquid only expands the root grants.
  // These paths come from source permissions, never a recorded query template.
  for (const ordinal of linkedPermissionOrdinals)
    compileLinkedPermission(context, ordinal, (entity, selected) => orderPermissionGrants(context, entity, selected));
  if (grants.some((grant) => (grant.scope ?? 'global') === 'global'))
    return finishPermissionQuery(context, true, grants);
  return compileScopedPermissionPaths(context, grants, rank);
}

function finishPermissionQuery(context, permissionGranted, grantIds = []) {
  const { tree, root, forceScopedDistinct, operation, unscopedCreate, defaultDistinct, defaultGlobalDistinct } =
    context;
  if (
    context.normalizeQuery &&
    permissionGranted &&
    !grantIds.some((grant) => (grant.scope ?? 'global') === 'global') &&
    !forceScopedDistinct &&
    /^(?:false|0)$/i.test(String(tree.attrs.distinct ?? ''))
  )
    context.diagnostics.push({
      code: 'PERMISSION_QUERY_DISTINCT_FALSE_UNQUALIFIED',
      message:
        'Captured scoped queries qualify the default distinct=true shape; explicit distinct=false remains authored and unqualified.',
    });
  const finalLinks = [...walk(tree)].filter((element) => element.name === 'link-entity');
  const permissionLinkCount = context.generatedNodes.size;
  if (context.normalizeQuery && permissionGranted && !(unscopedCreate && operation === 'create')) {
    if (forceScopedDistinct && !grantIds.some((grant) => (grant.scope ?? 'global') === 'global')) {
      if (tree.attrs.distinct !== 'true')
        context.diagnostics.push({
          code: 'PERMISSION_QUERY_DISTINCT_FORCED',
          message: 'The qualified scoped portal permission compiler selects DISTINCT for the secured query.',
        });
      tree.attrs.distinct = 'true';
    } else if (
      defaultDistinct &&
      (defaultGlobalDistinct || !grantIds.some((grant) => (grant.scope ?? 'global') === 'global'))
    )
      tree.attrs.distinct ??= 'true';
  }
  return {
    xml: context.normalizeQuery ? serializePermissionFetchXml(tree) : context.xml,
    authoredXml: context.xml,
    authoredLinkCount: context.authoredLinkCount,
    permissionLinkCount,
    totalLinkCount: context.authoredLinkCount + permissionLinkCount,
    generatedLinkOrdinals: finalLinks.flatMap((element, index) => (context.generatedNodes.has(element) ? [index] : [])),
    generatedLinkAliases: finalLinks
      .filter((element) => context.generatedNodes.has(element))
      .map((element) => element.attrs.alias)
      .filter(Boolean),
    generatedTerminalConditions: root.children
      .filter((element) => element.permissionFilter)
      .flatMap((element) =>
        [...walk(element)].filter((child) => child.name === 'condition').map((child) => ({ ...child.attrs })),
      ),
    permissionGranted,
    globalPermissionGranted: permissionGranted && grantIds.some((grant) => (grant.scope ?? 'global') === 'global'),
    grantIds: grantIds.map((grant) => grant.id),
    qualification: 'modeled',
    diagnostics: context.diagnostics,
    grantPaths: context.grantPaths,
    multiplicativePaths: context.grantPaths.filter((path) => path.multiplicative),
  };
}

function selectPermissionGrants(context, entity, right) {
  const { rules, identity, permissions } = context;
  if (rules) return rules(entity, right, identity);
  return permissions.filter((grant) =>
    isSelectedGrant(grant, entity, right, identity, context.availableRoles, context.availableIds),
  );
}

function isSelectedGrant(grant, entity, right, identity, availableRoles, availableIds) {
  return (
    grant.enabled !== false &&
    (grant.entity === entity || grant.entity === '*') &&
    (grant.operations ?? ['read']).includes(right) &&
    (identity.roleSource === 'memberships' && (grant.imported || grant.roleIds?.length)
      ? (grant.roleIds ?? []).some((role) => availableIds.has(key(role)))
      : !grant.roles?.length || grant.roles.some((role) => availableRoles.has(role)))
  );
}

function orderPermissionGrants(context, entity, selectedGrants) {
  const { grantOrder } = context;
  if (!grantOrder) return selectedGrants;
  const groups = grantOrder.tables?.[entity];
  if (groups) {
    const ranks = new Map(groups.flatMap((group, index) => group.map((id) => [key(id), index])));
    if (selectedGrants.some((grant) => !ranks.has(key(grant.id))))
      throw new DataError(
        'Observed permission order does not cover a selected source grant.',
        501,
        'PermissionGrantOrderUnqualified',
      );
    return [...selectedGrants].sort((a, b) => ranks.get(key(a.id)) - ranks.get(key(b.id)));
  }
  if (selectedGrants.length > 1 && !selectedGrants.some((grant) => (grant.scope ?? 'global') === 'global'))
    throw new DataError(
      'Multiple grants have no observed order for this table.',
      501,
      'PermissionGrantOrderUnqualified',
    );
  return selectedGrants;
}

function compileLinkedPermission(context, ordinal, orderedGrants) {
  const link = context.authoredLinks[ordinal];
  if (!link) throw new DataError('Authored permission link ordinal is invalid.', 400, 'InvalidPermission');
  const linkedGrants = orderedGrants(link.attrs.name, selectPermissionGrants(context, link.attrs.name, 'read'));
  if (linkedGrants.some((grant) => (grant.scope ?? 'global') === 'global')) return;
  const alternatives = [],
    seen = new Set();
  for (const grant of linkedGrants) {
    const result = linkedAlternative(context, link, grant);
    if (!result) continue;
    const signature = JSON.stringify(result.alternative);
    if (seen.has(signature)) continue;
    seen.add(signature);
    alternatives.push(result.alternative);
    context.grantPaths.push(...result.grantPaths);
    for (const element of walk(result.alternative))
      if (element.name === 'link-entity') context.generatedNodes.add(element);
  }
  if (!alternatives.length)
    throw new DataError('Table permission denies the authored linked table.', 403, 'PermissionDenied', {
      operation: 'read',
      table: link.attrs.name,
    });
  link.children.push(node('filter', { type: 'and' }, [node('filter', { type: 'or' }, alternatives)]));
}

function linkedAlternative(context, link, grant) {
  let firstSelection = true;
  const single = compilePermissionFetchXml(`<fetch><entity name="${xmlEscapeAttribute(link.attrs.name)}" /></fetch>`, {
    permissions: context.permissions,
    identity: context.identity,
    mappings: context.mappings,
    maxPathDepth: context.maxPathDepth,
    rules: (entity, right) => {
      if (firstSelection) {
        firstSelection = false;
        return [grant];
      }
      return selectPermissionGrants(context, entity, right);
    },
  });
  if (!single.permissionGranted) return null;
  const singleRoot = parseXmlDocument(single.xml, { root: 'fetch' }).children.find(
    (element) => element.name === 'entity',
  );
  const terminal = [...walk(singleRoot)].find((element) => element.name === 'condition');
  const path = singleRoot.children.find((element) => element.name === 'link-entity');
  const ancestor = linkedGrantAncestor(grant, context.permissions);
  if (!terminal || !ancestor) return null;
  const last = normalizeLinkedPath(path);
  const condition = node(
    'condition',
    Object.fromEntries(Object.entries(terminal.attrs).filter(([name]) => name !== 'entityname')),
    structuredClone(terminal.children),
  );
  return {
    alternative: makeLinkedAlternative(path, last, terminal, ancestor, condition, context.mappings),
    grantPaths: single.grantPaths.map((item) => ({ ...item, authoredTable: link.attrs.name, multiplicative: false })),
  };
}

function linkedGrantAncestor(grant, permissions) {
  let ancestor = grant;
  const visited = new Set();
  while (ancestor?.scope === 'parent' && !ancestor.observedOrphanParent) {
    if (visited.has(key(ancestor.id))) break;
    visited.add(key(ancestor.id));
    ancestor = permissions.find(
      (candidate) => key(candidate.id) === key(ancestor.parentPermissionId ?? ancestor.parentId),
    );
  }
  return ancestor;
}

function normalizeLinkedPath(path) {
  let last = path;
  if (!path) return last;
  for (;;) {
    delete last.attrs.alias;
    last.attrs['link-type'] = last === path ? 'any' : 'inner';
    const next = last.children.find((element) => element.name === 'link-entity');
    if (!next) break;
    last = next;
  }
  return last;
}

function makeLinkedAlternative(path, last, terminal, ancestor, condition, mappings) {
  let alternative = path;
  if (
    ancestor.identityRelationship ||
    ancestor.scope === 'self' ||
    ancestor.observedOrphanParent ||
    (ancestor.scope ?? 'global') === 'global'
  ) {
    const filter = node('filter', {}, [condition]);
    if (last) last.children.push(filter);
    else alternative = condition;
    return alternative;
  }
  const principal = ancestor.scope === 'account' ? 'account' : 'contact';
  const principalKey = mappings[principal]?.idColumn ?? `${principal}id`;
  const principalLink = node(
    'link-entity',
    { name: principal, from: principalKey, to: terminal.attrs.attribute, 'link-type': path ? 'inner' : 'any' },
    [
      node('filter', {}, [
        node(
          'condition',
          {
            attribute: principalKey,
            operator: terminal.attrs.operator,
            ...(terminal.attrs.value != null ? { value: terminal.attrs.value } : {}),
          },
          structuredClone(terminal.children),
        ),
      ]),
    ],
  );
  if (last) last.children.push(principalLink);
  else alternative = principalLink;
  return alternative;
}

function compileScopedPermissionPaths(context, grants, rank) {
  const byId = new Map(context.permissions.map((grant) => [key(grant.id), grant]));
  const aliases = new Set([...walk(context.tree)].map((element) => element.attrs.alias).filter(Boolean));
  const sequence = new Map();
  if (context.seedAliasesFromAuthoredLinks)
    for (const link of context.authoredLinks.filter((link) => link.attrs.alias))
      sequence.set(link.attrs.name, (sequence.get(link.attrs.name) ?? 0) + 1);
  const state = { aliases, sequence, byId, links: [], conditions: [], seenPaths: new Set(), accepted: [] };
  for (const grant of grants) addScopedGrantPath(context, state, grant);
  if (!state.conditions.length) return finishPermissionQuery(context, false);
  const permissionFilter = node('filter', { type: 'and' }, [
    node('filter', { type: 'or', hint: 'union' }, state.conditions),
  ]);
  permissionFilter.permissionFilter = true;
  const firstLink = context.root.children.findIndex((element) => element.name === 'link-entity');
  if (firstLink < 0) context.root.children.push(permissionFilter);
  else context.root.children.splice(firstLink, 0, permissionFilter);
  context.root.children.push(...state.links);
  context.root.children.sort((left, right) => (rank[left.name] ?? 4) - (rank[right.name] ?? 4));
  return finishPermissionQuery(context, true, state.accepted);
}

function addScopedGrantPath(context, state, grant) {
  const path = permissionGrantPath(context, state, grant);
  if (!path) return;
  const signature = JSON.stringify(path);
  if (state.seenPaths.has(signature)) return;
  state.seenPaths.add(signature);
  state.accepted.push(grant);
  context.grantPaths.push(describeGrantPath(grant, path.descriptors));
  const joins = buildPermissionJoins(context, state, path.descriptors);
  state.conditions.push(
    node('condition', { ...(joins.terminalAlias ? { entityname: joins.terminalAlias } : {}), ...path.terminal }),
  );
  if (joins.first) state.links.push(joins.first);
}

function permissionGrantPath(context, state, grant) {
  const descriptors = [],
    seen = new Set();
  let current = grant,
    terminal;
  while (current) {
    const currentKey = key(current.id);
    if (seen.has(currentKey) || descriptors.length > context.maxPathDepth)
      throw new DataError('Cyclic or excessive parent table permission path.', 400, 'InvalidPermission');
    seen.add(currentKey);
    const step = permissionPathStep(context, state, current, descriptors);
    if (step.terminal) {
      terminal = step.terminal;
      break;
    }
    if (step.next) {
      current = step.next;
      continue;
    }
    break;
  }
  if (terminal) return { descriptors, terminal };
  context.diagnostics.push({
    code: 'PERMISSION_QUERY_PATH_UNRESOLVED',
    permissionId: grant.id,
    message: 'This grant has no complete enabled path to an applicable identity or global ancestor.',
  });
  return null;
}

function permissionPathStep(context, state, current, descriptors) {
  const scope = current.scope ?? 'global';
  if (current.observedOrphanParent?.field) {
    context.diagnostics.push({
      code: 'PERMISSION_OBSERVED_ORPHAN_UNRESTRICTED',
      permissionId: current.id,
      message:
        'An explicitly observed inactive-parent profile replaced the missing identity path with a not-null parent lookup.',
    });
    return { terminal: { attribute: current.observedOrphanParent.field, operator: 'not-null' } };
  }
  if (scope === 'parent') return parentPermissionStep(context, state, current, descriptors);
  if (scope === 'global')
    return { terminal: { attribute: primaryPermissionKey(context, current.entity), operator: 'not-null' } };
  if (!['contact', 'account', 'self'].includes(scope)) return {};
  const value = scope === 'account' ? context.identity.accountId : (context.identity.contactId ?? context.identity.id);
  if (!value) return {};
  return { terminal: identityPermissionTerminal(context, current, scope, value, descriptors) };
}

function parentPermissionStep(context, state, current, descriptors) {
  const relationship = current.relationship;
  const parent = state.byId.get(key(current.parentPermissionId ?? current.parentId));
  if (
    !parent ||
    parent.enabled === false ||
    !relationship?.entity ||
    !relationship.from ||
    !relationship.to ||
    relationship.entity !== parent.entity ||
    !selectPermissionGrants(context, parent.entity, 'read').some((candidate) => key(candidate.id) === key(parent.id))
  )
    return {};
  descriptors.push(relationship);
  return { next: parent };
}

function identityPermissionTerminal(context, current, scope, value, descriptors) {
  if (current.identityRelationship) {
    descriptors.push(current.identityRelationship);
    return { attribute: primaryPermissionKey(context, current.identityRelationship.entity), operator: 'eq', value };
  }
  let attribute = current.field;
  if (attribute == null) attribute = defaultIdentityPermissionField(context, current, scope);
  return { attribute, operator: 'eq', value };
}

function defaultIdentityPermissionField(context, current, scope) {
  if (scope === 'self') return primaryPermissionKey(context, current.entity);
  if (scope === 'account') return 'parentcustomerid';
  return 'contactid';
}

function primaryPermissionKey(context, entity) {
  return context.mappings[entity]?.idColumn ?? `${entity}id`;
}

function describeGrantPath(grant, descriptors) {
  return {
    grantId: grant.id,
    tables: [grant.entity, ...descriptors.map((relation) => relation.entity)],
    links: descriptors.map(({ entity, from, to, many, intersect }) => ({
      entity,
      from,
      to,
      many: many === true,
      ...(intersect ? { intersect: { entity: intersect.entity, from: intersect.from, to: intersect.to } } : {}),
    })),
    multiplicative: descriptors.some((relation) => relation.many === true || Boolean(relation.intersect)),
  };
}

function buildPermissionJoins(context, state, descriptors) {
  let first, last, terminalAlias;
  for (const relationship of descriptors) {
    const result = permissionJoin(context, state, relationship);
    if (last) last.children.push(result.first);
    else first = result.first;
    last = result.last;
    terminalAlias = result.terminalAlias;
  }
  return { first, terminalAlias };
}

function permissionJoin(context, state, relationship) {
  if (!relationship.intersect) {
    const terminalAlias = nextPermissionAlias(state, relationship.entity);
    const join = node('link-entity', {
      name: relationship.entity,
      from: relationship.to,
      to: relationship.from,
      alias: terminalAlias,
      'link-type': 'outer',
    });
    context.generatedNodes.add(join);
    return { first: join, last: join, terminalAlias };
  }
  return permissionIntersectJoin(context, state, relationship);
}

function permissionIntersectJoin(context, state, relationship) {
  const edge = relationship.intersect;
  if (!edge.entity || !edge.from || !edge.to)
    throw new DataError('Permission intersect relationship is incomplete.', 400, 'InvalidPermission');
  const intersection = node('link-entity', {
    name: edge.entity,
    from: edge.from,
    to: relationship.from,
    'link-type': 'outer',
    visible: 'false',
    intersect: 'true',
  });
  const terminalAlias = nextPermissionAlias(state, relationship.entity);
  const join = node('link-entity', {
    name: relationship.entity,
    from: relationship.to,
    to: edge.to,
    alias: terminalAlias,
    'link-type': 'outer',
  });
  intersection.children.push(join);
  context.generatedNodes.add(intersection);
  context.generatedNodes.add(join);
  return { first: intersection, last: join, terminalAlias };
}

function nextPermissionAlias(state, entity) {
  let index = state.sequence.get(entity) ?? 0,
    result;
  do {
    result = `generated_alias_${entity}_${index++}`;
  } while (state.aliases.has(result));
  state.sequence.set(entity, index);
  state.aliases.add(result);
  return result;
}
