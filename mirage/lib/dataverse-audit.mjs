// Simulated Dataverse auditing: the read-only audit table, enablement from the organization,
// table and column flags, the change history functions and the audit-only delete action.
// Writes come from the store's committed events (portal and /_sim/ writes too) and from the
// afterWrite hook for N:N association. Invented schema and GUIDs only.
import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { privilegeDeniedError, uuidV5 } from './dataverse-security.mjs';

// Audit enums (Auditing (Audit) table reference): Operation 1-4, Action 1, 2, 3, 13, 33, 34, 41.
const OPERATION = { create: 1, update: 2, delete: 3 };
const ACTION = { create: 1, update: 2, delete: 3, assign: 13, setState: 41, associate: 33, disassociate: 34 };
const ATTRIBUTE_DETAIL = '#Microsoft.Dynamics.CRM.AttributeAuditDetail';
const RELATIONSHIP_DETAIL = '#Microsoft.Dynamics.CRM.RelationshipAuditDetail'; // unverified: member names
const BASE_DETAIL = '#Microsoft.Dynamics.CRM.AuditDetail';
const READ_PRIVILEGES = ['prvReadRecordAuditHistory', 'prvReadAuditSummary'];
const DELETE_PRIVILEGE = 'prvDeleteRecordChangeHistory';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_COUNT = 5000; // unverified: default PagingInfo.Count

const AUDIT_MAPPING = {
  logicalName: 'audit', entitySet: 'audits', idColumn: 'auditid',
  userConfigured: true,
  // Seeded for the Dataverse API only: the portal Web API resolver ignores these sets (webapi-handler resolveSet).
  dataverseOnly: true,
  fields: {
    auditid: { dataverseType: 'uniqueidentifier' }, operation: { dataverseType: 'int' }, action: { dataverseType: 'int' },
    objectid: { dataverseType: 'lookup' }, objecttypecode: { dataverseType: 'nvarchar' }, attributemask: { dataverseType: 'nvarchar' },
    userid: { dataverseType: 'lookup' }, callinguserid: { dataverseType: 'lookup' }, createdon: { dataverseType: 'datetime' },
    transactionid: { dataverseType: 'uniqueidentifier' },
  },
  relationships: {},
};

const flag = (value) => (value !== null && typeof value === 'object' ? value.Value === true : value === true);
const plain = (value) => (value !== null && typeof value === 'object' && 'id' in value ? value.id : value) ?? null;
const same = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));
const lower = (value) => String(value ?? '').toLowerCase();
const ref = (logical, id) => (id == null ? null : { id, logical_name: logical, name: '' });
const rowsOf = (store) => (store.state.tables.audit ??= []);
const detailsOf = (store) => ((store.state.dataverse ??= {}).auditDetails ??= {});
const organizationOf = (store) => store.tableRows('organization')[0] ?? {};
const schemaOf = (api) => (typeof api.schema === 'function' ? api.schema() : api.schema);

// Organization.IsAuditEnabled gates everything; a table and its columns are audited when their flags say so.
const auditingOn = (store) => flag(organizationOf(store).isauditenabled);
function tableAudited(api, mapping) {
  const table = (schemaOf(api)?.tables ?? []).find((t) => t.logicalName === mapping.logicalName);
  return flag(mapping.dataverseMetadata?.IsAuditEnabled ?? table?.isAuditEnabled);
}
function columnAudited(mapping, column) {
  const declared = mapping.fields[column].IsAuditEnabled;
  return declared === undefined ? true : flag(declared);
}
const auditable = (api, mapping) => mapping.logicalName !== 'audit' && auditingOn(api.store) && tableAudited(api, mapping);
const auditedColumns = (mapping) => Object.keys(mapping.fields).filter((column) => columnAudited(mapping, column));
// unverified: ColumnNumber is not in the exports; the field's position in the mapping stands in for it.
const columnNumber = (mapping, column) => Object.keys(mapping.fields).indexOf(column) + 1;
const isLookup = (mapping, column) => mapping.fields[column]?.dataverseType === 'lookup';
const pick = (values, columns) => Object.fromEntries(columns.map((column) => [column, values?.[column] ?? null]));

// Audit rows carry the calling user only when impersonation is used (identity.dataverse.callerId differs).
function actorFields(identity = {}) {
  const userId = identity.systemUserId ?? identity.id ?? null;
  const callerId = identity.dataverse?.callerId ?? null;
  return {
    userid: ref('systemuser', userId),
    callinguserid: callerId && lower(callerId) !== lower(userId) ? ref('systemuser', callerId) : null,
  };
}

function appendEntries(api, entries) {
  const { store } = api;
  api.change(() => {
    for (const { row, detail } of entries) {
      rowsOf(store).push(row);
      if (detail) detailsOf(store)[row.auditid] = detail;
    }
  });
}

function auditRow(api, { entity, id, operation, action, mask = null, identity, transactionId }) {
  return {
    auditid: randomUUID(),
    operation,
    action,
    objectid: ref(entity, id),
    objecttypecode: entity,
    attributemask: mask,
    ...actorFields(identity),
    createdon: new Date(api.clock()).toISOString(),
    transactionid: transactionId ?? randomUUID(),
  };
}

// Committed events: one audit row per changed record. Updates without an audited change write nothing.
function eventEntries(api, event, transactionId) {
  const mapping = api.store.state.mappings[event.entity];
  if (!mapping || !auditable(api, mapping) || !OPERATION[event.operation]) return [];
  const audited = auditedColumns(mapping);
  const changed = event.operation === 'create'
    ? audited.filter((column) => plain(event.row[column]) !== null)
    : event.operation === 'update' ? audited.filter((column) => !same(event.previous?.[column], event.row[column])) : [];
  if (event.operation === 'update' && changed.length === 0) return [];
  // unverified: create rows list every non-null audited column in attributemask.
  const action = event.operation === 'delete' ? ACTION.delete
    : event.operation === 'create' ? ACTION.create
      : changed.includes('ownerid') ? ACTION.assign
        : changed.includes('statecode') ? ACTION.setState : ACTION.update;
  const row = auditRow(api, {
    entity: event.entity, id: event.row[mapping.idColumn], operation: OPERATION[event.operation], action,
    mask: changed.length ? changed.map((column) => columnNumber(mapping, column)).join(',') : null,
    identity: event.identity, transactionId,
  });
  if (event.operation === 'delete') return [{ row, detail: null }];
  return [{
    row,
    detail: {
      oldValue: event.operation === 'update' ? pick(event.previous, changed) : null,
      newValue: pick(event.row, changed),
    },
  }];
}

function onCommitted(api, events, sequence) {
  const transactionId = uuidV5(organizationOf(api.store).organizationid ?? ZERO_GUID, `transaction:${sequence ?? 0}`);
  const entries = events.flatMap((event) => eventEntries(api, event, transactionId));
  if (entries.length) appendEntries(api, entries);
}

// N:N association writes are not committed events, so the record hook writes them.
function afterWrite(api, c, mapping, { operation, id, relationship }) {
  const action = operation === 'associate' ? ACTION.associate : operation === 'disassociate' ? ACTION.disassociate : null;
  if (!action || !auditable(api, mapping)) return;
  // unverified: Operation recorded for an association (Update assumed).
  const row = auditRow(api, { entity: mapping.logicalName, id, operation: OPERATION.update, action, identity: c.identity });
  appendEntries(api, [{ row, detail: { relationship: relationship ?? null } }]);
}

// Read-only table: any create, update or delete through the Web API is refused.
function beforeWrite(c, mapping) {
  if (mapping.logicalName === 'audit') {
    throw new DataError(`The requested resource does not support http method '${c.method}'.`, 405, 'MethodNotAllowed', { innerCode: '' });
  }
}

// unverified: element-level shape of OldValue/NewValue lookups (annotations below) is from the docs summary.
function entityValues(mapping, values) {
  const out = {};
  for (const [column, value] of Object.entries(values)) {
    if (!isLookup(mapping, column)) {
      out[column] = value;
      continue;
    }
    const id = plain(value);
    out[`_${column}_value`] = id;
    if (id !== null) {
      out[`_${column}_value@Microsoft.Dynamics.CRM.lookuplogicalname`] = value.logical_name ?? null;
      out[`_${column}_value@Microsoft.Dynamics.CRM.associatednavigationproperty`] = column;
    }
  }
  return out;
}

function attributeDetail(store, mapping, detail) {
  return {
    '@odata.type': ATTRIBUTE_DETAIL,
    InvalidNewValueAttributes: [],
    LocLabelLanguageCode: 0,
    DeletedAttributes: { Count: 0, Keys: [], Values: [] }, // unverified: populated only for deleted attributes
    OldValue: detail.oldValue ? { '@odata.type': `#Microsoft.Dynamics.CRM.${mapping.logicalName}`, ...entityValues(mapping, detail.oldValue) } : null,
    NewValue: detail.newValue ? { '@odata.type': `#Microsoft.Dynamics.CRM.${mapping.logicalName}`, ...entityValues(mapping, detail.newValue) } : null,
  };
}

function detailOf(store, row) {
  const stored = detailsOf(store)[row.auditid];
  if (row.action === ACTION.associate || row.action === ACTION.disassociate) {
    return { '@odata.type': RELATIONSHIP_DETAIL, RelationshipName: stored?.relationship ?? null };
  }
  if (!stored) return { '@odata.type': BASE_DETAIL };
  return attributeDetail(store, store.state.mappings[row.objecttypecode], stored);
}

// Target is an entity reference: { '@odata.id': 'widgets(<guid>)' } or the same string.
// unverified: how the router delivers Target (alias object or string) and the body of the bound action.
function targetOf(store, value) {
  const text = typeof value === 'string' ? value : value?.['@odata.id'];
  const match = /^([^(]+)\((.+)\)$/.exec(String(text ?? ''));
  const mapping = match && Object.values(store.state.mappings).find((m) => m.entitySet === match[1]);
  if (!mapping) throw new DataError('Target must be an entity reference.', 400, 'InvalidRequest');
  return { mapping, id: match[2] };
}

// unverified: newest-first ordering of the history collection.
const historyOf = (store, entity, id) => rowsOf(store)
  .filter((row) => row.objecttypecode === entity && lower(plain(row.objectid)) === lower(id))
  .reverse()
  .sort((a, b) => b.createdon.localeCompare(a.createdon)); // newest first; ties keep the newer insertion first

// PagingCookie is opaque to callers: a base64url-encoded offset.
const cookieOf = (offset) => Buffer.from(JSON.stringify({ offset })).toString('base64url');
function offsetOf(info, count) {
  if (!info.PagingCookie) return Math.max(0, ((Number(info.PageNumber) || 1) - 1) * count);
  try {
    return JSON.parse(Buffer.from(String(info.PagingCookie), 'base64url').toString()).offset;
  } catch {
    throw new DataError('PagingCookie is not valid.', 400, 'InvalidRequest');
  }
}

function pageOf(store, params, rows, render) {
  const info = params?.PagingInfo ?? {};
  const count = Number(info.Count) > 0 ? Number(info.Count) : DEFAULT_COUNT;
  const offset = offsetOf(info, count);
  const more = offset + count < rows.length;
  return {
    MoreRecords: more,
    PagingCookie: more ? cookieOf(offset + count) : null,
    TotalRecordCount: rows.length,
    AuditDetails: rows.slice(offset, offset + count).map((row) => render(store, row)),
  };
}

function requirePrivileges(api, user, names, entity) {
  const grants = api.principals.privileges(user);
  const missing = names.find((name) => !(grants.get(name) > 0));
  if (missing) throw privilegeDeniedError(user, missing, entity);
}

function operations(api) {
  const { store } = api;
  return [
    {
      name: 'RetrieveRecordChangeHistory', kind: 'function', binding: 'unbound',
      handle: async (c) => {
        const target = targetOf(store, c.params?.Target);
        requirePrivileges(api, c.user, READ_PRIVILEGES, target.mapping.logicalName);
        const rows = historyOf(store, target.mapping.logicalName, target.id);
        return { status: 200, body: { AuditDetailCollection: pageOf(store, c.params, rows, detailOf) } };
      },
    },
    {
      name: 'RetrieveAttributeChangeHistory', kind: 'function', binding: 'unbound',
      handle: async (c) => {
        const target = targetOf(store, c.params?.Target);
        const entity = target.mapping.logicalName, attribute = c.params?.AttributeLogicalName;
        requirePrivileges(api, c.user, READ_PRIVILEGES, entity);
        if (!target.mapping.fields[attribute]) throw new DataError(`${attribute} is not a valid attribute of ${entity}.`, 400, 'InvalidRequest');
        const number = String(columnNumber(target.mapping, attribute));
        const rows = historyOf(store, entity, target.id).filter((row) => row.attributemask?.split(',').includes(number));
        return { status: 200, body: { AuditDetailCollection: pageOf(store, c.params, rows, detailOf) } };
      },
    },
    {
      name: 'RetrieveAuditDetails', kind: 'function', binding: 'entity', entity: 'audit',
      handle: async (c) => {
        requirePrivileges(api, c.user, READ_PRIVILEGES, 'audit');
        return { status: 200, body: { AuditDetail: detailOf(store, c.target.row) } };
      },
    },
    {
      name: 'DeleteRecordChangeHistory', kind: 'action', binding: 'unbound',
      handle: async (c) => {
        const body = typeof c.body === 'string' ? JSON.parse(c.body || '{}') : (c.body ?? {});
        const target = targetOf(store, body.Target);
        requirePrivileges(api, c.user, [DELETE_PRIVILEGE], target.mapping.logicalName);
        const deleted = await api.change(() => {
          const rows = rowsOf(store), details = detailsOf(store);
          let count = 0;
          for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            if (row.objecttypecode !== target.mapping.logicalName || lower(plain(row.objectid)) !== lower(target.id)) continue;
            delete details[row.auditid];
            rows.splice(i, 1);
            count++;
          }
          return count;
        });
        return { status: 200, body: { DeletedEntriesCount: deleted } };
      },
    },
  ];
}

export function install(api) {
  const { store } = api;
  store.state.mappings.audit ??= structuredClone(AUDIT_MAPPING);
  store.state.tables.audit ??= [];
  store.addCommittedEvents((events, { sequence } = {}) => onCommitted(api, events, sequence));
  api.recordHooks.add('beforeWrite', beforeWrite);
  api.recordHooks.add('afterWrite', (c, mapping, info) => afterWrite(api, c, mapping, info));
  for (const op of operations(api)) api.registry.register(op);
}
