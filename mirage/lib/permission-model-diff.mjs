// Compare compiled portal table grants, not deployed access or row populations.
// Existing permission compilation remains the authority; this module never grants access.
const ownObject = (value) => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const sorted = (values) => [...new Set(values)].sort(/* NOSONAR: preserve default string coercion */);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const operations = new Set(['read', 'create', 'update', 'delete', 'append', 'appendTo']);
const sources = new Set(['configured', 'exported', 'combined']);
const MAX_PERMISSIONS = 10_000;
const MAX_ITEMS = 100_000;
const MAX_DEPTH = 64;
const MAX_WORK = 1_000_000;
const sortWork = (length) => length * Math.max(1, Math.ceil(Math.log2(length + 1)));

function array(value, label, limit = MAX_ITEMS) {
  if (!Array.isArray(value) || value.length > limit)
    throw new TypeError(`${label} must be an array with at most ${limit} entries.`);
  return value;
}
const strings = (value, label, work) => {
  array(value, label);
  work(sortWork(value.length));
  if (value.some((entry) => typeof entry !== 'string' || !entry))
    throw new TypeError(`${label} must contain nonempty strings.`);
  return sorted(value);
};

function modelContext(model, label, work) {
  if (!ownObject(model) || !sources.has(model.source))
    throw new TypeError(`${label} must be a full compiled permission model with a known source.`);
  array(model.permissions, `${label}.permissions`, MAX_PERMISSIONS);
  array(model.webRoles, `${label}.webRoles`);
  array(model.memberships, `${label}.memberships`);
  array(model.personas, `${label}.personas`);
  array(model.diagnostics, `${label}.diagnostics`);
  for (const values of [model.permissions, model.webRoles, model.memberships, model.personas, model.diagnostics])
    work(sortWork(values.length));
  if (!ownObject(model.settings)) throw new TypeError(`${label}.settings must be an object.`);
  return {
    source: model.source,
    settings: { associationPermissions: model.settings.associationPermissions ?? null },
    defaults: model.webRoles
      .filter((role) => role.authenticated || role.anonymous)
      .map((role) => [id(role.id), Boolean(role.authenticated), Boolean(role.anonymous)])
      .sort(),
    memberships: sorted(model.memberships.map((member) => JSON.stringify([id(member.contactId), id(member.roleId)]))),
    personas: model.personas
      .map((persona) => [
        id(persona.contactId),
        id(persona.accountId),
        Boolean(persona.active),
        sorted(strings(persona.roleIds ?? [], `${label}.persona.roleIds`, work).map(id)),
      ])
      .sort(),
  };
}

function indexRoles(model, side, work, issue, roles, byName) {
  for (const role of model.webRoles) {
    work();
    if (!ownObject(role) || !id(role.id) || typeof role.name !== 'string')
      throw new TypeError(`${side}.webRoles must contain role IDs and names.`);
    const key = id(role.id);
    if (roles.has(key)) issue('PERMISSION_DIFF_ROLE_ID_AMBIGUOUS');
    roles.set(key, role);
    if (!byName.has(role.name)) byName.set(role.name, []);
    byName.get(role.name).push(key);
  }
}

function indexPermissions(model, side, work, issue, byId) {
  for (const permission of model.permissions) {
    work();
    if (!ownObject(permission) || !id(permission.id))
      throw new TypeError(`${side}.permissions must contain permission objects with IDs.`);
    const key = id(permission.id);
    if (byId.has(key)) issue('PERMISSION_DIFF_ID_AMBIGUOUS', key);
    byId.set(key, permission);
  }
}

function collectModelIssues(model, side, work, issue) {
  for (const diagnostic of model.diagnostics) {
    work();
    if (/UNRESOLVED|AMBIGUOUS|CYCLE|ORPHAN/.test(String(diagnostic.code ?? '')))
      issue(String(diagnostic.code), id(diagnostic.id) || null);
  }
}

function permissionRoleIds(permission, side, work, roles, byName, issue) {
  const explicit = strings(permission.roleIds ?? [], `${side}.permission.roleIds`, work).map(id);
  if (explicit.length) {
    if (explicit.some((role) => !roles.has(role))) issue('PERMISSION_DIFF_ROLE_UNRESOLVED', id(permission.id));
    return explicit.filter((role) => roles.has(role));
  }
  const names = strings(permission.roles ?? [], `${side}.permission.roles`, work);
  if (!names.length) {
    if (permission.imported) {
      issue('PERMISSION_DIFF_IMPORTED_ROLES_MISSING', id(permission.id));
      return [];
    }
    return ['*'];
  }
  return sorted(
    names.flatMap((name) => {
      const matches = byName.get(name) ?? [];
      if (matches.length !== 1) issue('PERMISSION_DIFF_ROLE_UNRESOLVED', id(permission.id));
      return matches.length === 1 ? matches : [];
    }),
  );
}

function normalizeRelationship(value, permission, issue, work, depth = 0) {
  work();
  if (depth > 1) {
    issue('PERMISSION_DIFF_RELATIONSHIP_UNRESOLVED', id(permission.id));
    return null;
  }
  if (!ownObject(value) || !['entity', 'from', 'to'].every((key) => typeof value[key] === 'string' && value[key])) {
    issue('PERMISSION_DIFF_RELATIONSHIP_UNRESOLVED', id(permission.id));
    return null;
  }
  const result = { entity: value.entity, from: value.from, to: value.to };
  if (value.intersect) {
    result.intersect = normalizeRelationship(value.intersect, permission, issue, work, depth + 1);
    if (!result.intersect) return null;
  }
  return result;
}

function parentPredicate(permission, role, chain, context) {
  const { byId, roleIds, predicate, relationship, issue } = context;
  const key = id(permission.id);
  const parent = byId.get(id(permission.parentPermissionId ?? permission.parentId)),
    rel = relationship(permission.relationship, permission);
  if (!parent || parent.enabled === false || !rel || rel.entity !== parent.entity) {
    issue('PERMISSION_DIFF_PARENT_UNRESOLVED', key);
    return null;
  }
  if (!(parent.operations ?? ['read']).includes('read')) return false;
  const parentRoles = roleIds(parent);
  if (!parentRoles.includes('*') && !parentRoles.includes(role)) {
    issue('PERMISSION_DIFF_PARENT_ROLE_DEPENDENCY', key);
    return null;
  }
  const parentResult = predicate(parent, role, new Set([...chain, key]));
  return parentResult ? { scope: permission.scope ?? 'global', relationship: rel, parent: parentResult } : parentResult;
}

function permissionPredicate(permission, role, chain, context) {
  const { work, issue, relationship } = context;
  work();
  const key = id(permission.id);
  if (chain.has(key) || chain.size >= MAX_DEPTH) {
    issue('PERMISSION_DIFF_PARENT_UNRESOLVED', key);
    return null;
  }
  if (permission.observedOrphanParent) {
    issue('PERMISSION_DIFF_OBSERVED_PROFILE', key);
    return null;
  }
  const scope = permission.scope ?? 'global';
  if (scope === 'global') return { scope };
  if (scope === 'self') return { scope, field: permission.field ?? null };
  if (scope === 'contact' || scope === 'account') {
    if (permission.identityRelationship) {
      const rel = relationship(permission.identityRelationship, permission);
      return rel ? { scope, relationship: rel } : null;
    }
    if (typeof permission.field === 'string' && permission.field) return { scope, field: permission.field };
    issue('PERMISSION_DIFF_RELATIONSHIP_UNRESOLVED', key);
    return null;
  }
  if (scope === 'parent') return parentPredicate(permission, role, chain, context);
  issue('PERMISSION_DIFF_SCOPE_UNRESOLVED', key);
  return null;
}

function addRoleGrantCells(permission, role, rights, cells, predicate, work) {
  work();
  const condition = predicate(permission, role);
  if (!condition) return;
  for (const operation of rights.filter((right) => operations.has(right))) {
    work();
    const key = JSON.stringify([role, permission.entity, operation]);
    if (!cells.has(key)) cells.set(key, new Map());
    if (cells.size > MAX_ITEMS) throw new RangeError('Permission comparison exceeds the 100000 grant-cell limit.');
    const cell = cells.get(key),
      signature = JSON.stringify(condition);
    if (!cell.has(signature))
      cell.set(signature, { predicate: condition, permissionIds: new Set(), sourceFiles: new Set() });
    const entry = cell.get(signature);
    entry.permissionIds.add(id(permission.id));
    if (typeof permission.provenance?.file === 'string') entry.sourceFiles.add(permission.provenance.file);
  }
}

function addPermissionGrants(permission, side, work, issue, cells, roleIds, predicate) {
  work();
  if (permission.disabledCode) issue(permission.disabledCode, id(permission.id));
  if (permission.enabled === false) return;
  if (typeof permission.entity !== 'string' || !permission.entity || permission.entity === '*') {
    issue('PERMISSION_DIFF_TABLE_UNRESOLVED', id(permission.id));
    return;
  }
  const rights = strings(permission.operations ?? ['read'], `${side}.permission.operations`, work);
  for (const right of rights)
    if (!operations.has(right)) issue('PERMISSION_DIFF_OPERATION_UNRESOLVED', id(permission.id));
  for (const role of roleIds(permission)) addRoleGrantCells(permission, role, rights, cells, predicate, work);
}

function normalize(model, side, diagnostics, work) {
  const byId = new Map(),
    roles = new Map(),
    byName = new Map(),
    cells = new Map();
  const issue = (code, permissionId = null) => diagnostics.push({ code, side, permissionId });
  indexRoles(model, side, work, issue, roles, byName);
  indexPermissions(model, side, work, issue, byId);
  collectModelIssues(model, side, work, issue);
  const roleIds = (permission) => permissionRoleIds(permission, side, work, roles, byName, issue);
  const relationship = (value, permission, depth = 0) => normalizeRelationship(value, permission, issue, work, depth);
  const context = { byId, roleIds, relationship, issue, work };
  const predicate = (permission, role, chain = new Set()) =>
    permissionPredicate(permission, role, chain, { ...context, predicate });
  for (const permission of model.permissions) {
    addPermissionGrants(permission, side, work, issue, cells, roleIds, predicate);
  }
  for (const cell of cells.values()) {
    work(cell.size);
    const global = JSON.stringify({ scope: 'global' });
    if (cell.has(global)) for (const signature of cell.keys()) if (signature !== global) cell.delete(signature);
  }
  return cells;
}

const covers = (cover, target) =>
  !target.size || cover.has(JSON.stringify({ scope: 'global' })) || [...target.keys()].every((key) => cover.has(key));
const effectiveCell = (cells, key, work) => {
  const [role, entity, operation] = JSON.parse(key),
    result = new Map();
  for (const cell of [role === '*' ? null : cells.get(JSON.stringify(['*', entity, operation])), cells.get(key)])
    for (const [signature, entry] of cell ?? []) {
      work(1 + entry.permissionIds.size + entry.sourceFiles.size);
      if (!result.has(signature))
        result.set(signature, { predicate: entry.predicate, permissionIds: new Set(), sourceFiles: new Set() });
      const combined = result.get(signature);
      for (const permission of entry.permissionIds) combined.permissionIds.add(permission);
      for (const file of entry.sourceFiles) combined.sourceFiles.add(file);
    }
  return result;
};
const evidence = (cell) =>
  [...cell.values()]
    .map((entry) => ({
      predicate: entry.predicate,
      permissionIds: sorted(entry.permissionIds),
      sourceFiles: sorted(entry.sourceFiles),
    }))
    .sort((left, right) => JSON.stringify(left.predicate).localeCompare(JSON.stringify(right.predicate)));

function classifyPermissionChange(oldCoversNew, newCoversOld, diagnostics) {
  if (oldCoversNew && newCoversOld) return 'unchanged';
  if (diagnostics.length) return 'indeterminate';
  if (newCoversOld) return 'wider';
  if (oldCoversNew) return 'narrower';
  return 'indeterminate';
}

function permissionDiffStatus(issues, summary) {
  if (issues.length || summary.indeterminate) return 'indeterminate';
  if (summary.wider && summary.narrower) return 'mixed';
  if (summary.wider) return 'wider';
  if (summary.narrower) return 'narrower';
  return 'unchanged';
}

/** Compare full buildPermissionModel outputs without reading rows, changing grants or contacting a service. */
export function comparePermissionModels(before, after) {
  let remaining = MAX_WORK;
  const work = (amount = 1) => {
    remaining -= amount;
    if (remaining < 0) throw new RangeError('Permission comparison exceeds the 1000000 work-unit budget.');
  };
  const leftContext = modelContext(before, 'before', work),
    rightContext = modelContext(after, 'after', work),
    diagnostics = [];
  for (const [key, code] of [
    ['source', 'PERMISSION_DIFF_SOURCE_CHANGED'],
    ['settings', 'PERMISSION_DIFF_SETTINGS_CHANGED'],
    ['defaults', 'PERMISSION_DIFF_DEFAULT_ROLES_CHANGED'],
    ['memberships', 'PERMISSION_DIFF_MEMBERSHIPS_CHANGED'],
    ['personas', 'PERMISSION_DIFF_PERSONAS_CHANGED'],
  ])
    if (!same(leftContext[key], rightContext[key])) diagnostics.push({ code });
  const left = normalize(before, 'before', diagnostics, work),
    right = normalize(after, 'after', diagnostics, work),
    summary = { wider: 0, narrower: 0, indeterminate: 0, unchanged: 0 },
    changes = [];
  for (const key of sorted([...left.keys(), ...right.keys()])) {
    work();
    const a = effectiveCell(left, key, work),
      b = effectiveCell(right, key, work),
      oldCoversNew = covers(a, b),
      newCoversOld = covers(b, a);
    const classification = classifyPermissionChange(oldCoversNew, newCoversOld, diagnostics);
    summary[classification]++;
    if (classification === 'unchanged') continue;
    const [roleId, entity, operation] = JSON.parse(key);
    changes.push({ roleId, entity, operation, classification, before: evidence(a), after: evidence(b) });
  }
  const issues = [...new Map(diagnostics.map((entry) => [JSON.stringify(entry), entry])).values()];
  const status = permissionDiffStatus(issues, summary);
  return {
    version: 1,
    domain: 'compiled-portal-table-grants',
    status,
    summary,
    changes,
    diagnostics: issues,
  };
}
