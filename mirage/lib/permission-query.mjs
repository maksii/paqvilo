import { DataError } from './data-error.mjs';
import { parseXmlDocument, xmlEscapeAttribute } from './fetchxml-engine.mjs';
import {createHash} from 'node:crypto';

const key = value => String(value?.id ?? value ?? '').replace(/[{}]/g, '').toLowerCase();
const node = (name, attrs = {}, children = []) => ({ name, attrs, children, text: '' });
// XmlWriter shape observed in incoming FetchExpression captures. Unknown
// attributes retain source order after known fields; their native ordering
// needs qualification when a project introduces a new query contract.
const attributeOrder = {
  fetch: ['mapping', 'version', 'count', 'page', 'paging-cookie', 'utc-offset', 'aggregate', 'distinct', 'min-active-row-version', 'output-format', 'returntotalrecordcount', 'no-lock', 'top'],
  entity: ['name', 'alias'],
  attribute: ['name', 'alias', 'aggregate', 'groupby', 'dategrouping', 'usertimezone', 'distinct'],
  order: ['attribute', 'alias', 'descending', 'entityname'],
  filter: ['type', 'hint', 'isquickfindfields'],
  condition: ['entityname', 'attribute', 'operator', 'value', 'valueof', 'uiname', 'uitype', 'uihidden'],
  'link-entity': ['name', 'from', 'to', 'alias', 'link-type', 'visible', 'intersect'],
};
const escapeText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function serializePermissionFetchXml(element, depth = 0, pretty = true) {
  const rank = attributeOrder[element.name] ?? [];
  const attrs = Object.entries(element.attrs).sort(([left], [right]) =>
    (rank.includes(left) ? rank.indexOf(left) : rank.length) - (rank.includes(right) ? rank.indexOf(right) : rank.length))
    .map(([name, value]) => ` ${name}="${xmlEscapeAttribute(value).replaceAll('\r', '&#xD;').replaceAll('\n', '&#xA;').replaceAll('\t', '&#x9;')}"`).join('');
  const pad = pretty ? '  '.repeat(depth) : '', opening = `${pad}<${element.name}${attrs}`;
  const text = element.name === 'value' ? escapeText(element.text ?? '')
    : element.text?.trim() ? escapeText(element.text) : '';
  if (!element.children.length) return text ? `${opening}>${text}</${element.name}>` : `${opening} />`;
  const newline = pretty ? '\r\n' : '';
  return `${opening}>${text}${newline}${element.children.map(child => serializePermissionFetchXml(child, depth + 1, pretty)).join(newline)}${newline}${pad}</${element.name}>`;
}
const walk = function* (element) { yield element; for (const child of element.children) yield* walk(child); };
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>[name,canonical(item)])):value;
export function permissionOrderGraphFingerprint(permissions) {
  const graph=permissions.map(permission=>({
    id:key(permission.id),name:permission.name??null,entity:permission.entity,scope:permission.scope??'global',enabled:permission.enabled!==false,
    operations:[...(permission.operations??['read'])].sort(),roles:[...(permission.roles??[])].sort(),
    roleIds:(permission.roleIds??[]).map(key).sort(),imported:Boolean(permission.imported),field:permission.field??null,
    parentPermissionId:key(permission.parentPermissionId??permission.parentId)||null,
    relationship:permission.relationship??null,identityRelationship:permission.identityRelationship??null,
    observedOrphanParent:permission.observedOrphanParent??null,
  })).sort((a,b)=>a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(canonical(graph))).digest('hex');
}

/**
 * Compile the root table's effective grants into executable FetchXML. The shape
 * models captured Power Pages outer permission joins, rather than claiming a
 * version-independent native SQL/query rewrite. Authored linked tables are not
 * independent permission roots; the caller selects their lane-specific policy.
 * SDK/internal reads must bypass this portal-only compiler.
 */
export function compilePermissionFetchXml(xml, {
  permissions = [], identity = {}, mappings = {}, operation = 'read', rules,
  bypass = false, maxPathDepth = 32,
  linkedPermissionOrdinals = [],
  grantOrder,
  unscopedCreate = false,
  defaultDistinct = true,
  defaultGlobalDistinct = defaultDistinct,
  forceScopedDistinct = false,
  seedAliasesFromAuthoredLinks = false,
} = {}) {
  const tree = parseXmlDocument(xml, { root: 'fetch' });
  const root = tree.children.find(element => element.name === 'entity');
  if (!root?.attrs.name) throw new DataError('FetchXML entity is required.', 400, 'InvalidFetchXml');
  const authoredLinkCount = [...walk(tree)].filter(element => element.name === 'link-entity').length;
  const authoredLinks = [...walk(tree)].filter(element => element.name === 'link-entity');
  const generatedNodes = new Set();
  const diagnostics = [];
  const grantPaths = [];
  let normalizeQuery = false;
  const finish = (permissionGranted, permissionLinkCount = 0, grantIds = []) => {
    if(normalizeQuery&&permissionGranted&&!grantIds.some(grant=>(grant.scope??'global')==='global')&&!forceScopedDistinct&&/^(?:false|0)$/i.test(String(tree.attrs.distinct??'')))diagnostics.push({code:'PERMISSION_QUERY_DISTINCT_FALSE_UNQUALIFIED',message:'Captured scoped queries qualify the default distinct=true shape; explicit distinct=false remains authored and unqualified.'});
    const finalLinks = [...walk(tree)].filter(element => element.name === 'link-entity');
    permissionLinkCount = generatedNodes.size;
    if(normalizeQuery && permissionGranted && !(unscopedCreate&&operation==='create')) {
      if (forceScopedDistinct && !grantIds.some(grant => (grant.scope ?? 'global') === 'global')) {
        if (tree.attrs.distinct !== 'true') diagnostics.push({code:'PERMISSION_QUERY_DISTINCT_FORCED',
          message:'The qualified scoped portal permission compiler selects DISTINCT for the secured query.'});
        tree.attrs.distinct = 'true';
      } else if (defaultDistinct && (defaultGlobalDistinct || !grantIds.some(grant => (grant.scope ?? 'global') === 'global'))) tree.attrs.distinct ??= 'true';
    }
    return ({
    xml: normalizeQuery ? serializePermissionFetchXml(tree) : xml,
    authoredXml: xml, authoredLinkCount, permissionLinkCount,
    totalLinkCount: authoredLinkCount + permissionLinkCount,
    generatedLinkOrdinals: finalLinks.flatMap((element, index) => generatedNodes.has(element) ? [index] : []),
    generatedLinkAliases: finalLinks.filter(element => generatedNodes.has(element))
      .map(element => element.attrs.alias).filter(Boolean),
    generatedTerminalConditions: root.children.filter(element => element.permissionFilter)
      .flatMap(element => [...walk(element)].filter(child => child.name === 'condition').map(child => ({...child.attrs}))),
    permissionGranted, globalPermissionGranted: permissionGranted && grantIds.some(grant => (grant.scope ?? 'global') === 'global'),
    grantIds: grantIds.map(grant => grant.id), qualification: 'modeled', diagnostics,
    grantPaths, multiplicativePaths: grantPaths.filter(path => path.multiplicative),
    });
  };
  if (bypass || identity.admin) return finish(true);
  normalizeQuery = true;
  // Captured scoped FetchExpression serialization supplies these defaults and
  // writes order nodes before filters. Explicit DISTINCT is retained unless
  // the caller selects the independently qualified scoped portal contract.
  tree.attrs.mapping ??= 'logical';

  const rank = { attribute: 0, 'all-attributes': 0, order: 1, filter: 2, 'link-entity': 3 };
  root.children.sort((left, right) => (rank[left.name] ?? 4) - (rank[right.name] ?? 4));
  const availableRoles = new Set(identity.roles ?? []);
  const availableIds = new Set((identity.roleIds ?? []).map(key));
  const selected = (entity, right) => rules ? rules(entity, right, identity) : permissions.filter(grant =>
    grant.enabled !== false && (grant.entity === entity || grant.entity === '*') &&
    (grant.operations ?? ['read']).includes(right) &&
    (identity.roleSource === 'memberships' && (grant.imported || grant.roleIds?.length)
      ? (grant.roleIds ?? []).some(role => availableIds.has(key(role)))
      : !grant.roles?.length || grant.roles.some(role => availableRoles.has(role))));
  let grants = selected(root.attrs.name, operation);
  // The independently witnessed Liquid Create right asserts table creation
  // eligibility and executes the authored read without scoped permission joins.
  // The caller opts into this contract only for its observed Liquid lane.
  if(unscopedCreate&&operation==='create'){
    if(grantOrder&&grantOrder.normalizedGraphHash!==permissionOrderGraphFingerprint(permissions))throw new DataError('Observed permission order does not match the current source graph.',501,'PermissionGrantOrderUnqualified');
    return finish(grants.length>0,0,grants);
  }
  const orderedGrants=(entity,selectedGrants)=>{
    if(!grantOrder)return selectedGrants;
    const groups=grantOrder.tables?.[entity];
    if(groups){
      const ranks=new Map(groups.flatMap((group,index)=>group.map(id=>[key(id),index])));
      if(selectedGrants.some(grant=>!ranks.has(key(grant.id))))throw new DataError('Observed permission order does not cover a selected source grant.',501,'PermissionGrantOrderUnqualified');
      return [...selectedGrants].sort((a,b)=>ranks.get(key(a.id))-ranks.get(key(b.id)));
    }else if(selectedGrants.length>1&&!selectedGrants.some(grant=>(grant.scope??'global')==='global'))
      throw new DataError('Multiple grants have no observed order for this table.',501,'PermissionGrantOrderUnqualified');
    return selectedGrants;
  };
  if(grantOrder){
    if(grantOrder.normalizedGraphHash!==permissionOrderGraphFingerprint(permissions))throw new DataError('Observed permission order does not match the current source graph.',501,'PermissionGrantOrderUnqualified');
    grants=orderedGrants(root.attrs.name,grants);
  }
  // The evidenced classic API lane constrains each authored linked table using
  // existential paths to its principal. Liquid only expands the root grants.
  // These paths come from source permissions, never a recorded query template.
  for (const ordinal of linkedPermissionOrdinals) {
    const link = authoredLinks[ordinal];
    if (!link) throw new DataError('Authored permission link ordinal is invalid.', 400, 'InvalidPermission');
    const linkedGrants = orderedGrants(link.attrs.name,selected(link.attrs.name, 'read'));
    if (linkedGrants.some(grant => (grant.scope ?? 'global') === 'global')) continue;
    const alternatives = [], seen = new Set();
    for (const grant of linkedGrants) {
      let firstSelection = true;
      const single = compilePermissionFetchXml(`<fetch><entity name="${xmlEscapeAttribute(link.attrs.name)}" /></fetch>`, {
        permissions, identity, mappings, maxPathDepth,
        rules: (entity, right) => {
          if (firstSelection) { firstSelection = false; return [grant]; }
          return selected(entity, right);
        },
      });
      if (!single.permissionGranted) continue;
      const singleRoot = parseXmlDocument(single.xml, {root:'fetch'}).children.find(element => element.name === 'entity');
      const terminal = [...walk(singleRoot)].find(element => element.name === 'condition');
      const path = singleRoot.children.find(element => element.name === 'link-entity');
      let ancestor = grant;
      const visited = new Set();
      while (ancestor?.scope === 'parent' && !ancestor.observedOrphanParent) {
        if (visited.has(key(ancestor.id))) break;
        visited.add(key(ancestor.id));
        ancestor = permissions.find(candidate => key(candidate.id) === key(ancestor.parentPermissionId ?? ancestor.parentId));
      }
      if (!terminal || !ancestor) continue;
      let last = path;
      if (path) for (;;) {
        delete last.attrs.alias;
        last.attrs['link-type'] = last === path ? 'any' : 'inner';
        const next = last.children.find(element => element.name === 'link-entity');
        if (!next) break;
        last = next;
      }
      const condition = node('condition', Object.fromEntries(Object.entries(terminal.attrs).filter(([name]) => name !== 'entityname')), structuredClone(terminal.children));
      let alternative = path;
      if (ancestor.identityRelationship || ancestor.scope === 'self' || ancestor.observedOrphanParent || (ancestor.scope ?? 'global') === 'global') {
        const filter = node('filter', {}, [condition]);
        if (last) last.children.push(filter); else alternative = condition;
      } else {
        const principal = ancestor.scope === 'account' ? 'account' : 'contact';
        const principalKey = mappings[principal]?.idColumn ?? `${principal}id`;
        const principalLink = node('link-entity', {name:principal, from:principalKey, to:terminal.attrs.attribute, 'link-type':path ? 'inner' : 'any'},
          [node('filter', {}, [node('condition', {attribute:principalKey, operator:terminal.attrs.operator, ...(terminal.attrs.value != null ? {value:terminal.attrs.value} : {})}, structuredClone(terminal.children))])]);
        if (last) last.children.push(principalLink); else alternative = principalLink;
      }
      const signature = JSON.stringify(alternative);
      if (seen.has(signature)) continue;
      seen.add(signature); alternatives.push(alternative);
      grantPaths.push(...single.grantPaths.map(path=>({...path,authoredTable:link.attrs.name,multiplicative:false})));
      for (const element of walk(alternative)) if (element.name === 'link-entity') generatedNodes.add(element);
    }
    if (!alternatives.length) throw new DataError('Table permission denies the authored linked table.', 403, 'PermissionDenied', {operation:'read',table:link.attrs.name});
    link.children.push(node('filter', {type:'and'}, [node('filter', {type:'or'}, alternatives)]));
  }
  if (grants.some(grant => (grant.scope ?? 'global') === 'global')) return finish(true, 0, grants);
  const byId = new Map(permissions.map(grant => [key(grant.id), grant]));
  const aliases = new Set([...walk(tree)].map(element => element.attrs.alias).filter(Boolean));
  const sequence = new Map();
  if(seedAliasesFromAuthoredLinks)for(const link of authoredLinks.filter(link=>link.attrs.alias))
    sequence.set(link.attrs.name,(sequence.get(link.attrs.name)??0)+1);
  const alias = entity => {
    let index = sequence.get(entity) ?? 0, result;
    do { result = `generated_alias_${entity}_${index++}`; } while (aliases.has(result));
    sequence.set(entity, index); aliases.add(result); return result;
  };
  const primary = entity => mappings[entity]?.idColumn ?? `${entity}id`;
  let permissionLinkCount = 0;
  const links = [], conditions = [], seenPaths = new Set(), accepted = [];
  // Every alternative gets its full path. Sharing a role between two grants
  // must not turn their two different principal/relationship paths into AND.
  for (const grant of grants) {
    const descriptors = [], seen = new Set();
    let current = grant, terminal;
    while (current) {
      const currentKey = key(current.id);
      if (seen.has(currentKey) || descriptors.length > maxPathDepth)
        throw new DataError('Cyclic or excessive parent table permission path.', 400, 'InvalidPermission');
      seen.add(currentKey);
      const scope = current.scope ?? 'global';
      if (current.observedOrphanParent?.field) {
        terminal = { attribute: current.observedOrphanParent.field, operator: 'not-null' };
        diagnostics.push({ code: 'PERMISSION_OBSERVED_ORPHAN_UNRESTRICTED', permissionId: current.id,
          message: 'An explicitly observed inactive-parent profile replaced the missing identity path with a not-null parent lookup.' });
        break;
      }
      if (scope === 'parent') {
        const relationship = current.relationship;
        const parent = byId.get(key(current.parentPermissionId ?? current.parentId));
        if (!parent || parent.enabled === false || !relationship?.entity ||
            !relationship.from || !relationship.to || relationship.entity !== parent.entity ||
            !selected(parent.entity, 'read').some(candidate => key(candidate.id) === key(parent.id))) break;
        descriptors.push(relationship); current = parent; continue;
      }
      if (scope === 'global') {
        // A child of a global parent still needs an existing parent row.
        terminal = { attribute: primary(current.entity), operator: 'not-null' }; break;
      }
      if (!['contact', 'account', 'self'].includes(scope)) break;
      const value = scope === 'account' ? identity.accountId : identity.contactId ?? identity.id;
      if (!value) break;
      if (current.identityRelationship) {
        descriptors.push(current.identityRelationship);
        terminal = { attribute: primary(current.identityRelationship.entity), operator: 'eq', value };
      } else terminal = {
        attribute: current.field ?? (scope === 'self' ? primary(current.entity) : scope === 'account' ? 'parentcustomerid' : 'contactid'),
        operator: 'eq', value,
      };
      break;
    }
    if (!terminal) {
      diagnostics.push({ code: 'PERMISSION_QUERY_PATH_UNRESOLVED', permissionId: grant.id,
        message: 'This grant has no complete enabled path to an applicable identity or global ancestor.' });
      continue;
    }
    const signature = JSON.stringify({ descriptors, terminal });
    if (seenPaths.has(signature)) continue;
    seenPaths.add(signature); accepted.push(grant);
    grantPaths.push({ grantId: grant.id, tables: [grant.entity, ...descriptors.map(relation => relation.entity)],
      links: descriptors.map(({entity,from,to,many,intersect}) => ({entity,from,to,many:many===true, ...(intersect?{intersect:{entity:intersect.entity,from:intersect.from,to:intersect.to}}:{})})),
      multiplicative: descriptors.some(relation => relation.many === true || Boolean(relation.intersect)) });
    let first, last, terminalAlias;
    for (const relationship of descriptors) {
      let join;
      if (relationship.intersect) {
        const edge = relationship.intersect;
        if (!edge.entity || !edge.from || !edge.to)
          throw new DataError('Permission intersect relationship is incomplete.', 400, 'InvalidPermission');
        const intersection = node('link-entity', { name: edge.entity, from: edge.from, to: relationship.from,
          'link-type': 'outer', visible: 'false', intersect: 'true' });
        terminalAlias = alias(relationship.entity);
        join = node('link-entity', { name: relationship.entity, from: relationship.to, to: edge.to,
          alias: terminalAlias, 'link-type': 'outer' });
        intersection.children.push(join);
        generatedNodes.add(intersection); generatedNodes.add(join);
        if (last) last.children.push(intersection); else first = intersection;
        last = join; permissionLinkCount += 2;
      } else {
        terminalAlias = alias(relationship.entity);
        join = node('link-entity', { name: relationship.entity, from: relationship.to, to: relationship.from,
          alias: terminalAlias, 'link-type': 'outer' });
        if (last) last.children.push(join); else first = join;
        generatedNodes.add(join);
        last = join; permissionLinkCount++;
      }
    }
    conditions.push(node('condition', { ...(terminalAlias ? { entityname: terminalAlias } : {}), ...terminal }));
    if (first) links.push(first);
  }
  if (!conditions.length) return finish(false);
  const permissionFilter = node('filter', { type: 'and' }, [node('filter', { type: 'or', hint: 'union' }, conditions)]);
  permissionFilter.permissionFilter = true;
  // Native scoped serialization places the permission filter with the filters,
  // before authored joins. Generated paths follow all authored joins.
  const firstLink = root.children.findIndex(element => element.name === 'link-entity');
  if (firstLink < 0) root.children.push(permissionFilter);
  else root.children.splice(firstLink, 0, permissionFilter);
  root.children.push(...links);
  root.children.sort((left, right) => (rank[left.name] ?? 4) - (rank[right.name] ?? 4));
  return finish(true, permissionLinkCount, accepted);
}
