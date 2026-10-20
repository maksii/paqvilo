import { organizationRecord } from './organization-context.mjs';
// Simulated Dataverse security messages, second set: owner reassignment, owner-to-access team conversion, team business units
// and group sync, shared links, Entra object id privilege reads, the user hierarchy, team-derived privileges, masked columns,
// the delegation, privilege checker, consent and inherited-access messages, and the internal-only channel and sync messages.
// Registered from dataverse-extensions.mjs. Invented schema and GUIDs only. The response shapes come from the Learn complex-type
// pages (GenerateSharedLinkResponse, RetrieveMaskedAttributesForEntityResponse, RetrieveUsersPrivilegesThroughTeamsResponse,
// ResetInheritedAccessResponse, GetConsentLinkResponse). Lines marked "unverified" are behaviour not confirmed against a live capture.
import { randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { registerInternalMessage } from "./dataverse-addon-common.mjs";
import { objectTypeCode } from "./dataverse-metadata.mjs";
import { contextUrl, parseDataverseRoute, parsePrefer } from "./dataverse-odata.mjs";
import {
  ACCESS_RIGHTS, DEPTH, assertTeamCanOwn, businessUnitOf, dataverseIdentity, grantAccess, ownerColumns, ownershipOf, parseAccessMask,
  privilegeDeniedError, revokeAccess, teamsOfUser, uuidV5,
} from "./dataverse-security.mjs";
import { relationshipsOf } from "./dataverse-standard.mjs";
import {
  body, csdlOf, entriesOf, invalid, key, listOf, notFound, refId, roleIdsOfUser, sameId, systemuserByAad, systemuserOf, tableOf, targetRef,
} from "./dataverse-security-messages.mjs";

const OWNER_TEAM = 0, ACCESS_TEAM = 1;
const ADMIN_ROLE = "System Administrator";
// The owner rights of a shared authorization (owneraccess): every right but Create.
const OWNER_RIGHTS = ["Read", "Write", "Append", "AppendTo", "Delete", "Share", "Assign"].reduce((mask, right) => mask | ACCESS_RIGHTS[right], 0);
// privilegecheckerlog.privilegedepth (Basic 0, Local 1, Deep 2, Global 3) to the role privilege depth mask. Other values are skipped.
const CHECK_DEPTH_MASK = [DEPTH.Basic, DEPTH.Local, DEPTH.Deep, DEPTH.Global];
const CONSENT_PROPERTIES = ["tenantId", "redirectUrl", "parameterConsentLinks", "principalType", "principalId", "consentLink", "firstPartyLoginUri", "customParameters"];
const CONSENT_COMPLEX = `<ComplexType Name="GetConsentLinkResponse">\n  ${CONSENT_PROPERTIES.map((p) => `<Property Name="${p}" Type="Edm.String" />`).join("\n  ")}\n</ComplexType>`;
const lookup = (logical, id) => (id == null ? null : { id, logical_name: logical, name: "" });
const teamOf = (store, id) => {
  const found = tableOf(store, "team").find((t) => sameId(t.teamid, id));
  if (!found) throw notFound("team", id);
  return found;
};
// A shared link is a team row whose sharelinkqualifier holds the rights. Its id is a token derived from the record and the
// rights, so the same call returns the same link. ponytail: the team table stands in for a link table, which is not in the standard set.
const tokenOf = (recordId, mask) => uuidV5(recordId, `sharedlink:${mask}`);
const isLink = (team) => team.sharelinkqualifier != null;
const ownsRows = (store, id) => Object.entries(store.state.mappings).some(([logical, mapping]) => ownershipOf(logical, null, mapping) === "user"
  && tableOf(store, logical).some((r) => sameId(refId(r.ownerid), id)));

// A systemuser or team reference: an entity reference object, an "@odata.id" such as "systemusers(<guid>)", or a bare id.
function principalOf(store, value, label) {
  const text = value?.["@odata.id"];
  const match = text ? /\(\s*'?([0-9a-f-]{36})'?\s*\)\s*$/i.exec(text) : null;
  const id = match ? match[1] : refId(value?.systemuserid ?? value?.teamid ?? value?.ownerid ?? value);
  if (id == null || typeof id === "object") throw invalid(`${label} is required.`);
  const user = tableOf(store, "systemuser").find((u) => sameId(u.systemuserid, id));
  if (user) return { id: user.systemuserid, logical_name: "systemuser" };
  const team = tableOf(store, "team").find((t) => sameId(t.teamid, id));
  if (team) return { id: team.teamid, logical_name: "team" };
  throw notFound("systemuser", id);
}

const objectTypeArg = (value) => {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(Number(value))) throw invalid(`Invalid object type ${value}.`);
  return Number(value);
};

// Rows of the user-owned tables (only the objectType table when given) that `from` owns move to `to`. The caller needs Assign on
// each row, so one refusal rolls back the whole message. ponytail: the platform's cascade of the reassignment is not modelled.
function reassignRows(api, c, from, to, objectType) {
  const { store } = api;
  if (to.logical_name === "team") assertTeamCanOwn(store, to.id);
  const tables = Object.entries(store.state.mappings).filter(([logical, mapping]) => ownershipOf(logical, null, mapping) === "user"
    && (objectType === null || objectTypeCode(logical) === objectType));
  // unverified: the refusal for an object type that is not a user-owned table.
  if (objectType !== null && tables.length === 0) throw invalid(`The object type code ${objectType} is not a user-owned table.`);
  for (const [logical, mapping] of tables) {
    for (const row of tableOf(store, logical)) {
      if (!sameId(refId(row.ownerid), from.id)) continue;
      api.principals.authorize({ user: c.user, entity: logical, operation: "assign", row, mapping });
      Object.assign(row, ownerColumns(store, to));
    }
  }
}

// A shared-link row. The target's business unit and the organization are copied as the other team rows carry them.
function linkRow(store, { token, logical, id, mask, row }) {
  const org = organizationRecord(store);
  return {
    teamid: token, name: "Shared link", teamtype: OWNER_TEAM, systemmanaged: false, sharelinkqualifier: String(mask),
    regardingobjectid: lookup(logical, id), regardingobjecttypecode: logical, grantees: [],
    businessunitid: lookup("businessunit", businessUnitOf(store, row) || null), organizationid: lookup("organization", org?.organizationid ?? null),
  };
}

export function install(api) {
  const { store } = api;
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const need = (c, privilege, entity) => {
    if (!(api.principals.privileges(c.user).get(privilege) > 0)) throw privilegeDeniedError(c.user, privilege, entity);
  };
  const respond = (c, name, payload) => ({
    status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), ...payload },
  });
  // Rows of a table by id, formatted as a GET on the table (the caller's $select, row privileges and lookup columns).
  const collectionOf = async (c, logical, ids) => {
    const mapping = store.resolveMapping(logical);
    if (ids.length === 0) return { status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, mapping.entitySet), value: [] } };
    const path = `/api/data/${c.version}/${mapping.entitySet}`;
    const url = new URL(`${c.origin}${path}`);
    url.searchParams.set("$filter", ids.map((id) => `${mapping.idColumn} eq ${id}`).join(" or "));
    if (c.url?.searchParams.has("$select")) url.searchParams.set("$select", c.url.searchParams.get("$select"));
    const res = await api.records.handle({
      method: "GET", route: parseDataverseRoute(path), url, origin: c.origin, version: c.version,
      prefer: parsePrefer(undefined), headers: {}, user: c.user, caller: c.caller, identity: c.identity, requestId: c.requestId,
    });
    return { status: 200, body: res.body };
  };
  // The record a shared-link message names, read and checked against the caller's privilege for `operation`.
  const sharedTarget = (c, value, operation) => {
    const { mapping, id } = targetRef(api, value);
    const row = store.get(mapping.logicalName, id, c.identity);
    if (!row) throw notFound(mapping.logicalName, id);
    api.principals.authorize({ user: c.user, entity: mapping.logicalName, operation, row, mapping });
    return { mapping, id, row };
  };
  // The privilege-derived rights of an Entra object id: privileges through its systemuser's roles, filtered by `keep`.
  const aadPrivileges = (c, name, keep) => {
    need(c, "prvReadUser", "systemuser");
    const user = systemuserByAad(store, c.params?.DirectoryObjectId);
    return respond(c, name, { RolePrivileges: entriesOf(store, roleIdsOfUser(store, user.systemuserid)).filter(keep) });
  };
  const orgId = () => organizationRecord(store)?.organizationid ?? null;
  // The System Administrator role check of dataverse-fls.mjs. unverified: the privilege name in the refusal.
  const needSystemAdministrator = (c) => {
    if (!api.principals.roles(c.user).some((r) => r.name === ADMIN_ROLE)) throw privilegeDeniedError(c.user, "prvSystemAdministrator", "organization");
  };
  // The table holding the referencing (many) side of the relationship with this schema name, or null. ponytail: a many-to-many
  // relationship answers the other table.
  const relationshipTableOf = (schemaName) => {
    const wanted = key(schemaName);
    for (const logical of Object.keys(store.state.mappings)) {
      for (const rel of Object.values(relationshipsOf(store, logical))) {
        if (key(rel.schemaName) === wanted) return rel.many ? rel.entity : logical;
      }
    }
    return null;
  };
  // Inserts the delegated authorization when it is missing. Synchronous: call it inside write.
  const insertDelegation = (daId, name) => {
    const rows = tableOf(store, "delegatedauthorization");
    if (!rows.some((d) => sameId(d.delegatedauthorizationid, daId))) {
      rows.push({ delegatedauthorizationid: daId, name, statecode: 0, statuscode: 1, organizationid: lookup("organization", orgId()) });
    }
  };
  // The delegation team of an authorization, created with it when missing. Synchronous: call it inside write.
  // unverified: teamtype 1. ponytail: the team gets no members and no roles.
  const delegationTeamOf = (c, daId) => {
    const teams = tableOf(store, "team");
    const found = teams.find((t) => sameId(refId(t.delegatedauthorizationid), daId));
    if (found) return found;
    const team = {
      teamid: uuidV5(daId, "delegation:team"), name: `Delegation ${daId}`, teamtype: 1, systemmanaged: true,
      delegatedauthorizationid: lookup("delegatedauthorization", daId), businessunitid: lookup("businessunit", businessUnitOf(store, c.user)),
      organizationid: lookup("organization", orgId()),
    };
    teams.push(team);
    return team;
  };
  // The connection instance a consent message names: read, checked for write. Returns the stored row.
  const connectionOf = (c) => {
    const id = c.target.id;
    const row = store.get("connectioninstance", id, c.identity);
    if (!row) throw notFound("connectioninstance", id);
    api.principals.authorize({ user: c.user, entity: "connectioninstance", operation: "write", row, mapping: store.resolveMapping("connectioninstance") });
    return tableOf(store, "connectioninstance").find((r) => sameId(r.connectioninstanceid, id));
  };
  // RetrievePrincipalAccessInfo, bound to systemuser and to team: the rights the principal holds on one row.
  // unverified: the AccessInfo format; the rights string is wrapped as JSON.
  const principalAccessInfo = (entity) => ({
    name: "RetrievePrincipalAccessInfo", kind: "function", binding: "entity", entity,
    handle: async (c) => {
      const isUser = entity === "systemuser";
      need(c, isUser ? "prvReadUser" : "prvReadTeam", entity);
      const logical = store.resolveMapping(String(c.params?.EntityName ?? "")).logicalName;
      const id = c.params?.ObjectId;
      const row = store.get(logical, id, c.identity);
      if (!row) throw notFound(logical, id);
      const AccessRights = isUser
        ? api.principals.principalAccess({ user: systemuserOf(store, c.target.id), entity: logical, row })
        : api.principals.teamAccess({ team: teamOf(store, c.target.id), entity: logical, row });
      return respond(c, "RetrievePrincipalAccessInfo", { AccessInfo: JSON.stringify({ AccessRights }) });
    },
    csdl: csdlOf("function", "RetrievePrincipalAccessInfo", { bound: entity, params: [["ObjectId", "Edm.Guid"], ["EntityName", "Edm.String"]], response: ["AccessInfo", "Edm.String"] }),
  });

  const operations = [
    {
      name: "ConvertOwnerTeamToAccessTeam", kind: "action", binding: "entity", entity: "team",
      handle: async (c) => {
        need(c, "prvWriteTeam", "team");
        const teamId = c.target.id, team = teamOf(store, teamId);
        // unverified: both refusals; the live wording and code are not captured.
        if (Number(team.teamtype ?? 0) !== OWNER_TEAM) throw invalid(`Team with Id = ${teamId} is not an owner team.`);
        if (ownsRows(store, teamId)) throw invalid(`Team with Id = ${teamId} owns records and cannot be converted to an access team.`);
        await write(() => { teamOf(store, teamId).teamtype = ACCESS_TEAM; });
        return { status: 204 };
      },
      csdl: csdlOf("action", "ConvertOwnerTeamToAccessTeam", { bound: "team" }),
    },
    {
      name: "ReassignObjectsOwner", kind: "action", binding: "unbound",
      handle: async (c) => {
        const args = body(c);
        const from = principalOf(store, args.FromPrincipal, "FromPrincipal");
        const to = principalOf(store, args.ToPrincipal, "ToPrincipal");
        const objectType = objectTypeArg(args.objectType);
        await write(() => reassignRows(api, c, from, to, objectType));
        return { status: 204 };
      },
      csdl: csdlOf("action", "ReassignObjectsOwner", { params: [["FromPrincipal", "mscrm.crmbaseentity"], ["ToPrincipal", "mscrm.crmbaseentity"], ["objectType", "Edm.Int32"]] }),
    },
    {
      name: "ReassignObjectsSystemUser", kind: "action", binding: "entity", entity: "systemuser",
      handle: async (c) => {
        const args = body(c);
        const from = { id: systemuserOf(store, c.target.id).systemuserid, logical_name: "systemuser" };
        const to = principalOf(store, args.ReassignPrincipal, "ReassignPrincipal");
        const objectType = objectTypeArg(args.objectType);
        await write(() => reassignRows(api, c, from, to, objectType));
        return { status: 204 };
      },
      csdl: csdlOf("action", "ReassignObjectsSystemUser", { bound: "systemuser", params: [["ReassignPrincipal", "mscrm.crmbaseentity"], ["objectType", "Edm.Int32"]] }),
    },
    {
      name: "ResetInheritedAccess", kind: "function", binding: "unbound",
      handle: async (c) => {
        const fetchXml = String(c.params?.FetchXml ?? "");
        // unverified: the refusal for a query on another table.
        if (!/<entity\s+name=['"]principalobjectaccess['"]/i.test(fetchXml)) throw invalid("The FetchXml query must select principalobjectaccess.");
        // ponytail: every share row is reset and the FetchXml filter is not applied. Mirage never writes inherited rights (grantAccess
        // stores 0), so the reset changes nothing observable. unverified: the sentence and the privilege gate.
        await write(() => { for (const share of tableOf(store, "principalobjectaccess")) share.inheritedaccessrightsmask = 0; });
        return respond(c, "ResetInheritedAccess", {
          ResetInheritedAccessResponse: "The job to reset inherited access was created successfully. ExecutionMode: Synchronous.",
        });
      },
      csdl: csdlOf("function", "ResetInheritedAccess", { params: [["FetchXml", "Edm.String"]], response: ["ResetInheritedAccessResponse", "Edm.String"] }),
    },
    {
      name: "GenerateSharedLink", kind: "action", binding: "unbound",
      handle: async (c) => {
        const args = body(c);
        const { mapping, id, row } = sharedTarget(c, args.Target, "share");
        const mask = parseAccessMask(args.SharedRights), token = tokenOf(id, mask);
        await write(() => {
          const teams = tableOf(store, "team");
          if (!teams.some((t) => sameId(t.teamid, token))) teams.push(linkRow(store, { token, logical: mapping.logicalName, id, mask, row }));
        });
        // unverified: the link's URL shape. The loopback form carries the record and the token.
        const url = `${c.origin}/main.aspx?etn=${mapping.logicalName}&id=${id}&sharedlink=${token}`;
        return respond(c, "GenerateSharedLink", { Response: url });
      },
      csdl: csdlOf("action", "GenerateSharedLink", { params: [["Target", "mscrm.crmbaseentity"], ["SharedRights", "Edm.String"]], response: ["Response", "Edm.String"] }),
    },
    {
      name: "GrantAccessUsingSharedLink", kind: "action", binding: "unbound",
      handle: async (c) => {
        let token = null;
        try { token = new URL(String(body(c).RecordUrlWithSharedLink ?? "")).searchParams.get("sharedlink"); } catch { token = null; }
        const link = token ? tableOf(store, "team").find((t) => sameId(t.teamid, token) && isLink(t)) : null;
        // unverified: the refusal for a URL without a live shared link.
        if (!link) throw invalid("The URL does not carry a shared link.");
        const logical = link.regardingobjecttypecode, id = refId(link.regardingobjectid);
        const row = store.get(logical, id, c.identity);
        if (!row) throw notFound(logical, id);
        // The caller gains the link's rights on the record; the caller is recorded as a grantee for RevokeSharedLink.
        await write(() => {
          grantAccess(store, { target: { id, logical }, principal: { id: c.user.systemuserid, logical_name: "systemuser" }, mask: Number(link.sharelinkqualifier) });
          const live = teamOf(store, token);
          live.grantees = [...new Set([...(live.grantees ?? []), key(c.user.systemuserid)])];
        });
        return { status: 204 };
      },
      csdl: csdlOf("action", "GrantAccessUsingSharedLink", { params: [["RecordUrlWithSharedLink", "Edm.String"]] }),
    },
    {
      name: "RetrieveSharedLinks", kind: "function", binding: "unbound",
      handle: async (c) => {
        const { mapping, id } = sharedTarget(c, c.params?.Target, "read");
        const ids = tableOf(store, "team")
          .filter((t) => isLink(t) && sameId(refId(t.regardingobjectid), id) && t.regardingobjecttypecode === mapping.logicalName)
          .map((t) => t.teamid);
        return collectionOf(c, "team", ids);
      },
      csdl: csdlOf("function", "RetrieveSharedLinks", { params: [["Target", "mscrm.crmbaseentity"]], returns: "Collection(mscrm.team)" }),
    },
    {
      name: "RevokeSharedLink", kind: "action", binding: "unbound",
      handle: async (c) => {
        const args = body(c);
        const { mapping, id } = sharedTarget(c, args.Target, "share");
        const token = tokenOf(id, parseAccessMask(args.SharedRights));
        await write(() => {
          const teams = tableOf(store, "team"), link = teams.find((t) => sameId(t.teamid, token) && isLink(t));
          if (!link) return;
          // ponytail: a grantee loses the whole share on the record, not only the rights the link carried.
          for (const grantee of link.grantees ?? []) {
            revokeAccess(store, { target: { id, logical: mapping.logicalName }, principal: { id: grantee, logical_name: "systemuser" } });
          }
          teams.splice(teams.indexOf(link), 1);
        });
        return { status: 204 };
      },
      csdl: csdlOf("action", "RevokeSharedLink", { params: [["Target", "mscrm.crmbaseentity"], ["SharedRights", "Edm.String"]] }),
    },
    {
      name: "RetrieveAadUserSetOfPrivilegesByIds", kind: "function", binding: "unbound",
      handle: async (c) => {
        const ids = listOf(c.params?.PrivilegeIds).map(key);
        return aadPrivileges(c, "RetrieveAadUserSetOfPrivilegesByIds", (p) => ids.includes(key(p.PrivilegeId)));
      },
      csdl: csdlOf("function", "RetrieveAadUserSetOfPrivilegesByIds", {
        params: [["DirectoryObjectId", "Edm.Guid"], ["PrivilegeIds", "Collection(Edm.Guid)"]],
        response: ["RolePrivileges", "Collection(mscrm.RolePrivilege)"],
      }),
    },
    {
      name: "RetrieveAadUserSetOfPrivilegesByNames", kind: "function", binding: "unbound",
      handle: async (c) => {
        const names = listOf(c.params?.PrivilegeNames);
        return aadPrivileges(c, "RetrieveAadUserSetOfPrivilegesByNames", (p) => names.includes(p.PrivilegeName));
      },
      csdl: csdlOf("function", "RetrieveAadUserSetOfPrivilegesByNames", {
        params: [["DirectoryObjectId", "Edm.Guid"], ["PrivilegeNames", "Collection(Edm.String)"]],
        response: ["RolePrivileges", "Collection(mscrm.RolePrivilege)"],
      }),
    },
    {
      name: "RetrieveAllChildUsersSystemUser", kind: "function", binding: "entity", entity: "systemuser",
      handle: async (c) => {
        need(c, "prvReadUser", "systemuser");
        const user = systemuserOf(store, c.target.id);
        // Every user under the manager, at any depth; the user itself is not listed.
        return collectionOf(c, "systemuser", [...dataverseIdentity(store, user).userHierarchy(user.systemuserid)]);
      },
      csdl: csdlOf("function", "RetrieveAllChildUsersSystemUser", { bound: "systemuser", returns: "Collection(mscrm.systemuser)" }),
    },
    {
      name: "RetrieveMaskedAttributesForEntity", kind: "function", binding: "unbound",
      handle: async (c) => {
        const logical = String(c.params?.EntityLogicalName ?? "");
        if (!logical) throw invalid("EntityLogicalName is required.");
        // ponytail: the masking rules are listed whatever the caller's privileges; the platform filters by them.
        const names = tableOf(store, "attributemaskingrule").filter((r) => sameId(r.entityname, logical)).map((r) => r.attributelogicalname);
        return respond(c, "RetrieveMaskedAttributesForEntity", { AttributeLogicalNames: names });
      },
      csdl: csdlOf("function", "RetrieveMaskedAttributesForEntity", { params: [["EntityLogicalName", "Edm.String"]], response: ["AttributeLogicalNames", "Collection(Edm.String)"] }),
    },
    {
      name: "RetrieveUsersPrivilegesThroughTeams", kind: "function", binding: "entity", entity: "systemuser",
      handle: async (c) => {
        need(c, "prvReadUser", "systemuser");
        const user = systemuserOf(store, c.target.id);
        // ponytail: ExcludeOrgDisabledPrivileges and IncludeSetupUserFiltering are not applied. Team grants report Basic, as in
        // RetrieveUserPrivileges.
        const teams = new Set(teamsOfUser(store, user.systemuserid));
        const roleIds = new Set(tableOf(store, "teamroles").filter((t) => teams.has(key(refId(t.teamid)))).map((t) => key(refId(t.roleid))));
        return respond(c, "RetrieveUsersPrivilegesThroughTeams", { RolePrivileges: entriesOf(store, roleIds).map((p) => ({ ...p, Depth: "Basic" })) });
      },
      csdl: csdlOf("function", "RetrieveUsersPrivilegesThroughTeams", {
        bound: "systemuser",
        params: [["ExcludeOrgDisabledPrivileges", "Edm.Boolean"], ["IncludeSetupUserFiltering", "Edm.Boolean"]],
        response: ["RolePrivileges", "Collection(mscrm.RolePrivilege)"],
      }),
    },
    {
      name: "RetrievePrivilegeSet", kind: "function", binding: "collection", entity: "privilege",
      // Projected from the privilege mapping without the records layer: the seeded roles hold no read grant on the privilege table,
      // so a formatted read would be refused for every caller. ponytail: lookup columns are not formatted.
      handle: async (c) => {
        const mapping = store.resolveMapping("privilege"), fields = Object.keys(mapping.fields ?? {});
        const value = tableOf(store, "privilege").map((p) => Object.fromEntries(fields.map((f) => [f, p[f] ?? null])));
        return { status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, mapping.entitySet), value } };
      },
      csdl: '<Function Name="RetrievePrivilegeSet" IsBound="true">\n  <Parameter Name="entity" Type="Collection(mscrm.privilege)" Nullable="false" />\n  <ReturnType Type="Collection(mscrm.privilege)" Nullable="false" />\n</Function>',
    },
    {
      name: "SetParentTeam", kind: "action", binding: "entity", entity: "team",
      handle: async (c) => {
        need(c, "prvWriteTeam", "team");
        const args = body(c), teamId = c.target.id;
        teamOf(store, teamId);
        const unitId = targetRef(api, args.BusinessUnit).id;
        const unit = tableOf(store, "businessunit").find((b) => sameId(b.businessunitid, unitId));
        if (!unit) throw notFound("businessunit", unitId);
        if (unit.isdisabled === true) throw new DataError("The business unit is disabled.", 400, "InvalidRequest", { innerCode: "0x8004032d" });
        const unitRef = lookup("businessunit", unit.businessunitid);
        await write(() => {
          teamOf(store, teamId).businessunitid = unitRef;
          if (args.DoNotMoveAllRecords === true) return;
          // The records the team owns move to the new business unit, as a user's do in SetBusinessSystemUser.
          for (const [logical, mapping] of Object.entries(store.state.mappings)) {
            if (ownershipOf(logical, null, mapping) !== "user") continue;
            for (const row of tableOf(store, logical)) if (sameId(refId(row.ownerid), teamId)) row.owningbusinessunit = unitRef;
          }
        });
        // ponytail: a business unit's default team is not kept in place, and the moved team's members are not changed.
        return { status: 204 };
      },
      csdl: csdlOf("action", "SetParentTeam", { bound: "team", params: [["BusinessUnit", "mscrm.businessunit"], ["DoNotMoveAllRecords", "Edm.Boolean"]] }),
    },
    {
      name: "SyncGroupMembersToTeam", kind: "action", binding: "entity", entity: "team",
      handle: async (c) => {
        need(c, "prvWriteTeam", "team");
        const teamId = c.target.id, team = teamOf(store, teamId);
        // unverified: the refusal for a team that is not an Entra group team.
        if (Number(team.teamtype ?? 0) < 2 || !team.azureactivedirectoryobjectid) throw invalid(`Team with Id = ${teamId} is not a Microsoft Entra group team.`);
        const group = key(team.azureactivedirectoryobjectid);
        await write(() => {
          // Members are the enabled users whose token carries the group's object id; the same rule as syncGroupMembership.
          const members = tableOf(store, "systemuser")
            .filter((u) => u.isdisabled !== true && listOf(u.azureactivedirectorygroupids).map(key).includes(group))
            .map((u) => u.systemuserid);
          const rows = tableOf(store, "teammembership");
          for (let i = rows.length - 1; i >= 0; i--) {
            if (sameId(refId(rows[i].teamid), teamId) && !members.some((id) => sameId(id, refId(rows[i].systemuserid)))) rows.splice(i, 1);
          }
          for (const id of members) {
            if (rows.some((m) => sameId(refId(m.teamid), teamId) && sameId(refId(m.systemuserid), id))) continue;
            rows.push({ teammembershipid: uuidV5(teamId, `member:${key(id)}`), systemuserid: lookup("systemuser", id), teamid: lookup("team", teamId) });
          }
        });
        return { status: 204 };
      },
      csdl: csdlOf("action", "SyncGroupMembersToTeam", { bound: "team" }),
    },
    {
      name: "CreateAsyncJobToRevokeInheritedAccess", kind: "action", binding: "unbound",
      handle: async (c) => {
        needSystemAdministrator(c);
        const schema = String(body(c).RelationshipSchema ?? "").trim();
        if (!schema) throw invalid("RelationshipSchema is required.");
        // unverified: the refusal for a relationship that does not exist.
        if (!relationshipTableOf(schema)) throw invalid(`The relationship ${schema} does not exist.`);
        // unverified: the operation type. The job clears the inherited rights of the share rows on the referencing table's records.
        // ponytail: one level only; the cascade through related tables is not walked.
        await api.systemJob({ name: "RevokeInheritedAccess", operationtype: null, callerId: (c.caller ?? c.user).systemuserid }, async () => {
          const referencing = relationshipTableOf(schema), idColumn = store.resolveMapping(referencing).idColumn;
          const ids = new Set(tableOf(store, referencing).map((r) => key(r[idColumn])));
          await write(() => {
            for (const share of tableOf(store, "principalobjectaccess")) if (ids.has(key(refId(share.objectid)))) share.inheritedaccessrightsmask = 0;
          });
          return "Inherited access revoked.";
        });
        return { status: 204 };
      },
      csdl: csdlOf("action", "CreateAsyncJobToRevokeInheritedAccess", { params: [["RelationshipSchema", "Edm.String"]] }),
    },
    principalAccessInfo("systemuser"),
    principalAccessInfo("team"),
    {
      name: "GrantDelegatedAccess", kind: "action", binding: "unbound",
      handle: async (c) => {
        const args = body(c);
        const daId = targetRef(api, args.delegatedauthorization).id;
        if (!tableOf(store, "delegatedauthorization").some((d) => sameId(d.delegatedauthorizationid, daId))) throw notFound("delegatedauthorization", daId);
        const { mapping, id } = sharedTarget(c, args.target, "share");
        // unverified: the owner-access mask and the Share privilege gate. Without owneraccess the team gets Read only.
        const mask = args.owneraccess === true ? OWNER_RIGHTS : ACCESS_RIGHTS.Read;
        await write(() => {
          const team = delegationTeamOf(c, daId);
          grantAccess(store, { target: { id, logical: mapping.logicalName }, principal: { id: team.teamid, logical_name: "team" }, mask });
        });
        return { status: 204 };
      },
      csdl: csdlOf("action", "GrantDelegatedAccess", {
        params: [["delegatedauthorization", "mscrm.delegatedauthorization"], ["target", "mscrm.crmbaseentity"], ["owneraccess", "Edm.Boolean"]],
      }),
    },
    {
      name: "ProvisionDelegation", kind: "action", binding: "unbound",
      handle: async (c) => {
        need(c, "prvCreateTeam", "team");
        // The argument is an entity body. A missing authorization is created; its team is created with it.
        const entity = body(c).delegatedauthorization ?? {};
        const daId = refId(entity.delegatedauthorizationid) ?? randomUUID();
        let team;
        await write(() => {
          insertDelegation(daId, entity.name ?? "Delegation");
          team = delegationTeamOf(c, daId);
        });
        const { body: rows } = await collectionOf(c, "team", [team.teamid]);
        return { status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, "teams/$entity"), ...rows.value[0] } };
      },
      csdl: csdlOf("action", "ProvisionDelegation", { params: [["delegatedauthorization", "mscrm.delegatedauthorization"]], returns: "mscrm.team" }),
    },
    {
      name: "RetrieveAppsWithDelegatedAccessPermissions", kind: "action", binding: "unbound",
      handle: async (c) => {
        const cloud = body(c).cloud;
        // unverified: the refusal for a cloud that is not an integer.
        if (cloud === undefined || !Number.isInteger(Number(cloud))) throw invalid("cloud must be an integer.");
        // ponytail: no app registry is modelled, so no app holds delegated permissions. LC-2 for the native items.
        return { status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, "Collection(Microsoft.Dynamics.CRM.crmbaseentity)"), value: [] } };
      },
      csdl: csdlOf("action", "RetrieveAppsWithDelegatedAccessPermissions", { params: [["cloud", "Edm.Int32"]], returns: "Collection(mscrm.crmbaseentity)" }),
    },
    {
      name: "CreateRoleWithPrivilegeCheckerRun", kind: "action", binding: "entity", entity: "privilegecheckerrun",
      handle: async (c) => {
        need(c, "prvCreateRole", "role");
        const args = body(c), runId = c.target.id;
        // unverified: the refusal for a PrivilegeCheckerRunId that is not the bound run, and for a missing RoleName.
        if (!sameId(args.PrivilegeCheckerRunId, runId)) throw invalid("PrivilegeCheckerRunId must be the bound privilegecheckerrun.");
        if (!args.RoleName) throw invalid("RoleName is required.");
        // Privilege checks (checktype 1) of the run, one mask per privilege; the highest depth wins for a repeated privilege.
        const masks = new Map();
        for (const log of tableOf(store, "privilegecheckerlog")) {
          if (!sameId(refId(log.privilegecheckerrunid), runId) || Number(log.checktype ?? 1) !== 1 || log.checkedprivilege == null) continue;
          const mask = CHECK_DEPTH_MASK[Number(log.privilegedepth)];
          if (mask === undefined) continue;
          const privilegeId = refId(log.checkedprivilege);
          masks.set(key(privilegeId), { id: privilegeId, mask: Math.max(masks.get(key(privilegeId))?.mask ?? 0, mask) });
        }
        const roleId = randomUUID();
        await write(() => {
          tableOf(store, "role").push({
            roleid: roleId, name: args.RoleName, businessunitid: lookup("businessunit", businessUnitOf(store, c.user)),
            organizationid: lookup("organization", orgId()), isinherited: 1,
          });
          for (const { id, mask } of masks.values()) {
            tableOf(store, "roleprivileges").push({
              roleprivilegeid: uuidV5(roleId, id), roleid: lookup("role", roleId), privilegeid: lookup("privilege", id), privilegedepthmask: mask,
            });
          }
        });
        return respond(c, "CreateRoleWithPrivilegeCheckerRun", { RoleId: roleId });
      },
      csdl: csdlOf("action", "CreateRoleWithPrivilegeCheckerRun", {
        bound: "privilegecheckerrun", params: [["PrivilegeCheckerRunId", "Edm.Guid"], ["RoleName", "Edm.String"]], response: ["RoleId", "Edm.Guid"],
      }),
    },
    {
      name: "GetConsentLink", kind: "action", binding: "entity", entity: "connectioninstance",
      handle: async (c) => {
        const redirectUrl = String(body(c).redirectUrl ?? "");
        connectionOf(c);
        // unverified: the link shape and the property values. No request leaves the simulator; the link names this loopback origin.
        return respond(c, "GetConsentLink", {
          tenantId: api.settings?.tenantId ?? null, redirectUrl, parameterConsentLinks: "[]", principalType: "User", principalId: c.user.systemuserid,
          consentLink: `${c.origin}/consent/${c.target.id}?redirect_uri=${encodeURIComponent(redirectUrl)}`, firstPartyLoginUri: null, customParameters: null,
        });
      },
      csdl: csdlOf("action", "GetConsentLink", { bound: "connectioninstance", params: [["redirectUrl", "Edm.String"]], complex: CONSENT_COMPLEX, returns: "mscrm.GetConsentLinkResponse" }),
    },
    {
      name: "ConfirmConsentCode", kind: "action", binding: "entity", entity: "connectioninstance",
      handle: async (c) => {
        connectionOf(c);
        const code = body(c).code;
        if (!code) throw invalid("code is required.");
        // unverified: the status value. The code itself is never stored.
        await write(() => {
          tableOf(store, "connectioninstance").find((r) => sameId(r.connectioninstanceid, c.target.id)).connectionstatus = JSON.stringify([{ status: "Connected" }]);
        });
        return { status: 204 };
      },
      csdl: csdlOf("action", "ConfirmConsentCode", { bound: "connectioninstance", params: [["code", "Edm.String"]] }),
    },
  ];
  for (const op of operations) api.registry.register(op);

  // Internal-only messages (GC policy, dataverse-addon-common.mjs): each keeps its native signature and answers 501 unless a pack
  // handles it. Each names the Learn page that says "For internal use only."
  // https://learn.microsoft.com/dotnet/api/microsoft.crm.sdk.messages.addchannelaccessprofileprivilegesrequest
  registerInternalMessage(api, {
    name: "AddChannelAccessProfilePrivileges", kind: "action", binding: "unbound",
    csdl: csdlOf("action", "AddChannelAccessProfilePrivileges", { params: [["ChannelAccessProfileId", "Edm.Guid"], ["Privileges", "Collection(mscrm.ChannelAccessProfilePrivilege)"]] }),
  });
  // https://learn.microsoft.com/dotnet/api/microsoft.crm.sdk.messages.retrievechannelaccessprofileprivilegesrequest
  registerInternalMessage(api, {
    name: "RetrieveChannelAccessProfilePrivileges", kind: "function", binding: "unbound",
    csdl: csdlOf("function", "RetrieveChannelAccessProfilePrivileges", { params: [["ChannelAccessProfileId", "Edm.Guid"]], response: ["ChannelAccessProfile", "mscrm.ChannelAccessProfileWithPrivileges"] }),
  });
  // https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveprincipalsyncattributemappings
  for (const entity of ["systemuser", "team"]) {
    registerInternalMessage(api, {
      name: "RetrievePrincipalSyncAttributeMappings", kind: "function", binding: "entity", entity,
      csdl: csdlOf("function", "RetrievePrincipalSyncAttributeMappings", { bound: entity, response: ["AttributeMappings", "Collection(mscrm.AttributeMapping)"] }),
    });
  }
}
