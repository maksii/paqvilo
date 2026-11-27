// Read-only site tables derived from the portal export and local personas:
// the site's components and its contact web role memberships.
//
// Enhanced data model: powerpagecomponent rows for every imported component and
// the documented N:N powerpagecomponent_mspp_webrole_contact (intersect
// powerpagecomponent_mspp_webrole_contact, powerpagecomponentid / contactid).
// Standard data model: adx_webrole rows and the N:N adx_webrole_contact
// (intersect adx_webrole_contact, adx_webroleid / contactid).
// learn.microsoft.com/power-apps/developer/data-platform/reference/entities/powerpagecomponent
// and .../contact#BKMK_powerpagecomponent_mspp_webrole_contact.
import { createHash } from 'node:crypto';
import { readRecordValues } from './record-tables.mjs';

const chooseLazily = (condition, yes, no) => {
  if (condition()) return yes();
  return no();
};

const guidFrom = (text) => {
  const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const normalizedId = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const META = new Set(['kind', 'id', 'name', 'statecode', 'powerpagecomponenttype']);

const COMPONENT_FIELDS = {
  powerpagecomponentid: { dataverseType: 'uniqueidentifier' },
  name: { dataverseType: 'nvarchar', isPrimaryName: true },
  powerpagecomponenttype: { dataverseType: 'picklist' },
  content: { dataverseType: 'memo' },
  statecode: {
    dataverseType: 'state',
    options: [
      { value: 0, label: 'Active' },
      { value: 1, label: 'Inactive' },
    ],
  },
  statuscode: {
    dataverseType: 'status',
    options: [
      { value: 1, label: 'Active' },
      { value: 2, label: 'Inactive' },
    ],
  },
};
const WEBROLE_FIELDS = {
  adx_webroleid: { dataverseType: 'uniqueidentifier' },
  adx_name: { dataverseType: 'nvarchar', isPrimaryName: true },
  adx_description: { dataverseType: 'memo' },
  adx_authenticatedusersrole: { dataverseType: 'bit' },
  adx_anonymoususersrole: { dataverseType: 'bit' },
  statecode: {
    dataverseType: 'state',
    options: [
      { value: 0, label: 'Active' },
      { value: 1, label: 'Inactive' },
    ],
  },
  statuscode: {
    dataverseType: 'status',
    options: [
      { value: 1, label: 'Active' },
      { value: 2, label: 'Inactive' },
    ],
  },
};

// Enhanced data model: mspp_webrole, the Power Pages Management virtual table of web roles, holds the site's web roles.
// A hosted site's /_api/mspp_webroles returned these columns (session F1, summary-F1.md AUTH-03c) and, beyond them, the
// web roles of every site in the environment with their audit columns; locally the table holds this export's roles only.
const MSPP_WEBROLE_FIELDS = {
  mspp_webroleid: { dataverseType: 'uniqueidentifier' },
  mspp_name: { dataverseType: 'nvarchar', isPrimaryName: true },
  statecode: WEBROLE_FIELDS.statecode,
  statuscode: WEBROLE_FIELDS.statuscode,
};

/** The mspp_webrole site table of an enhanced data model export: { mapping, rows } or null. */
function webRoleTable(records, declared) {
  const rows = records
    .filter((record) => record.kind === 'webrole')
    .map((record) => ({
      mspp_webroleid: normalizedId(record.id),
      mspp_name: record.name ?? null,
      statecode: Number(record.statecode ?? 0),
      statuscode: Number(record.statecode ?? 0) === 1 ? 2 : 1,
    }));
  if (!rows.length) return null;
  return {
    mapping: {
      logicalName: 'mspp_webrole',
      entitySet: declared?.entitySet ?? 'mspp_webroles',
      idColumn: declared?.idColumn ?? 'mspp_webroleid',
      nameColumn: 'mspp_name',
      fields: { ...MSPP_WEBROLE_FIELDS, ...declared?.fields },
      relationships: {},
    },
    rows,
  };
}

export function contactRoleIntersection(portal) {
  return portal.format === 'enhanced'
    ? { table: 'powerpagecomponent_mspp_webrole_contact', roleColumn: 'powerpagecomponentid' }
    : { table: 'adx_webrole_contact', roleColumn: 'adx_webroleid' };
}

/** A stored intersection stays authoritative after its last membership is removed. */
export function contactRoleAssignments(portal, state) {
  const { table, roleColumn } = contactRoleIntersection(portal);
  const rows = state.tables?.[table];
  return rows === undefined
    ? (state.simulator?.contactRoles ?? [])
    : Array.from(readRecordValues(rows), (row) => ({ contactId: row.contactid, roleId: row[roleColumn] }));
}

const assignmentKey = ({ contactId, roleId }) => `${normalizedId(contactId)}:${normalizedId(roleId)}`;

function writeStoredContactRoles(portal, state, assignments, removed = new Set()) {
  const { table, roleColumn } = contactRoleIntersection(portal);
  const rows = state.tables?.[table];
  if (rows === undefined) return;
  const next = [];
  const stored = new Set();
  for (const row of readRecordValues(rows)) {
    const key = assignmentKey({ contactId: row.contactid, roleId: row[roleColumn] });
    if (removed.has(key)) continue;
    next.push(row);
    stored.add(key);
  }
  const idColumn = state.mappings?.[table]?.idColumn ?? `${table}id`;
  for (const assignment of assignments) {
    const key = assignmentKey(assignment);
    if (stored.has(key)) continue;
    next.push({
      [idColumn]: guidFrom(`${table}:${key}`),
      contactid: normalizedId(assignment.contactId),
      [roleColumn]: normalizedId(assignment.roleId),
    });
    stored.add(key);
  }
  state.tables[table] = next;
}

/** Apply an explicit persona configuration change without replacing unrelated stored associations. */
export function configureContactRoles(portal, state, assignments) {
  const simulator = (state.simulator ??= {});
  const assigned = new Set(assignments.map(assignmentKey));
  const removed = new Set((simulator.contactRoles ?? []).map(assignmentKey).filter((key) => !assigned.has(key)));
  writeStoredContactRoles(portal, state, assignments, removed);
  simulator.contactRoles = assignments;
}

/** Add only the named grants. This leaves previously revoked legacy assignments unchanged. */
export function grantContactRoles(portal, state, assignments) {
  const simulator = (state.simulator ??= {});
  writeStoredContactRoles(portal, state, assignments);
  const configured = new Map((simulator.contactRoles ?? []).map((entry) => [assignmentKey(entry), entry]));
  for (const assignment of assignments) {
    const key = assignmentKey(assignment);
    if (!configured.has(key)) configured.set(key, assignment);
  }
  simulator.contactRoles = [...configured.values()];
}

/** Contact web role memberships: assigned memberships plus the configured persona's role names. */
function memberships(portal, state) {
  const roles = (portal.records ?? []).filter((record) => record.kind === 'webrole');
  const byName = new Map(
    roles.map((role) => [
      String(role.name ?? '')
        .trim()
        .toLowerCase(),
      normalizedId(role.id),
    ]),
  );
  const out = new Map();
  const add = (contactId, roleId) => {
    const contact = normalizedId(contactId),
      role = normalizedId(roleId);
    if (contact && role) out.set(`${contact}:${role}`, { contactId: contact, roleId: role });
  };
  for (const assignment of contactRoleAssignments(portal, state)) add(assignment.contactId, assignment.roleId);
  const identity = state.simulator?.identity ?? {};
  const contactId = identity.contactId ?? identity.id;
  if (contactId)
    for (const name of identity.roles ?? []) {
      const roleId = byName.get(
        String(name ?? '')
          .trim()
          .toLowerCase(),
      );
      if (roleId) add(contactId, roleId);
    }
  return [...out.values()];
}

/**
 * Site tables for a portal and store state:
 * { tables: { logical: { mapping, rows } }, relationships: { logical: { navigation: rel } } }.
 * A table is only supplied while local data holds no rows of its own.
 */
export function buildSiteTables(portal, state) {
  const tables = {},
    relationships = {};
  const own = (logical) => (state.tables?.[logical] ?? []).length > 0;
  const declared = (logical) => state.mappings?.[logical];
  const records = portal.records ?? [];
  const enhanced = portal.format === 'enhanced';
  const [table, idColumn, nameColumn, setName, fields, intersect, rows] = enhanced
    ? [
        'powerpagecomponent',
        'powerpagecomponentid',
        'name',
        'powerpagecomponents',
        COMPONENT_FIELDS,
        'powerpagecomponent_mspp_webrole_contact',
        // Only site components are powerpagecomponent rows: the website (powerpagesite), its site
        // languages (powerpagesitelanguage) and code-site source files (powerpagessourcefile) are
        // other tables.
        records
          .filter((record) =>
            Number.isInteger(Number(record.powerpagecomponenttype ?? /^component:(\d+)$/.exec(record.kind ?? '')?.[1])),
          )
          .map((record) => {
            const type = Number(record.powerpagecomponenttype ?? /^component:(\d+)$/.exec(record.kind ?? '')?.[1]);
            const content = Object.fromEntries(
              Object.entries(record).filter(([key]) => !META.has(key) && !key.startsWith('_')),
            );
            return {
              powerpagecomponentid: normalizedId(record.id),
              name: record.name ?? null,
              ...(Number.isInteger(type) ? { powerpagecomponenttype: type } : {}),
              content: JSON.stringify(content),
              statecode: Number(record.statecode ?? 0),
              statuscode: Object.hasOwn(record._componentEnvelope ?? {}, 'statuscode')
                ? record._componentEnvelope.statuscode
                : chooseLazily(
                    () => Number(record.statecode ?? 0) === 1,
                    () => 2,
                    () => 1,
                  ),
            };
          }),
      ]
    : [
        'adx_webrole',
        'adx_webroleid',
        'adx_name',
        'adx_webroles',
        WEBROLE_FIELDS,
        'adx_webrole_contact',
        records
          .filter((record) => record.kind === 'webrole')
          .map((record) => ({
            adx_webroleid: normalizedId(record.id),
            adx_name: record.name ?? null,
            ...(record.adx_description != null ? { adx_description: record.adx_description } : {}),
            ...(record.adx_authenticatedusersrole != null
              ? { adx_authenticatedusersrole: Boolean(record.adx_authenticatedusersrole) }
              : {}),
            ...(record.adx_anonymoususersrole != null
              ? { adx_anonymoususersrole: Boolean(record.adx_anonymoususersrole) }
              : {}),
            statecode: Number(record.statecode ?? 0),
            statuscode: Number(record.statecode ?? 0) === 1 ? 2 : 1,
          })),
      ];
  const roleIds = new Set(
    records.filter((record) => record.kind === 'webrole').map((record) => normalizedId(record.id)),
  );
  if (!own(table) && rows.length)
    tables[table] = {
      mapping: {
        logicalName: table,
        entitySet: declared(table)?.entitySet ?? setName,
        idColumn: declared(table)?.idColumn ?? idColumn,
        nameColumn,
        fields: { ...fields, ...declared(table)?.fields },
        relationships: {},
      },
      rows,
    };
  const webRoles = enhanced && !own('mspp_webrole') ? webRoleTable(records, declared('mspp_webrole')) : null;
  if (webRoles) tables.mspp_webrole = webRoles;
  if (!Object.hasOwn(state.tables ?? {}, intersect))
    tables[intersect] = {
      mapping: {
        logicalName: intersect,
        entitySet: declared(intersect)?.entitySet ?? `${intersect}s`,
        idColumn: declared(intersect)?.idColumn ?? `${intersect}id`,
        fields: { contactid: { dataverseType: 'uniqueidentifier' }, [idColumn]: { dataverseType: 'uniqueidentifier' } },
        relationships: {},
        // The web role memberships: a permitted portal association stores them as local data (data.mjs storeSiteMembership).
        intersect: true,
        siteMembership: true,
      },
      rows: memberships(portal, state)
        .filter((membership) => roleIds.has(membership.roleId))
        .map((membership) => ({
          [`${intersect}id`]: guidFrom(`${intersect}:${membership.contactId}:${membership.roleId}`),
          contactid: membership.contactId,
          [idColumn]: membership.roleId,
        })),
    };
  // The platform's N:N (its schema name is the intersect's): a portal $ref needs the endpoint tables' Append and Append
  // To, never a permission on the intersect itself.
  relationships.contact = {
    [intersect]: {
      entity: table,
      from: 'contactid',
      to: idColumn,
      many: true,
      type: 'many-to-many',
      schemaName: intersect,
      intersect: { entity: intersect, from: 'contactid', to: idColumn },
    },
  };
  relationships[table] = {
    [intersect]: {
      entity: 'contact',
      from: idColumn,
      to: 'contactid',
      many: true,
      type: 'many-to-many',
      schemaName: intersect,
      intersect: { entity: intersect, from: idColumn, to: 'contactid' },
    },
  };
  return { tables, relationships };
}
