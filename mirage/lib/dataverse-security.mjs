// Simulated Dataverse security model: organization, business units, roles, privileges
// and the depth-based checks the Dataverse layer runs before it calls the store.
import { createHash } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { standardTable } from './solution-standard.mjs';

export const ACCESS_RIGHTS = { Read: 1, Write: 2, Append: 4, AppendTo: 16, Create: 32, Delete: 65536, Share: 262144, Assign: 524288 };
export const DEPTH = { Basic: 1, Local: 2, Deep: 4, Global: 8 };
export const PRIVILEGE_PREFIX = { Create: 'prvCreate', Read: 'prvRead', Write: 'prvWrite', Delete: 'prvDelete', Append: 'prvAppend', AppendTo: 'prvAppendTo', Assign: 'prvAssign', Share: 'prvShare' };
export const ACCESS_MODE = { ReadWrite: 0, Administrative: 1, Read: 2, SupportUser: 3, NonInteractive: 4, DelegatedAdmin: 5 };

const OPERATION_RIGHT = { read: 'Read', create: 'Create', update: 'Write', write: 'Write', delete: 'Delete', append: 'Append', appendto: 'AppendTo', assign: 'Assign', share: 'Share' };
const ORGANIZATION_EXCLUDED = new Set(['Assign', 'Share']);
const ROLE_NAMES = ['System Administrator', 'System Customizer', 'Basic User'];
const DEPTH_NAMES = ['Global', 'Deep', 'Local', 'Basic'];
const DEFAULT_OTC = 10000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TEXT = 'nvarchar', INT = 'int', BOOL = 'bit', LOOKUP = 'lookup', GUID = 'uniqueidentifier';
const nn = (target, from, to, via) => ({ entity: target, from, to, many: true, intersect: { entity: via, from, to } });
// ponytail: systemuser and team are user-owned in Dataverse; they are treated as organization-owned here.
const TABLE_DEFS = {
  organization: { set: 'organizations', id: 'organizationid', name: 'name', schemaName: 'Organization', fields: { organizationid: GUID, name: TEXT, uniquename: TEXT, friendlyname: TEXT } },
  businessunit: { set: standardTable('businessunit').entitySet, id: 'businessunitid', name: 'name', schemaName: 'BusinessUnit', fields: { businessunitid: GUID, name: TEXT, parentbusinessunitid: LOOKUP, organizationid: LOOKUP } },
  systemuser: { set: standardTable('systemuser').entitySet, id: 'systemuserid', name: 'fullname', schemaName: 'SystemUser', fields: { systemuserid: GUID, fullname: TEXT, domainname: TEXT, applicationid: GUID, azureactivedirectoryobjectid: GUID, accessmode: INT, isdisabled: BOOL, businessunitid: LOOKUP, organizationid: LOOKUP }, relationships: { systemuserroles_association: nn('role', 'systemuserid', 'roleid', 'systemuserroles') } },
  team: { set: standardTable('team').entitySet, id: 'teamid', name: 'name', schemaName: 'Team', fields: { teamid: GUID, name: TEXT, businessunitid: LOOKUP, organizationid: LOOKUP }, relationships: { teammembership_association: nn('systemuser', 'teamid', 'systemuserid', 'teammembership'), teamroles_association: nn('role', 'teamid', 'roleid', 'teamroles') } },
  role: { set: 'roles', id: 'roleid', name: 'name', schemaName: 'Role', fields: { roleid: GUID, name: TEXT, businessunitid: LOOKUP, organizationid: LOOKUP }, relationships: { roleprivileges_association: nn('privilege', 'roleid', 'privilegeid', 'roleprivileges') } },
  systemuserroles: { set: 'systemuserrolescollection', id: 'systemuserroleid', schemaName: 'SystemUserRoles', fields: { systemuserroleid: GUID, systemuserid: LOOKUP, roleid: LOOKUP } },
  teammembership: { set: 'teammemberships', id: 'teammembershipid', schemaName: 'TeamMembership', fields: { teammembershipid: GUID, systemuserid: LOOKUP, teamid: LOOKUP } },
  teamroles: { set: 'teamrolescollection', id: 'teamroleid', schemaName: 'TeamRoles', fields: { teamroleid: GUID, teamid: LOOKUP, roleid: LOOKUP } },
  roleprivileges: { set: 'roleprivilegescollection', id: 'roleprivilegeid', schemaName: 'RolePrivileges', fields: { roleprivilegeid: GUID, roleid: LOOKUP, privilegeid: LOOKUP, privilegedepthmask: INT } },
  privilege: { set: 'privileges', id: 'privilegeid', name: 'name', schemaName: 'Privilege', fields: { privilegeid: GUID, name: TEXT, accessright: INT, canbebasic: BOOL, canbelocal: BOOL, canbedeep: BOOL, canbeglobal: BOOL, canbeentityreference: BOOL, canbeparententityreference: BOOL, canberecordfilter: BOOL } },
};

const key = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value) ?? undefined;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const rootId = (organizationId) => uuidV5(organizationId, 'businessunit:root');

/** RFC 4122 version 5 (SHA-1, name-based) GUID, lowercase. */
export function uuidV5(namespace, name) {
  const hex = String(namespace).replace(/[{}-]/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new DataError(`Invalid namespace GUID: ${namespace}`, 400, 'InvalidRequest');
  const bytes = createHash('sha1').update(Buffer.from(hex, 'hex')).update(String(name), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function privilegeId(organizationId, name) {
  return uuidV5(organizationId, `privilege:${name}`);
}

/** privilegeName('Read', 'Account') or privilegeName('read', 'Account') -> 'prvReadAccount'. */
export function privilegeName(operation, schemaName) {
  const right = OPERATION_RIGHT[operation] ?? operation;
  if (!PRIVILEGE_PREFIX[right]) throw new DataError(`Unknown privilege operation ${operation}`, 400, 'InvalidRequest');
  return PRIVILEGE_PREFIX[right] + schemaName;
}

function ownershipKind(value) {
  if (value === undefined || value === null) return undefined;
  if (value === 1 || /^user/i.test(String(value))) return 'user';
  if (value === 8 || /^organi[sz]ation/i.test(String(value))) return 'org';
  return undefined;
}

/** 'user' | 'org'. Table object ownership, then mapping ownership, then an ownerid field marks user-owned. */
function ownershipOf(logical, table, mapping) {
  if (TABLE_DEFS[logical]) return 'org';
  return ownershipKind(table?.ownership) ?? ownershipKind(mapping?.ownership)
    ?? (Object.hasOwn(mapping?.fields ?? {}, 'ownerid') ? 'user' : 'org');
}

const schemaNameOf = (logical, table) => table?.schemaName ?? TABLE_DEFS[logical]?.schemaName ?? capitalize(logical);

function mappingFor(logical, def) {
  return {
    logicalName: logical,
    entitySet: def.set,
    idColumn: def.id,
    ...(def.name ? { nameColumn: def.name } : {}),
    userConfigured: true,
    fields: Object.fromEntries(Object.entries(def.fields).map(([field, type]) => [field, { dataverseType: type }])),
    relationships: def.relationships ?? {},
  };
}

const rowsOf = (store, logical) => (store.state.tables[logical] ??= []);

// Seeding is insert-only: an existing row is never rewritten, so administrator edits survive a re-seed.
function insertMissing(rows, idColumn, row) {
  if (!rows.some((r) => sameId(r[idColumn], row[idColumn]))) rows.push(row);
}

function lookupRow(store, logical, id) {
  const def = TABLE_DEFS[logical];
  // Accept a stored lookup object as well as a bare id (systemuser.businessunitid is a lookup).
  id = refId(id);
  const row = store.tableRows(logical).find((r) => sameId(r[def.id], id));
  if (!row) throw new DataError(`${logical} ${id} does not exist.`, 404, 'NotFound');
  return { id: row[def.id], logical_name: logical, name: row[def.name] ?? '' };
}

// Roles are given by built-in name or by GUID.
const roleIdOf = (organizationId, role) => (GUID_RE.test(role) ? role.toLowerCase() : uuidV5(organizationId, `role:${role}`));

function seedMappings(store) {
  for (const [logical, def] of Object.entries(TABLE_DEFS)) {
    const existing = store.state.mappings[logical];
    if (existing) existing.userConfigured = true;
    else store.state.mappings[logical] = mappingFor(logical, def);
    rowsOf(store, logical);
  }
}

function linkRole(store, userId, roleId) {
  const rows = rowsOf(store, 'systemuserroles');
  if (rows.some((r) => sameId(refId(r.systemuserid), userId) && sameId(refId(r.roleid), roleId))) return;
  rows.push({
    systemuserroleid: uuidV5(userId, roleId),
    systemuserid: lookupRow(store, 'systemuser', userId),
    roleid: lookupRow(store, 'role', roleId),
  });
}

function addUser(store, organizationId, id, fields, roles) {
  insertMissing(rowsOf(store, 'systemuser'), 'systemuserid', {
    systemuserid: id,
    ...fields,
    isdisabled: false,
    businessunitid: lookupRow(store, 'businessunit', rootId(organizationId)),
    organizationid: lookupRow(store, 'organization', organizationId),
  });
  for (const role of roles) linkRole(store, id, roleIdOf(organizationId, role));
  return id;
}

function applicationUser(store, settings, app) {
  return addUser(store, settings.organizationId, uuidV5(settings.organizationId, `systemuser:app:${app.appId}`), {
    fullname: app.displayName ?? app.appId,
    applicationid: app.appId,
    azureactivedirectoryobjectid: uuidV5(app.appId, 'sp'),
    domainname: `${app.appId}@${settings.tenantId}`,
    accessmode: ACCESS_MODE.NonInteractive,
  }, app.roles ?? []);
}

function interactiveUser(store, settings, user) {
  return addUser(store, settings.organizationId, uuidV5(settings.organizationId, `systemuser:oid:${user.objectId}`), {
    fullname: user.displayName ?? user.upn ?? user.objectId,
    domainname: user.upn ?? '',
    azureactivedirectoryobjectid: user.objectId,
    accessmode: ACCESS_MODE.ReadWrite,
  }, user.roles ?? []);
}

/** Table list for privilege generation: mapped tables, the ten security tables and schema tables. */
function tableInfo(store, schema) {
  const source = typeof schema === 'function' ? schema() : schema;
  const byName = new Map((source?.tables ?? []).map((t) => [t.logicalName, t]));
  const names = new Set([...Object.keys(store.state.mappings), ...Object.keys(TABLE_DEFS), ...byName.keys()]);
  return [...names].map((logical) => ({
    logical,
    own: ownershipOf(logical, byName.get(logical), store.state.mappings[logical]),
    schemaName: schemaNameOf(logical, byName.get(logical)),
  }));
}

/** Built-in role templates: admins Global on everything; Basic User Basic on user-owned, Global Read on org-owned. */
function templateGrants(p) {
  const admins = [['System Administrator', DEPTH.Global], ['System Customizer', DEPTH.Global]];
  if (!p.right) return admins;
  if (p.own === 'user') return [...admins, ['Basic User', DEPTH.Basic]];
  return p.right === 'Read' ? [...admins, ['Basic User', DEPTH.Global]] : admins;
}

function seedSecurity(store, settings, schema) {
  const org = settings.organizationId, root = rootId(org), name = settings.friendlyName ?? settings.uniqueName;
  seedMappings(store);
  insertMissing(rowsOf(store, 'organization'), 'organizationid', { organizationid: org, name, uniquename: settings.uniqueName, friendlyname: name });
  insertMissing(rowsOf(store, 'businessunit'), 'businessunitid', {
    businessunitid: root, name: settings.uniqueName, parentbusinessunitid: null, organizationid: lookupRow(store, 'organization', org),
  });
  const roleIds = {};
  for (const role of ROLE_NAMES) {
    roleIds[role] = roleIdOf(org, role);
    insertMissing(rowsOf(store, 'role'), 'roleid', {
      roleid: roleIds[role], name: role, businessunitid: lookupRow(store, 'businessunit', root), organizationid: lookupRow(store, 'organization', org),
    });
  }
  const privileges = [{ right: null, name: 'prvActOnBehalfOfAnotherUser', own: null }];
  for (const table of tableInfo(store, schema)) {
    for (const right of Object.keys(ACCESS_RIGHTS)) {
      if (table.own === 'user' || !ORGANIZATION_EXCLUDED.has(right)) privileges.push({ right, name: privilegeName(right, table.schemaName), own: table.own });
    }
  }
  for (const p of privileges) {
    const id = privilegeId(org, p.name), userOwned = p.own === 'user';
    insertMissing(rowsOf(store, 'privilege'), 'privilegeid', {
      privilegeid: id, name: p.name, accessright: p.right ? ACCESS_RIGHTS[p.right] : 0,
      canbebasic: userOwned, canbelocal: userOwned, canbedeep: userOwned, canbeglobal: true,
      canbeentityreference: false, canbeparententityreference: false, canberecordfilter: false,
    });
    for (const [role, depth] of templateGrants(p)) {
      insertMissing(rowsOf(store, 'roleprivileges'), 'roleprivilegeid', {
        roleprivilegeid: uuidV5(roleIds[role], id),
        roleid: lookupRow(store, 'role', roleIds[role]),
        privilegeid: lookupRow(store, 'privilege', id),
        privilegedepthmask: depth,
      });
    }
  }
  const systemUserId = addUser(store, org, uuidV5(org, 'systemuser:SYSTEM'), { fullname: 'SYSTEM', accessmode: ACCESS_MODE.NonInteractive }, []);
  const userIds = {};
  for (const app of settings.applications ?? []) userIds[app.appId] = applicationUser(store, settings, app);
  for (const user of settings.users ?? []) userIds[user.objectId] = interactiveUser(store, settings, user);
  return { organizationId: org, rootBusinessUnitId: root, systemUserId, roleIds, userIds };
}

/** Seeds the security tables. Async because store.transact is queued. */
export function ensureSecurityModel(store, settings, { schema } = {}) {
  return store.transact(() => {
    if (!GUID_RE.test(settings?.organizationId ?? '')) throw new DataError('A GUID organizationId is required.', 400, 'InvalidRequest');
    return seedSecurity(store, settings, schema);
  });
}

/** Creates or updates an application user and links its roles (names or role GUIDs). Returns systemuserid. */
export function createApplicationUser(store, settings, app) {
  return store.transact(() => applicationUser(store, settings, app));
}

export function assignRoles(store, { systemuserid, roleIds = [] }) {
  return store.transact(() => {
    for (const roleId of roleIds) linkRole(store, systemuserid, roleId);
    return { systemuserid, roleIds };
  });
}

// Derived indexes, rebuilt wholesale when store.dataRevision() changes.
// ponytail: whole-state rebuild per committed change; per-table indexes if tables grow large.
const indexes = new WeakMap();

function buildIndex(store) {
  const idx = {
    users: new Map(), byOid: new Map(), byApp: new Map(), byDomain: new Map(),
    roles: new Map(), privNames: new Map(), privIds: new Map(), grants: new Map(),
    direct: new Map(), teams: new Map(), teamRoles: new Map(), children: new Map(),
    roleSets: new Map(), privSets: new Map(), chains: new Map(),
  };
  const add = (map, k, v) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  };
  for (const u of store.tableRows('systemuser')) {
    idx.users.set(key(u.systemuserid), u);
    if (u.azureactivedirectoryobjectid) idx.byOid.set(key(u.azureactivedirectoryobjectid), u);
    if (u.applicationid) idx.byApp.set(key(u.applicationid), u);
    if (u.domainname) idx.byDomain.set(key(u.domainname), u);
  }
  for (const r of store.tableRows('role')) idx.roles.set(key(r.roleid), r);
  for (const p of store.tableRows('privilege')) {
    idx.privNames.set(key(p.privilegeid), p.name);
    idx.privIds.set(p.name, p.privilegeid);
  }
  for (const g of store.tableRows('roleprivileges')) add(idx.grants, key(refId(g.roleid)), { privilegeId: key(refId(g.privilegeid)), mask: Number(g.privilegedepthmask) });
  for (const a of store.tableRows('systemuserroles')) add(idx.direct, key(refId(a.systemuserid)), key(refId(a.roleid)));
  for (const m of store.tableRows('teammembership')) add(idx.teams, key(refId(m.systemuserid)), key(refId(m.teamid)));
  for (const t of store.tableRows('teamroles')) add(idx.teamRoles, key(refId(t.teamid)), key(refId(t.roleid)));
  for (const b of store.tableRows('businessunit')) {
    if (refId(b.parentbusinessunitid)) add(idx.children, key(refId(b.parentbusinessunitid)), key(b.businessunitid));
  }
  return idx;
}

function indexOf(store) {
  const revision = store.dataRevision();
  const hit = indexes.get(store);
  if (hit?.revision === revision) return hit.idx;
  const idx = buildIndex(store);
  indexes.set(store, { revision, idx });
  return idx;
}

const teamsOf = (idx, uid) => idx.teams.get(uid) ?? [];

function rolesOf(idx, uid) {
  if (!idx.roleSets.has(uid)) {
    const set = new Set(idx.direct.get(uid) ?? []);
    for (const team of teamsOf(idx, uid)) for (const role of idx.teamRoles.get(team) ?? []) set.add(role);
    idx.roleSets.set(uid, set);
  }
  return idx.roleSets.get(uid);
}

/** Map privilege name -> highest depth mask over direct and team roles. */
function privilegesOf(idx, uid) {
  if (!idx.privSets.has(uid)) {
    const map = new Map();
    for (const role of rolesOf(idx, uid)) {
      for (const g of idx.grants.get(role) ?? []) {
        const name = idx.privNames.get(g.privilegeId);
        if (name) map.set(name, Math.max(map.get(name) ?? 0, g.mask));
      }
    }
    idx.privSets.set(uid, map);
  }
  return idx.privSets.get(uid);
}

function chainOf(idx, root) {
  if (!idx.chains.has(root)) {
    const out = new Set(), stack = [root];
    while (stack.length) {
      const id = stack.pop();
      if (out.has(id)) continue;
      out.add(id);
      stack.push(...(idx.children.get(id) ?? []));
    }
    idx.chains.set(root, out);
  }
  return idx.chains.get(root);
}

/** Row-level check for a depth below Global. Rows without an owner or business unit are visible. */
function visible(idx, user, depth, row) {
  if (depth >= DEPTH.Global) return true;
  const uid = key(user.systemuserid), owner = key(refId(row.ownerid));
  if (depth < DEPTH.Local) return !owner || owner === uid || teamsOf(idx, uid).includes(owner);
  const bu = key(refId(row.owningbusinessunit)), userBu = key(refId(user.businessunitid));
  if (!bu) return true;
  return depth >= DEPTH.Deep ? chainOf(idx, userBu).has(bu) : bu === userBu;
}

const depthName = (mask) => DEPTH_NAMES.find((name) => mask & DEPTH[name]) ?? 'Basic';

function privilegeDenied(idx, settings, user, logical, name, schema) {
  const uid = user.systemuserid, uidKey = key(uid);
  const otc = settings?.objectTypeCode?.(logical) ?? DEFAULT_OTC;
  const label = schema?.displayName ?? logical;
  return new DataError(
    `Principal user (Id=${uid}, type=8, roleCount=${rolesOf(idx, uidKey).size}, privilegeCount=${privilegesOf(idx, uidKey).size}, accessMode=${user.accessmode ?? 0}), is missing ${name} privilege (Id=${idx.privIds.get(name) ?? ''}) on OTC=${otc} for entity '${logical}' (LocalizedName='${label}'). context.Caller=${uid}. Consider adding missing privilege to one of the principal (user/team) roles for the request to succeed.`,
    403, 'PrivilegeDenied', { innerCode: '0x80040220', privilege: name, entity: logical },
  );
}

function accessDenied(user, operation, row, idColumn, logical) {
  const right = OPERATION_RIGHT[operation] ?? operation;
  return new DataError(
    `Principal with ID ${user.systemuserid} does not have ${right}Access right(s) for record with ID ${row[idColumn]} of entity ${logical}.`,
    403, 'AccessDenied', { innerCode: '0x80048306' },
  );
}

/** Principal and privilege checks for the Dataverse layer. Read-only apart from the cached index. */
export function createPrincipals(store, settings = {}) {
  const idx = () => indexOf(store);
  const uidOf = (user) => key(typeof user === 'string' ? user : user?.systemuserid);

  // Returns the depth on success, throws PrivilegeDenied or AccessDenied otherwise.
  function check(user, entity, operation, { row, mapping, schema } = {}) {
    const m = mapping ?? store.resolveMapping(entity), logical = m.logicalName, index = idx();
    const name = privilegeName(operation, schemaNameOf(logical, schema));
    const depth = privilegesOf(index, key(user.systemuserid)).get(name);
    if (!depth) throw privilegeDenied(index, settings, user, logical, name, schema);
    if (row && depth < DEPTH.Global && ownershipOf(logical, schema, m) === 'user' && !visible(index, user, depth, row)) {
      throw accessDenied(user, operation, row, m.idColumn ?? `${logical}id`, logical);
    }
    return depth;
  }

  return {
    byId: (id) => idx().users.get(key(id)) ?? null,
    byObjectId: (oid) => idx().byOid.get(key(oid)) ?? null,
    byApplicationId: (appId) => idx().byApp.get(key(appId)) ?? null,
    byDomainName: (name) => idx().byDomain.get(key(name)) ?? null,

    /** Claims -> { user, reason }. reason: 'unknown' | 'disabled' | null. */
    resolve(claims = {}) {
      const index = idx();
      const appId = claims.appid ?? claims.azp, upn = claims.upn ?? claims.preferred_username;
      const user = (claims.oid ? index.byOid.get(key(claims.oid)) : undefined)
        ?? (appId ? index.byApp.get(key(appId)) : undefined)
        ?? (upn ? index.byDomain.get(key(upn)) : undefined) ?? null;
      if (!user) return { user: null, reason: 'unknown' };
      return { user, reason: user.isdisabled === true ? 'disabled' : null };
    },

    roles(user) {
      const index = idx();
      return [...rolesOf(index, uidOf(user))].map((id) => index.roles.get(id)).filter(Boolean).map((r) => ({ roleid: r.roleid, name: r.name }));
    },

    privileges(user) {
      return new Map(privilegesOf(idx(), uidOf(user)));
    },

    businessUnitChain(businessUnitId) {
      return new Set(chainOf(idx(), key(businessUnitId)));
    },

    /** Throws PrivilegeDenied (0x80040220) or AccessDenied (0x80048306); returns the depth. */
    authorize(options) {
      return check(options.user, options.entity, options.operation, options);
    },

    /** null when no row filter is needed (Global depth or organization-owned table). */
    readFilter({ user, entity, mapping, schema } = {}) {
      const depth = check(user, entity, 'read', { mapping, schema });
      const m = mapping ?? store.resolveMapping(entity);
      if (depth >= DEPTH.Global || ownershipOf(m.logicalName, schema, m) === 'org') return null;
      const index = idx();
      return (row) => visible(index, user, depth, row);
    },

    ownershipDefaults({ user, mapping, schema } = {}) {
      const ref = lookupRow(store, 'systemuser', user.systemuserid);
      const defaults = { createdby: ref, modifiedby: ref };
      if (ownershipOf(mapping.logicalName, schema, mapping) === 'user') {
        Object.assign(defaults, { ownerid: ref, owninguser: ref, owningbusinessunit: lookupRow(store, 'businessunit', user.businessunitid) });
      }
      return defaults;
    },

    modifiedBy({ user }) {
      return { modifiedby: lookupRow(store, 'systemuser', user.systemuserid) };
    },

    canImpersonate(user) {
      return privilegesOf(idx(), uidOf(user)).has('prvActOnBehalfOfAnotherUser');
    },

    /** One entry per role-privilege grant of the user's direct and team roles. */
    retrieveUserPrivileges(userId) {
      const index = idx(), out = [];
      for (const roleId of rolesOf(index, uidOf(userId))) {
        const businessUnitId = refId(index.roles.get(roleId)?.businessunitid) ?? null;
        for (const g of index.grants.get(roleId) ?? []) {
          const name = index.privNames.get(g.privilegeId);
          if (name) out.push({ Depth: depthName(g.mask), PrivilegeId: g.privilegeId, BusinessUnitId: businessUnitId, PrivilegeName: name, RecordFilterId: null, RecordFilterUniqueName: null });
        }
      }
      return out;
    },

    /** Comma-separated AccessRights flags, or 'None'. Create is table-level and needs no row. */
    principalAccess({ user, entity, row, mapping, schema } = {}) {
      const index = idx(), m = mapping ?? store.resolveMapping(entity), granted = privilegesOf(index, uidOf(user)), flags = [];
      for (const right of Object.keys(ACCESS_RIGHTS)) {
        const depth = granted.get(privilegeName(right, schemaNameOf(m.logicalName, schema)));
        if (!depth) continue;
        if (right === 'Create' || !row || ownershipOf(m.logicalName, schema, m) === 'org' || visible(index, user, depth, row)) flags.push(`${right}Access`);
      }
      return flags.length ? flags.join(', ') : 'None';
    },
  };
}
