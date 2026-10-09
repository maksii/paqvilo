import { portalField } from "./importer.mjs";
import { accountWebRoleIds } from "./platform-changes.mjs";

const id = (value) =>
  String(value?.id ?? value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
const scalar = (value) =>
  value && typeof value === "object" ? (value.id ?? value.value) : value;
const truth = (value) =>
  value === true ||
  value === 1 ||
  (typeof value === "string" && value.toLowerCase() === "true");
const operations = [
  ["read", "read"],
  ["create", "create"],
  ["write", "update"],
  ["delete", "delete"],
  ["append", "append"],
  ["appendto", "appendTo"],
];
const scopes = {
  756150000: "global",
  756150001: "contact",
  756150002: "account",
  756150003: "parent",
  756150004: "self",
};
const clone = (value) => structuredClone(value);

export function portalWebRoles(portal) {
  return (portal.records ?? [])
    .filter(
      (record) =>
        record.kind === "webrole" &&
        Number(scalar(portalField(record, "statecode", 0))) !== 1,
    )
    .map((record) => ({
      id: id(record.id),
      name: record.name ?? portalField(record, "name"),
      authenticated: truth(portalField(record, "authenticatedusersrole")),
      anonymous: truth(portalField(record, "anonymoususersrole")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function membershipsForRoles(portal, personas) {
  const roles = portalWebRoles(portal),
    byName = new Map(roles.map((role) => [role.name, role.id]));
  for (const role of roles)
    if (roles.filter((candidate) => candidate.name === role.name).length > 1)
      byName.set(role.name, null);
  const memberships = [];
  for (const persona of personas)
    for (const name of persona.roles ?? []) {
      const roleId = byName.get(name);
      if (!roleId)
        throw new Error(
          `Web role '${name}' is absent or ambiguous in the selected portal export.`,
        );
      memberships.push({
        contactId: id(persona.contactId ?? persona.id),
        roleId,
      });
    }
  return memberships;
}

function membershipModel(portal, state) {
  const webRoles = portalWebRoles(portal),
    roles = new Map(webRoles.map((role) => [role.id, role]));
  const contacts = new Map(
    (state.tables?.contact ?? []).map((contact) => [
      id(contact.contactid),
      contact,
    ]),
  );
  const memberships = [],
    diagnostics = [],
    seen = new Set();
  for (const assignment of state.simulator?.contactRoles ?? []) {
    const contactId = id(assignment.contactId),
      roleId = id(assignment.roleId),
      key = contactId + ":" + roleId;
    if (
      !contacts.has(contactId) ||
      Number(scalar(contacts.get(contactId)?.statecode) ?? 0) !== 0 ||
      !roles.has(roleId)
    ) {
      diagnostics.push({
        code: "PERSONA_MEMBERSHIP_UNRESOLVED",
        contactId,
        roleId,
        message:
          !contacts.has(contactId) ||
          Number(scalar(contacts.get(contactId)?.statecode) ?? 0) !== 0
            ? "Assigned contact does not exist or is inactive in local data."
            : "Assigned web role does not exist in the selected portal export.",
      });
      continue;
    }
    if (!seen.has(key)) {
      memberships.push({ contactId, roleId });
      seen.add(key);
    }
  }
  return { webRoles, roles, contacts, memberships, diagnostics };
}

/** Local contact membership resolution; browser live permissions are independent. */
export function resolvePortalIdentity(
  portal,
  state,
  selected = state.simulator?.identity ?? {},
) {
  selected ??= {};
  const model = membershipModel(portal, state),
    contactId = id(selected.contactId ?? selected.id),
    contact = model.contacts.get(contactId);
  if (selected.roleSource !== "memberships") {
    // admin is an internal storage capability; stale membership IDs are not manual grants.
    const {
      admin: ignoredAdmin,
      roleIds: ignoredRoleIds,
      ...override
    } = clone(selected);
    const roles = [...new Set(selected.roles ?? [])],
      roleIds = [];
    for (const role of roles) {
      const matches = model.webRoles.filter(
        (candidate) => candidate.name === role || candidate.id === id(role),
      );
      if (matches.length === 1) roleIds.push(matches[0].id);
    }
    return {
      ...override,
      roleSource: "override",
      roles,
      roleIds,
      diagnostics: [],
    };
  }
  const authenticated = Boolean(
    contact && Number(scalar(contact.statecode) ?? 0) === 0,
  );
  const roleIds = new Set(
    model.webRoles
      .filter((role) => (authenticated ? role.authenticated : role.anonymous))
      .map((role) => role.id),
  );
  if (authenticated)
    for (const assignment of model.memberships)
      if (assignment.contactId === contactId) roleIds.add(assignment.roleId);
  const parent = contact?.parentcustomerid ?? contact?._parentcustomerid_value;
  const parentType =
    parent?.logical_name ??
    contact?.[
      "_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname"
    ];
  const accountId =
    authenticated && (!parentType || parentType === "account")
      ? id(scalar(parent)) || null
      : null;
  const roles = [...roleIds]
    .map((roleId) => model.roles.get(roleId)?.name)
    .filter(Boolean);
  // Web roles of the persona's parent account are reported, not applied (agent B,
  // lib/platform-changes.mjs accountWebRoleIds).
  const accountRoles = accountId
    ? accountWebRoleIds(state, accountId).filter((roleId) => model.roles.has(roleId) && !roleIds.has(roleId))
    : [];
  return {
    id: authenticated ? contactId : null,
    contactId: authenticated ? contactId : null,
    accountId,
    name: authenticated
      ? (contact.fullname ??
          [contact.firstname, contact.lastname].filter(Boolean).join(" ")) ||
        contactId
      : "Anonymous",
    fullname: authenticated ? (contact.fullname ?? "") : null,
    roles,
    roleIds: [...roleIds],
    roleSource: "memberships",
    diagnostics: [
      ...model.diagnostics,
      ...(contactId && !authenticated
        ? [
            {
              code: "PERSONA_CONTACT_UNAVAILABLE",
              contactId,
              message:
                "The selected local contact is missing or inactive; anonymous permissions apply.",
            },
          ]
        : []),
      ...(accountRoles.length
        ? [
            {
              code: "PERSONA_ACCOUNT_ROLES_NOT_APPLIED",
              contactId,
              accountId,
              roleIds: accountRoles,
              roles: accountRoles.map((roleId) => model.roles.get(roleId)?.name).filter(Boolean),
              message:
                "Web roles associated with the persona's parent account are not applied locally. The 2017 Adxstudio portal source gave contacts their parent account's web roles; current Power Pages behaviour is not documented (docs/dataverse-parity.md, Platform changes).",
            },
          ]
        : []),
    ],
  };
}

function exportedPermissions(portal) {
  const byRole = new Map(
    portalWebRoles(portal).map((role) => [role.id, role.name]),
  );
  return (portal.records ?? [])
    .filter(
      (record) =>
        record.kind === "tablepermission" &&
        Number(portalField(record, "statecode", 0)) !== 1,
    )
    .map((record) => {
      const roleValues =
        portalField(record, "entitypermission_webrole", []) ?? [];
      const roleIds = (
        Array.isArray(roleValues) ? roleValues : [roleValues]
      ).map((value) =>
        id(
          typeof value === "object"
            ? (value.id ?? value.adx_webroleid ?? value.mspp_webroleid)
            : value,
        ),
      );
      return {
        id: id(record.id),
        name: record.name || portalField(record, "entityname") || record.id,
        entity: portalField(record, "entitylogicalname"),
        scope: scopes[scalar(portalField(record, "scope"))] ?? "unresolved",
        operations: operations
          .filter(([field]) => truth(portalField(record, field)))
          .map(([, operation]) => operation),
        roles: roleIds.map((roleId) => byRole.get(roleId) ?? roleId),
        roleIds,
        relationshipName: portalField(
          record,
          "contactrelationship",
          portalField(
            record,
            "accountrelationship",
            portalField(record, "parentrelationship"),
          ),
        ),
        parentPermissionId:
          id(portalField(record, "parententitypermission")) || null,
        imported: true,
        provenance: {
          type: "portal-export",
          file: record.file ?? record._file ?? record.source?.path ?? null,
          recordId: record.id,
        },
        enabled: true,
      };
    });
}

function descriptor(rel, permission, target, mappings) {
  return resolveScopedRelationship(rel, permission, target, mappings)?.descriptor ?? null;
}

/**
 * Resolve the relationship a scoped grant names into a join descriptor from the
 * permission's table to `target` (contact, account or the parent permission's table).
 * A many-to-one lookup on the permission's table also yields `field`.
 */
export function resolveScopedRelationship(rel, permission, target, mappings = {}) {
  if (!rel) return null;
  if (rel.type === "one-to-many") {
    if (rel.referencingEntity === permission.entity && rel.referencedEntity === target)
      return {
        field: rel.referencingAttribute,
        descriptor: {
          entity: target,
          from: rel.referencingAttribute,
          to: rel.referencedAttribute ?? mappings[target]?.idColumn,
        },
      };
    if (rel.referencedEntity === permission.entity && rel.referencingEntity === target)
      return {
        descriptor: {
          entity: target,
          from: rel.referencedAttribute ?? mappings[permission.entity]?.idColumn,
          to: rel.referencingAttribute,
        },
      };
  }
  if (rel.type === "many-to-many") {
    const first = rel.entity1 === permission.entity && rel.entity2 === target,
      second = rel.entity2 === permission.entity && rel.entity1 === target;
    if (first || second)
      return {
        descriptor: {
          entity: target,
          from: mappings[permission.entity]?.idColumn ?? permission.entity + "id",
          to: mappings[target]?.idColumn ?? target + "id",
          intersect: {
            entity: rel.intersectEntity,
            from: first ? rel.attribute1 : rel.attribute2,
            to: first ? rel.attribute2 : rel.attribute1,
          },
        },
      };
  }
  return null;
}

/** Compile an explicit grant ledger and hierarchy. Unresolved source grants fail closed. */
export function buildPermissionModel(
  portal,
  state,
  {
    relationships = {},
    source = state.simulator?.permissionSource ?? "configured",
  } = {},
) {
  if (!["configured", "exported", "combined"].includes(source))
    throw new Error("Unknown permissionSource.");
  const identityModel = membershipModel(portal, state),
    configured = clone(state.permissions ?? []),
    exported = exportedPermissions(portal);
  const existing = new Map(
    configured
      .filter((rule) => rule.imported)
      .map((rule) => [id(rule.id), rule]),
  );
  const permissions =
    source === "configured"
      ? configured
      : exported.map((rule) => {
          const merged = { ...existing.get(rule.id), ...rule };
          // Recompile source grants rather than retaining a previous runtime
          // failure reason after metadata/role associations were repaired.
          delete merged.disabledReason;
          delete merged.disabledCode;
          delete merged.disabledReasons;
          delete merged.ownRoleIds;
          return merged;
        });
  if (source === "combined")
    permissions.push(
      ...configured
        .filter((rule) => !rule.imported)
        .map((rule) => ({
          ...rule,
          provenance: rule.provenance ?? { type: "local-configuration" },
        })),
    );
  const byId = new Map(permissions.map((rule) => [id(rule.id), rule])),
    diagnostics = [...identityModel.diagnostics],
    visiting = new Set(),
    visited = new Set();
  for (const record of portal.records ?? [])
    if (
      Number(portalField(record, "statecode", 0)) !== 1 &&
      portalField(record, "tablename") &&
      portalField(record, "columnpermissionprofile_webrole") &&
      portalField(record, "allcolumnpermissions") == null
    )
      diagnostics.push({
        code: "COLUMN_PERMISSION_DEFAULT_INHERITED",
        id: record.id,
        entity: portalField(record, "tablename"),
        file: record.file ?? record._file ?? record.source?.path ?? null,
        message:
          "The optional All Column Permissions setting is empty. Unspecified columns retain table-level operations; explicit child-column restrictions and Web API enabled fields still apply.",
      });
  // The first reason is the root cause; later checks add context without hiding it.
  const disable = (rule, code, message) => {
    if (rule.enabled === false && rule.disabledReason && rule.disabledCode) {
      if (!(rule.disabledReasons ??= [rule.disabledReason]).includes(message))
        rule.disabledReasons.push(message);
      return;
    }
    rule.enabled = false;
    rule.disabledReason = message;
    rule.disabledCode = code;
    diagnostics.push({ code, id: rule.id, entity: rule.entity, message });
  };
  // Child (parent-scope) grants inherit their parent's roles (Microsoft: "These roles are
  // inherited from the parent table permission"; legacy runtime ignored child links).
  // settings.childPermissionRoles = "intersect" keeps only roles also on the parent.
  const childRoleMode =
    state.settings?.childPermissionRoles === "intersect" ? "intersect" : "inherit";
  const counts = new Map();
  for (const rule of permissions)
    counts.set(id(rule.id), (counts.get(id(rule.id)) ?? 0) + 1);
  for (const rule of permissions)
    if (counts.get(id(rule.id)) > 1)
      disable(
        rule,
        "PERMISSION_ID_AMBIGUOUS",
        "More than one permission source defines this ID. Resolve the conflicting export or local definitions before enabling it.",
      );
  function compile(rule) {
    const key = id(rule.id);
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      disable(
        rule,
        "PERMISSION_PARENT_CYCLE",
        "The permission hierarchy contains a cycle.",
      );
      return;
    }
    visiting.add(key);
    rule.id = key;
    if (rule.imported && !Array.isArray(rule.roleIds))
      rule.roleIds = (rule.roles ?? []).flatMap((name) => {
        const matches = identityModel.webRoles.filter(
          (role) => role.name === name,
        );
        return matches.length === 1 ? [matches[0].id] : [];
      });
    if (!rule.imported && rule.scope === "parent") {
      const parent = byId.get(id(rule.parentPermissionId));
      if (!parent)
        disable(
          rule,
          "PERMISSION_PARENT_MISSING",
          "A local parent grant must reference an existing parent permission.",
        );
      else {
        compile(parent);
        if (parent.enabled === false)
          disable(
            rule,
            "PERMISSION_PARENT_DISABLED",
            "The parent permission is disabled or unresolved.",
          );
        if (!rule.roles?.length) {
          rule.roles = clone(parent.roles ?? []);
          rule.inheritedRoles = true;
        }
        if (
          !rule.relationship?.entity ||
          !rule.relationship.from ||
          !rule.relationship.to ||
          rule.relationship.entity !== parent.entity
        )
          disable(
            rule,
            "PERMISSION_RELATIONSHIP_UNRESOLVED",
            "The local child relationship must connect to its parent permission table.",
          );
      }
    }
    if (rule.imported) {
      if (rule.scope === "unresolved" || !rule.entity)
        disable(
          rule,
          "PERMISSION_UNRESOLVED",
          "The source permission has no supported scope or table.",
        );
      // Web-role associations are alternative grants. An unavailable role
      // cannot authorize anyone, but must not revoke another exact source ID.
      const assignedRoles = rule.roles ?? [],
        assignedIds = [...new Set((rule.roleIds ?? []).map(id))],
        unresolvedIds = assignedIds.filter(
          (roleId) => !identityModel.roles.has(roleId),
        );
      rule.roleIds = assignedIds.filter((roleId) =>
        identityModel.roles.has(roleId),
      );
      rule.unresolvedRoleIds = unresolvedIds;
      if (unresolvedIds.length)
        diagnostics.push({
          code: "PERMISSION_ROLE_ID_UNRESOLVED",
          id: rule.id,
          entity: rule.entity,
          roleIds: unresolvedIds,
          message:
            "These source web-role IDs are absent or inactive and cannot grant access: " +
            unresolvedIds.join(", ") +
            ". Other exact active source role associations remain eligible.",
        });
      rule.roles = rule.roleIds.map(
        (roleId) => identityModel.roles.get(roleId).name,
      );
      if (assignedRoles.length && !rule.roleIds.length && rule.scope !== "parent")
        disable(
          rule,
          "PERMISSION_ROLE_ID_UNRESOLVED",
          "The imported grant does not resolve to exact active exported web-role IDs.",
        );
      const parent =
        rule.scope === "parent" ? byId.get(id(rule.parentPermissionId)) : null;
      if (rule.scope === "parent") {
        if (!parent)
          disable(
            rule,
            "PERMISSION_PARENT_MISSING",
            rule.parentPermissionId
              ? "The parent permission is inactive or was not exported into this portal; a child of an ineffective parent permission does not take effect."
              : "The parent-scope permission names no parent permission.",
          );
        else {
          compile(parent);
          if (parent.enabled === false)
            disable(
              rule,
              "PERMISSION_PARENT_DISABLED",
              "The source parent permission is disabled or unresolved.",
            );
          else {
            // Configured states keep the source links in ownRoleIds across recompiles.
            const own = [...new Set((rule.ownRoleIds ?? rule.roleIds ?? []).map(id))].filter((role) =>
                identityModel.roles.has(role),
              ),
              inherited = parent.roleIds ?? [];
            const outside = own.filter((role) => !inherited.includes(role));
            const effective =
              childRoleMode === "intersect" && own.length
                ? own.filter((role) => inherited.includes(role))
                : [...inherited];
            if (own.length) rule.ownRoleIds = own;
            if (outside.length)
              diagnostics.push({
                code: "PERMISSION_CHILD_ROLE_NOT_ON_PARENT",
                id: rule.id,
                entity: rule.entity,
                roleIds: outside,
                message:
                  "One or more roles applied to this child permission aren't available to its parent table permission; they cannot grant access through the parent: " +
                  outside.map((role) => identityModel.roles.get(role)?.name ?? role).join(", "),
              });
            if (childRoleMode === "inherit" && own.length && (outside.length || own.length !== inherited.length))
              diagnostics.push({
                code: "PERMISSION_CHILD_ROLES_INHERITED",
                id: rule.id,
                entity: rule.entity,
                ownRoleIds: own,
                message:
                  "Child permission roles are inherited from the parent permission; this child's own web-role links do not narrow access. Set settings.childPermissionRoles to 'intersect' to evaluate only roles shared with the parent.",
              });
            rule.roleIds = effective;
            rule.roles = effective.map(
              (role) => identityModel.roles.get(role)?.name ?? role,
            );
            rule.inheritedRoles = childRoleMode === "inherit" || !own.length;
            if (!effective.length)
              disable(
                rule,
                "PERMISSION_CHILD_ROLES_UNAVAILABLE",
                "None of this child permission's web roles is available to its parent permission.",
              );
          }
        }
      }
      if (["contact", "account", "parent"].includes(rule.scope)) {
        if (source !== "configured" && rule.userConfigured !== true) {
          delete rule.field;
          delete rule.relationship;
          delete rule.identityRelationship;
          delete rule.metadataSource;
        }
        const target =
          parent?.entity ?? (rule.scope === "account" ? "account" : "contact");
        const rel =
          relationships[String(rule.relationshipName ?? "").toLowerCase()];
        let resolved = descriptor(rel, rule, target, state.mappings ?? {});
        if (
          !resolved?.entity ||
          !resolved.from ||
          !resolved.to ||
          (resolved.intersect &&
            (!resolved.intersect.entity ||
              !resolved.intersect.from ||
              !resolved.intersect.to))
        )
          resolved = null;
        if (resolved) {
          if (rule.scope === "parent") rule.relationship = resolved;
          else if (
            rel.type === "one-to-many" &&
            rel.referencingEntity === rule.entity
          )
            rule.field = rel.referencingAttribute;
          else rule.identityRelationship = resolved;
          rule.metadataSource = rel.source;
        }
        const identityRelationship = rule.identityRelationship;
        if (
          rule.scope === "parent"
            ? !rule.relationship?.entity ||
              !rule.relationship.from ||
              !rule.relationship.to
            : !rule.field &&
              (!identityRelationship?.entity ||
                !identityRelationship.from ||
                !identityRelationship.to)
        )
          disable(
            rule,
            "PERMISSION_RELATIONSHIP_UNRESOLVED",
            !rule.relationshipName
              ? "The exported permission has no relationship name for its scope."
              : !rel
                ? `No selected solution layer or documented Dataverse relationship defines '${rule.relationshipName}'.`
                : `Relationship '${rel.schemaName ?? rule.relationshipName}' does not connect '${rule.entity}' to '${target}'.`,
          );
      }
      if (!rule.roles?.length)
        disable(
          rule,
          "PERMISSION_ROOT_ROLE_MISSING",
          "No web role is associated with this permission; Power Pages requires at least one web role for a table permission to take effect.",
        );
    }
    visiting.delete(key);
    visited.add(key);
  }
  for (const rule of permissions) compile(rule);
  const tree = permissions.map((rule) => ({
    id: rule.id,
    parentId: rule.scope === "parent" ? rule.parentPermissionId : null,
    name: rule.name ?? rule.entity,
    entity: rule.entity,
    scope: rule.scope,
    roles: rule.roles ?? [],
    operations: rule.operations ?? [],
    enabled: rule.enabled !== false,
    inheritedRoles: Boolean(rule.inheritedRoles),
    ...(rule.ownRoleIds?.length ? { ownRoleIds: rule.ownRoleIds } : {}),
    relationshipName: rule.relationshipName,
    disabledReason: rule.disabledReason,
    ...(rule.disabledCode ? { disabledCode: rule.disabledCode } : {}),
    ...(rule.disabledReasons?.length > 1 ? { disabledReasons: rule.disabledReasons } : {}),
    provenance:
      rule.provenance ??
      (rule.imported
        ? { type: "portal-export" }
        : { type: "local-configuration" }),
  }));
  const personas = [...identityModel.contacts.values()].map((contact) => {
    const effective = resolvePortalIdentity(portal, state, {
      contactId: contact.contactid,
      roleSource: "memberships",
    });
    return {
      contactId: id(contact.contactid),
      name: effective.name,
      accountId: effective.accountId,
      roles: effective.roles,
      roleIds: effective.roleIds,
      active: Boolean(effective.contactId),
    };
  });
  return {
    source,
    permissions,
    tree,
    webRoles: identityModel.webRoles,
    memberships: identityModel.memberships,
    personas,
    diagnostics,
    settings: {
      associationPermissions:
        source === "configured"
          ? (state.settings?.associationPermissions ?? "compatibility")
          : "enforce",
    },
  };
}
