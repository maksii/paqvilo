// Simulated Dataverse column (field) security: field security profiles, field permissions, field sharing,
// the record hooks that null or refuse secured columns, and RetrievePrincipalAttributePrivileges.
import { DataError } from './data-error.mjs';
import { metadataComponentId } from './dataverse-metadata.mjs';
import { organizationRecord } from './organization-context.mjs';
import { onceReporter } from './dataverse-addon-common.mjs';
import { fieldKind } from './dataverse-values.mjs';
import { immutableColumnRights } from './field-rights.mjs';
import { plainDataObject } from './state-clone.mjs';

export const SYSTEM_ADMINISTRATOR_PROFILE_ID = '572329c1-a042-4e22-be47-367c6374ea45';
// field_security_permission_type: 0 Not Allowed, 4 Allowed.
const ALLOWED = 4;
const ADMIN_ROLE = 'System Administrator';
/**
 * A principal not yet created that will hold System Administrator (the portal's local application user, created on first
 * use): column security evaluates it as an administrator. Matched by reference only, so no data can claim it.
 */
export const SYSTEM_ADMINISTRATOR_STAND_IN = Object.freeze({ systemuserid: null });
const FLAGS = ['cancreate', 'canread', 'canupdate', 'canreadunmasked'];
// CanReadUnmasked: 1 One Record (Retrieve only), 3 All Records.
const UNMASK_ONE = 1,
  UNMASK_ALL = 3;
// The read inner code 0x8004f508 is a guess.
const INNER_CODE = { create: '0x8004f502', update: '0x8004f507', read: '0x8004f508' };

const TEXT = 'nvarchar',
  INT = 'int',
  BOOL = 'bit',
  LOOKUP = 'lookup',
  GUID = 'uniqueidentifier';
const nn = (target, from, to, via) => ({ entity: target, from, to, many: true, intersect: { entity: via, from, to } });
// Entity set names are guessed from the Web API plural convention.
const TABLE_DEFS = {
  fieldsecurityprofile: {
    set: 'fieldsecurityprofiles',
    id: 'fieldsecurityprofileid',
    name: 'name',
    fields: { fieldsecurityprofileid: GUID, name: TEXT },
    relationships: {
      systemuserprofiles_association: nn('systemuser', 'fieldsecurityprofileid', 'systemuserid', 'systemuserprofiles'),
      teamprofiles_association: nn('team', 'fieldsecurityprofileid', 'teamid', 'teamprofiles'),
    },
  },
  fieldpermission: {
    set: 'fieldpermissions',
    id: 'fieldpermissionid',
    fields: {
      fieldpermissionid: GUID,
      fieldsecurityprofileid: LOOKUP,
      entityname: TEXT,
      attributelogicalname: TEXT,
      cancreate: INT,
      canread: INT,
      canupdate: INT,
      canreadunmasked: INT,
    },
  },
  systemuserprofiles: {
    set: 'systemuserprofiles',
    id: 'systemuserprofileid',
    fields: { systemuserprofileid: GUID, systemuserid: LOOKUP, fieldsecurityprofileid: LOOKUP },
  },
  teamprofiles: {
    set: 'teamprofiles',
    id: 'teamprofileid',
    fields: { teamprofileid: GUID, teamid: LOOKUP, fieldsecurityprofileid: LOOKUP },
  },
  principalobjectattributeaccess: {
    set: 'principalobjectattributeaccesses',
    id: 'principalobjectattributeaccessid',
    fields: {
      principalobjectattributeaccessid: GUID,
      objectid: LOOKUP,
      attributeid: GUID,
      principalid: LOOKUP,
      readaccess: BOOL,
      updateaccess: BOOL,
    },
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
  return flag(
    field?.dataverseMetadata?.IsSecured ??
      field?.dataverseMetadata?.isSecured ??
      field?.columnMetadata?.IsSecured ??
      field?.columnMetadata?.isSecured ??
      field?.isSecured,
  );
}
// A link-entity or aggregate alias prefixes both the key and the id column.
const idOf = (mapping, row, prefix = '') => row?.[`${prefix}${mapping.idColumn ?? `${mapping.logicalName}id`}`];

// Field sharing keys AttributeId on the column's metadata id.
const attributeIdOf = (organizationId, entity, name) => metadataComponentId(organizationId, 'attribute', entity, name);

// The 403 status, AccessDenied code and principal-type wording are a guess.
/** The column-security refusal of a write (also used by dataverse-customapi.mjs for low-code plug-in changes). */
export function denied(operation, user, name, entity) {
  return new DataError(
    `SystemUser user with Id ${user.systemuserid} does not have ${operation} permissions to a ${name} secured field on entity ${entity}. The requested operation could not be completed.`,
    403,
    'AccessDenied',
    { innerCode: INNER_CODE[operation] },
  );
}

/** A masked column used as a filter, order or aggregate operand: 0x80041155 CannotFilterOnMaskedAttribute. */
export function maskedOperand() {
  return new DataError(
    'Filtering on masked attributes without the read unmasked column permission is not allowed.',
    400,
    'InvalidRequest',
    { innerCode: '0x80041155' },
  );
}
// Aggregates that read only whether a value is present: masking keeps null as null, so they observe nothing of the clear value.
const PRESENCE_AGGREGATES = new Set(['count', 'countcolumn', '$count']);

/** Pure factory over a store and principals. `organizationId()` returns the organization GUID that derives the column MetadataIds. */
function createFieldSecurity({
  store,
  principals,
  organizationId,
  metadataFields = () => undefined,
  diagnostic = null,
}) {
  const reporter = onceReporter(diagnostic);
  const report = (entry) => reporter.report(entry, `${entry.code}\u0000${entry.table}\u0000${entry.column}`);
  const rows = (logical) => store.tableRows(logical);
  const isAdmin = (user) =>
    user === SYSTEM_ADMINISTRATOR_STAND_IN || principals.roles(user).some((r) => r.name === ADMIN_ROLE);
  const mappingField = (mapping, name, source = metadataFields(mapping?.logicalName)) => ({
    ...source?.[name],
    ...mapping?.fieldMetadata?.[name],
    ...mapping?.fields?.[name],
  });
  const securedNames = (mapping) => {
    const source = metadataFields(mapping?.logicalName) ?? null;
    return [
      ...new Set([
        ...Object.keys(source ?? {}),
        ...Object.keys(mapping?.fieldMetadata ?? {}),
        ...Object.keys(mapping?.fields ?? {}),
      ]),
    ].filter((name) => isSecuredField(mappingField(mapping, name, source)));
  };
  // A stored mapping keyed by its logical name may omit logicalName (a project-declared table); the masking rule, grant and
  // metadata lookups key on it, so it is always set here.
  const mappingOf = (logical) => {
    const mapping = store.state.mappings?.[logical];
    return mapping && !mapping.logicalName ? { ...mapping, logicalName: logical } : mapping;
  };
  const fieldOf = (logical, column) => mappingField(mappingOf(logical), column);
  // Primary name columns can't be secured (their
  // CanBeSecuredFor* are false, attribute-metadata.mjs). Metadata that secures one is refused when it loads, so a lookup's
  // formatted value and a Liquid `.name` never disagree with a masked column read.
  const assertSecurable = () => {
    for (const logical of Object.keys(store.state.mappings ?? {})) {
      const mapping = mappingOf(logical),
        name = mapping?.nameColumn;
      if (name && isSecuredField(mappingField(mapping, name))) {
        throw new DataError(
          `The primary name column ${name} of table ${logical} can't be secured.`,
          400,
          'InvalidRequest',
        ); // Native message text and code not known.
      }
    }
  };

  // The profiles a systemuser or team holds, and the principals a field share can name: the user (or team) and its teams.
  // A user reaches its own profiles and those of its teams.
  function scopeOf(kind, id) {
    const uid = key(id);
    const teams =
      kind === 'team'
        ? [uid]
        : rows('teammembership')
            .filter((m) => same(refId(m.systemuserid), uid))
            .map((m) => key(refId(m.teamid)));
    const profiles = new Set();
    if (kind !== 'team')
      for (const r of rows('systemuserprofiles'))
        if (same(refId(r.systemuserid), uid)) profiles.add(key(refId(r.fieldsecurityprofileid)));
    for (const r of rows('teamprofiles'))
      if (teams.some((t) => same(refId(r.teamid), t))) profiles.add(key(refId(r.fieldsecurityprofileid)));
    return { profiles, principals: kind === 'team' ? teams : [uid, ...teams] };
  }

  // Field permissions reachable through the profiles, max-merged per column ("entity.attribute").
  function grantsOf(profiles) {
    const out = new Map();
    for (const r of rows('fieldpermission')) {
      if (!profiles.has(key(refId(r.fieldsecurityprofileid)))) continue;
      const k = `${key(r.entityname)}.${key(r.attributelogicalname)}`;
      const cur = out.get(k) ?? {
        entity: key(r.entityname),
        name: key(r.attributelogicalname),
        cancreate: 0,
        canread: 0,
        canupdate: 0,
        canreadunmasked: 0,
      };
      for (const f of FLAGS) cur[f] = Math.max(cur[f], Number(r[f]) || 0);
      out.set(k, cur);
    }
    return out;
  }

  // Field sharing: a PrincipalObjectAttributeAccess row for this record and column, granted to one of the principals.
  // Assumed: a team's field share reaches its members through team membership.
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

  // A System Administrator passes every secured column (assumed); recordId is absent on create and on aggregates.
  // unmasked is the max-merged CanReadUnmasked (0 Not Allowed, 1 One Record, 3 All Records); a field share grants none.
  // A System Administrator may unmask every record, but still reads masked values until it asks.
  function accessOf(user, entity, name, recordId) {
    if (isAdmin(user)) return { create: true, read: true, update: true, unmasked: UNMASK_ALL };
    const { profiles, principals: ids } = scopeOf('systemuser', user.systemuserid);
    const perm = grantsOf(profiles).get(`${key(entity)}.${key(name)}`) ?? {};
    const shared = sharedOf(ids, recordId, attributeIdOf(organizationId(), entity, name));
    return {
      create: perm.cancreate === ALLOWED,
      read: perm.canread === ALLOWED || shared.read,
      update: perm.canupdate === ALLOWED || shared.update,
      unmasked: Number(perm.canreadunmasked) || 0,
    };
  }

  // The masking rule of a column: attributemaskingrule (entityname, attributelogicalname) -> maskingrule
  // (regularexpression, maskedcharacter). null when the column has none. A pattern JS cannot compile is { error }.
  // ponytail: the .NET regular expression dialect is approximated by JS RegExp (unicode-less, global); a .NET-only
  // construct reports MASKING_RULE_UNSUPPORTED and the column reads null, never the clear value.
  const compiled = new Map();
  // Rules per column, memoised per data revision (a masking rule row edit is a committed data write); the row counts also
  // catch rule rows added inside the open transaction.
  let rules = { revision: null, byColumn: new Map() };
  function maskOf(entity, column) {
    const revision = `${store.dataRevision?.() ?? Math.random()}:${rows('attributemaskingrule').length}:${rows('maskingrule').length}`;
    if (rules.revision !== revision) rules = { revision, byColumn: new Map() };
    const id = `${key(entity)}\u0000${key(column)}`;
    if (!rules.byColumn.has(id)) rules.byColumn.set(id, ruleOf(entity, column));
    return rules.byColumn.get(id);
  }
  function ruleOf(entity, column) {
    const link = rows('attributemaskingrule').find(
      (r) => same(r.entityname, entity) && same(r.attributelogicalname, column),
    );
    if (!link) return null;
    const rule = rows('maskingrule').find((r) => same(r.maskingruleid, refId(link.maskingruleid)));
    if (!rule?.regularexpression) return { error: 'The masking rule has no regular expression.' };
    const pattern = String(rule.regularexpression);
    if (!compiled.has(pattern)) {
      try {
        compiled.set(pattern, { regex: new RegExp(pattern, 'g') });
      } catch (error) {
        compiled.set(pattern, { error: error.message });
      }
    }
    const { regex, error } = compiled.get(pattern);
    return error ? { error } : { regex, character: String(rule.maskedcharacter ?? '*') || '*' };
  }

  // The one unmask rule: UnMaskedData asked and CanReadUnmasked All Records, or One Record on a single-record read.
  const unmaskable = (access, view) =>
    view?.unmask === true &&
    (access.unmasked === UNMASK_ALL || (access.unmasked === UNMASK_ONE && view.single === true));

  // Each match of the rule's expression becomes one masked character.
  function maskedValue(entity, column, value, access, view) {
    if (value === null || value === undefined || typeof value === 'object') return value;
    const rule = maskOf(entity, column);
    if (!rule) return value;
    if (unmaskable(access, view)) return value;
    if (rule.error) {
      report({
        code: 'MASKING_RULE_UNSUPPORTED',
        table: entity,
        column,
        message: `The masking rule of ${entity}.${column} cannot be evaluated (${rule.error}); the column reads as null.`,
      });
      return null;
    }
    return String(value).replace(rule.regex, () => rule.character);
  }

  // A catalogue asks for every field's three rights together. Resolve imported
  // metadata and staff grants once for this table, within the caller's serialized
  // read. Do not retain either across requests or security/source edits.
  function capabilities(user, logical, columns, recordId, { compact = false } = {}) {
    const mapping = mappingOf(logical);
    const source = metadataFields(mapping?.logicalName ?? logical) ?? null;
    let administrator, scope, grants;
    const result = plainDataObject(),
      property = { value: undefined, writable: true, enumerable: true, configurable: true };
    const rights = (read, create, update) =>
      compact ? immutableColumnRights(read, create, update) : { read, create, update };
    for (const name of columns) {
      let access;
      if (!isSecuredField(mappingField(mapping, name, source))) access = rights(true, true, true);
      else {
        administrator ??= isAdmin(user);
        if (administrator) access = rights(true, true, true);
        else {
          scope ??= scopeOf('systemuser', user.systemuserid);
          grants ??= grantsOf(scope.profiles);
          const permission = grants.get(`${key(logical)}.${key(name)}`) ?? {};
          const shared = sharedOf(scope.principals, recordId, attributeIdOf(organizationId(), logical, name));
          access = rights(
            permission.canread === ALLOWED || shared.read,
            permission.cancreate === ALLOWED,
            permission.canupdate === ALLOWED || shared.update,
          );
        }
      }
      property.value = access;
      Object.defineProperty(result, name, property);
    }
    return result;
  }

  // Create checks cancreate; update checks canupdate or an update share on the record.
  function writable(user, logical, name, operation, recordId) {
    const access = accessOf(user, logical, name, recordId);
    return operation === 'create' ? access.create : access.update;
  }

  // Nulls each secured column the user cannot read, under its plain name and its lookup form (_name_value), with its annotations.
  // view ({ unmask, single }) is a read the caller receives: a readable column with a masking rule answers its masked value
  // unless the read asked UnMaskedData and CanReadUnmasked allows it (All Records, or One Record on a single-record read).
  // Without view (filter evaluation) a readable column keeps its stored value.
  // The aliased lookup form `prefix_name_value` is assumed.
  function maskRow(user, mapping, row, prefix = '', view = null) {
    const recordId = idOf(mapping, row, prefix);
    for (const name of securedNames(mapping)) {
      const forms = [`${prefix}${name}`, `${prefix}_${name}_value`].filter((form) => Object.hasOwn(row, form));
      if (!forms.length) continue;
      const access = accessOf(user, mapping.logicalName, name, recordId);
      if (access.read) {
        const plain = `${prefix}${name}`;
        if (view && Object.hasOwn(row, plain)) {
          const masked = maskedValue(mapping.logicalName, name, row[plain], access, view);
          if (masked !== row[plain]) {
            row[plain] = masked;
            for (const k of Object.keys(row)) if (k.startsWith(`${plain}@`)) delete row[k];
          }
        }
        continue;
      }
      for (const form of forms) {
        row[form] = null;
        for (const k of Object.keys(row)) if (k.startsWith(`${form}@`)) delete row[k];
      }
    }
    return row;
  }

  return {
    capabilities,
    assertSecurable,
    /**
     * Projection hook: a secured column the caller may not read becomes null and loses its annotations; a readable one with a
     * masking rule answers its masked value unless c.unmasked (UnMaskedData=true) and CanReadUnmasked allow the clear value.
     * single: a single-record read (Retrieve), which CanReadUnmasked One Record unmasks.
     */
    project(c, mapping, formatted, { prefix = '', single = false } = {}) {
      if (!securedNames(mapping).length) return;
      const view = { unmask: c.unmasked === true, single: single === true };
      for (const row of [].concat(formatted)) maskRow(c.user, mapping, row, prefix, view);
    },

    /**
     * Copy of a row with the secured columns the user cannot read nulled. Other modules' responses use it via api.fieldSecurity.
     * With view ({ unmask, single }) the copy is what the caller receives, masking rules applied; without it (filter evaluation)
     * readable columns keep their stored value.
     */
    mask(user, logical, row, { prefix = '', view = null } = {}) {
      const mapping = mappingOf(logical);
      const copy = { ...row };
      return mapping ? maskRow(user, mapping, copy, prefix, view) : copy;
    },

    /** The value a caller receives for one readable column (masking rule applied per view); unreadable columns read null. */
    maskValue(user, logical, column, value, view, recordId) {
      if (!isSecuredField(fieldOf(logical, column))) return value;
      const access = accessOf(user, logical, column, recordId);
      return access.read ? maskedValue(logical, column, value, access, view) : null;
    },

    diagnostics: () => [...reporter.diagnostics],

    /**
     * True when the caller reads this column masked for this view ({ unmask, single }): a secured column it may read, with
     * a masking rule, that UnMaskedData plus CanReadUnmasked does not unmask. Such a column is never a filter or order
     * operand (dataverse-records.mjs answers 0x80041155).
     */
    maskedFor(user, logical, column, view = { unmask: false, single: false }) {
      if (!isSecuredField(fieldOf(logical, column))) return false;
      const access = accessOf(user, logical, column);
      return access.read && maskOf(logical, column) !== null && !unmaskable(access, view);
    },

    canRead(user, logical, column, recordId) {
      return !isSecuredField(fieldOf(logical, column)) || accessOf(user, logical, column, recordId).read;
    },

    /** operation: 'create' or 'update'. */
    canWrite(user, logical, column, operation, recordId) {
      return !isSecuredField(fieldOf(logical, column)) || writable(user, logical, column, operation, recordId);
    },

    /**
     * Aggregates and groupings read the raw column. columns: names on mapping, or { logical, column, method } resolved through
     * navigation paths. A secured column the caller cannot read is refused (403); a masked one is refused as an operand (400
     * 0x80041155) for every method but a presence count.
     * The docs name filtering only; min/max/groupby/countdistinct are refused too, since over the clear value they leak the
     * same order and equality a filter would.
     */
    assertAggregate(c, mapping, columns = []) {
      const view = { unmask: c.unmasked === true, single: false };
      for (const item of columns) {
        const { logical = mapping.logicalName, column, method } = typeof item === 'string' ? { column: item } : item;
        const field = mappingField(logical === mapping.logicalName ? mapping : mappingOf(logical), column);
        if (!isSecuredField(field)) continue;
        const access = accessOf(c.user, logical, column);
        if (!access.read) throw denied('read', c.user, column, logical);
        // The maskedFor rule over the access just read.
        if (!PRESENCE_AGGREGATES.has(method) && maskOf(logical, column) !== null && !unmaskable(access, view))
          throw maskedOperand();
      }
    },

    /**
     * Query-context row mask for a table (store.queryContext backendRowsMask): null when the table has no secured column, else
     * a function returning a copy of a row with each secured column this user cannot read nulled. Readable columns keep their
     * stored value (masking applies to what the caller receives, not to evaluation). Lookups are join keys and are never
     * nulled: lookup columns cannot be secured.
     */
    rowMask(user, logical) {
      const mapping = mappingOf(logical);
      if (!mapping || isAdmin(user)) return null;
      const source = metadataFields(mapping.logicalName) ?? null;
      const names = securedNames(mapping).filter((name) => fieldKind(mappingField(mapping, name, source)) !== 'lookup');
      if (!names.length) return null;
      return (row) => {
        let copy = row;
        for (const name of names) {
          if (row[name] == null || accessOf(user, logical, name, idOf(mapping, row)).read) continue;
          if (copy === row) copy = { ...row };
          copy[name] = null;
        }
        return copy;
      };
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
    // The organization GUID comes from the organization row: api.settings.organizationId is null at runtime.
    const fls = createFieldSecurity({
      store,
      principals,
      metadataFields: (logical) => api.metadataFields?.(logical),
      organizationId: () => organizationRecord(store)?.organizationid,
      diagnostic: api.diagnostic ?? null,
    });
    (api.readMetadata ?? ((fn) => fn()))(() => fls.assertSecurable());
    api.fieldSecurity = {
      mask: fls.mask,
      maskValue: fls.maskValue,
      maskedFor: fls.maskedFor,
      canRead: fls.canRead,
      canWrite: fls.canWrite,
      capabilities: fls.capabilities,
      assertAggregate: fls.assertAggregate,
      rowMask: fls.rowMask,
      maskedOperand,
      diagnostics: fls.diagnostics,
    };
    for (const entity of ['systemuser', 'team']) {
      api.registry.register({
        name: 'RetrievePrincipalAttributePrivileges',
        kind: 'function',
        binding: 'entity',
        entity,
        handle: (c) => {
          const kind = c.target.mapping.logicalName;
          // Assumed: reading another principal's field permissions needs read on that principal; a user reads its own.
          const own = kind === 'systemuser' && same(c.user?.systemuserid, c.target.id);
          if (!own) principals.authorize({ user: c.user, entity: kind, operation: 'read' });
          return { status: 200, body: { AttributePrivileges: fls.retrievePrivileges(kind, c.target.id) } };
        },
      });
    }
    api.recordHooks.add('project', (c, mapping, formatted, info = {}) =>
      fls.project(c, mapping, formatted, { single: info.single === true }),
    );
    api.recordHooks.add('beforeWrite', (c, mapping, change) => fls.beforeWrite(c, mapping, change));
    // The API awaits install, so the seed is committed before the first request.
    return api.change(() => ensureFieldSecurity(store));
  },
  // Re-seeds through the store only: reset runs inside the server's change queue (see dataverse-extensions.mjs).
  reset(api) {
    return ensureFieldSecurity(api.store);
  },
};
