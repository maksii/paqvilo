import { organizationRecord } from './organization-context.mjs';
// Simulated Dataverse security model: organization, business units, roles, privileges
// and the depth-based checks the Dataverse layer runs before it calls the store.
import { hash } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { standardTable } from './solution-standard.mjs';
import { relationshipsOf, standardTableDef } from './dataverse-standard.mjs';
import { guidKey } from './dataverse-values.mjs';
import { isDeepStrictEqual } from 'node:util';

export const ACCESS_RIGHTS = {
  Read: 1,
  Write: 2,
  Append: 4,
  AppendTo: 16,
  Create: 32,
  Delete: 65536,
  Share: 262144,
  Assign: 524288,
};
export const DEPTH = { Basic: 1, Local: 2, Deep: 4, Global: 8 };
const PRIVILEGE_PREFIX = {
  Create: 'prvCreate',
  Read: 'prvRead',
  Write: 'prvWrite',
  Delete: 'prvDelete',
  Append: 'prvAppend',
  AppendTo: 'prvAppendTo',
  Assign: 'prvAssign',
  Share: 'prvShare',
};
export const ACCESS_MODE = {
  ReadWrite: 0,
  Administrative: 1,
  Read: 2,
  SupportUser: 3,
  NonInteractive: 4,
  DelegatedAdmin: 5,
};

const OPERATION_RIGHT = {
  read: 'Read',
  create: 'Create',
  update: 'Write',
  write: 'Write',
  delete: 'Delete',
  append: 'Append',
  appendto: 'AppendTo',
  assign: 'Assign',
  share: 'Share',
};
const ORGANIZATION_EXCLUDED = new Set(['Assign', 'Share']);
const ROLE_NAMES = ['System Administrator', 'System Customizer', 'Basic User'];
// Miscellaneous privileges (no table). Granted at Global to System Administrator and System Customizer only,
// except the three System Administrator only privileges: the two bypass privileges and prvBulkDelete (a system
// administrator has BulkDelete by default; other users, System Customizer included, must be granted it).
const SYSTEM_ADMINISTRATOR_ONLY = new Set(['prvBypassCustomPlugins', 'prvBypassCustomBusinessLogic', 'prvBulkDelete']);
const GLOBAL_PRIVILEGES = [
  'prvActOnBehalfOfAnotherUser',
  'prvBypassCustomPlugins',
  'prvBypassCustomBusinessLogic',
  'prvBulkDelete',
  'prvReadRecordAuditHistory',
  'prvReadAuditSummary',
  'prvDeleteRecordChangeHistory',
  'prvCreateEntity',
  'prvReadEntity',
  'prvWriteEntity',
  'prvDeleteEntity',
  'prvCreateAttribute',
  'prvReadAttribute',
  'prvWriteAttribute',
  'prvDeleteAttribute',
  'prvReadbackgroundoperation',
  'prvWritebackgroundoperation',
  'prvExportCustomization',
  'prvImportCustomization',
];
const DEPTH_NAMES = ['Global', 'Deep', 'Local', 'Basic'];
const DEFAULT_OTC = 10000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// team.membershiptype: the Entra group match for a group team (Members and guests is the default).
export const TEAM_MEMBERSHIP = { MembersAndGuests: 0, Members: 1, Owners: 2, Guests: 3 };
const DEFAULT_HIERARCHY_DEPTH = 3;
const HIERARCHY_LIMIT = 100;

const TEXT = 'nvarchar',
  INT = 'int',
  BOOL = 'bit',
  LOOKUP = 'lookup',
  GUID = 'uniqueidentifier';
const nn = (target, from, to, via) => ({ entity: target, from, to, many: true, intersect: { entity: via, from, to } });
// ponytail: systemuser and team are user-owned in Dataverse; they are treated as organization-owned here.
const TABLE_DEFS = {
  organization: {
    set: 'organizations',
    id: 'organizationid',
    name: 'name',
    schemaName: 'Organization',
    fields: {
      organizationid: GUID,
      name: TEXT,
      uniquename: TEXT,
      friendlyname: TEXT,
      isauditenabled: BOOL,
      isduplicatedetectionenabled: BOOL,
      localeid: INT,
      languagecode: INT,
    },
  },
  businessunit: {
    set: standardTable('businessunit').entitySet,
    id: 'businessunitid',
    name: 'name',
    schemaName: 'BusinessUnit',
    fields: { businessunitid: GUID, name: TEXT, parentbusinessunitid: LOOKUP, organizationid: LOOKUP },
  },
  systemuser: {
    set: standardTable('systemuser').entitySet,
    id: 'systemuserid',
    name: 'fullname',
    schemaName: 'SystemUser',
    fields: {
      systemuserid: GUID,
      fullname: TEXT,
      domainname: TEXT,
      internalemailaddress: TEXT,
      applicationid: GUID,
      azureactivedirectoryobjectid: GUID,
      accessmode: INT,
      isdisabled: BOOL,
      businessunitid: LOOKUP,
      organizationid: LOOKUP,
      parentsystemuserid: LOOKUP,
    },
    relationships: { systemuserroles_association: nn('role', 'systemuserid', 'roleid', 'systemuserroles') },
  },
  // teamtype: 0 Owner, 1 Access, 2 Security group, 3 Office group. Access teams own no records and hold no roles.
  team: {
    set: standardTable('team').entitySet,
    id: 'teamid',
    name: 'name',
    schemaName: 'Team',
    fields: {
      teamid: GUID,
      name: TEXT,
      businessunitid: LOOKUP,
      organizationid: LOOKUP,
      teamtype: INT,
      membershiptype: INT,
      azureactivedirectoryobjectid: GUID,
      administratorid: LOOKUP,
      teamtemplateid: LOOKUP,
      systemmanaged: BOOL,
    },
    relationships: {
      teammembership_association: nn('systemuser', 'teamid', 'systemuserid', 'teammembership'),
      teamroles_association: nn('role', 'teamid', 'roleid', 'teamroles'),
    },
    alternateKeys: [
      { name: 'team_aadobjectid_membershiptype', attributes: ['azureactivedirectoryobjectid', 'membershiptype'] },
    ],
  },
  // isinherited: 0 Team privileges only, 1 Direct User (Basic) access level and Team privileges (the default).
  role: {
    set: 'roles',
    id: 'roleid',
    name: 'name',
    schemaName: 'Role',
    fields: { roleid: GUID, name: TEXT, businessunitid: LOOKUP, organizationid: LOOKUP, isinherited: INT },
    relationships: { roleprivileges_association: nn('privilege', 'roleid', 'privilegeid', 'roleprivileges') },
  },
  systemuserroles: {
    set: 'systemuserrolescollection',
    id: 'systemuserroleid',
    schemaName: 'SystemUserRoles',
    fields: { systemuserroleid: GUID, systemuserid: LOOKUP, roleid: LOOKUP },
  },
  teammembership: {
    set: 'teammemberships',
    id: 'teammembershipid',
    schemaName: 'TeamMembership',
    fields: { teammembershipid: GUID, systemuserid: LOOKUP, teamid: LOOKUP },
  },
  teamroles: {
    set: 'teamrolescollection',
    id: 'teamroleid',
    schemaName: 'TeamRoles',
    fields: { teamroleid: GUID, teamid: LOOKUP, roleid: LOOKUP },
  },
  roleprivileges: {
    set: 'roleprivilegescollection',
    id: 'roleprivilegeid',
    schemaName: 'RolePrivileges',
    fields: { roleprivilegeid: GUID, roleid: LOOKUP, privilegeid: LOOKUP, privilegedepthmask: INT },
  },
  privilege: {
    set: 'privileges',
    id: 'privilegeid',
    name: 'name',
    schemaName: 'Privilege',
    fields: {
      privilegeid: GUID,
      name: TEXT,
      accessright: INT,
      canbebasic: BOOL,
      canbelocal: BOOL,
      canbedeep: BOOL,
      canbeglobal: BOOL,
      canbeentityreference: BOOL,
      canbeparententityreference: BOOL,
      canberecordfilter: BOOL,
    },
  },
  principalobjectaccess: {
    set: 'principalobjectaccessset',
    id: 'principalobjectaccessid',
    schemaName: 'PrincipalObjectAccess',
    fields: {
      principalobjectaccessid: GUID,
      principalid: LOOKUP,
      objectid: GUID,
      objecttypecode: TEXT,
      accessrightsmask: INT,
      inheritedaccessrightsmask: INT,
    },
  },
  transactioncurrency: {
    set: 'transactioncurrencies',
    id: 'transactioncurrencyid',
    name: 'currencyname',
    schemaName: 'TransactionCurrency',
    fields: {
      transactioncurrencyid: GUID,
      currencyname: TEXT,
      isocurrencycode: TEXT,
      currencysymbol: TEXT,
      currencyprecision: INT,
      exchangerate: 'decimal',
      organizationid: LOOKUP,
    },
  },
};

export const baseCurrencyId = (organizationId) => uuidV5(organizationId, 'transactioncurrency:base');

const key = (value) => guidKey(value) ?? String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value) ?? undefined;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const rootId = (organizationId) => uuidV5(organizationId, 'businessunit:root');
// Impersonation: the caller differs from the user the write is made as.
const onBehalf = (user, caller) => Boolean(caller) && key(caller.systemuserid) !== key(user.systemuserid);
// Keeps only the keys a mapping declares, when it declares fields at all.
const declaredOnly = (values, mapping) =>
  mapping?.fields
    ? Object.fromEntries(Object.entries(values).filter(([name]) => Object.hasOwn(mapping.fields, name)))
    : values;
const namespaceBytes = new Map();
/** RFC 4122 version 5 (SHA-1, name-based) GUID, lowercase. */
export function uuidV5(namespace, name) {
  let prefix = namespaceBytes.get(namespace);
  if (!prefix) {
    const hex = String(namespace).replace(/[{}-]/g, '');
    if (!/^[0-9a-f]{32}$/i.test(hex))
      throw new DataError(`Invalid namespace GUID: ${namespace}`, 400, 'InvalidRequest');
    prefix = Buffer.from(hex, 'hex');
    // A process sees a few namespaces (its organizations and fixed ones); the bound only caps memory.
    if (typeof namespace === 'string' && namespaceBytes.size < 256) namespaceBytes.set(namespace, prefix);
  }
  // One-shot SHA-1 of the namespace bytes and the UTF-8 name: the same digest without a Hash object per id.
  const bytes = hash('sha1', Buffer.concat([prefix, Buffer.from(String(name), 'utf8')]), 'buffer').subarray(0, 16);
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
export function ownershipOf(logical, table, mapping) {
  if (TABLE_DEFS[logical]) return 'org';
  return (
    ownershipKind(table?.ownership) ??
    ownershipKind(mapping?.ownership) ??
    (Object.hasOwn(mapping?.fields ?? {}, 'ownerid') ? 'user' : 'org')
  );
}

/** Dataverse OwnershipType name for metadata: the standard file's value for a standard table; else the ten security tables report BusinessOwned. */
export function ownershipTypeName(logical, table, mapping) {
  const standard = standardTableDef(logical)?.ownershipType;
  if (standard && !table?.ownership) return standard;
  if (TABLE_DEFS[logical]) return 'BusinessOwned';
  return ownershipOf(logical, table, mapping) === 'user' ? 'UserOwned' : 'OrganizationOwned';
}

// A table's SchemaName: its Solution schema entry, else the mapping's dataverseMetadata (a Solution or metadata-API table keeps it there),
// else the security table, else the standard file, else the capitalised logical name.
const schemaNameOf = (logical, table, mapping) =>
  table?.schemaName ??
  mapping?.dataverseMetadata?.schemaName ??
  TABLE_DEFS[logical]?.schemaName ??
  standardTableDef(logical)?.schemaName ??
  capitalize(logical);
// Privilege noun where it differs from the table SchemaName: systemuser privileges are prvReadUser, prvWriteUser, and so on.
// Notes are prvReadNote and email templates prvReadEmailTemplate. activitypointer is the Activity noun (see privilegeNounOf).
const PRIVILEGE_NOUN = {
  systemuser: 'User',
  annotation: 'Note',
  template: 'EmailTemplate',
  activitypointer: 'Activity',
};
// Platform tables the simulator's modules seed (not Solution content), by their documented SchemaName.
const PLATFORM_NOUN = {
  asyncoperation: 'AsyncOperation',
  bulkdeleteoperation: 'BulkDeleteOperation',
  bulkdeletefailure: 'BulkDeleteFailure',
  backgroundoperation: 'BackgroundOperation',
  audit: 'Audit',
  customapi: 'CustomAPI',
  customapirequestparameter: 'CustomAPIRequestParameter',
  customapiresponseproperty: 'CustomAPIResponseProperty',
  duplicaterule: 'DuplicateRule',
  duplicaterulecondition: 'DuplicateRuleCondition',
  fieldsecurityprofile: 'FieldSecurityProfile',
  fieldpermission: 'FieldPermission',
  principalobjectattributeaccess: 'PrincipalObjectAttributeAccess',
  savedquery: 'SavedQuery',
  userquery: 'UserQuery',
  teamtemplate: 'TeamTemplate',
  queueitem: 'QueueItem',
  environmentvariablevalue: 'EnvironmentVariableValue',
};
// Core-authored identity and platform state stays owned by the organization
// even when a Solution/config supplied its mapping before bootstrap.
export const isOrganizationTable = (logical) =>
  Object.hasOwn(TABLE_DEFS, logical) || Object.hasOwn(PLATFORM_NOUN, logical);
// Intersect tables own no privileges; Dataverse checks the parent table's (the table whose relationship they serve).
// Activity parties follow their activity: the Activity privileges, tested against the activity row (see parentRowOf).
// The other None-owned tables below take their parent's privileges too (OwnershipType None with a lookup to the parent; the
// privilege mapping itself is assumed). Their privileges are not seeded (tableInfo).
const INTERSECT_PARENT = {
  systemuserroles: 'systemuser',
  teammembership: 'team',
  teamroles: 'team',
  roleprivileges: 'role',
  activityparty: 'activitypointer',
  calendarrule: 'calendar',
  appmodulecomponent: 'appmodule',
  attributemaskingrule: 'maskingrule',
  workflowlog: 'workflow',
  activitymimeattachment: 'activitypointer',
  solutioncomponent: 'solution',
  dependency: 'solution',
  // None-owned tables and queue membership (intersect rows), each under its parent's privileges.
  queuemembership: 'queue',
  postregarding: 'post',
  privilegecheckerlog: 'privilegecheckerrun',
  knowledgearticleviews: 'knowledgearticle',
  processstage: 'workflow',
  reportcategory: 'report',
  rollupfield: 'metric',
  duplicaterecord: 'duplicaterule',
  columnmapping: 'importmap',
  picklistmapping: 'importmap',
  lookupmapping: 'importmap',
  ownermapping: 'importmap',
  importentitymapping: 'importmap',
  transformationmapping: 'importmap',
  transformationparametermapping: 'importmap',
  msdyn_aiconfiguration: 'msdyn_aimodel',
};
// Timezone tables are platform reads open to every enabled user without a privilege (assumed; not documented).
const PUBLIC_READ = new Set(['timezonedefinition', 'timezonerule', 'timezonelocalizedname']);
// Customer addresses follow their parent account or contact (objecttypecode). Without a row (create, lists) either parent's privilege passes.
// ponytail: create (no row) checks either parent's privilege, not the body's parent; records would need to pass the body to narrow it.
const FOLLOWS_PARENT = new Set(['activityparty', 'customeraddress']);
const ADDRESS_PARENTS = ['account', 'contact'];
// Activity tables (isActivity in the standard file) check the activitypointer privileges: prvReadActivity, prvCreateActivity, and so on.
const isActivityTable = (logical) => standardTableDef(logical)?.isActivity === true;
const privilegeParent = (logical) =>
  INTERSECT_PARENT[logical] ??
  (logical !== 'activitypointer' && isActivityTable(logical) ? 'activitypointer' : undefined);
// The one resolver for a table's privilege noun. Callers that have the Solution schema entry pass it as `table`; the mapping
// (which a Solution import fills with dataverseMetadata.schemaName) is enough on its own.
export const privilegeNounOf = (logical, table, mapping) => {
  const parent = privilegeParent(logical);
  return parent
    ? privilegeNounOf(parent)
    : (PRIVILEGE_NOUN[logical] ?? PLATFORM_NOUN[logical] ?? schemaNameOf(logical, table, mapping));
};
// The Solution schema entry of a table; `schema` is the schema itself or a function returning it.
const schemaTableOf = (schema, logical) => (typeof schema === 'function' ? schema() : schema)?.tables?.[logical];

// Platform tables get only the Basic User depths listed here, per right; every other right on them is none for Basic User.
// System Job (AsyncOperation) is user-owned, so Basic reads only its own rows and its teams'. The userquery depths and the
// savedquery Global read are assumed (a published Basic User baseline lists userquery Read, Write and Create at Basic).
const PLATFORM_BASIC = {
  asyncoperation: { Read: DEPTH.Basic },
  userquery: {
    Create: DEPTH.Basic,
    Read: DEPTH.Basic,
    Write: DEPTH.Basic,
    Delete: DEPTH.Basic,
    Append: DEPTH.Basic,
    AppendTo: DEPTH.Basic,
    Assign: DEPTH.Basic,
    Share: DEPTH.Basic,
  },
  savedquery: { Read: DEPTH.Global },
};
// Everything else in PLATFORM_NOUN gets no Basic User grant: bulkdeleteoperation, bulkdeletefailure,
// backgroundoperation, audit (its reads are the miscellaneous prvReadAuditSummary and prvReadRecordAuditHistory, administrators only),
// the custom API tables, duplicaterule(condition), the field security tables, teamtemplate, queueitem and environmentvariablevalue
// (organization depth for the administrators only; those depths are assumed).
const PLATFORM_TABLES = new Set(Object.keys(PLATFORM_NOUN));

function mappingFor(logical, def) {
  return {
    logicalName: logical,
    entitySet: def.set,
    idColumn: def.id,
    ...(def.name ? { nameColumn: def.name } : {}),
    userConfigured: true,
    // Seeded for the Dataverse API only: the portal Web API resolver ignores these sets (webapi-handler resolveSet).
    dataverseOnly: true,
    fields: Object.fromEntries(Object.entries(def.fields).map(([field, type]) => [field, { dataverseType: type }])),
    relationships: def.relationships ?? {},
    ...(def.alternateKeys ? { alternateKeys: def.alternateKeys } : {}),
  };
}

// These indexes live only for a synchronous seed inside the caller's transaction.
// Never retain indexes across administrator edits, replacement or rollback.
const seedFrames = new WeakMap(),
  seedRows = new WeakMap();
function rowsOf(store, logical) {
  const rows = (store.state.tables[logical] ??= []);
  const frame = seedFrames.get(store),
    def = TABLE_DEFS[logical];
  if (frame && def && !seedRows.has(rows)) {
    const index = new Map();
    for (const row of rows) {
      const id = key(row[def.id]);
      const existing = index.get(id);
      if (existing && !isDeepStrictEqual(seedIdentity(existing), seedIdentity(row)))
        throw new DataError(
          `Conflicting equivalent IDs in security table ${logical}.`,
          409,
          'SecuritySeedIdentityConflict',
        );
      if (!existing) index.set(id, row);
    }
    seedRows.set(rows, index);
    frame.push(rows);
  }
  return rows;
}
// Compare reference IDs too, while retaining every administrator-controlled value.
function seedIdentity(value) {
  if (Array.isArray(value)) return value.map(seedIdentity);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, seedIdentity(item)]));
  return guidKey(value) ?? value;
}
function withSeedIndexes(store, fn) {
  if (seedFrames.has(store)) return fn();
  const frame = [];
  seedFrames.set(store, frame);
  try {
    return fn();
  } finally {
    for (const rows of frame) seedRows.delete(rows);
    seedFrames.delete(store);
  }
}

// Seeding is insert-only: an existing row is never rewritten, so administrator edits survive a re-seed.
function insertMissing(rows, idColumn, row) {
  const index = seedRows.get(rows),
    id = key(row[idColumn]);
  if (index ? !index.has(id) : !rows.some((r) => sameId(r[idColumn], row[idColumn]))) {
    rows.push(row);
    index?.set(id, row);
  }
}

function removeWhere(rows, predicate) {
  for (let i = rows.length - 1; i >= 0; i--) if (predicate(rows[i])) rows.splice(i, 1);
}

/** The organization's base currency row, found by its id (never by position: a portal table may list other currencies first). */
export function baseCurrencyRow(store, organizationId) {
  if (!GUID_RE.test(organizationId ?? '')) return null;
  const id = baseCurrencyId(organizationId);
  return (store.state.tables.transactioncurrency ?? []).find((row) => sameId(row.transactioncurrencyid, id)) ?? null;
}

function rowOf(store, logical, id) {
  const def = TABLE_DEFS[logical];
  // Accept a stored lookup object as well as a bare id (systemuser.businessunitid is a lookup).
  id = refId(id);
  const rows = seedFrames.has(store) ? rowsOf(store, logical) : store.tableRows(logical);
  const index = seedRows.get(rows);
  const row = index ? index.get(key(id)) : rows.find((r) => sameId(r[def.id], id));
  if (!row) throw new DataError(`${logical} ${id} does not exist.`, 404, 'NotFound');
  return row;
}

function lookupRow(store, logical, id) {
  const row = rowOf(store, logical, id);
  return { id: row[TABLE_DEFS[logical].id], logical_name: logical, name: row[TABLE_DEFS[logical].name] ?? '' };
}

/** Owner columns for a row owned by a systemuser or team: ownerid, the matching owning column (the other null) and the owner's business unit. */
export function ownerColumns(store, ownerRef) {
  const logical = ownerRef?.logical_name;
  if (logical !== 'systemuser' && logical !== 'team')
    throw new DataError(`Owner must be a systemuser or team, not ${logical}.`, 400, 'InvalidRequest');
  const ref = lookupRow(store, logical, ownerRef.id);
  const row = rowOf(store, logical, ownerRef.id);
  return {
    ownerid: ref,
    owninguser: logical === 'systemuser' ? ref : null,
    owningteam: logical === 'team' ? ref : null,
    owningbusinessunit: refId(row.businessunitid) ? lookupRow(store, 'businessunit', row.businessunitid) : null,
  };
}

// Roles are given by built-in name or by GUID.
const roleIdOf = (organizationId, role) =>
  GUID_RE.test(role) ? role.toLowerCase() : uuidV5(organizationId, `role:${role}`);

// An existing mapping (from a Solution or the user) is left exactly as it is: no flags, no dataverseOnly.
function seedMappings(store) {
  for (const [logical, def] of Object.entries(TABLE_DEFS)) {
    store.state.mappings[logical] ??= mappingFor(logical, def);
    rowsOf(store, logical);
  }
}

function linkRole(store, userId, roleId) {
  const rows = rowsOf(store, 'systemuserroles');
  const frame = seedFrames.get(store),
    pair = key(userId) + '/' + key(roleId);
  if (frame && !frame.roleLinks)
    frame.roleLinks = new Set(rows.map((row) => key(refId(row.systemuserid)) + '/' + key(refId(row.roleid))));
  if (
    frame
      ? frame.roleLinks.has(pair)
      : rows.some((r) => sameId(refId(r.systemuserid), userId) && sameId(refId(r.roleid), roleId))
  )
    return;
  const row = {
    systemuserroleid: uuidV5(userId, roleId),
    systemuserid: lookupRow(store, 'systemuser', userId),
    roleid: lookupRow(store, 'role', roleId),
  };
  rows.push(row);
  seedRows.get(rows)?.set(key(row.systemuserroleid), row);
  frame?.roleLinks.add(pair);
}

function addUser(store, organizationId, id, fields, roles) {
  insertMissing(rowsOf(store, 'systemuser'), 'systemuserid', {
    systemuserid: id,
    ...fields,
    isdisabled: false,
    businessunitid: lookupRow(store, 'businessunit', rootId(organizationId)),
    organizationid: lookupRow(store, 'organization', organizationId),
  });
  for (const role of roles) linkRole(store, id, roleIdByName(store, organizationId, role));
  return id;
}

// A role named by a user is a built-in role, a GUID, or a role row of that name (a Solution role keeps its Solution id).
function roleIdByName(store, organizationId, role) {
  if (GUID_RE.test(role) || ROLE_NAMES.includes(role)) return roleIdOf(organizationId, role);
  return rowsOf(store, 'role').find((row) => key(row.name) === key(role))?.roleid ?? roleIdOf(organizationId, role);
}

// Privilege depth names of a Solution role file -> privilegedepthmask (Basic 1, Local 2, Deep 4, Global 8).
const depthMaskOf = (depth) =>
  DEPTH[Object.keys(DEPTH).find((name) => key(name) === key(depth))] ??
  (Number.isInteger(Number(depth)) && Object.values(DEPTH).includes(Number(depth)) ? Number(depth) : null);
const grantSignature = (store, roleId) =>
  rowsOf(store, 'roleprivileges')
    .filter((g) => sameId(refId(g.roleid), roleId))
    .map((g) => `${key(refId(g.privilegeid))}:${g.privilegedepthmask}`)
    .sort()
    .join('|');

// An uninstall restores a role or field security profile from its layer stack (dataverse-solution-messages.mjs popLayers
// through SECURITY_LAYERS: the layer below, or the component, its grants and its user/team associations removed with the last layer).
/**
 * Replaces a role's roleprivileges with grants ([{ privilegeid, mask }]) and returns the role's new grant signature (the
 * `applied` mark of its securityrole layer). Shared by importSolutionSecurity and the uninstall restore.
 */
export function applyRoleGrants(store, roleid, grants) {
  removeWhere(rowsOf(store, 'roleprivileges'), (g) => sameId(refId(g.roleid), roleid));
  for (const grant of grants) {
    const id = uuidV5(roleid, grant.privilegeid);
    rowsOf(store, 'roleprivileges').push({
      roleprivilegeid: id,
      roleid: lookupRow(store, 'role', roleid),
      privilegeid: lookupRow(store, 'privilege', grant.privilegeid),
      privilegedepthmask: grant.mask,
    });
  }
  seedRows.delete(rowsOf(store, 'roleprivileges')); // the seed index no longer matches the rewritten rows
  return grantSignature(store, roleid);
}

/** Removes a role row, its roleprivileges and its user/team role associations (the last managed layer was uninstalled). */
export function removeRoleGrants(store, roleid) {
  for (const table of ['roleprivileges', 'systemuserroles', 'teamroles'])
    removeWhere(rowsOf(store, table), (g) => sameId(refId(g.roleid), roleid));
  removeWhere(rowsOf(store, 'role'), (r) => sameId(r.roleid, roleid));
  for (const table of ['roleprivileges', 'systemuserroles', 'teamroles', 'role']) seedRows.delete(rowsOf(store, table));
}

const permissionSignature = (store, profileId) =>
  rowsOf(store, 'fieldpermission')
    .filter((p) => sameId(refId(p.fieldsecurityprofileid), profileId))
    .map(
      (p) =>
        `${key(p.entityname)}:${key(p.attributelogicalname)}:${p.canread}:${p.cancreate}:${p.canupdate}:${p.canreadunmasked}`,
    )
    .sort()
    .join('|');

/** Replaces a field security profile's fieldpermission rows and returns its permission signature (the layer's `applied` mark). */
function applyProfilePermissions(store, profileId, permissions) {
  const rows = rowsOf(store, 'fieldpermission');
  const profile = rowsOf(store, 'fieldsecurityprofile').find((p) => sameId(p.fieldsecurityprofileid, profileId));
  const ref = { id: profileId, logical_name: 'fieldsecurityprofile', name: profile?.name };
  removeWhere(rows, (p) => sameId(refId(p.fieldsecurityprofileid), profileId));
  for (const permission of permissions) {
    rows.push({
      fieldpermissionid: permission.id ?? uuidV5(profileId, `${permission.entity}:${permission.attribute}`),
      fieldsecurityprofileid: ref,
      entityname: permission.entity,
      attributelogicalname: permission.attribute,
      canread: permission.canread,
      cancreate: permission.cancreate,
      canupdate: permission.canupdate,
      canreadunmasked: permission.canreadunmasked,
    });
  }
  return permissionSignature(store, profileId);
}

/** Removes a field security profile row, its fieldpermission rows and its systemuserprofiles/teamprofiles associations. */
function removeProfile(store, profileId) {
  for (const table of ['fieldpermission', 'systemuserprofiles', 'teamprofiles'])
    removeWhere(rowsOf(store, table), (p) => sameId(refId(p.fieldsecurityprofileid), profileId));
  removeWhere(rowsOf(store, 'fieldsecurityprofile'), (p) => sameId(p.fieldsecurityprofileid, profileId));
}

/** The one security-layer table: how popLayers restores a lower layer's body ([apply]) or removes the component ([remove]). */
export const SECURITY_LAYERS = Object.freeze({
  securityrole: { apply: applyRoleGrants, remove: removeRoleGrants, signature: grantSignature },
  fieldsecurityprofile: { apply: applyProfilePermissions, remove: removeProfile, signature: permissionSignature },
});

// A managed definition is a layer on the component's stack; it is applied unless the component was changed after its last
// import (an unmanaged layer on top, activeOnTop), which stays. An unmanaged definition is applied the same way but adds no layer.
function pushSecurityLayer(store, org, kind, id, name, managed, solutionid, body) {
  const { apply, signature } = SECURITY_LAYERS[kind];
  const layers = ((store.state.dataverse ??= {}).managedLayers ??= {});
  const record = (layers[key(uuidV5(org, `${kind}:${id}`))] ??= {
    kind,
    logical: id,
    name,
    stack: [],
    activeOnTop: false,
    seq: 0,
  });
  const customized = record.applied != null && signature(store, id) !== record.applied;
  if (!customized) record.applied = apply(store, id, body);
  record.activeOnTop = customized;
  const entry = { solutionid, version: null, body, seq: 0 };
  const at = record.stack.findIndex((item) => sameId(item.solutionid, solutionid));
  if (managed) {
    if (at >= 0) record.stack[at] = entry;
    else record.stack.push(entry);
  }
}

/**
 * Imports Solution security definitions (solution-inventory.mjs securityDefinitions) into the security tables:
 * - a role row under the root business unit, keeping the Solution's role id, with its roleprivileges resolved by privilege name;
 *   an unknown privilege name is skipped and reported (SOLUTION_ROLE_PRIVILEGE_UNKNOWN), never granted;
 * - a field security profile row, keeping its Solution id, with its fieldpermission rows.
 * Users and teams get the roles and profiles from project data (settings users' roles, /_sim/, the Web API associations).
 * A managed definition is a layer on the role's stack (state.dataverse.managedLayers, kind securityrole): a new definition
 * replaces the privilege set (the platform's replace behavior for custom security roles) unless the
 * role was changed after the last import (AddPrivilegesRole, ReplacePrivilegesRole: an unmanaged layer on top), which stays.
 * An unmanaged definition is applied when the role is new or unchanged since its last import. Returns the diagnostics.
 */
export function importSolutionSecurity(
  store,
  organizationId,
  { securityRoles = [], fieldSecurityProfiles = [] } = {},
  { solutionId = null } = {},
) {
  const org = organizationId,
    root = rootId(org);
  const diagnostics = [];
  const privileges = new Map(rowsOf(store, 'privilege').map((row) => [key(row.name), row]));
  for (const role of securityRoles) {
    const roleid = key(role.id ?? '') && GUID_RE.test(role.id) ? key(role.id) : roleIdOf(org, role.name);
    insertMissing(rowsOf(store, 'role'), 'roleid', {
      roleid,
      name: role.name,
      businessunitid: lookupRow(store, 'businessunit', root),
      organizationid: lookupRow(store, 'organization', org),
    });
    const row = rowsOf(store, 'role').find((r) => sameId(r.roleid, roleid));
    Object.assign(row, {
      name: role.name,
      ismanaged: role.managed === true,
      ...(solutionId ? { solutionid: solutionId } : {}),
    });
    const grants = [];
    for (const privilege of role.privileges ?? []) {
      const found = privileges.get(key(privilege.name)),
        mask = depthMaskOf(privilege.depth);
      if (!found || mask == null) {
        diagnostics.push({
          code: 'SOLUTION_ROLE_PRIVILEGE_UNKNOWN',
          severity: 'warning',
          role: role.name,
          privilege: privilege.name,
          message: `Role ${role.name}: ${found ? `depth ${privilege.depth} is not Basic, Local, Deep or Global` : `privilege ${privilege.name} does not exist in this organization`}; it is not granted.`,
        });
        continue;
      }
      grants.push({ privilegeid: found.privilegeid, mask });
    }
    pushSecurityLayer(
      store,
      org,
      'securityrole',
      roleid,
      role.name,
      role.managed === true,
      solutionId ?? role.solution ?? null,
      grants,
    );
  }
  const profileRows = rowsOf(store, 'fieldsecurityprofile');
  for (const profile of fieldSecurityProfiles) {
    const profileId =
      profile.id && GUID_RE.test(profile.id)
        ? key(profile.id)
        : uuidV5(org, `fieldsecurityprofile:${key(profile.name)}`);
    let row = profileRows.find((p) => sameId(p.fieldsecurityprofileid, profileId));
    if (!row) profileRows.push((row = { fieldsecurityprofileid: profileId }));
    Object.assign(row, {
      name: profile.name,
      ismanaged: profile.managed === true,
      ...(solutionId ? { solutionid: solutionId } : {}),
    });
    // The definition replaces the profile's permissions, as a managed import replaces a role's privileges.
    pushSecurityLayer(
      store,
      org,
      'fieldsecurityprofile',
      profileId,
      profile.name,
      profile.managed === true,
      solutionId ?? profile.solution ?? null,
      profile.permissions ?? [],
    );
  }
  return diagnostics;
}

function applicationUser(store, settings, app) {
  return addUser(
    store,
    settings.organizationId,
    uuidV5(settings.organizationId, `systemuser:app:${app.appId}`),
    {
      fullname: app.displayName ?? app.appId,
      applicationid: app.appId,
      azureactivedirectoryobjectid: uuidV5(app.appId, 'sp'),
      domainname: `${app.appId}@${settings.tenantId}`,
      accessmode: ACCESS_MODE.NonInteractive,
    },
    app.roles ?? [],
  );
}

// Same fixed namespace dataverse-settings.mjs uses for its default objectId.
const USER_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

// A settings user without objectId gets a stable id from the tenant (or organization) GUID and its domain name;
// without a GUID namespace the fixed namespace above is used, so this never throws for a missing GUID.
function interactiveObjectId(settings, user) {
  if (user.objectId) return user.objectId;
  const domain = (user.domainname ?? user.upn ?? '').toLowerCase();
  if (!domain) throw new DataError('A settings user needs an objectId, domainname or upn.', 400, 'InvalidRequest');
  const tenant = settings.tenantId ?? settings.organizationId;
  return GUID_RE.test(tenant ?? '')
    ? uuidV5(tenant, `user:${domain}`)
    : uuidV5(USER_NAMESPACE, `paqvilo-dataverse-user:${domain}`);
}

function interactiveUser(store, settings, user) {
  const oid = interactiveObjectId(settings, user),
    domain = user.domainname ?? user.upn ?? '';
  return addUser(
    store,
    settings.organizationId,
    uuidV5(settings.organizationId, `systemuser:oid:${oid}`),
    {
      fullname: user.fullname ?? user.displayName ?? user.upn ?? oid,
      domainname: domain,
      internalemailaddress: domain,
      azureactivedirectoryobjectid: oid,
      accessmode: user.accessmode ?? ACCESS_MODE.ReadWrite,
      // Entra group object ids; private, not a declared column. Group teams with a matching id make the user a member.
      azureactivedirectorygroupids: user.groups ?? [],
    },
    user.roles ?? [],
  );
}

/** Picker eligibility: an enabled, non-application user with an Entra object id (SYSTEM has none). */
export function isInteractiveUser(row) {
  return Boolean(
    !row.applicationid &&
    row.accessmode !== ACCESS_MODE.NonInteractive &&
    !row.isdisabled &&
    row.azureactivedirectoryobjectid,
  );
}

/** Table list for privilege generation: mapped tables, the ten security tables and schema tables. */
function tableInfo(store, schema) {
  const source = typeof schema === 'function' ? schema() : schema;
  const byName = new Map(Object.values(source?.tables ?? {}).map((t) => [t.logicalName, t]));
  const names = new Set([...Object.keys(store.state.mappings), ...Object.keys(TABLE_DEFS), ...byName.keys()]);
  // Tables the standard file marks OwnershipType None (privilege, principalobjectaccess, customeraddress, ...) get no privileges.
  // Platform tables keep theirs: the simulator's modules (custom API, team templates, audit) check them.
  const noneOwned = (logical) => standardTableDef(logical)?.ownershipType === 'None' && !PLATFORM_TABLES.has(logical);
  return [...names]
    .filter((logical) => !INTERSECT_PARENT[logical] && !noneOwned(logical))
    .map((logical) => {
      const mapping = store.state.mappings[logical],
        meta = mapping?.dataverseMetadata;
      // A table made through the metadata API has no schema entry: its SchemaName is kept on the mapping.
      const table = byName.get(logical) ?? (meta?.schemaName ? { schemaName: meta.schemaName } : undefined);
      return {
        logical,
        own: ownershipOf(logical, byName.get(logical), mapping),
        schemaName: privilegeNounOf(logical, table, mapping),
        created: meta?.createdByMetadataApi === true,
      };
    });
}

// System Customizer sees only the rows it creates in account, contact and the activity tables: Basic there, Global elsewhere.
const CUSTOMIZER_BASIC = new Set(['account', 'contact']);
/** Built-in role templates: admins Global on everything; Basic User Basic on user-owned, Global Read on org-owned. */
function templateGrants(p) {
  if (!p.right && SYSTEM_ADMINISTRATOR_ONLY.has(p.name)) return [['System Administrator', DEPTH.Global]];
  const customizer =
    p.right && (CUSTOMIZER_BASIC.has(p.table) || isActivityTable(p.table)) ? DEPTH.Basic : DEPTH.Global;
  const admins = [
    ['System Administrator', DEPTH.Global],
    ['System Customizer', customizer],
  ];
  if (!p.right) return admins;
  // Assumed: a table made at run time (metadata API or Solution import) gets the admin and customizer roles only; Basic User needs a grant.
  if (p.created) return admins;
  if (PLATFORM_TABLES.has(p.table)) {
    const depth = PLATFORM_BASIC[p.table]?.[p.right];
    return depth ? [...admins, ['Basic User', depth]] : admins;
  }
  // Basic User depths are a heuristic (Basic on user-owned, Global Read on org-owned), not a documented per-table list.
  if (p.own === 'user') return [...admins, ['Basic User', DEPTH.Basic]];
  // Every share in the organization is listed here, so Basic User gets no Global Read on it.
  return p.right === 'Read' && p.table !== 'principalobjectaccess' ? [...admins, ['Basic User', DEPTH.Global]] : admins;
}

/** The privileges a table gets: eight for user-owned tables, six for organization-owned ones (no Assign or Share). */
function tablePrivilegesOf(table) {
  return Object.keys(ACCESS_RIGHTS)
    .filter((right) => table.own === 'user' || !ORGANIZATION_EXCLUDED.has(right))
    .map((right) => ({
      right,
      name: privilegeName(right, table.schemaName),
      own: table.own,
      table: table.logical,
      created: table.created,
    }));
}

const roleIdsOf = (organizationId) =>
  Object.fromEntries(ROLE_NAMES.map((role) => [role, roleIdOf(organizationId, role)]));

// Insert-only: privileges and role grants that already exist are left as they are, so this is idempotent.
function grantPrivileges(store, org, privileges) {
  const roleIds = roleIdsOf(org);
  for (const p of privileges) {
    const id = privilegeId(org, p.name),
      userOwned = p.own === 'user';
    insertMissing(rowsOf(store, 'privilege'), 'privilegeid', {
      privilegeid: id,
      name: p.name,
      accessright: p.right ? ACCESS_RIGHTS[p.right] : 0,
      canbebasic: userOwned,
      canbelocal: userOwned,
      canbedeep: userOwned,
      canbeglobal: true,
      canbeentityreference: false,
      canbeparententityreference: false,
      canberecordfilter: false,
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
}

function seedSecurity(store, settings, schema) {
  const org = settings.organizationId,
    root = rootId(org),
    name = settings.friendlyName ?? settings.uniqueName;
  seedMappings(store);
  insertMissing(rowsOf(store, 'organization'), 'organizationid', {
    organizationid: org,
    name,
    uniquename: settings.uniqueName,
    friendlyname: name,
    hierarchysecurityenabled: settings.hierarchySecurity?.enabled === true,
    hierarchysecuritydepth: settings.hierarchySecurity?.depth ?? DEFAULT_HIERARCHY_DEPTH,
    isauditenabled: settings.auditing === true,
    isduplicatedetectionenabled: settings.duplicateDetection !== false,
    localeid: settings.localeId ?? 1033,
    languagecode: settings.localeId ?? 1033,
  });
  insertMissing(rowsOf(store, 'businessunit'), 'businessunitid', {
    businessunitid: root,
    name: settings.uniqueName,
    parentbusinessunitid: null,
    organizationid: lookupRow(store, 'organization', org),
  });
  // The organization's base currency: money columns report it as _transactioncurrencyid_value.
  insertMissing(rowsOf(store, 'transactioncurrency'), 'transactioncurrencyid', {
    transactioncurrencyid: baseCurrencyId(org),
    currencyname: 'Base currency',
    isocurrencycode: settings.currencyCode ?? 'USD',
    currencysymbol: settings.currencySymbol ?? '$',
    currencyprecision: 2,
    exchangerate: 1,
    organizationid: lookupRow(store, 'organization', org),
  });
  const roleIds = {};
  for (const role of ROLE_NAMES) {
    roleIds[role] = roleIdOf(org, role);
    insertMissing(rowsOf(store, 'role'), 'roleid', {
      roleid: roleIds[role],
      name: role,
      businessunitid: lookupRow(store, 'businessunit', root),
      organizationid: lookupRow(store, 'organization', org),
      isinherited: 1,
    });
  }
  const privileges = GLOBAL_PRIVILEGES.map((name) => ({ right: null, name, own: null }));
  for (const table of tableInfo(store, schema)) privileges.push(...tablePrivilegesOf(table));
  grantPrivileges(store, org, privileges);
  // Solution roles and field security profiles (buildSolutionSchema securityRoles/fieldSecurityProfiles), before any user names them.
  const source = typeof schema === 'function' ? schema() : schema;
  if (source?.securityRoles?.length || source?.fieldSecurityProfiles?.length)
    (store.state.dataverse ??= {}).securityDiagnostics = importSolutionSecurity(store, org, source);
  // SYSTEM runs internal reads that need no caller privilege (dataverse-security-messages.mjs), so it holds System Administrator.
  const systemUserId = addUser(
    store,
    org,
    uuidV5(org, 'systemuser:SYSTEM'),
    { fullname: 'SYSTEM', accessmode: ACCESS_MODE.NonInteractive },
    ['System Administrator'],
  );
  const userIds = {};
  for (const app of settings.applications ?? []) userIds[app.appId] = applicationUser(store, settings, app);
  for (const user of settings.users ?? [])
    userIds[interactiveObjectId(settings, user)] = interactiveUser(store, settings, user);
  return { organizationId: org, rootBusinessUnitId: root, systemUserId, roleIds, userIds };
}

/** Seeds the security tables. Async because store.transact is queued. */
export function ensureSecurityModel(store, settings, { schema } = {}) {
  return store.transact(() => {
    if (!GUID_RE.test(settings?.organizationId ?? ''))
      throw new DataError('A GUID organizationId is required.', 400, 'InvalidRequest');
    return withSeedIndexes(store, () => seedSecurity(store, settings, schema));
  });
}

/**
 * Gives a table created after seeding its standard privileges and role grants. Idempotent. The table must have a mapping
 * (or appear in the schema) and the security model must already be seeded.
 */
export function seedTablePrivileges(store, settings, logical, { schema } = {}) {
  return store.transact(() => grantTablePrivileges(store, settings.organizationId, logical, { schema }));
}

/** Synchronous: the caller's transaction (createTable, the Solution import) grants them, so a table is never without them. */
export function grantTablePrivileges(store, organizationId, logical, { schema } = {}) {
  const [table] = tableInfo(store, schema).filter((t) => t.logical === logical);
  if (!table) throw new DataError(`${logical} is not a known table.`, 404, 'NotFound');
  const privileges = tablePrivilegesOf(table);
  withSeedIndexes(store, () => grantPrivileges(store, organizationId, privileges));
  return privileges.map((p) => p.name);
}

/** Removes a table's privileges and the role grants on them. Call before its mapping is deleted (the names come from the mapping). */
export function revokeTablePrivileges(store, organizationId, logical) {
  const [table] = tableInfo(store, undefined).filter((t) => t.logical === logical);
  if (!table) return;
  const ids = new Set(tablePrivilegesOf(table).map((p) => privilegeId(organizationId, p.name)));
  removeWhere(rowsOf(store, 'roleprivileges'), (g) => ids.has(key(refId(g.privilegeid))));
  removeWhere(rowsOf(store, 'privilege'), (p) => ids.has(key(p.privilegeid)));
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

const ALL_RIGHTS = Object.values(ACCESS_RIGHTS).reduce((mask, right) => mask | right, 0);

/** 'ReadAccess, WriteAccess' or a positive integer made of known bits -> AccessRights mask; throws on an unknown name or bit, or an empty list. */
export function parseAccessMask(value) {
  const invalid = (text) =>
    new DataError(`Invalid access mask ${text}.`, 400, 'InvalidRequest', { innerCode: '0x80040203' });
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 0 && value <= ALL_RIGHTS && (value & ~ALL_RIGHTS) === 0) return value;
    throw invalid(value);
  }
  let mask = 0;
  for (const name of String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const right = ACCESS_RIGHTS[name.replace(/Access$/, '')];
    if (!right || name === 'None')
      throw new DataError(`Invalid access right '${name}'.`, 400, 'InvalidRequest', { innerCode: '0x80040203' });
    mask |= right;
  }
  if (!mask) throw invalid(`'${value ?? ''}'`);
  return mask;
}

const shareOf = (store, target, principal) =>
  rowsOf(store, 'principalobjectaccess').find(
    (r) =>
      sameId(r.objectid, target.id) &&
      key(r.objecttypecode) === key(target.logical) &&
      sameId(refId(r.principalid), principal.id),
  );

/**
 * Share `target` ({ logical, id }) with `principal` ({ id, logical_name: systemuser | team }) at `mask`.
 * GrantAccess ORs the mask into an existing share; ModifyAccess (replace) sets it.
 */
// Share rows change through the store's row operations, so a share is an incremental (journaled) write
// that advances only the principalobjectaccess revision: the security index keeps everything but its shares.
export function grantAccess(store, { target, principal, mask }, { replace = false } = {}) {
  return store.transact(
    () => {
      const existing = shareOf(store, target, principal);
      if (existing) {
        const rows = rowsOf(store, 'principalobjectaccess');
        store.mutateRow('principalobjectaccess', rows, rows.indexOf(existing), {
          accessrightsmask: replace ? mask : Number(existing.accessrightsmask) | mask,
        });
        return existing;
      }
      const logical = key(principal.logical_name) === 'team' ? 'team' : 'systemuser';
      const row = {
        principalobjectaccessid: uuidV5(target.id, `share:${logical}:${principal.id}`),
        principalid: lookupRow(store, logical, principal.id),
        objectid: String(target.id).toLowerCase(),
        objecttypecode: target.logical,
        accessrightsmask: mask,
        inheritedaccessrightsmask: 0,
      };
      store.insertRow('principalobjectaccess', rowsOf(store, 'principalobjectaccess'), row);
      return row;
    },
    { incremental: true },
  );
}

export const modifyAccess = (store, args) => grantAccess(store, args, { replace: true });

export function revokeAccess(store, { target, principal }) {
  return store.transact(
    () => {
      const rows = rowsOf(store, 'principalobjectaccess');
      const index = rows.indexOf(shareOf(store, target, principal));
      if (index >= 0) store.removeRow('principalobjectaccess', rows, index);
      return index >= 0;
    },
    { incremental: true },
  );
}

// Derived indexes per store: the principal/role/privilege part is rebuilt only when one of its tables
// commits a change (store.tablesRevision), the share part only when principalobjectaccess does.
const indexes = new WeakMap();
const CORE_TABLES = Object.freeze([
  'systemuser',
  'team',
  'role',
  'privilege',
  'roleprivileges',
  'systemuserroles',
  'teammembership',
  'teamroles',
  'businessunit',
  'organization',
]);
const SHARE_TABLES = Object.freeze(['principalobjectaccess']);
// Stores without per-table counters (older embedders) fall back to the whole-data revision.
const revisionOf = (store, tables) =>
  typeof store.tablesRevision === 'function'
    ? `${store.tablesRevision(tables)}.${store.state.dataverse?.organizationId ?? ''}`
    : store.dataRevision();

function buildShares(store) {
  const shares = new Map();
  for (const s of store.tableRows('principalobjectaccess')) {
    const k = key(s.objectid);
    if (!shares.has(k)) shares.set(k, []);
    shares.get(k).push({ principal: key(refId(s.principalid)), mask: Number(s.accessrightsmask) });
  }
  return shares;
}

function buildIndex(store) {
  const idx = {
    users: new Map(),
    teamRows: new Map(),
    byOid: new Map(),
    byApp: new Map(),
    byDomain: new Map(),
    roles: new Map(),
    privNames: new Map(),
    privIds: new Map(),
    grants: new Map(),
    direct: new Map(),
    teams: new Map(),
    teamRoles: new Map(),
    children: new Map(),
    roleSets: new Map(),
    grantSets: new Map(),
    chains: new Map(),
    shares: new Map(),
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
  for (const t of store.tableRows('team')) idx.teamRows.set(key(t.teamid), t);
  for (const r of store.tableRows('role')) idx.roles.set(key(r.roleid), r);
  for (const p of store.tableRows('privilege')) {
    idx.privNames.set(key(p.privilegeid), p.name);
    idx.privIds.set(p.name, p.privilegeid);
  }
  for (const g of store.tableRows('roleprivileges'))
    add(idx.grants, key(refId(g.roleid)), {
      privilegeId: key(refId(g.privilegeid)),
      mask: Number(g.privilegedepthmask),
    });
  for (const a of store.tableRows('systemuserroles')) add(idx.direct, key(refId(a.systemuserid)), key(refId(a.roleid)));
  for (const m of store.tableRows('teammembership')) add(idx.teams, key(refId(m.systemuserid)), key(refId(m.teamid)));
  // Group teams (type 2 security or 3 office group) have members derived from the user's Entra group ids, not from teammembership rows.
  const groupTeams = new Map();
  for (const t of store.tableRows('team')) {
    if (Number(t.teamtype) >= 2 && t.azureactivedirectoryobjectid)
      add(groupTeams, key(t.azureactivedirectoryobjectid), key(t.teamid));
  }
  for (const u of store.tableRows('systemuser')) {
    for (const groupId of u.isdisabled === true ? [] : (u.azureactivedirectorygroupids ?? [])) {
      for (const teamId of groupTeams.get(key(groupId)) ?? []) {
        if (!(idx.teams.get(key(u.systemuserid)) ?? []).includes(teamId)) add(idx.teams, key(u.systemuserid), teamId);
      }
    }
  }
  for (const t of store.tableRows('teamroles')) add(idx.teamRoles, key(refId(t.teamid)), key(refId(t.roleid)));
  for (const b of store.tableRows('businessunit')) {
    if (refId(b.parentbusinessunitid)) add(idx.children, key(refId(b.parentbusinessunitid)), key(b.businessunitid));
  }
  // Org settings (hierarchySecurity) live on the organization row.
  const org = organizationRecord(store),
    depth = Number(org?.hierarchysecuritydepth);
  idx.hierarchy = {
    enabled: org?.hierarchysecurityenabled === true,
    depth: Number.isInteger(depth) && depth > 0 ? depth : DEFAULT_HIERARCHY_DEPTH,
  };
  return idx;
}

/** Rights shared with the user directly or through a team membership, as an AccessRights mask. */
function sharedMask(idx, uid, rowId) {
  const principals = new Set([uid, ...teamsOf(idx, uid)]);
  let mask = 0;
  for (const share of idx.shares.get(key(rowId)) ?? []) if (principals.has(share.principal)) mask |= share.mask;
  return mask;
}

/** Whether a share gives the user `right` on the row, keyed by `idColumn`. */
function sharedWith(idx, uid, row, idColumn, right) {
  return row[idColumn] != null && (sharedMask(idx, uid, row[idColumn]) & ACCESS_RIGHTS[right]) !== 0;
}

function indexOf(store) {
  const core = revisionOf(store, CORE_TABLES),
    shares = revisionOf(store, SHARE_TABLES);
  let hit = indexes.get(store);
  if (hit?.core !== core) indexes.set(store, (hit = { core, shares: null, idx: buildIndex(store) }));
  if (hit.shares !== shares) {
    hit.idx.shares = buildShares(store);
    hit.shares = shares;
  }
  return hit.idx;
}

const teamsOf = (idx, uid) => idx.teams.get(uid) ?? [];

/** Role ids of the user's direct roles and of the teams it belongs to. */
function rolesOf(idx, uid) {
  if (!idx.roleSets.has(uid)) {
    const set = new Set(idx.direct.get(uid) ?? []);
    for (const team of teamsOf(idx, uid)) for (const role of idx.teamRoles.get(team) ?? []) set.add(role);
    idx.roleSets.set(uid, set);
  }
  return idx.roleSets.get(uid);
}

/** Adds the grants a team's own roles give (privilege name -> { id, bu, depth, teamOnly }) to `into`. Members and the team subject share it. */
function teamGrants(idx, teamId, into) {
  const bu = key(refId(idx.teamRows.get(teamId)?.businessunitid));
  for (const role of idx.teamRoles.get(teamId) ?? []) {
    // isinherited 0 (Team privileges only): the team's privileges reach team-owned rows only.
    const teamOnly = Number(idx.roles.get(role)?.isinherited ?? 1) === 0;
    for (const g of idx.grants.get(role) ?? []) {
      const name = idx.privNames.get(g.privilegeId);
      if (!name) continue;
      if (!into.has(name)) into.set(name, []);
      into.get(name).push({ id: teamId, bu, depth: g.mask, teamOnly });
    }
  }
  return into;
}

/**
 * Privilege grants of a user, kept apart by source. direct: privilege name -> highest depth mask over the
 * user's direct roles. team: privilege name -> one entry per team grant ({ id, bu, depth }), where bu is the team's business unit.
 */
function grantsOf(idx, uid) {
  if (!idx.grantSets.has(uid)) {
    const direct = new Map(),
      team = new Map();
    for (const role of idx.direct.get(uid) ?? []) {
      for (const g of idx.grants.get(role) ?? []) {
        const name = idx.privNames.get(g.privilegeId);
        if (name) direct.set(name, Math.max(direct.get(name) ?? 0, g.mask));
      }
    }
    for (const teamId of teamsOf(idx, uid)) teamGrants(idx, teamId, team);
    idx.grantSets.set(uid, { direct, team });
  }
  return idx.grantSets.get(uid);
}

/** Privilege name -> depth as RetrieveUserPrivileges reports it: the direct depth, or Basic for team-only grants. */
function privilegeMapOf(idx, uid) {
  const { direct, team } = grantsOf(idx, uid);
  const map = new Map(direct);
  for (const name of team.keys()) map.set(name, Math.max(map.get(name) ?? 0, DEPTH.Basic));
  return map;
}

function privilegeCountOf(idx, uid) {
  const { direct, team } = grantsOf(idx, uid);
  let count = direct.size;
  for (const name of team.keys()) if (!direct.has(name)) count++;
  return count;
}

function chainOf(idx, root) {
  if (!idx.chains.has(root)) {
    const out = new Set(),
      stack = [root];
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

/**
 * Business unit of a row: its owningbusinessunit, else the business unit of its owner (systemuser or team).
 * Returns a lowercase id, or '' when neither exists.
 */
function rowBusinessUnit(idx, row) {
  const explicit = refId(row.owningbusinessunit);
  if (explicit) return key(explicit);
  const owner = key(refId(row.ownerid));
  return key(refId((idx.users.get(owner) ?? idx.teamRows.get(owner))?.businessunitid));
}

// Business unit scope: Local = the same unit, Deep = the unit and its children. An unknown unit admits nothing.
function buAdmits(idx, depth, rowBu, anchorBu) {
  if (!rowBu || !anchorBu) return false;
  return depth >= DEPTH.Deep ? chainOf(idx, anchorBu).has(rowBu) : rowBu === anchorBu;
}

// A direct grant admits a row: Basic = the user's own rows and rows owned by its teams; Local/Deep = by the user's business unit; Global = all.
function directAdmits(idx, user, depth, row) {
  if (depth >= DEPTH.Global) return true;
  const uid = key(user.systemuserid),
    owner = key(refId(row.ownerid));
  if (depth < DEPTH.Local) return owner === uid || teamsOf(idx, uid).includes(owner);
  return buAdmits(idx, depth, rowBusinessUnit(idx, row), key(refId(user.businessunitid)));
}

// A team grant admits a row: Basic = rows owned by the team; Local/Deep/Global = by geometry, whoever owns the row
// (inherited team privileges are evaluated as if the team were the caller, so a member's own row passes too).
function teamAdmits(idx, team, row) {
  const owner = key(refId(row.ownerid));
  if (team.teamOnly) return owner === team.id;
  if (team.depth >= DEPTH.Global) return true;
  if (team.depth < DEPTH.Local) return owner === team.id;
  return buAdmits(idx, team.depth, rowBusinessUnit(idx, row), team.bu);
}

/**
 * Each grant the user holds for one privilege, with its row test. An effective principal (impersonation) holds one grant:
 * the lower depth, admitting only rows that both the impersonated user and the caller admit.
 */
// `hierarchy` adds the manager-hierarchy grants; callers set it only when a row (or a row filter) is in play.
function grantsNamed(idx, user, name, { hierarchy = false } = {}) {
  const own = ownGrantsNamed(idx, user, name, hierarchy);
  if (!user.impersonator) return own;
  const caller = ownGrantsNamed(idx, user.impersonator, name, hierarchy);
  if (!own.length || !caller.length) return [];
  return [
    {
      depth: Math.min(deepest(own), deepest(caller)),
      direct: own.some((g) => g.direct) && caller.some((g) => g.direct),
      admits: (row) => own.some((g) => g.admits(row)) && caller.some((g) => g.admits(row)),
    },
  ];
}

function ownGrantsNamed(idx, user, name, hierarchy = false) {
  const uid = key(user.systemuserid),
    { direct, team } = grantsOf(idx, uid),
    out = [];
  if (direct.has(name)) {
    const depth = direct.get(name);
    out.push({ depth, direct: true, admits: (row) => directAdmits(idx, user, depth, row) });
  }
  for (const grant of team.get(name) ?? []) {
    out.push({ depth: grant.depth, direct: false, admits: (row) => teamAdmits(idx, grant, row) });
  }
  const manager = hierarchy ? managerGrant(idx, user, name) : null;
  if (manager) out.push(manager);
  return out;
}

// Manager hierarchy (org hierarchySecurity). Read, Write, Append and AppendTo; the caller needs the user-level Read
// privilege on the table too. Requires the same-or-parent business unit rule below.
const MANAGER_RIGHTS = ['prvAppendTo', 'prvAppend', 'prvWrite', 'prvRead'];

function managerGrant(idx, user, name) {
  const prefix = idx.hierarchy.enabled ? MANAGER_RIGHTS.find((p) => name.startsWith(p)) : undefined;
  if (!prefix) return null;
  const { direct, team } = grantsOf(idx, key(user.systemuserid)),
    readName = `prvRead${name.slice(prefix.length)}`;
  if (!direct.has(readName) && !team.has(readName)) return null;
  return { depth: DEPTH.Deep, direct: false, admits: (row) => managerAdmits(idx, user, prefix, row) };
}

// Level 1 = direct report (all four rights); levels 2..depth = nondirect reports in the chain (Read only).
function managerAdmits(idx, user, prefix, row) {
  const manager = key(user.systemuserid),
    owner = key(refId(row.ownerid));
  let level = 0;
  for (let at = owner, n = 1; n <= idx.hierarchy.depth && at; n++) {
    const parent = key(refId(idx.users.get(at)?.parentsystemuserid));
    if (parent === manager) {
      level = n;
      break;
    }
    at = parent;
  }
  if (!level || (prefix !== 'prvRead' && level !== 1)) return false;
  // ManagersMustBeInSameOrParentBusinessUnitAsReports (default true): the report's unit is the manager's or below it.
  return buAdmits(idx, DEPTH.Deep, key(refId(idx.users.get(owner)?.businessunitid)), key(refId(user.businessunitid)));
}

/** Business-unit-scoped hierarchy walk over `link` (a lookup column of `logical` that names the parent row). */
function walkTree(store, logical, link, startKey, up) {
  const idColumn = store.state.mappings[logical]?.idColumn ?? `${logical}id`;
  const rows = store.tableRows(logical),
    out = new Set();
  const parentOf = (row) => key(refId(row[link]));
  if (up) {
    let current = rows.find((r) => key(r[idColumn]) === startKey);
    for (let n = 0; current && n < HIERARCHY_LIMIT; n++) {
      const parent = parentOf(current);
      if (!parent || out.has(parent)) break;
      out.add(parent);
      current = rows.find((r) => key(r[idColumn]) === parent);
    }
    return out;
  }
  let frontier = new Set(startKey ? [startKey] : []);
  for (let level = 0; frontier.size && level < HIERARCHY_LIMIT; level++) {
    const next = new Set();
    for (const row of rows) {
      const id = key(row[idColumn]);
      if (frontier.has(parentOf(row)) && id !== startKey && !out.has(id)) {
        out.add(id);
        next.add(id);
      }
    }
    frontier = next;
  }
  return out;
}

// The self-referencing hierarchical relationship of a table: its parent lookup column. systemuser uses its manager column.
function hierarchyLinkOf(store, logical) {
  if (logical === 'systemuser') return 'parentsystemuserid';
  // Both sides of a self relationship match: the many-to-one side (many false) holds the lookup column in from; the one-to-many side's to.
  const rel = Object.values(relationshipsOf(store, logical)).find((r) => r.hierarchical && r.entity === logical);
  return rel ? (rel.many === false ? rel.from : rel.to) : null;
}

/**
 * The identity.dataverse object for the conditions layer: the caller's user id, business unit and team ids, plus
 * hierarchy(logical, idColumn, id, mode) (null when the table has no hierarchical relationship) and userHierarchy(userId),
 * which lists the user's reports at any level. The walk follows the table's own parent lookup, not idColumn.
 */
export function dataverseIdentity(store, user) {
  return {
    userId: user.systemuserid,
    businessUnitId: refId(user.businessunitid) ?? null,
    teamIds: teamsOfUser(store, user.systemuserid),
    hierarchy(logical, idColumn, id, mode) {
      const link = hierarchyLinkOf(store, logical);
      if (!link) return null;
      const startKey = key(refId(id)),
        set = walkTree(store, logical, link, startKey, mode === 'above' || mode === 'eq-or-above');
      if (mode === 'eq-or-under' || mode === 'eq-or-above') set.add(startKey);
      return set;
    },
    userHierarchy: (userId) => walkTree(store, 'systemuser', 'parentsystemuserid', key(userId), false),
  };
}

/** Sets the organization's hierarchySecurity (enabled, depth). Depth is the number of levels of read-only access below a manager. */
export function setHierarchySecurity(store, organizationId, { enabled, depth = DEFAULT_HIERARCHY_DEPTH } = {}) {
  return store.transact(() => {
    if (!Number.isInteger(depth) || depth < 1)
      throw new DataError(`Invalid hierarchy depth ${depth}.`, 400, 'InvalidRequest');
    const row = rowOf(store, 'organization', organizationId);
    row.hierarchysecurityenabled = enabled === true;
    row.hierarchysecuritydepth = depth;
    return { enabled: row.hierarchysecurityenabled, depth };
  });
}

const deepest = (grants) => grants.reduce((max, g) => Math.max(max, g.depth), 0);

const depthName = (mask) => DEPTH_NAMES.find((name) => mask & DEPTH[name]) ?? 'Basic';

/** The PrivilegeDenied (0x80040220) error for a user without a privilege on an entity. Counts default to 0. */
export function privilegeDeniedError(
  user,
  name,
  entity,
  { roleCount = 0, privilegeCount = 0, objectTypeCode = DEFAULT_OTC, displayName = entity } = {},
) {
  const uid = user.systemuserid,
    orgId = refId(user.organizationid);
  const privId = orgId ? privilegeId(orgId, name) : '';
  return new DataError(
    `Principal user (Id=${uid}, type=8, roleCount=${roleCount}, privilegeCount=${privilegeCount}, accessMode=${user.accessmode ?? 0}), is missing ${name} privilege (Id=${privId}) on OTC=${objectTypeCode} for entity '${entity}' (LocalizedName='${displayName}'). context.Caller=${uid}. Consider adding missing privilege to one of the principal (user/team) roles for the request to succeed.`,
    403,
    'PrivilegeDenied',
    { innerCode: '0x80040220', privilege: name, entity },
  );
}

function privilegeDenied(idx, settings, user, logical, name, schema) {
  const uid = key(user.systemuserid);
  return privilegeDeniedError(user, name, logical, {
    roleCount: rolesOf(idx, uid).size,
    privilegeCount: privilegeCountOf(idx, uid),
    objectTypeCode: settings?.objectTypeCode?.(logical) ?? DEFAULT_OTC,
    displayName: schema?.displayName ?? logical,
  });
}

function accessDenied(user, operation, row, idColumn, logical) {
  const right = OPERATION_RIGHT[operation] ?? operation;
  return new DataError(
    `Principal with ID ${user.systemuserid} does not have ${right}Access right(s) for record with ID ${row[idColumn]} of entity ${logical}.`,
    403,
    'AccessDenied',
    { innerCode: '0x80048306' },
  );
}

// Team rules. The records layer calls these before an owner assignment, a role association or a membership write.
const teamTypeOf = (store, teamId) => Number(rowOf(store, 'team', teamId).teamtype ?? 0);
const ACCESS_TEAM = 1;

/** An access team cannot own records (0x80048340). */
export function assertTeamCanOwn(store, teamId) {
  if (teamTypeOf(store, teamId) === ACCESS_TEAM)
    throw new DataError('An access team cannot own records.', 400, 'InvalidRequest', { innerCode: '0x80048340' });
}

/** An access team cannot hold security roles (0x80048331). */
export function assertTeamCanHoldRoles(store, teamId) {
  if (teamTypeOf(store, teamId) === ACCESS_TEAM)
    throw new DataError('An access team cannot be assigned security roles.', 400, 'InvalidRequest', {
      innerCode: '0x80048331',
    });
}

/** A disabled user cannot join a team (0x80048d36). */
export function assertCanJoinTeam(store, systemuserid) {
  if (rowOf(store, 'systemuser', systemuserid).isdisabled === true)
    throw new DataError('A disabled user cannot be added to a team.', 400, 'InvalidRequest', {
      innerCode: '0x80048d36',
    });
}

/** Lowercase ids of the teams a user belongs to: teammembership rows plus group teams matched through the user's Entra group ids. */
export function teamsOfUser(store, systemuserid) {
  return [...teamsOf(indexOf(store), key(systemuserid))];
}

/** Lowercase id of the business unit a row belongs to (its owningbusinessunit, else its owner's), or '' when neither exists. */
export function businessUnitOf(store, row) {
  return rowBusinessUnit(indexOf(store), row);
}

/**
 * Just-in-time group team membership from the token's Entra group ids: a group team (security or office) whose object id is
 * in `groupIds` gets a teammembership row, and one the user has left loses it. Owner and access memberships are never touched.
 * A disabled user joins no group team. ponytail: membershiptype (Members, Owners, Guests) is not matched; any member type
 * matches by object id.
 */
export function syncGroupMembership(store, user, groupIds = []) {
  return store.transact(() => {
    const uid = key(user.systemuserid),
      wanted = new Set(groupIds.map(key));
    const userRow = rowOf(store, 'systemuser', uid);
    userRow.azureactivedirectorygroupids = [...wanted];
    const groupTeams = rowsOf(store, 'team').filter((t) => Number(t.teamtype) >= 2 && t.azureactivedirectoryobjectid);
    const isGroupMember = (team) => userRow.isdisabled !== true && wanted.has(key(team.azureactivedirectoryobjectid));
    const memberships = rowsOf(store, 'teammembership');
    for (let i = memberships.length - 1; i >= 0; i--) {
      if (!sameId(refId(memberships[i].systemuserid), uid)) continue;
      const team = groupTeams.find((t) => sameId(t.teamid, refId(memberships[i].teamid)));
      if (team && !isGroupMember(team)) memberships.splice(i, 1);
    }
    const teamIds = [];
    for (const team of groupTeams) {
      if (!isGroupMember(team)) continue;
      teamIds.push(key(team.teamid));
      insertMissing(memberships, 'teammembershipid', {
        teammembershipid: uuidV5(team.teamid, `member:${uid}`),
        systemuserid: lookupRow(store, 'systemuser', uid),
        teamid: lookupRow(store, 'team', team.teamid),
      });
    }
    return { systemuserid: uid, teamIds };
  });
}

/**
 * SetBusinessSystemUser: moves a user to a business unit. Removes the user's role assignments (the default
 * DoNotRemoveRolesOnChangeBusinessUnit = false) and, unless doNotMoveAllRecords, moves the business unit of the records the
 * user owns. A disabled business unit is refused (0x8004032d).
 * ponytail: ReassignPrincipal (owned records reassigned to another principal), the root default team membership and the
 * manager reparenting of reports are not modelled.
 */
export function setBusinessUnit(store, { userId, businessUnitId, doNotMoveAllRecords = false } = {}) {
  return store.transact(() => {
    const user = rowOf(store, 'systemuser', userId),
      unit = rowOf(store, 'businessunit', businessUnitId);
    if (unit.isdisabled === true)
      throw new DataError('The business unit is disabled.', 400, 'InvalidRequest', { innerCode: '0x8004032d' });
    const uid = key(user.systemuserid),
      unitRef = lookupRow(store, 'businessunit', unit.businessunitid);
    const roles = rowsOf(store, 'systemuserroles');
    for (let i = roles.length - 1; i >= 0; i--) if (sameId(refId(roles[i].systemuserid), uid)) roles.splice(i, 1);
    if (!doNotMoveAllRecords) {
      for (const [logical, mapping] of Object.entries(store.state.mappings)) {
        if (ownershipOf(logical, null, mapping) !== 'user') continue;
        for (const row of store.state.tables[logical] ?? [])
          if (sameId(refId(row.ownerid), uid)) row.owningbusinessunit = unitRef;
      }
    }
    user.businessunitid = unitRef;
    return { systemuserid: uid, businessUnitId: unitRef.id };
  });
}

/**
 * The parent row a follows-parent row belongs to, as { logical, row }: an activity party's activity (found in the activity
 * tables by activityid, or the lookup's logical name), a customer address's account or contact (parentid, named by
 * objecttypecode). null when the parent is not in the store.
 */
function parentRowOf(store, logical, row) {
  const find = (table, id) => {
    const idColumn =
      store.state.mappings[table]?.idColumn ?? standardTableDef(table)?.primaryIdAttribute ?? `${table}id`;
    // A row keyed by the id is found through the primary key index; the scan also finds a row by its activityid.
    const mapping = store.state.mappings[table];
    const keyed =
      mapping && typeof id === 'string' ? store.primaryKeySubset({ ...mapping, logicalName: table }, [id]) : null;
    const hit =
      keyed?.[0] ?? (store.state.tables[table] ?? []).find((r) => sameId(r[idColumn], id) || sameId(r.activityid, id));
    return hit ? { logical: table, row: hit } : null;
  };
  if (logical === 'activityparty') {
    const id = refId(row.activityid);
    if (!id) return null;
    const named = row.activityid?.logical_name;
    const tables = named
      ? [named]
      : Object.keys(store.state.mappings).filter((t) => t !== 'activitypointer' && isActivityTable(t));
    for (const table of tables) {
      const hit = find(table, id);
      if (hit) return hit;
    }
    return null;
  }
  const id = refId(row.parentid),
    table = row.objecttypecode ?? row.parentid?.logical_name;
  return id && table ? find(String(table), id) : null;
}

/**
 * The principal kind an access token stands for: 'delegated' (a user signed in through a client: idtyp user, or an scp claim)
 * or 'application' (client credentials, managed identity: idtyp app, or appid/azp without scp). Every issuer path of
 * dataverse-auth.mjs (authorization code, device code, password, on-behalf-of, refresh, federated client assertions) mints
 * idtyp; a claim set with neither idtyp nor a client id (an in-process caller naming a user) is delegated.
 */
export function tokenKind(claims = {}) {
  if (claims.idtyp === 'user' || claims.scp != null) return 'delegated';
  if (claims.idtyp === 'app' || claims.appid != null || claims.azp != null) return 'application';
  return 'delegated';
}

/** Principal and privilege checks for the Dataverse layer. Read-only apart from the cached index. */
export function createPrincipals(store, settings = {}) {
  const idx = () => indexOf(store);
  const uidOf = (user) => key(typeof user === 'string' ? user : user?.systemuserid);
  // The privilege noun, resolved as seeding resolves it: the Solution schema (settings.schema unless the call passes one) and the store's mapping.
  const nounFor = (logical, schema) =>
    privilegeNounOf(logical, schemaTableOf(schema ?? settings.schema, logical), store.state.mappings[logical]);

  // Grants that pass the privilege check. A user-owned row is tested against each grant; org-owned rows need no row test.
  function gate(user, entity, operation, { row, mapping, schema, filter = false } = {}) {
    const m = mapping ?? store.resolveMapping(entity),
      logical = m.logicalName,
      index = idx();
    // A follows-parent row is tested as its parent row, by the parent table's privilege. Without a parent, a customer address
    // checks either parent's privilege at table level, so System Administrator still passes.
    const parent = row && FOLLOWS_PARENT.has(logical) ? parentRowOf(store, logical, row) : null;
    if (parent) return gate(user, parent.logical, operation, { row: parent.row });
    if (operation === 'read' && PUBLIC_READ.has(logical)) return { m, grants: [], depth: DEPTH.Global };
    const nouns =
      logical === 'customeraddress' ? ADDRESS_PARENTS.map((p) => privilegeNounOf(p)) : [nounFor(logical, schema)];
    const names = nouns.map((noun) => privilegeName(operation, noun)),
      name = names[0];
    const owned = ownershipOf(logical, schema, m) === 'user';
    const grants = names.flatMap((n) => grantsNamed(index, user, n, { hierarchy: (Boolean(row) || filter) && owned }));
    if (!grants.length) throw privilegeDenied(index, settings, user, logical, name, schema);
    if (!row || ownershipOf(logical, schema, m) === 'org') return { m, grants, depth: deepest(grants) };
    const idColumn = m.idColumn ?? `${logical}id`;
    const admitting = grants.filter((g) => g.admits(row));
    if (admitting.length) return { m, grants: admitting, depth: deepest(admitting) };
    if (!sharedWith(index, key(user.systemuserid), row, idColumn, OPERATION_RIGHT[operation] ?? operation))
      throw accessDenied(user, operation, row, idColumn, logical);
    return { m, grants, depth: deepest(grants) };
  }

  return {
    byId: (id) => idx().users.get(key(id)) ?? null,
    /** The privilege noun of a table as the checks name it (prvRead<noun>), the same resolution the seeding uses. */
    privilegeNoun: (logical, schema) => nounFor(logical, schema),
    byObjectId: (oid) => idx().byOid.get(key(oid)) ?? null,
    byApplicationId: (appId) => idx().byApp.get(key(appId)) ?? null,
    byDomainName: (name) => idx().byDomain.get(key(name)) ?? null,

    /**
     * Claims -> { user, reason }. reason: 'unknown' | 'disabled' | null. The token kind decides the lookup: a delegated token
     * (user sign-in, on-behalf-of, federated user) resolves its user by oid (by upn only when it carries no oid) and never falls
     * back to the client's application user; an application token resolves the application user by appid/azp only.
     */
    resolve(claims = {}) {
      const index = idx();
      const appId = claims.appid ?? claims.azp,
        upn = claims.upn ?? claims.preferred_username;
      const user =
        tokenKind(claims) === 'delegated'
          ? ((claims.oid ? index.byOid.get(key(claims.oid)) : upn ? index.byDomain.get(key(upn)) : null) ?? null)
          : ((appId ? index.byApp.get(key(appId)) : null) ?? null);
      if (!user) return { user: null, reason: 'unknown' };
      return { user, reason: user.isdisabled === true ? 'disabled' : null };
    },

    roles(user) {
      const index = idx();
      return [...rolesOf(index, uidOf(user))]
        .map((id) => index.roles.get(id))
        .filter(Boolean)
        .map((r) => ({ roleid: r.roleid, name: r.name }));
    },

    privileges(user) {
      const map = privilegeMapOf(idx(), uidOf(user));
      if (!user.impersonator) return map;
      // Effective principal: a privilege counts only when the caller holds it too, at the lower depth.
      const callerMap = privilegeMapOf(idx(), uidOf(user.impersonator));
      return new Map(
        [...map]
          .filter(([name]) => callerMap.has(name))
          .map(([name, depth]) => [name, Math.min(depth, callerMap.get(name))]),
      );
    },

    businessUnitChain(businessUnitId) {
      return new Set(chainOf(idx(), key(businessUnitId)));
    },

    /** Business unit of a row as a lookup: its owningbusinessunit, else its owner's. null when neither exists. */
    ownerBusinessUnit(row) {
      const id = rowBusinessUnit(idx(), row);
      return id ? lookupRow(store, 'businessunit', id) : null;
    },

    /**
     * Throws PrivilegeDenied (0x80040220) or AccessDenied (0x80048306); returns the depth.
     * assign with a team `target` also checks that the team can own records (an access team cannot).
     */
    authorize(options) {
      const { depth } = gate(options.user, options.entity, options.operation, options);
      if (options.operation === 'assign' && options.target?.logical_name === 'team')
        assertTeamCanOwn(store, options.target.id);
      return depth;
    },

    /** The user acting as `user` under `caller`: privileges and rows are the intersection of both users' (see grantsNamed). */
    effectivePrincipal(caller, user) {
      return sameId(caller.systemuserid, user.systemuserid) ? user : { ...user, impersonator: caller };
    },

    /** null when no row filter is needed (Global direct depth or organization-owned table). */
    readFilter({ user, entity, mapping, schema } = {}) {
      const { m, grants } = gate(user, entity, 'read', { mapping, schema, filter: true });
      if (FOLLOWS_PARENT.has(m.logicalName)) {
        // Each row is read if its parent row is; an orphan row is shown only to a Global direct grant (administrators).
        const canRead = (parent) => {
          try {
            gate(user, parent.logical, 'read', { row: parent.row });
            return true;
          } catch {
            return false;
          }
        };
        return (row) => {
          const parent = parentRowOf(store, m.logicalName, row);
          return parent ? canRead(parent) : grants.some((g) => g.direct && g.depth >= DEPTH.Global);
        };
      }
      if (ownershipOf(m.logicalName, schema, m) === 'org') return null;
      if (grants.some((g) => g.direct && g.depth >= DEPTH.Global)) return null;
      const index = idx(),
        uid = uidOf(user),
        idColumn = m.idColumn ?? `${m.logicalName}id`;
      return (row) => grants.some((g) => g.admits(row)) || sharedWith(index, uid, row, idColumn, 'Read');
    },

    /**
     * Store system columns for a write: audit lookups, the impersonating caller (null when none) and,
     * on user-owned tables, the owner trio for `owner` ({ id, logical_name } of a systemuser or team),
     * the caller on create. These are written whether or not the mapping declares the columns.
     */
    systemColumns({ user, caller = null, mapping, schema, owner = null, create = true } = {}) {
      const userRef = lookupRow(store, 'systemuser', user.systemuserid);
      const callerRef =
        caller && !sameId(caller.systemuserid, user.systemuserid)
          ? lookupRow(store, 'systemuser', caller.systemuserid)
          : null;
      const columns = create
        ? { createdby: userRef, modifiedby: userRef, createdonbehalfby: callerRef, modifiedonbehalfby: callerRef }
        : { modifiedby: userRef, modifiedonbehalfby: callerRef };
      if (ownershipOf(mapping.logicalName, schema, mapping) !== 'user') return columns;
      if (owner || create)
        Object.assign(columns, ownerColumns(store, owner ?? { id: user.systemuserid, logical_name: 'systemuser' }));
      return columns;
    },

    ownershipDefaults({ user, caller, mapping, schema } = {}) {
      const ref = lookupRow(store, 'systemuser', user.systemuserid);
      const defaults = { createdby: ref, modifiedby: ref };
      if (onBehalf(user, caller)) defaults.createdonbehalfby = lookupRow(store, 'systemuser', caller.systemuserid);
      if (ownershipOf(mapping.logicalName, schema, mapping) === 'user') {
        Object.assign(defaults, ownerColumns(store, { id: user.systemuserid, logical_name: 'systemuser' }));
      }
      return declaredOnly(defaults, mapping);
    },

    modifiedBy({ user, caller }) {
      const values = { modifiedby: lookupRow(store, 'systemuser', user.systemuserid) };
      if (onBehalf(user, caller)) values.modifiedonbehalfby = lookupRow(store, 'systemuser', caller.systemuserid);
      return values;
    },

    // Direct roles only: the privilege cannot be inherited through a team.
    canImpersonate(user) {
      return grantsOf(idx(), uidOf(user)).direct.has('prvActOnBehalfOfAnotherUser');
    },

    /** One entry per role-privilege grant: direct roles at their depth, team roles at Basic; de-duplicated by privilege, business unit and depth. */
    retrieveUserPrivileges(userId) {
      const index = idx(),
        uid = uidOf(userId),
        out = [],
        seen = new Set();
      const emit = (roleId, fromTeam) => {
        const businessUnitId = refId(index.roles.get(roleId)?.businessunitid) ?? null;
        for (const g of index.grants.get(roleId) ?? []) {
          const name = index.privNames.get(g.privilegeId);
          if (!name) continue;
          const Depth = fromTeam ? 'Basic' : depthName(g.mask);
          const dedupe = `${g.privilegeId}|${businessUnitId}|${Depth}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          out.push({
            Depth,
            PrivilegeId: g.privilegeId,
            BusinessUnitId: businessUnitId,
            PrivilegeName: name,
            RecordFilterId: null,
            RecordFilterUniqueName: null,
          });
        }
      };
      for (const roleId of index.direct.get(uid) ?? []) emit(roleId, false);
      for (const teamId of teamsOf(index, uid))
        for (const roleId of index.teamRoles.get(teamId) ?? []) emit(roleId, true);
      return out;
    },

    /** Comma-separated AccessRights flags, or 'None'. Create is table-level and needs no row; shares count per right. */
    principalAccess({ user, entity, row, mapping, schema } = {}) {
      const index = idx(),
        m = mapping ?? store.resolveMapping(entity),
        owned = ownershipOf(m.logicalName, schema, m) === 'user',
        flags = [];
      const idColumn = m.idColumn ?? `${m.logicalName}id`,
        uid = uidOf(user);
      for (const right of Object.keys(ACCESS_RIGHTS)) {
        const grants = grantsNamed(index, user, privilegeName(right, nounFor(m.logicalName, schema)), {
          hierarchy: Boolean(row) && owned,
        });
        if (!grants.length) continue;
        if (
          right === 'Create' ||
          !row ||
          !owned ||
          grants.some((g) => g.admits(row)) ||
          sharedWith(index, uid, row, idColumn, right)
        )
          flags.push(`${right}Access`);
      }
      return flags.length ? flags.join(', ') : 'None';
    },

    /** Team subject: the team's own roles (teamroles, team depth) and shares to the team. No membership, no manager hierarchy. */
    teamAccess({ team, entity, row, mapping, schema } = {}) {
      const index = idx(),
        m = mapping ?? store.resolveMapping(entity),
        owned = ownershipOf(m.logicalName, schema, m) === 'user',
        flags = [];
      const idColumn = m.idColumn ?? `${m.logicalName}id`,
        teamId = key(team.teamid),
        grants = teamGrants(index, teamId, new Map());
      for (const right of Object.keys(ACCESS_RIGHTS)) {
        const list = grants.get(privilegeName(right, nounFor(m.logicalName, schema))) ?? [];
        if (!list.length) continue;
        if (
          right === 'Create' ||
          !row ||
          !owned ||
          list.some((g) => teamAdmits(index, g, row)) ||
          sharedWith(index, teamId, row, idColumn, right)
        )
          flags.push(`${right}Access`);
      }
      return flags.length ? flags.join(', ') : 'None';
    },

    /** Organization subject: every right but Assign and Share on organization-owned tables and rows; nothing on user-owned ones. */
    organizationAccess({ entity, mapping, schema } = {}) {
      const m = mapping ?? store.resolveMapping(entity);
      if (ownershipOf(m.logicalName, schema, m) !== 'org') return 'None';
      return Object.keys(ACCESS_RIGHTS)
        .filter((right) => !ORGANIZATION_EXCLUDED.has(right))
        .map((right) => `${right}Access`)
        .join(', ');
    },
  };
}
