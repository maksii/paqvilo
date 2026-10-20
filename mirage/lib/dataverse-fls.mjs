// Simulated Dataverse column (field) security: field security profiles, field permissions, field sharing,
// the record hooks that null or refuse secured columns, and RetrievePrincipalAttributePrivileges.
// Invented schema and GUIDs only.
import { DataError } from './data-error.mjs';
import { uuidV5 } from './dataverse-security.mjs';
import { organizationRecord } from './organization-context.mjs';

export const SYSTEM_ADMINISTRATOR_PROFILE_ID = '572329c1-a042-4e22-be47-367c6374ea45';
// field_security_permission_type: 0 Not Allowed, 4 Allowed.
const ALLOWED = 4;
const ADMIN_ROLE = 'System Administrator';
const FLAGS = ['cancreate', 'canread', 'canupdate', 'canreadunmasked'];
// unverified: the read code 0x8004f508 comes from the audit brief, not from a captured response.
const INNER_CODE = { create: '0x8004f502', update: '0x8004f507', read: '0x8004f508' };

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

// IsSecured arrives as a bool, or as { Value } in the Web API; the dataverseMetadata flag overrides the columnMetadata one.
const flag = (value) => (value !== null && typeof value === 'object' ? value.Value === true : value === true);
export function isSecuredField(field) {
  return flag(field?.dataverseMetadata?.IsSecured ?? field?.dataverseMetadata?.isSecured ?? field?.columnMetadata?.IsSecured ?? field?.columnMetadata?.isSecured ?? field?.isSecured);
}
// A link-entity or aggregate alias prefixes both the key and the id column.
const idOf = (mapping, row, prefix = '') => row?.[`${prefix}${mapping.idColumn ?? `${mapping.logicalName}id`}`];

// unverified: mirrors dataverse-metadata metadataIdOf (not exported); field sharing keys AttributeId on it.
const attributeIdOf = (organizationId, entity, name) => uuidV5(organizationId, `attribute:${entity}:${name}`);

// unverified: status 403, the AccessDenied code and the principal-type wording; inner codes from the task brief.
function denied(operation, user, name, entity) {
  return new DataError(
    `SystemUser user with Id ${user.systemuserid} does not have ${operation} permissions to a ${name} secured field on entity ${entity}. The requested operation could not be completed.`,
    403, 'AccessDenied', { innerCode: INNER_CODE[operation] },
  );
}

/** Pure factory over a store and principals. `organizationId()` returns the organization GUID that derives the column MetadataIds. */
export function createFieldSecurity({ store, principals, organizationId, metadataFields = () => undefined }) {
  const rows = (logical) => store.tableRows(logical);
  const isAdmin = (user) => principals.roles(user).some((r) => r.name === ADMIN_ROLE);
  const mappingField = (mapping, name, source = metadataFields(mapping?.logicalName)) => ({ ...source?.[name], ...mapping?.fieldMetadata?.[name], ...mapping?.fields?.[name] });
  const securedNames = mapping => {
    const source = metadataFields(mapping?.logicalName) ?? null;
    return [...new Set([...Object.keys(source ?? {}), ...Object.keys(mapping?.fieldMetadata ?? {}), ...Object.keys(mapping?.fields ?? {})])]
      .filter(name => isSecuredField(mappingField(mapping, name, source)));
  };
  const fieldOf = (logical, column) => mappingField(store.state.mappings?.[logical], column);

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

  // unverified: a System Administrator passes every secured column; recordId is absent on create and on aggregates.
  function accessOf(user, entity, name, recordId) {
    if (isAdmin(user)) return { create: true, read: true, update: true };
    const { profiles, principals: ids } = scopeOf('systemuser', user.systemuserid);
    const perm = grantsOf(profiles).get(`${key(entity)}.${key(name)}`) ?? {};
    const shared = sharedOf(ids, recordId, attributeIdOf(organizationId(), entity, name));
    return {
      create: perm.cancreate === ALLOWED,
      read: perm.canread === ALLOWED || shared.read,
      update: perm.canupdate === ALLOWED || shared.update,
    };
  }

  // A catalogue asks for every field's three rights together. Resolve imported
  // metadata and staff grants once for this table, within the caller's serialized
  // read. Do not retain either across requests or security/source edits.
  function capabilities(user, logical, columns, recordId) {
    const mapping = store.state.mappings?.[logical];
    const source = metadataFields(mapping?.logicalName ?? logical) ?? null;
    let administrator, scope, grants;
    return Object.fromEntries(columns.map(name => {
      if (!isSecuredField(mappingField(mapping, name, source))) return [name, { read: true, create: true, update: true }];
      administrator ??= isAdmin(user);
      if (administrator) return [name, { read: true, create: true, update: true }];
      scope ??= scopeOf('systemuser', user.systemuserid);
      grants ??= grantsOf(scope.profiles);
      const permission = grants.get(`${key(logical)}.${key(name)}`) ?? {};
      const shared = sharedOf(scope.principals, recordId, attributeIdOf(organizationId(), logical, name));
      return [name, { read: permission.canread === ALLOWED || shared.read, create: permission.cancreate === ALLOWED,
        update: permission.canupdate === ALLOWED || shared.update }];
    }));
  }

  // Create checks cancreate; update checks canupdate or an update share on the record.
  function writable(user, logical, name, operation, recordId) {
    const access = accessOf(user, logical, name, recordId);
    return operation === 'create' ? access.create : access.update;
  }

  // Nulls each secured column the user cannot read, under its plain name and its lookup form (_name_value), with its annotations.
  // unverified: the aliased lookup form `prefix_name_value` is assumed, not captured.
  function maskRow(user, mapping, row, prefix = '') {
    const recordId = idOf(mapping, row, prefix);
    for (const name of securedNames(mapping)) {
      const forms = [`${prefix}${name}`, `${prefix}_${name}_value`].filter((form) => Object.hasOwn(row, form));
      if (!forms.length || accessOf(user, mapping.logicalName, name, recordId).read) continue;
      for (const form of forms) {
        row[form] = null;
        for (const k of Object.keys(row)) if (k.startsWith(`${form}@`)) delete row[k];
      }
    }
    return row;
  }

  return {
    capabilities,
    /** Projection hook: a secured column the caller may not read becomes null and loses its annotations. */
    project(c, mapping, formatted, { prefix = '' } = {}) {
      if (!securedNames(mapping).length) return;
      // unverified: `formatted` may be one row or an array; both are handled.
      for (const row of [].concat(formatted)) maskRow(c.user, mapping, row, prefix);
    },

    /** Copy of a row with the secured columns the user cannot read nulled. Other modules' responses use it via api.fieldSecurity. */
    mask(user, logical, row, { prefix = '' } = {}) {
      const mapping = store.state.mappings?.[logical];
      const copy = { ...row };
      return mapping ? maskRow(user, mapping, copy, prefix) : copy;
    },

    canRead(user, logical, column, recordId) {
      return !isSecuredField(fieldOf(logical, column)) || accessOf(user, logical, column, recordId).read;
    },

    /** operation: 'create' or 'update'. */
    canWrite(user, logical, column, operation, recordId) {
      return !isSecuredField(fieldOf(logical, column)) || writable(user, logical, column, operation, recordId);
    },

    /** Aggregates read the raw column, so a secured one the caller cannot read is refused. */
    assertAggregate(c, mapping, columns = []) {
      for (const name of columns) {
        if (isSecuredField(mappingField(mapping, name)) && !accessOf(c.user, mapping.logicalName, name).read) throw denied('read', c.user, name, mapping.logicalName);
      }
    },

    /** Write hook: a write naming a secured column (plain or @odata.bind) needs the matching permission. */
    beforeWrite(c, mapping, { operation, data = {}, existing } = {}) {
      if (operation !== 'create' && operation !== 'update') return;
      const recordId = operation === 'update' ? (idOf(mapping, existing) ?? c.target?.id) : undefined;
      for (const name of securedNames(mapping)) {
        if (!Object.hasOwn(data, name) && !Object.hasOwn(data, `${name}@odata.bind`)) continue;
        if (writable(c.user, mapping.logicalName, name, operation, recordId)) continue;
        throw denied(operation, c.user, name, mapping.logicalName);
      }
    },

    /** RetrievePrincipalAttributePrivileges: the field permissions a systemuser or team holds through its profiles. */
    retrievePrivileges(kind, id) {
      const { profiles } = scopeOf(kind, id);
      return [...grantsOf(profiles).values()].map((g) => ({
        AttributeId: attributeIdOf(organizationId(), g.entity, g.name),
        CanCreate: g.cancreate,
        CanRead: g.canread,
        CanReadUnMasked: g.canreadunmasked,
        CanUpdate: g.canupdate,
      }));
    },
  };
}

/** Extension entry: seeds its tables, exposes api.fieldSecurity and registers the bound function and the project / beforeWrite hooks. */
export const fieldSecurity = {
  name: 'dataverse-fls',
  install(api) {
    const { store, principals } = api;
    // The organization GUID comes from the organization row: api.settings.organizationId is null at runtime (H6).
    const fls = createFieldSecurity({ store, principals, metadataFields: logical => api.metadataFields?.(logical), organizationId: () => organizationRecord(store)?.organizationid });
    api.fieldSecurity = { mask: fls.mask, canRead: fls.canRead, canWrite: fls.canWrite, capabilities: fls.capabilities, assertAggregate: fls.assertAggregate };
    for (const entity of ['systemuser', 'team']) {
      api.registry.register({
        name: 'RetrievePrincipalAttributePrivileges',
        kind: 'function',
        binding: 'entity',
        entity,
        handle: (c) => {
          const kind = c.target.mapping.logicalName;
          // unverified: reading another principal's field permissions needs read on that principal; a user reads its own.
          const own = kind === 'systemuser' && same(c.user?.systemuserid, c.target.id);
          if (!own) principals.authorize({ user: c.user, entity: kind, operation: 'read' });
          return { status: 200, body: { AttributePrivileges: fls.retrievePrivileges(kind, c.target.id) } };
        },
      });
    }
    api.recordHooks.add('project', (c, mapping, formatted) => fls.project(c, mapping, formatted));
    api.recordHooks.add('beforeWrite', (c, mapping, change) => fls.beforeWrite(c, mapping, change));
    // The API awaits install, so the seed is committed before the first request.
    return api.change(() => ensureFieldSecurity(store));
  },
  // Re-seeds through the store only: reset runs inside the server's change queue (see dataverse-extensions.mjs).
  reset(api) {
    return ensureFieldSecurity(api.store);
  },
};
