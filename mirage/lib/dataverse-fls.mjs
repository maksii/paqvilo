// Simulated Dataverse column (field) security: field security profiles, field permissions, field sharing,
// the record hooks that null or refuse secured columns, and RetrievePrincipalAttributePrivileges.
// Invented schema and GUIDs only.
import { DataError } from './data-error.mjs';
import { uuidV5 } from './dataverse-security.mjs';

export const SYSTEM_ADMINISTRATOR_PROFILE_ID = '572329c1-a042-4e22-be47-367c6374ea45';
// field_security_permission_type: 0 Not Allowed, 4 Allowed.
const ALLOWED = 4;
const ADMIN_ROLE = 'System Administrator';
const FLAGS = ['cancreate', 'canread', 'canupdate', 'canreadunmasked'];

const TEXT = 'nvarchar', INT = 'int', BOOL = 'bit', LOOKUP = 'lookup', GUID = 'uniqueidentifier';
const nn = (target, from, to, via) => ({ entity: target, from, to, many: true, intersect: { entity: via, from, to } });
// unverified: entity set names follow the Web API plural convention.
const TABLE_DEFS = {
  fieldsecurityprofile: {
    set: 'fieldsecurityprofiles', id: 'fieldsecurityprofileid', name: 'name',
    fields: { fieldsecurityprofileid: GUID, name: TEXT },
    relationships: {
      systemuserprofiles_association: nn('systemuser', 'fieldsecurityprofileid', 'systemuserid', 'systemuserprofiles'),
      teamprofiles_association: nn('team', 'fieldsecurityprofileid', 'teamid', 'teamprofiles'),
    },
  },
  fieldpermission: {
    set: 'fieldpermissions', id: 'fieldpermissionid',
    fields: { fieldpermissionid: GUID, fieldsecurityprofileid: LOOKUP, entityname: TEXT, attributelogicalname: TEXT, cancreate: INT, canread: INT, canupdate: INT, canreadunmasked: INT },
  },
  systemuserprofiles: { set: 'systemuserprofiles', id: 'systemuserprofileid', fields: { systemuserprofileid: GUID, systemuserid: LOOKUP, fieldsecurityprofileid: LOOKUP } },
  teamprofiles: { set: 'teamprofiles', id: 'teamprofileid', fields: { teamprofileid: GUID, teamid: LOOKUP, fieldsecurityprofileid: LOOKUP } },
  principalobjectattributeaccess: {
    set: 'principalobjectattributeaccesses', id: 'principalobjectattributeaccessid',
    fields: { principalobjectattributeaccessid: GUID, objectid: LOOKUP, attributeid: GUID, principalid: LOOKUP, readaccess: BOOL, updateaccess: BOOL },
  },
};

const key = (value) => String(value ?? '').toLowerCase();
const same = (a, b) => key(a) === key(b);
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value) ?? undefined;
const rowsOf = (store, logical) => (store.state.tables[logical] ??= []);

function mappingFor(logical, def) {
  return {
    logicalName: logical,
    entitySet: def.set,
    idColumn: def.id,
    ...(def.name ? { nameColumn: def.name } : {}),
    userConfigured: true,
    // Seeded for the Dataverse API only: the portal Web API resolver ignores these sets.
    dataverseOnly: true,
    fields: Object.fromEntries(Object.entries(def.fields).map(([field, type]) => [field, { dataverseType: type }])),
    relationships: def.relationships ?? {},
  };
}

/** Seeds the field security tables and the System Administrator profile. Insert-only: an existing mapping or row is left alone. */
export function ensureFieldSecurity(store) {
  return store.transact(() => {
    for (const [logical, def] of Object.entries(TABLE_DEFS)) {
      store.state.mappings[logical] ??= mappingFor(logical, def);
      rowsOf(store, logical);
    }
    const profiles = rowsOf(store, 'fieldsecurityprofile');
    if (!profiles.some((p) => same(p.fieldsecurityprofileid, SYSTEM_ADMINISTRATOR_PROFILE_ID))) {
      profiles.push({ fieldsecurityprofileid: SYSTEM_ADMINISTRATOR_PROFILE_ID, name: 'System Administrator' });
    }
  });
}

// Column-level security: columnMetadata.isSecured, unless dataverseMetadata.isSecured overrides it.
const isSecured = (field) => (field?.dataverseMetadata?.isSecured ?? (field?.columnMetadata?.isSecured === true));
const securedNames = (mapping) => Object.entries(mapping?.fields ?? {}).filter(([, field]) => isSecured(field)).map(([name]) => name);
const idOf = (mapping, row) => row?.[mapping.idColumn ?? `${mapping.logicalName}id`];

// unverified: mirrors dataverse-metadata metadataIdOf (not exported); field sharing keys AttributeId on it.
const attributeIdOf = (organizationId, entity, name) => uuidV5(organizationId, `attribute:${entity}:${name}`);

// unverified: status 403, the AccessDenied code and the principal-type wording; inner codes from the task brief.
function denied(operation, user, name, entity) {
  const innerCode = operation === 'create' ? '0x8004f502' : '0x8004f507';
  return new DataError(
    `SystemUser user with Id ${user.systemuserid} does not have ${operation} permissions to a ${name} secured field on entity ${entity}. The requested operation could not be completed.`,
    403, 'AccessDenied', { innerCode },
  );
}

/** Pure factory over a store and principals. `organizationId` (a GUID) derives the column MetadataIds. */
export function createFieldSecurity({ store, principals, organizationId }) {
  const rows = (logical) => store.tableRows(logical);
  const isAdmin = (user) => principals.roles(user).some((r) => r.name === ADMIN_ROLE);

  // The profiles a systemuser or team holds, and the principals a field share can name: the user (or team) and its teams.
  // A user reaches its own profiles and those of its teams.
  function scopeOf(kind, id) {
    const uid = key(id);
    const teams = kind === 'team'
      ? [uid]
      : rows('teammembership').filter((m) => same(refId(m.systemuserid), uid)).map((m) => key(refId(m.teamid)));
    const profiles = new Set();
    if (kind !== 'team') for (const r of rows('systemuserprofiles')) if (same(refId(r.systemuserid), uid)) profiles.add(key(refId(r.fieldsecurityprofileid)));
    for (const r of rows('teamprofiles')) if (teams.some((t) => same(refId(r.teamid), t))) profiles.add(key(refId(r.fieldsecurityprofileid)));
    return { profiles, principals: kind === 'team' ? teams : [uid, ...teams] };
  }

  // Field permissions reachable through the profiles, max-merged per column ("entity.attribute").
  function grantsOf(profiles) {
    const out = new Map();
    for (const r of rows('fieldpermission')) {
      if (!profiles.has(key(refId(r.fieldsecurityprofileid)))) continue;
      const k = `${key(r.entityname)}.${key(r.attributelogicalname)}`;
      const cur = out.get(k) ?? { entity: key(r.entityname), name: key(r.attributelogicalname), cancreate: 0, canread: 0, canupdate: 0, canreadunmasked: 0 };
      for (const f of FLAGS) cur[f] = Math.max(cur[f], Number(r[f]) || 0);
      out.set(k, cur);
    }
    return out;
  }

  // Field sharing: a PrincipalObjectAttributeAccess row for this record and column, granted to one of the principals.
  // unverified: whether a team's field share reaches its members through team membership (assumed yes here).
  function sharedOf(principalIds, recordId, attributeId) {
    const out = { read: false, update: false };
    if (!recordId) return out;
    for (const r of rows('principalobjectattributeaccess')) {
      if (!same(refId(r.objectid), recordId) || !same(r.attributeid, attributeId)) continue;
      if (!principalIds.some((p) => same(refId(r.principalid), p))) continue;
      out.read ||= r.readaccess === true;
      out.update ||= r.updateaccess === true;
    }
    return out;
  }

  // unverified: a System Administrator passes every secured column; recordId is absent on create.
  function accessOf(user, entity, name, recordId) {
    if (isAdmin(user)) return { create: true, read: true, update: true };
    const { profiles, principals: ids } = scopeOf('systemuser', user.systemuserid);
    const perm = grantsOf(profiles).get(`${key(entity)}.${key(name)}`) ?? {};
    const shared = sharedOf(ids, recordId, attributeIdOf(organizationId, entity, name));
    return {
      create: perm.cancreate === ALLOWED,
      read: perm.canread === ALLOWED || shared.read,
      update: perm.canupdate === ALLOWED || shared.update,
    };
  }

  return {
    /** Projection hook: a secured column the caller may not read becomes null and loses its annotations. */
    project(c, mapping, formatted) {
      const names = securedNames(mapping);
      if (!names.length) return;
      // unverified: `formatted` may be one row or an array; both are handled.
      for (const row of [].concat(formatted)) {
        const recordId = idOf(mapping, row);
        for (const name of names) {
          if (!Object.hasOwn(row, name) || accessOf(c.user, mapping.logicalName, name, recordId).read) continue;
          row[name] = null;
          for (const k of Object.keys(row)) if (k.startsWith(`${name}@`)) delete row[k];
        }
      }
    },

    /** Write hook: create needs cancreate, update needs canupdate or an update share on the record. */
    beforeWrite(c, mapping, { operation, data = {}, existing } = {}) {
      if (operation !== 'create' && operation !== 'update') return;
      const recordId = operation === 'update' ? (idOf(mapping, existing) ?? c.target?.id) : undefined;
      for (const name of securedNames(mapping)) {
        if (!Object.hasOwn(data, name)) continue;
        const access = accessOf(c.user, mapping.logicalName, name, recordId);
        if (operation === 'create' ? access.create : access.update) continue;
        throw denied(operation, c.user, name, mapping.logicalName);
      }
    },

    /** RetrievePrincipalAttributePrivileges: the field permissions a systemuser or team holds through its profiles. */
    retrievePrivileges(kind, id) {
      const { profiles } = scopeOf(kind, id);
      return [...grantsOf(profiles).values()].map((g) => ({
        AttributeId: attributeIdOf(organizationId, g.entity, g.name),
        CanCreate: g.cancreate,
        CanRead: g.canread,
        CanReadUnMasked: g.canreadunmasked,
        CanUpdate: g.canupdate,
      }));
    },
  };
}

/** Extension entry: registers the bound function and the project / beforeWrite hooks. Seed with ensureFieldSecurity. */
export const fieldSecurity = {
  name: 'dataverse-fls',
  install(api) {
    const fls = createFieldSecurity({ store: api.store, principals: api.principals, organizationId: api.settings.organizationId });
    for (const entity of ['systemuser', 'team']) {
      api.registry.register({
        name: 'RetrievePrincipalAttributePrivileges',
        kind: 'function',
        binding: 'entity',
        entity,
        handle: (c) => ({ status: 200, body: { AttributePrivileges: fls.retrievePrivileges(c.target.mapping.logicalName, c.target.id) } }),
      });
    }
    api.recordHooks.add('project', (c, mapping, formatted) => fls.project(c, mapping, formatted));
    api.recordHooks.add('beforeWrite', (c, mapping, change) => fls.beforeWrite(c, mapping, change));
  },
};
