import { messageCollection } from './dataverse-message-context.mjs';
import { organizationRecord } from './organization-context.mjs';
// Simulated Dataverse security messages: role privileges, team membership, privilege and share lookups, parent users, the
// business unit hierarchy, access-team templates and the Microsoft Entra ID user lookups, through the registered operations.
// Registered as extension operations (dataverse-operations.mjs).
// The built-in RetrieveUserPrivileges and RetrievePrincipalAccess stay in dataverse-api.mjs and are not registered here.
import { DataError } from './data-error.mjs';
import { principalAccessesOf } from './plugin-platform-messages.mjs';
import { objectTypeCode } from './dataverse-metadata.mjs';
import {
  ACCESS_RIGHTS,
  DEPTH,
  assertCanJoinTeam,
  assertTeamCanHoldRoles,
  businessUnitOf,
  grantAccess,
  ownerColumns,
  ownershipOf,
  privilegeDeniedError,
  privilegeName,
  revokeAccess,
  seedTablePrivileges,
  setBusinessUnit,
  teamsOfUser,
  uuidV5,
} from './dataverse-security.mjs';
import { AUDIT_ACTION, writeAudit } from './dataverse-audit.mjs';
import { contextUrl } from './dataverse-odata.mjs';

// PrivilegeDepth enum values: Basic 0, Local 1, Deep 2, Global 3. Accepts the name or the number.
const DEPTH_ENUM = ['Basic', 'Local', 'Deep', 'Global'];
const ACCESS_TEAM = 1;
// The privilege check each access right needs (authorize operation).
const RIGHT_OPERATION = {
  Read: 'read',
  Write: 'write',
  Append: 'append',
  AppendTo: 'appendto',
  Create: 'create',
  Delete: 'delete',
  Share: 'share',
  Assign: 'assign',
};
const TEAM_TEMPLATE_FIELDS = {
  teamtemplateid: 'uniqueidentifier',
  teamtemplatename: 'nvarchar',
  objecttypecode: 'int',
  defaultaccessrightsmask: 'int',
  issystem: 'bit',
  description: 'nvarchar',
};
const TEAM_TEMPLATE_SCHEMA = { tables: { teamtemplate: { logicalName: 'teamtemplate', schemaName: 'TeamTemplate' } } };
const RECORD_TEAM_PARAMS = [
  ['Record', 'mscrm.crmbaseentity'],
  ['TeamTemplate', 'mscrm.teamtemplate'],
];

const key = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value) ?? undefined;
const ref = (logical, id) => (id == null ? null : { id, logical_name: logical, name: '' });
const tableOf = (store, logical) => (store.state.tables[logical] ??= []);
const listOf = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const body = (c) => (typeof c.body === 'string' ? JSON.parse(c.body || '{}') : (c.body ?? {}));
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, 'NotFound', { id });
// Refusals carry the Dataverse inner code; InvalidArgument (0x80040203) is the default for an argument the platform rejects.
const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });

function maskOf(depth) {
  const name = /^\d+$/.test(String(depth))
    ? DEPTH_ENUM[Number(depth)]
    : DEPTH_ENUM.find((n) => n.toLowerCase() === String(depth).toLowerCase());
  if (!name) throw invalid(`Invalid privilege depth ${depth}.`);
  return DEPTH[name];
}
const depthName = (mask) => Object.keys(DEPTH).find((name) => DEPTH[name] === Number(mask)) ?? 'Basic';
const accessNames = (mask) =>
  Object.keys(ACCESS_RIGHTS)
    .filter((right) => Number(mask) & ACCESS_RIGHTS[right])
    .map((right) => `${right}Access`)
    .join(', ') || 'None';
const principalType = (store, id) =>
  `#Microsoft.Dynamics.CRM.${tableOf(store, 'systemuser').some((u) => sameId(u.systemuserid, id)) ? 'systemuser' : 'team'}`;

function removeWhere(rows, predicate) {
  for (let i = rows.length - 1; i >= 0; i--) if (predicate(rows[i])) rows.splice(i, 1);
}

// RolePrivilege entries for a set of lowercase role ids.
function entriesOf(store, roleIds) {
  const roles = new Map(tableOf(store, 'role').map((r) => [key(r.roleid), r]));
  const privileges = new Map(tableOf(store, 'privilege').map((p) => [key(p.privilegeid), p]));
  return tableOf(store, 'roleprivileges')
    .filter((g) => roleIds.has(key(refId(g.roleid))))
    .map((g) => ({
      Depth: depthName(g.privilegedepthmask),
      PrivilegeId: refId(g.privilegeid),
      BusinessUnitId: refId(roles.get(key(refId(g.roleid)))?.businessunitid) ?? null,
      PrivilegeName: privileges.get(key(refId(g.privilegeid)))?.name ?? '',
    }));
}

// Role ids (lowercase) a user holds directly or through its team memberships.
function roleIdsOfUser(store, userId) {
  const teams = new Set(teamsOfUser(store, userId));
  const direct = tableOf(store, 'systemuserroles')
    .filter((r) => sameId(refId(r.systemuserid), userId))
    .map((r) => key(refId(r.roleid)));
  const viaTeams = tableOf(store, 'teamroles')
    .filter((t) => teams.has(key(refId(t.teamid))))
    .map((t) => key(refId(t.roleid)));
  return new Set([...direct, ...viaTeams]);
}

function systemuserOf(store, id) {
  const found = tableOf(store, 'systemuser').find((u) => sameId(u.systemuserid, id));
  if (!found) throw notFound('systemuser', id);
  return found;
}

// The Entra ID object id is the lookup key for the AAD functions; the user must already exist in Dataverse.
function systemuserByAad(store, directoryObjectId) {
  const found = tableOf(store, 'systemuser').find((u) => sameId(u.azureactivedirectoryobjectid, directoryObjectId));
  if (!found) throw notFound('systemuser', directoryObjectId);
  return found;
}

// The SYSTEM user (seeded with the System Administrator role, dataverse-security.mjs): the identity of internal reads.
function systemUser(store) {
  const found = tableOf(store, 'systemuser').find((u) => u.fullname === 'SYSTEM');
  if (!found) throw notFound('systemuser', 'SYSTEM');
  return found;
}

function privilegeRow(store, privilegeId) {
  const found = tableOf(store, 'privilege').find((p) => sameId(p.privilegeid, privilegeId));
  if (!found) throw notFound('privilege', privilegeId);
  return found;
}

// A privilege argument is a RolePrivilege PrivilegeId (Edm.Guid) in lists, or a privilege entity reference in RemovePrivilegeRole.
function privilegeIdOf(api, value) {
  return value?.privilegeid ?? targetRef(api, value).id;
}

// Every entry of a Privileges list is checked before the first write: one unknown privilege or depth refuses the whole list.
function grantsOf(store, list) {
  return listOf(list).map((entry) => ({
    privilege: privilegeRow(store, refId(entry.PrivilegeId)),
    mask: maskOf(entry.Depth),
  }));
}

function upsertGrant(store, roleId, { privilege, mask }) {
  const rows = tableOf(store, 'roleprivileges');
  const existing = rows.find(
    (g) => sameId(refId(g.roleid), roleId) && sameId(refId(g.privilegeid), privilege.privilegeid),
  );
  if (existing) existing.privilegedepthmask = mask;
  else
    rows.push({
      roleprivilegeid: uuidV5(roleId, privilege.privilegeid),
      roleid: ref('role', roleId),
      privilegeid: ref('privilege', privilege.privilegeid),
      privilegedepthmask: mask,
    });
}

// Removes one privilege from a role, or every privilege when privilegeId is undefined.
function revokeGrants(store, roleId, privilegeId) {
  removeWhere(
    tableOf(store, 'roleprivileges'),
    (g) => sameId(refId(g.roleid), roleId) && (privilegeId === undefined || sameId(refId(g.privilegeid), privilegeId)),
  );
}

// Access origin for RetrieveAccessOrigin, in the documented order (security-sharing-assigning#determine-why-a-user-has-access).
function accessOriginOf(store, { principal, teams, logical, objectId, row }) {
  const owner = refId(row.ownerid);
  if (sameId(owner, principal)) return `PrincipalId is object owner (${objectId})`;
  const ownerTeam = teams.find((t) => sameId(t, owner));
  if (ownerTeam) return `PrincipalId is member of team (${ownerTeam}) who is object owner (${objectId})`;
  const shares = tableOf(store, 'principalobjectaccess').filter(
    (s) => sameId(s.objectid, objectId) && sameId(s.objecttypecode, logical),
  );
  if (shares.some((s) => sameId(refId(s.principalid), principal)))
    return `PrincipalId has direct poa access to object (${objectId})`;
  for (const share of shares) {
    const team = teams.find((t) => sameId(t, refId(share.principalid)));
    if (team) return `PrincipalId is member of team (${team}) who has poa access to object (${objectId})`;
  }
  return 'Access origin could not be found. Access does not come from POA table or object ownership.';
}

// Team membership the platform refuses: Entra and office group teams (teamtype 2 and 3), and a business unit's default team.
function assertTeamAcceptsMembers(store, target) {
  // The router passes the row of an entity-bound target; the lookup covers a caller that passes only the id.
  const row = target.row ?? tableOf(store, 'team').find((t) => sameId(t.teamid, target.id));
  if (Number(row?.teamtype) >= 2) {
    throw invalid(
      `Team with Id = ${target.id} has type ${row.teamtype}. It's not allowed to add members to Microsoft Entra security group teams or office group teams.`,
      '0x80040208',
    );
  }
  // The wording of the default team refusal is a guess; 0x8004830B is the documented code.
  if (row?.isdefault === true)
    throw invalid(
      `Team with Id = ${target.id} is the default team of its business unit; members cannot be added to or removed from it.`,
      '0x8004830B',
    );
}

// True when `parentId` is `userId` or reports, directly or indirectly, to it: setting it as the user's manager would close a loop.
function managerLoop(store, userId, parentId) {
  const seen = new Set();
  for (let id = parentId ?? null; id != null && !seen.has(key(id));) {
    if (sameId(id, userId)) return true;
    seen.add(key(id));
    id = refId(tableOf(store, 'systemuser').find((u) => sameId(u.systemuserid, id))?.parentsystemuserid) ?? null;
  }
  return false;
}

// Members are systemuser references; the @odata.type is required, or the platform cannot tell a user from a team.
function membersOf(c) {
  return listOf(body(c).Members).map((m) => {
    const id = m?.ownerid ?? m?.systemuserid;
    if (!/systemuser$/i.test(String(m?.['@odata.type'] ?? '')) || !id)
      throw invalid('EdmEntityObject passed should have the key property value set.');
    return id;
  });
}

function addMember(store, teamId, userId) {
  const rows = tableOf(store, 'teammembership');
  if (rows.some((m) => sameId(refId(m.teamid), teamId) && sameId(refId(m.systemuserid), userId))) return;
  rows.push({
    teammembershipid: uuidV5(teamId, userId),
    systemuserid: ref('systemuser', userId),
    teamid: ref('team', teamId),
  });
}

// Entity id from { "@odata.id": "widgets(<guid>)" } or a bare reference string.
function targetRef(api, value) {
  const text = String(value?.['@odata.id'] ?? value ?? '');
  const match = /([a-z_][a-z0-9_]*)\(\s*'?([0-9a-f-]{36})'?\s*\)\s*$/i.exec(text);
  if (!match) throw invalid('Invalid argument.');
  return { mapping: api.store.resolveMapping(match[1]), id: match[2] };
}

// The teamtemplate mapping and table, which every install and reset must have (the platform table always exists).
// Insert-only and idempotent. The privileges come from seedSecurity, which runs after install and reset.
function seedTeamTemplateTable(store) {
  store.state.mappings.teamtemplate ??= {
    logicalName: 'teamtemplate',
    entitySet: 'teamtemplates',
    idColumn: 'teamtemplateid',
    nameColumn: 'teamtemplatename',
    userConfigured: true,
    // Seeded for the Dataverse API only, as in dataverse-security.mjs.
    dataverseOnly: true,
    fields: Object.fromEntries(
      Object.entries(TEAM_TEMPLATE_FIELDS).map(([field, type]) => [field, { dataverseType: type }]),
    ),
    relationships: {},
  };
  tableOf(store, 'teamtemplate');
}

/**
 * Seeds the teamtemplate table and its privileges. Insert-only and idempotent: an existing mapping or row is left as it is.
 * Called before the record-team operations, and by tests that need a template to exist.
 */
export async function ensureTeamTemplates(store) {
  seedTeamTemplateTable(store);
  const org = organizationRecord(store);
  return seedTablePrivileges(store, { organizationId: org?.organizationid }, 'teamtemplate', {
    schema: TEAM_TEMPLATE_SCHEMA,
  });
}

function templateOf(store, teamTemplateId) {
  const found = tableOf(store, 'teamtemplate').find((t) => sameId(t.teamtemplateid, teamTemplateId));
  if (!found) throw notFound('teamtemplate', teamTemplateId);
  return found;
}

// The system-managed access team for one template and one record, or null before the first member is added.
const accessTeamOf = (store, teamTemplateId, recordId) =>
  tableOf(store, 'team').find(
    (t) =>
      t.systemmanaged === true &&
      sameId(refId(t.teamtemplateid), teamTemplateId) &&
      sameId(refId(t.regardingobjectid), recordId),
  ) ?? null;

// Owned records of a user move to `toId` (a systemuser or team): the owner trio is set as for any owner assignment.
function reassignOwned(store, fromId, toLogical, toId) {
  for (const [logical, mapping] of Object.entries(store.state.mappings)) {
    if (ownershipOf(logical, null, mapping) !== 'user') continue;
    for (const row of tableOf(store, logical))
      if (sameId(refId(row.ownerid), fromId))
        Object.assign(row, ownerColumns(store, { id: toId, logical_name: toLogical }));
  }
}

function operations(api) {
  const { store } = api;
  // Every write is one store transaction inside the change queue: a refusal part-way through rolls the whole message back,
  // and the store revision moves so cached privilege indexes see the change. Isolated, so the helpers that open their own
  // store.transact (grantAccess, setBusinessUnit, seedTablePrivileges) join it: a plain nested transact would wait behind
  // this one and never finish. A throw discards the working copy.
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const need = (c, privilege, entity) => {
    if (!(api.principals.privileges(c.user).get(privilege) > 0)) throw privilegeDeniedError(c.user, privilege, entity);
  };
  // A complex response carries its Web API context, as the other Dataverse modules' function responses do.
  const respond = (c, name, body) => ({
    status: 200,
    body: { '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), ...body },
  });
  // Rows of a collection function, formatted as a GET on the table (the caller's $select, row privileges and lookup columns).
  // `user` is the principal the read runs as: the caller by default, the SYSTEM user for an operation that needs no privilege.
  const collectionOf = (c, logical, ids, user = c.user) => messageCollection(api, c, logical, ids, user);
  // Privileges a user holds directly or through team roles (team grants report Basic), filtered by a predicate.
  // Team membership changes, for the Web API (write answers a promise) and a plug-in's SDK Execute (a synchronous write).
  const afterWrite = (written, answer) => (typeof written?.then === 'function' ? written.then(() => answer) : answer);
  const addMembersTeam = (c, writeMembers) => {
    need(c, 'prvWriteTeam', 'team');
    const teamId = c.target.id,
      members = membersOf(c);
    assertTeamAcceptsMembers(store, c.target);
    members.forEach((id) => assertCanJoinTeam(store, id));
    return afterWrite(
      writeMembers(() => {
        for (const id of members) addMember(store, teamId, id);
      }),
      { status: 204 },
    );
  };
  const removeMembersTeam = (c, writeMembers) => {
    need(c, 'prvWriteTeam', 'team');
    const teamId = c.target.id,
      members = membersOf(c);
    assertTeamAcceptsMembers(store, c.target);
    return afterWrite(
      writeMembers(() => {
        removeWhere(
          tableOf(store, 'teammembership'),
          (m) => sameId(refId(m.teamid), teamId) && members.some((id) => sameId(refId(m.systemuserid), id)),
        );
      }),
      { status: 204 },
    );
  };
  const userPrivileges = (c, name, keep) => {
    need(c, 'prvReadUser', 'systemuser');
    if (!api.principals.byId(c.target.id)) throw notFound('systemuser', c.target.id);
    return respond(c, name, { RolePrivileges: api.principals.retrieveUserPrivileges(c.target.id).filter(keep) });
  };
  // Checks shared by the record-team actions: the caller's privileges on systemuser and teamtemplate, the record, the template
  // (which must be for the record's table) and the caller's Share access on the record.
  const recordTeamContext = (c) => {
    need(c, 'prvReadUser', 'systemuser');
    need(c, 'prvReadTeamTemplate', 'teamtemplate');
    const { mapping, id } = targetRef(api, body(c).Record);
    const row = store.get(mapping.logicalName, id, c.identity);
    if (!row) throw notFound(mapping.logicalName, id);
    const template = templateOf(store, targetRef(api, body(c).TeamTemplate).id);
    if (Number(template.objecttypecode) !== objectTypeCode(mapping.logicalName))
      throw invalid(`The team template is not for the ${mapping.logicalName} table.`);
    api.principals.authorize({ user: c.user, entity: mapping.logicalName, operation: 'share', row, mapping });
    return { mapping, id, row, template };
  };

  return [
    {
      name: 'AddPrivilegesRole',
      kind: 'action',
      binding: 'entity',
      entity: 'role',
      // Declared by the role actions in dataverse-metadata.mjs (CSDL_ROLE_ACTIONS); an empty string adds no second declaration.
      csdl: '',
      handle: async (c) => {
        need(c, 'prvWriteRole', 'role');
        const roleId = c.target.id,
          grants = grantsOf(store, body(c).Privileges);
        await write(async () => {
          for (const grant of grants) upsertGrant(store, roleId, grant);
          await writeAudit(api, {
            entity: 'role',
            id: roleId,
            action: AUDIT_ACTION.addPrivilegesToRole,
            identity: c.identity,
          });
        });
        return { status: 204 };
      },
    },
    {
      name: 'RemovePrivilegeRole',
      kind: 'action',
      binding: 'entity',
      entity: 'role',
      handle: async (c) => {
        need(c, 'prvWriteRole', 'role');
        const roleId = c.target.id,
          privilege = privilegeRow(store, privilegeIdOf(api, body(c).Privilege));
        await write(async () => {
          revokeGrants(store, roleId, privilege.privilegeid);
          await writeAudit(api, {
            entity: 'role',
            id: roleId,
            action: AUDIT_ACTION.removePrivilegesFromRole,
            identity: c.identity,
          });
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'RemovePrivilegeRole', { bound: 'role', params: [['Privilege', 'mscrm.privilege']] }),
    },
    {
      name: 'ReplacePrivilegesRole',
      kind: 'action',
      binding: 'entity',
      entity: 'role',
      handle: async (c) => {
        need(c, 'prvWriteRole', 'role');
        const roleId = c.target.id,
          grants = grantsOf(store, body(c).Privileges);
        await write(async () => {
          revokeGrants(store, roleId);
          for (const grant of grants) upsertGrant(store, roleId, grant);
          await writeAudit(api, {
            entity: 'role',
            id: roleId,
            action: AUDIT_ACTION.replacePrivilegesInRole,
            identity: c.identity,
          });
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'ReplacePrivilegesRole', {
        bound: 'role',
        params: [['Privileges', 'Collection(mscrm.RolePrivilege)']],
      }),
    },
    {
      name: 'RetrieveRolePrivilegesRole',
      kind: 'function',
      binding: 'unbound',
      handle: (c) => {
        need(c, 'prvReadRole', 'role');
        const id = c.params?.RoleId;
        if (!id) throw invalid('RoleId is required.');
        if (!tableOf(store, 'role').some((row) => sameId(row.roleid, id))) throw notFound('role', id);
        return respond(c, 'RetrieveRolePrivilegesRole', { RolePrivileges: entriesOf(store, new Set([key(id)])) });
      },
      csdl: csdlOf('function', 'RetrieveRolePrivilegesRole', {
        params: [['RoleId', 'Edm.Guid']],
        response: ['RolePrivileges', 'Collection(mscrm.RolePrivilege)'],
      }),
    },
    {
      name: 'RetrieveUserPrivilegeByPrivilegeName',
      kind: 'function',
      binding: 'entity',
      entity: 'systemuser',
      handle: (c) =>
        userPrivileges(c, 'RetrieveUserPrivilegeByPrivilegeName', (p) => p.PrivilegeName === c.params?.PrivilegeName),
      csdl: csdlOf('function', 'RetrieveUserPrivilegeByPrivilegeName', {
        bound: 'systemuser',
        params: [['PrivilegeName', 'Edm.String']],
        response: ['RolePrivileges', 'Collection(mscrm.RolePrivilege)'],
      }),
    },
    {
      name: 'RetrieveUserPrivilegeByPrivilegeId',
      kind: 'function',
      binding: 'entity',
      entity: 'systemuser',
      handle: (c) =>
        userPrivileges(c, 'RetrieveUserPrivilegeByPrivilegeId', (p) => sameId(p.PrivilegeId, c.params?.PrivilegeId)),
      csdl: csdlOf('function', 'RetrieveUserPrivilegeByPrivilegeId', {
        bound: 'systemuser',
        params: [['PrivilegeId', 'Edm.Guid']],
        response: ['RolePrivileges', 'Collection(mscrm.RolePrivilege)'],
      }),
    },
    {
      name: 'RetrieveUserSetOfPrivilegesByNames',
      kind: 'function',
      binding: 'entity',
      entity: 'systemuser',
      handle: (c) => {
        const names = listOf(c.params?.PrivilegeNames);
        return userPrivileges(c, 'RetrieveUserSetOfPrivilegesByNames', (p) => names.includes(p.PrivilegeName));
      },
      csdl: csdlOf('function', 'RetrieveUserSetOfPrivilegesByNames', {
        bound: 'systemuser',
        params: [['PrivilegeNames', 'Collection(Edm.String)']],
        response: ['RolePrivileges', 'Collection(mscrm.RolePrivilege)'],
      }),
    },
    {
      name: 'RetrieveUserSetOfPrivilegesByIds',
      kind: 'function',
      binding: 'entity',
      entity: 'systemuser',
      handle: (c) => {
        const ids = listOf(c.params?.PrivilegeIds).map(key);
        return userPrivileges(c, 'RetrieveUserSetOfPrivilegesByIds', (p) => ids.includes(key(p.PrivilegeId)));
      },
      csdl: csdlOf('function', 'RetrieveUserSetOfPrivilegesByIds', {
        bound: 'systemuser',
        params: [['PrivilegeIds', 'Collection(Edm.Guid)']],
        response: ['RolePrivileges', 'Collection(mscrm.RolePrivilege)'],
      }),
    },
    {
      name: 'RetrieveTeamPrivileges',
      kind: 'function',
      binding: 'entity',
      entity: 'team',
      handle: (c) => {
        need(c, 'prvReadTeam', 'team');
        const roleIds = new Set(
          tableOf(store, 'teamroles')
            .filter((t) => sameId(refId(t.teamid), c.target.id))
            .map((t) => key(refId(t.roleid))),
        );
        return respond(c, 'RetrieveTeamPrivileges', { RolePrivileges: entriesOf(store, roleIds) });
      },
      csdl: csdlOf('function', 'RetrieveTeamPrivileges', {
        bound: 'team',
        response: ['RolePrivileges', 'Collection(mscrm.RolePrivilege)'],
      }),
    },
    {
      name: 'AddMembersTeam',
      kind: 'action',
      binding: 'entity',
      entity: 'team',
      handle: async (c) => addMembersTeam(c, write),
      // A plug-in's SDK Execute (AddMembersTeamRequest) writes inside its caller's transaction.
      sdk: (c) => addMembersTeam(c, c.sdkWrite),
      csdl: csdlOf('action', 'AddMembersTeam', {
        bound: 'team',
        params: [['Members', 'Collection(mscrm.systemuser)']],
      }),
    },
    {
      name: 'RemoveMembersTeam',
      kind: 'action',
      binding: 'entity',
      entity: 'team',
      handle: async (c) => removeMembersTeam(c, write),
      sdk: (c) => removeMembersTeam(c, c.sdkWrite),
      csdl: csdlOf('action', 'RemoveMembersTeam', {
        bound: 'team',
        params: [['Members', 'Collection(mscrm.systemuser)']],
      }),
    },
    {
      name: 'AddUserToRecordTeam',
      kind: 'action',
      binding: 'entity',
      entity: 'systemuser',
      handle: async (c) => {
        await write(() => ensureTeamTemplates(store));
        const { mapping, id, row, template } = recordTeamContext(c);
        const memberId = c.target.id,
          member = systemuserOf(store, memberId);
        // The member needs Basic (User) Read on the record's table; the message is the one the platform returns.
        if (
          !(
            api.principals
              .privileges(member)
              .get(privilegeName('Read', api.principals.privilegeNoun(mapping.logicalName))) > 0
          )
        ) {
          // The code is a guess: PrincipalPrivilegeDenied 0x80040231.
          throw invalid(
            "You can't add the user to the access team because the user doesn't have sufficient privileges on the entity.",
            '0x80040231',
          );
        }
        // The caller must hold every right the template grants, on this record.
        for (const right of Object.keys(ACCESS_RIGHTS)) {
          if (Number(template.defaultaccessrightsmask) & ACCESS_RIGHTS[right])
            api.principals.authorize({
              user: c.user,
              entity: mapping.logicalName,
              operation: RIGHT_OPERATION[right],
              row,
              mapping,
            });
        }
        let accessTeamId;
        await write(async () => {
          assertCanJoinTeam(store, memberId);
          let team = accessTeamOf(store, template.teamtemplateid, id);
          if (!team) {
            // ponytail: one access team per (template, record); the platform's team naming and cascade rules are not modelled.
            const org = organizationRecord(store);
            team = {
              teamid: store.ids.uuid(),
              name: template.teamtemplatename ?? '',
              teamtype: ACCESS_TEAM,
              systemmanaged: true,
              teamtemplateid: ref('teamtemplate', template.teamtemplateid),
              regardingobjectid: ref(mapping.logicalName, id),
              businessunitid: ref('businessunit', businessUnitOf(store, row) || refId(member.businessunitid) || null),
              organizationid: ref('organization', org?.organizationid ?? null),
            };
            tableOf(store, 'team').push(team);
            await grantAccess(store, {
              target: { id, logical: mapping.logicalName },
              principal: { id: team.teamid, logical_name: 'team' },
              mask: Number(template.defaultaccessrightsmask),
            });
          }
          addMember(store, team.teamid, memberId);
          accessTeamId = team.teamid;
        });
        return respond(c, 'AddUserToRecordTeam', { AccessTeamId: accessTeamId });
      },
      csdl: csdlOf('action', 'AddUserToRecordTeam', {
        bound: 'systemuser',
        params: RECORD_TEAM_PARAMS,
        response: ['AccessTeamId', 'Edm.Guid'],
      }),
    },
    {
      name: 'RemoveUserFromRecordTeam',
      kind: 'action',
      binding: 'entity',
      entity: 'systemuser',
      handle: async (c) => {
        await write(() => ensureTeamTemplates(store));
        const { mapping, id, template } = recordTeamContext(c);
        const memberId = c.target.id;
        await write(async () => {
          const team = accessTeamOf(store, template.teamtemplateid, id);
          if (!team) return;
          const memberships = tableOf(store, 'teammembership');
          let removed = false;
          for (let index = memberships.length - 1; index >= 0; index--) {
            const member = memberships[index];
            if (sameId(refId(member.teamid), team.teamid) && sameId(refId(member.systemuserid), memberId)) {
              store.removeRow('teammembership', memberships, index);
              removed = true;
            }
          }
          if (!removed || memberships.some((member) => sameId(refId(member.teamid), team.teamid))) return;
          // Microsoft documents final-member removal as removing the team's
          // record share and deleting the system-managed access team. The
          // enclosing transaction publishes both removals together.
          await revokeAccess(store, {
            target: { id, logical: mapping.logicalName },
            principal: { id: team.teamid, logical_name: 'team' },
          });
          const teams = tableOf(store, 'team');
          store.removeRow('team', teams, teams.indexOf(team));
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'RemoveUserFromRecordTeam', { bound: 'systemuser', params: RECORD_TEAM_PARAMS }),
    },
    {
      name: 'SetBusinessSystemUser',
      kind: 'action',
      binding: 'entity',
      entity: 'systemuser',
      handle: async (c) => {
        need(c, 'prvWriteUser', 'systemuser');
        const userId = c.target.id,
          args = body(c);
        const unit = targetRef(api, args.BusinessUnit),
          principal = targetRef(api, args.ReassignPrincipal);
        if (!['systemuser', 'team'].includes(principal.mapping.logicalName))
          throw invalid('ReassignPrincipal must be a systemuser or a team.');
        systemuserOf(store, userId);
        await write(async () => {
          const moved = systemuserOf(store, userId),
            previousParent = refId(moved.parentsystemuserid) ?? null;
          // Awaited: an unknown or disabled business unit throws here and the whole message rolls back.
          await setBusinessUnit(store, {
            userId,
            businessUnitId: unit.id,
            doNotMoveAllRecords: args.DoNotMoveAllRecords === true,
          });
          reassignOwned(store, userId, principal.mapping.logicalName, principal.id);
          // Direct reports outside the new hierarchy report to the user's previous manager; the user leaves a manager
          // whose business unit hierarchy no longer holds the new unit.
          const chain = api.principals.businessUnitChain(unit.id);
          if (
            previousParent &&
            !api.principals
              .businessUnitChain(refId(systemuserOf(store, previousParent).businessunitid))
              .has(key(unit.id))
          ) {
            moved.parentsystemuserid = null;
          }
          for (const report of tableOf(store, 'systemuser').filter((u) =>
            sameId(refId(u.parentsystemuserid), userId),
          )) {
            if (!chain.has(key(refId(report.businessunitid))))
              report.parentsystemuserid = previousParent ? ref('systemuser', previousParent) : null;
          }
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'SetBusinessSystemUser', {
        bound: 'systemuser',
        params: [
          ['BusinessUnit', 'mscrm.businessunit'],
          ['ReassignPrincipal', 'mscrm.crmbaseentity'],
          ['DoNotMoveAllRecords', 'Edm.Boolean'],
        ],
      }),
    },
    {
      name: 'RetrieveAadUserRoles',
      kind: 'function',
      binding: 'unbound',
      // The roles the user holds directly or through a team. No privilege is required (the reference lists none).
      handle: async (c) => {
        const ids = roleIdsOfUser(store, systemuserByAad(store, c.params?.DirectoryObjectId).systemuserid);
        // The role rows are read as SYSTEM, so the caller needs no prvReadRole; $select and the row formatting still apply.
        return collectionOf(c, 'role', [...ids], systemUser(store));
      },
      csdl: csdlOf('function', 'RetrieveAadUserRoles', {
        params: [['DirectoryObjectId', 'Edm.Guid']],
        returns: 'Collection(mscrm.role)',
      }),
    },
    {
      name: 'RetrieveAadUserPrivileges',
      kind: 'function',
      binding: 'unbound',
      handle: async (c) => {
        const ids = roleIdsOfUser(store, systemuserByAad(store, c.params?.DirectoryObjectId).systemuserid);
        return respond(c, 'RetrieveAadUserPrivileges', { RolePrivileges: entriesOf(store, ids) });
      },
      csdl: csdlOf('function', 'RetrieveAadUserPrivileges', {
        params: [['DirectoryObjectId', 'Edm.Guid']],
        response: ['RolePrivileges', 'Collection(mscrm.RolePrivilege)'],
      }),
    },
    {
      name: 'RetrieveSharedPrincipalsAndAccess',
      kind: 'function',
      binding: 'unbound',
      handle: async (c) => {
        const { mapping, id } = targetRef(api, c.params?.Target);
        // No Retrieve pipeline runs before it (recorded native webApiNamed).
        const row = store.get(mapping.logicalName, id, c.identity, { skipPluginRead: true });
        if (!row) throw notFound(mapping.logicalName, id);
        api.principals.authorize({ user: c.user, entity: mapping.logicalName, operation: 'read', row, mapping });
        const shares = tableOf(store, 'principalobjectaccess').filter(
          (s) => sameId(s.objectid, id) && sameId(s.objecttypecode, mapping.logicalName),
        );
        return respond(c, 'RetrieveSharedPrincipalsAndAccess', {
          PrincipalAccesses: shares.map((s) => {
            const principal = refId(s.principalid);
            return {
              AccessMask: accessNames(s.accessrightsmask),
              Principal: { '@odata.type': principalType(store, principal), ownerid: principal },
            };
          }),
        });
      },
      // Steps read PrincipalAccess[] (native webApiNamed RetrieveSharedPrincipalsAndAccess/40 OutputParameters).
      pluginOutputs: (body, c) => {
        const { mapping, id } = targetRef(api, c.params?.Target);
        return { PrincipalAccesses: principalAccessesOf(store, { logicalName: mapping.logicalName, id }) };
      },
      csdl: csdlOf('function', 'RetrieveSharedPrincipalsAndAccess', {
        params: [['Target', 'mscrm.crmbaseentity']],
        response: ['PrincipalAccesses', 'Collection(mscrm.PrincipalAccess)'],
      }),
    },
    {
      name: 'RetrieveAccessOrigin',
      kind: 'function',
      binding: 'unbound',
      handle: async (c) => {
        const p = c.params ?? {},
          logical = store.resolveMapping(p.LogicalName).logicalName;
        const row = store.get(logical, p.ObjectId, c.identity);
        if (!row) throw notFound(logical, p.ObjectId);
        const teams = teamsOfUser(store, p.PrincipalId);
        return respond(c, 'RetrieveAccessOrigin', {
          Response: accessOriginOf(store, { principal: p.PrincipalId, teams, logical, objectId: p.ObjectId, row }),
        });
      },
      csdl: csdlOf('function', 'RetrieveAccessOrigin', {
        params: [
          ['ObjectId', 'Edm.Guid'],
          ['LogicalName', 'Edm.String'],
          ['PrincipalId', 'Edm.Guid'],
        ],
        response: ['Response', 'Edm.String'],
      }),
    },
    {
      name: 'SetParentSystemUser',
      kind: 'action',
      binding: 'entity',
      entity: 'systemuser',
      // Assumed: KeepChildUsers true leaves the direct reports under the user; false moves them to the user's former parent.
      handle: async (c) => {
        need(c, 'prvWriteUser', 'systemuser');
        const userId = c.target.id,
          args = body(c);
        const parentId = targetRef(api, args.Parent).id;
        if (typeof args.KeepChildUsers !== 'boolean') throw invalid('KeepChildUsers is required.');
        systemuserOf(store, parentId);
        if (managerLoop(store, userId, parentId)) {
          throw new DataError(
            "You cannot set the selected user as the manager for this user because the selected user is either already the manager or is in the user's immediate management hierarchy.",
            400,
            'InvalidRequest',
            { innerCode: '0x80041d25' },
          );
        }
        await write(() => {
          const user = systemuserOf(store, userId),
            previousParent = refId(user.parentsystemuserid) ?? null;
          if (args.KeepChildUsers === false) {
            for (const child of tableOf(store, 'systemuser').filter((u) =>
              sameId(refId(u.parentsystemuserid), userId),
            )) {
              child.parentsystemuserid = previousParent ? ref('systemuser', previousParent) : null;
            }
          }
          user.parentsystemuserid = ref('systemuser', parentId);
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'SetParentSystemUser', {
        bound: 'systemuser',
        params: [
          ['Parent', 'mscrm.systemuser'],
          ['KeepChildUsers', 'Edm.Boolean'],
        ],
      }),
    },
    {
      name: 'RetrieveBusinessHierarchyBusinessUnit',
      kind: 'function',
      binding: 'entity',
      entity: 'businessunit',
      handle: async (c) => {
        need(c, 'prvReadBusinessUnit', 'businessunit');
        const chain = api.principals.businessUnitChain(c.target.id);
        return collectionOf(c, 'businessunit', [...chain]);
      },
      csdl: csdlOf('function', 'RetrieveBusinessHierarchyBusinessUnit', {
        bound: 'businessunit',
        returns: 'Collection(mscrm.businessunit)',
      }),
    },
  ];
}

// CSDL for one operation: its binding parameter, parameters and return type. A response is a ComplexType named <Name>Response.
function csdlOf(kind, name, { bound = null, params = [], returns = null, response = null, complex = null }) {
  const tag = kind === 'action' ? 'Action' : 'Function';
  // A supplied supporting type supplements the response wrapper; both are referenced by the operation's model.
  const complexType = [
    complex,
    response
      ? `<ComplexType Name="${name}Response"><Property Name="${response[0]}" Type="${response[1]}" /></ComplexType>`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
  const parts = bound ? [`<Parameter Name="entity" Type="mscrm.${bound}" Nullable="false" />`] : [];
  for (const [param, type] of params) parts.push(`<Parameter Name="${param}" Type="${type}" />`);
  if (response) returns = `mscrm.${name}Response`;
  if (returns) parts.push(`<ReturnType Type="${returns}" Nullable="false" />`);
  const head = `<${tag} Name="${name}"${bound ? ' IsBound="true"' : ''}>`;
  return [complexType, `${head}\n  ${parts.join('\n  ')}\n</${tag}>`].filter(Boolean).join('\n');
}

// Registers the operations and the record hook that refuses an access team holding roles. The teamtemplate table exists from
// install on, so /teamtemplates answers before any record-team call (its privileges follow from the security seeding).
// Synchronous: runs before the first transaction, and the security seeding that follows saves the whole state.
export function install(api) {
  api.recordHooks.add('beforeWrite', (c, mapping, { operation, data, existing }) => {
    if (operation === 'associate' && mapping.logicalName === 'team' && data?.relationship === 'teamroles_association')
      assertTeamCanHoldRoles(api.store, existing?.teamid);
  });
  seedTeamTemplateTable(api.store);
  for (const op of operations(api)) api.registry.register(op);
}

// A store reset drops the mapping and the table: they come back before the security seeding runs.
export function reset(api) {
  return api.store.transact(() => seedTeamTemplateTable(api.store));
}

// Helpers shared with dataverse-security-messages2.mjs (its operations are registered from dataverse-extensions.mjs).
export {
  key,
  sameId,
  refId,
  tableOf,
  listOf,
  body,
  notFound,
  invalid,
  targetRef,
  entriesOf,
  roleIdsOfUser,
  systemuserOf,
  systemuserByAad,
  csdlOf,
};
