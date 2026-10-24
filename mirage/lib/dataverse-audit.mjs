import { organizationRecord } from './organization-context.mjs';
// Simulated Dataverse auditing: the read-only audit table, enablement from the organization,
// table and column flags, the change history functions, the audit-only delete action, and the writers
// other modules call: writeAudit (shares, role privileges and role assignments) and recordUserAccess.
// Writes come from the store's committed events (portal and /_sim/ writes too) and from the
// afterWrite hook for N:N association.
import { systemIds } from './runtime-clock.mjs';
import { DataError } from './data-error.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { privilegeDeniedError, uuidV5 } from './dataverse-security.mjs';

// Enums from the Auditing (Audit) table reference: Operation 1-5 and the Action option set (0-125).
const OPERATION = { create: 1, update: 2, delete: 3, access: 4 };
const ACTION = {
  create: 1,
  update: 2,
  delete: 3,
  assign: 13,
  share: 14,
  setState: 41,
  associate: 33,
  disassociate: 34,
  assignRoleToTeam: 53,
  removeRoleFromTeam: 54,
  assignRoleToUser: 55,
  removeRoleFromUser: 56,
  addPrivilegesToRole: 57,
  removePrivilegesFromRole: 58,
  replacePrivilegesInRole: 59,
  modifyShare: 48,
  unshare: 49,
  userAccessWeb: 64,
  userAccessWebServices: 65,
};
export const AUDIT_ACTION = ACTION;
const ATTRIBUTE_DETAIL = '#Microsoft.Dynamics.CRM.AttributeAuditDetail';
const RELATIONSHIP_DETAIL = '#Microsoft.Dynamics.CRM.RelationshipAuditDetail';
const BASE_DETAIL = '#Microsoft.Dynamics.CRM.AuditDetail';
const READ_PRIVILEGES = ['prvReadRecordAuditHistory', 'prvReadAuditSummary'];
const DELETE_PRIVILEGE = 'prvDeleteRecordChangeHistory';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_COUNT = 5000; // Default page size of paged queries.
const DEFAULT_INTERVAL_HOURS = 4; // Organization.UserAccessAuditingInterval default.

const AUDIT_MAPPING = {
  logicalName: 'audit',
  entitySet: 'audits',
  idColumn: 'auditid',
  userConfigured: true,
  // Seeded by the simulated Dataverse API (not from the Solution); the portal sees it under its site settings and table permissions.
  dataverseOnly: true,
  fields: {
    auditid: { dataverseType: 'uniqueidentifier' },
    operation: { dataverseType: 'int' },
    action: { dataverseType: 'int' },
    objectid: { dataverseType: 'lookup' },
    objecttypecode: { dataverseType: 'nvarchar' },
    attributemask: { dataverseType: 'nvarchar' },
    userid: { dataverseType: 'lookup' },
    callinguserid: { dataverseType: 'lookup' },
    createdon: { dataverseType: 'datetime' },
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
const organizationOf = (store) => organizationRecord(store) ?? {};
const schemaOf = (api) => (typeof api.schema === 'function' ? api.schema() : api.schema);

// Organization.IsAuditEnabled gates everything; a table and its columns are audited when their flags say so.
const auditingOn = (store) => flag(organizationOf(store).isauditenabled);
function tableAudited(api, mapping) {
  const table = schemaOf(api)?.tables?.[mapping.logicalName];
  return flag(mapping.dataverseMetadata?.IsAuditEnabled ?? table?.isAuditEnabled);
}
// The flag comes from dataverseMetadata, columnMetadata or the field itself; absent everywhere means audited.
function columnAudited(mapping, column) {
  const field = mapping.fields[column];
  const declared =
    field.dataverseMetadata?.IsAuditEnabled ?? field.columnMetadata?.isAuditEnabled ?? field.IsAuditEnabled;
  return declared === undefined ? true : flag(declared);
}
const auditable = (api, mapping) =>
  mapping.logicalName !== 'audit' && auditingOn(api.store) && tableAudited(api, mapping);
const auditedColumns = (mapping) => Object.keys(mapping.fields).filter((column) => columnAudited(mapping, column));
// ColumnNumber is not in the exports; the field's position in the mapping stands in for it.
const columnNumber = (mapping, column) => Object.keys(mapping.fields).indexOf(column) + 1;
const isLookup = (mapping, column) => mapping.fields[column]?.dataverseType === 'lookup';
const pick = (values, columns) => Object.fromEntries(columns.map((column) => [column, values?.[column] ?? null]));

// Audit rows carry the calling user only when impersonation is used (identity.dataverse.callerId differs).
// An identity without a systemuser id (a portal contact, for one) is audited as the SYSTEM user.
function actorFields(store, identity = {}) {
  const userId =
    identity.systemUserId ?? uuidV5(organizationOf(store).organizationid ?? ZERO_GUID, 'systemuser:SYSTEM');
  const callerId = identity.dataverse?.callerId ?? null;
  return {
    userid: ref('systemuser', userId),
    callinguserid: callerId && lower(callerId) !== lower(userId) ? ref('systemuser', callerId) : null,
  };
}

// Rows land in store.transact: a write that rolls back takes its audit rows with it. nested joins the write's own
// transaction (the afterWrite path); otherwise the rows queue behind the transaction that committed.
function writeEntries(store, entries, { nested = false } = {}) {
  return store.transact(
    () => {
      for (const { row, detail } of entries) {
        store.insertRow('audit', rowsOf(store), row);
        if (detail) detailsOf(store)[row.auditid] = detail;
      }
    },
    { nested },
  );
}

// Fire-and-forget from committed events: a failed audit write is logged and never reaches the caller.
async function appendLater(api, entries) {
  try {
    await api.change(() => writeEntries(api.store, entries));
  } catch (error) {
    api.log?.(error);
  }
}

function auditRow(api, { entity, id, operation, action, mask = null, identity, transactionId }) {
  return {
    auditid: (api.ids ?? systemIds).uuid(),
    operation,
    action,
    objectid: ref(entity, id),
    objecttypecode: entity,
    attributemask: mask,
    ...actorFields(api.store, identity),
    createdon: new Date(api.clock()).toISOString(),
    transactionid: transactionId ?? (api.ids ?? systemIds).uuid(),
  };
}

// Committed events: one audit row per changed record. Updates without an audited change write nothing.
function eventEntries(api, event, transactionId) {
  const mapping = api.store.state.mappings[event.entity];
  if (!mapping || !auditable(api, mapping) || !OPERATION[event.operation]) return [];
  const audited = auditedColumns(mapping);
  // Assumption: create rows list every non-null audited column in attributemask.
  const changed =
    event.operation === 'create'
      ? audited.filter((column) => plain(event.row[column]) !== null)
      : event.operation === 'update'
        ? audited.filter((column) => !same(event.previous?.[column], event.row[column]))
        : [];
  if (event.operation === 'update' && changed.length === 0) return [];
  const action =
    event.operation === 'delete'
      ? ACTION.delete
      : event.operation === 'create'
        ? ACTION.create
        : changed.includes('ownerid')
          ? ACTION.assign
          : changed.includes('statecode')
            ? ACTION.setState
            : ACTION.update;
  const row = auditRow(api, {
    entity: event.entity,
    id: event.row[mapping.idColumn],
    operation: OPERATION[event.operation],
    action,
    mask: changed.length ? changed.map((column) => columnNumber(mapping, column)).join(',') : null,
    identity: event.identity,
    transactionId,
  });
  if (event.operation === 'delete') return [{ row, detail: null }];
  return [
    {
      row,
      detail: {
        oldValue: event.operation === 'update' ? pick(event.previous, changed) : null,
        newValue: pick(event.row, changed),
      },
    },
  ];
}

// One transaction id per committed change set (a fresh id each time, so restarts cannot collide).
function onCommitted(api, events) {
  const transactionId = (api.ids ?? systemIds).uuid();
  const entries = events.flatMap((event) => eventEntries(api, event, transactionId));
  if (entries.length) appendLater(api, entries);
}

// N:N association writes are not committed events, so the record hook writes them inside the write's transaction.
// A failure is logged, never thrown: auditing must not break the write.
async function afterWrite(api, c, mapping, { operation, id, relationship }) {
  try {
    const action =
      operation === 'associate' ? ACTION.associate : operation === 'disassociate' ? ACTION.disassociate : null;
    if (!action || !auditable(api, mapping)) return;
    // Assumption: an association is recorded as Operation Update.
    const row = auditRow(api, {
      entity: mapping.logicalName,
      id,
      operation: OPERATION.update,
      action,
      identity: c.identity,
    });
    await writeEntries(api.store, [{ row, detail: { relationship: relationship ?? null } }], { nested: true });
  } catch (error) {
    api.log?.(error);
  }
}

// Writer for the modules that change shares, role privileges or role assignments. Rows join the caller's open
// transaction (nested), as afterWrite does, and a failure is logged, never thrown.
// Assumption: share and role changes are recorded as Operation Update (the reference does not say).
export async function writeAudit(
  api,
  { entity, id, action, operation = OPERATION.update, mask = null, identity, detail = null },
) {
  try {
    const mapping = api.store.state.mappings[entity];
    if (!mapping || !auditable(api, mapping)) return;
    const row = auditRow(api, { entity, id, operation, action, mask, identity });
    await writeEntries(api.store, [{ row, detail }], { nested: true });
  } catch (error) {
    api.log?.(error);
  }
}

// User access auditing: Organization.IsUserAccessAuditEnabled (with IsAuditEnabled) writes an Access row per user and
// channel at most once per UserAccessAuditingInterval hours. channel: 'web' (64) or 'webServices' (65).
// Assumption: the object of a user access row is the user's systemuser record (the reference does not say).
const lastAccess = new WeakMap();
export async function recordUserAccess(api, identity = {}, channel = 'web') {
  const org = organizationOf(api.store);
  if (!auditingOn(api.store) || !flag(org.isuseraccessauditenabled)) return false;
  const userId = plain(actorFields(api.store, identity).userid);
  const key = `${channel}:${lower(userId)}`;
  const log = lastAccess.get(api.store) ?? new Map();
  lastAccess.set(api.store, log);
  const now = api.clock();
  const interval = Number(org.useraccessauditinginterval ?? DEFAULT_INTERVAL_HOURS) * 3600000;
  if (log.has(key) && now - log.get(key) < interval) return false;
  log.set(key, now);
  try {
    const action = channel === 'webServices' ? ACTION.userAccessWebServices : ACTION.userAccessWeb;
    const row = auditRow(api, { entity: 'systemuser', id: userId, operation: OPERATION.access, action, identity });
    await writeEntries(api.store, [{ row, detail: null }]);
    return true;
  } catch (error) {
    api.log?.(error);
    return false;
  }
}

// Read-only table: any create, update or delete through the Web API is refused.
function beforeWrite(c, mapping) {
  if (mapping.logicalName === 'audit') {
    throw new DataError(`The requested resource does not support http method '${c.method}'.`, 405, 'MethodNotAllowed', {
      innerCode: '',
    });
  }
}

// Assumption: the lookup annotations in OldValue/NewValue follow the documented summary, not a live capture.
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

// Secured columns (api.fieldSecurity, from the FLS extension) read as null in audit values, as the platform masks them, and a
// readable one with a masking rule reads masked, as the native audit log shows masked before and after values.
// Every audited column stays present, so a hidden value is null rather than missing.
function visibleValues(api, user, mapping, objectId, values) {
  if (!values || !api.fieldSecurity?.mask) return values;
  const masked =
    api.fieldSecurity.mask(
      user,
      mapping.logicalName,
      { [mapping.idColumn]: objectId, ...values },
      { view: { unmask: false, single: false } },
    ) ?? {};
  return Object.fromEntries(Object.keys(values).map((column) => [column, masked[column] ?? null]));
}

function attributeDetail(api, user, mapping, detail, objectId) {
  const oldValues = visibleValues(api, user, mapping, objectId, detail.oldValue);
  const newValues = visibleValues(api, user, mapping, objectId, detail.newValue);
  return {
    '@odata.type': ATTRIBUTE_DETAIL,
    InvalidNewValueAttributes: [],
    LocLabelLanguageCode: 0,
    DeletedAttributes: { Count: 0, Keys: [], Values: [] }, // assumed populated only for deleted attributes
    OldValue: oldValues
      ? { '@odata.type': `#Microsoft.Dynamics.CRM.${mapping.logicalName}`, ...entityValues(mapping, oldValues) }
      : null,
    NewValue: newValues
      ? { '@odata.type': `#Microsoft.Dynamics.CRM.${mapping.logicalName}`, ...entityValues(mapping, newValues) }
      : null,
  };
}

function detailOf(api, user, row) {
  const stored = detailsOf(api.store)[row.auditid];
  if (row.action === ACTION.associate || row.action === ACTION.disassociate) {
    return { '@odata.type': RELATIONSHIP_DETAIL, RelationshipName: stored?.relationship ?? null };
  }
  if (!stored) return { '@odata.type': BASE_DETAIL };
  const mapping = api.store.state.mappings[row.objecttypecode];
  return attributeDetail(api, user, mapping, stored, plain(row.objectid));
}

// Target is an entity reference: { '@odata.id': 'widgets(<guid>)' } or the same string.
// Both forms are accepted because the router's delivery of Target (alias object or string) is not pinned down.
function targetOf(store, value) {
  const text = typeof value === 'string' ? value : value?.['@odata.id'];
  const match = /^([^(]+)\((.+)\)$/.exec(String(text ?? ''));
  const mapping = match && Object.values(store.state.mappings).find((m) => m.entitySet === match[1]);
  if (!mapping) throw new DataError('Target must be an entity reference.', 400, 'InvalidRequest');
  return { mapping, id: match[2] };
}

// Assumption: the history collection is ordered newest first.
const historyOf = (store, entity, id) =>
  rowsOf(store)
    .filter((row) => row.objecttypecode === entity && lower(plain(row.objectid)) === lower(id))
    .reverse()
    .sort((a, b) => b.createdon.localeCompare(a.createdon)); // newest first; ties keep the newer insertion first

// Record-level read on the target row, as the platform checks it. A row that no longer exists leaves only the
// entity-level privilege check, since its history stays readable.
function authorizeTarget(api, user, target) {
  const { mapping, id } = target;
  const row = api.store.tableRows(mapping.logicalName).find((r) => lower(r[mapping.idColumn]) === lower(id));
  if (row) api.principals.authorize({ user, entity: mapping.logicalName, operation: 'read', row, mapping });
}

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

function pageOf(params, rows, render) {
  const info = params?.PagingInfo ?? {};
  const count = Number(info.Count) > 0 ? Number(info.Count) : DEFAULT_COUNT;
  const offset = offsetOf(info, count);
  const more = offset + count < rows.length;
  // Native: with no further page the cookie is an empty string, and the total is -1 unless the
  // request sets PagingInfo.ReturnTotalRecordCount.
  return {
    MoreRecords: more,
    PagingCookie: more ? cookieOf(offset + count) : '',
    TotalRecordCount: info.ReturnTotalRecordCount === true ? rows.length : -1,
    AuditDetails: rows.slice(offset, offset + count).map(render),
  };
}

function requirePrivileges(api, user, names, entity) {
  const grants = api.principals.privileges(user);
  const missing = names.find((name) => !(grants.get(name) > 0));
  if (missing) throw privilegeDeniedError(user, missing, entity);
}

// CSDL. The shared complex types are emitted once, by the first fragment that needs them (RetrieveRecordChangeHistory).
// PagingInfo is also used by dataverse-duplicates.mjs (RetrieveDuplicates), which relies on this fragment.
const CSDL_RECORD_HISTORY = `<ComplexType Name="PagingInfo">
  <Property Name="Count" Type="Edm.Int32" />
  <Property Name="PageNumber" Type="Edm.Int32" />
  <Property Name="PagingCookie" Type="Edm.String" />
  <Property Name="ReturnRecordCountLessThanMarv" Type="Edm.Boolean" />
  <Property Name="ReturnTotalRecordCount" Type="Edm.Boolean" />
</ComplexType>
<ComplexType Name="Collection_Int32_String">
  <Property Name="Count" Type="Edm.Int32" />
  <Property Name="Keys" Type="Collection(Edm.Int32)" />
  <Property Name="Values" Type="Collection(Edm.String)" />
</ComplexType>
<ComplexType Name="AuditDetail">
  <NavigationProperty Name="AuditRecord" Type="mscrm.crmbaseentity" Nullable="false" />
</ComplexType>
<ComplexType Name="AttributeAuditDetail" BaseType="mscrm.AuditDetail">
  <Property Name="DeletedAttributes" Type="mscrm.Collection_Int32_String" />
  <Property Name="InvalidNewValueAttributes" Type="Collection(Edm.String)" />
  <Property Name="LocLabelLanguageCode" Type="Edm.Int32" />
  <NavigationProperty Name="NewValue" Type="mscrm.crmbaseentity" Nullable="false" />
  <NavigationProperty Name="OldValue" Type="mscrm.crmbaseentity" Nullable="false" />
</ComplexType>
<ComplexType Name="RelationshipAuditDetail" BaseType="mscrm.AuditDetail">
  <Property Name="RelationshipName" Type="Edm.String" />
  <NavigationProperty Name="TargetRecords" Type="Collection(mscrm.crmbaseentity)" />
</ComplexType>
<ComplexType Name="AuditDetailCollection">
  <Property Name="AuditDetails" Type="Collection(mscrm.AuditDetail)" />
  <Property Name="MoreRecords" Type="Edm.Boolean" />
  <Property Name="PagingCookie" Type="Edm.String" />
  <Property Name="TotalRecordCount" Type="Edm.Int32" />
</ComplexType>
<ComplexType Name="RetrieveRecordChangeHistoryResponse">
  <Property Name="AuditDetailCollection" Type="mscrm.AuditDetailCollection" />
</ComplexType>
<Function Name="RetrieveRecordChangeHistory">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="PagingInfo" Type="mscrm.PagingInfo" />
  <ReturnType Type="mscrm.RetrieveRecordChangeHistoryResponse" Nullable="false" />
</Function>`;
const CSDL_ATTRIBUTE_HISTORY = `<ComplexType Name="RetrieveAttributeChangeHistoryResponse">
  <Property Name="AuditDetailCollection" Type="mscrm.AuditDetailCollection" />
</ComplexType>
<Function Name="RetrieveAttributeChangeHistory">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="AttributeLogicalName" Type="Edm.String" Nullable="false" />
  <Parameter Name="PagingInfo" Type="mscrm.PagingInfo" />
  <ReturnType Type="mscrm.RetrieveAttributeChangeHistoryResponse" Nullable="false" />
</Function>`;
const CSDL_AUDIT_DETAILS = `<ComplexType Name="RetrieveAuditDetailsResponse">
  <Property Name="AuditDetail" Type="mscrm.AuditDetail" />
</ComplexType>
<Function Name="RetrieveAuditDetails" IsBound="true">
  <Parameter Name="entity" Type="mscrm.audit" Nullable="false" />
  <ReturnType Type="mscrm.RetrieveAuditDetailsResponse" Nullable="false" />
</Function>`;
const CSDL_DELETE_HISTORY = `<ComplexType Name="DeleteRecordChangeHistoryResponse">
  <Property Name="DeletedEntriesCount" Type="Edm.Int32" />
</ComplexType>
<Action Name="DeleteRecordChangeHistory">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <ReturnType Type="mscrm.DeleteRecordChangeHistoryResponse" Nullable="false" />
</Action>`;

// Assumption: the response type names below are not captured from a live $metadata.
const CSDL_DELETE_AUDIT = `<ComplexType Name="DeleteAuditDataResponse" />
<Action Name="DeleteAuditData">
  <Parameter Name="EndDate" Type="Edm.DateTimeOffset" Nullable="false" />
  <ReturnType Type="mscrm.DeleteAuditDataResponse" Nullable="false" />
</Action>`;
const CSDL_STORAGE = `<ComplexType Name="AuditStorageDetailsValue">
  <Property Name="SizeInBytes" Type="Edm.Int64" />
  <Property Name="ObjectTypeCode" Type="Edm.Int32" />
</ComplexType>
<ComplexType Name="AuditStorageDetails">
  <Property Name="Count" Type="Edm.Int32" />
  <Property Name="Keys" Type="Collection(Edm.String)" />
  <Property Name="Values" Type="Collection(mscrm.AuditStorageDetailsValue)" />
</ComplexType>
<ComplexType Name="GetAuditStorageDetailsResult">
  <Property Name="Status" Type="Edm.String" />
  <Property Name="AuditStorageDetails" Type="mscrm.AuditStorageDetails" />
</ComplexType>
<ComplexType Name="GetAuditStorageDetailsResponse">
  <Property Name="Result" Type="mscrm.GetAuditStorageDetailsResult" />
</ComplexType>
<Action Name="GetAuditStorageDetails">
  <ReturnType Type="mscrm.GetAuditStorageDetailsResponse" Nullable="false" />
</Action>`;
// Shape from the native $metadata (AuditPartitionDetail, four members); the SDK's response member is AuditPartitionDetailCollection.
const CSDL_PARTITIONS = `<ComplexType Name="AuditPartitionDetail">
  <Property Name="PartitionNumber" Type="Edm.Int32" />
  <Property Name="StartDate" Type="Edm.DateTimeOffset" />
  <Property Name="EndDate" Type="Edm.DateTimeOffset" />
  <Property Name="Size" Type="Edm.Int64" />
</ComplexType>
<ComplexType Name="RetrieveAuditPartitionListResponse">
  <Property Name="AuditPartitionDetailCollection" Type="Collection(mscrm.AuditPartitionDetail)" />
</ComplexType>
<Function Name="RetrieveAuditPartitionList">
  <ReturnType Type="mscrm.RetrieveAuditPartitionListResponse" Nullable="false" />
</Function>`;
// The privilege DeleteAuditData checks is not documented; the catalogue's audit delete privilege is a guess.
const DELETE_AUDIT_PRIVILEGE = 'prvDeleteRecordChangeHistory';

function operations(api) {
  const { store } = api;
  return [
    {
      name: 'RetrieveRecordChangeHistory',
      kind: 'function',
      binding: 'unbound',
      csdl: CSDL_RECORD_HISTORY,
      handle: async (c) => {
        const target = targetOf(store, c.params?.Target);
        requirePrivileges(api, c.user, READ_PRIVILEGES, target.mapping.logicalName);
        authorizeTarget(api, c.user, target);
        const rows = historyOf(store, target.mapping.logicalName, target.id);
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(
              c.origin,
              c.version,
              'Microsoft.Dynamics.CRM.RetrieveRecordChangeHistoryResponse',
            ),
            AuditDetailCollection: pageOf(c.params, rows, (row) => detailOf(api, c.user, row)),
          },
        };
      },
    },
    {
      name: 'RetrieveAttributeChangeHistory',
      kind: 'function',
      binding: 'unbound',
      csdl: CSDL_ATTRIBUTE_HISTORY,
      handle: async (c) => {
        const target = targetOf(store, c.params?.Target);
        const entity = target.mapping.logicalName,
          attribute = c.params?.AttributeLogicalName;
        requirePrivileges(api, c.user, READ_PRIVILEGES, entity);
        authorizeTarget(api, c.user, target);
        if (!target.mapping.fields[attribute])
          throw new DataError(`${attribute} is not a valid attribute of ${entity}.`, 400, 'InvalidRequest');
        const number = String(columnNumber(target.mapping, attribute));
        const rows = historyOf(store, entity, target.id).filter((row) =>
          row.attributemask?.split(',').includes(number),
        );
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(
              c.origin,
              c.version,
              'Microsoft.Dynamics.CRM.RetrieveAttributeChangeHistoryResponse',
            ),
            AuditDetailCollection: pageOf(c.params, rows, (row) => detailOf(api, c.user, row)),
          },
        };
      },
    },
    {
      name: 'RetrieveAuditDetails',
      kind: 'function',
      binding: 'entity',
      entity: 'audit',
      csdl: CSDL_AUDIT_DETAILS,
      handle: async (c) => {
        requirePrivileges(api, c.user, READ_PRIVILEGES, 'audit');
        return { status: 200, body: { AuditDetail: detailOf(api, c.user, c.target.row) } };
      },
    },
    {
      name: 'DeleteRecordChangeHistory',
      kind: 'action',
      binding: 'unbound',
      csdl: CSDL_DELETE_HISTORY,
      handle: async (c) => {
        const body = typeof c.body === 'string' ? JSON.parse(c.body || '{}') : (c.body ?? {});
        const target = targetOf(store, body.Target);
        requirePrivileges(api, c.user, [DELETE_PRIVILEGE], target.mapping.logicalName);
        const deleted = await api.change(() =>
          store.transact(() => {
            const rows = rowsOf(store),
              details = detailsOf(store);
            let count = 0;
            for (let i = rows.length - 1; i >= 0; i--) {
              const row = rows[i];
              if (row.objecttypecode !== target.mapping.logicalName || lower(plain(row.objectid)) !== lower(target.id))
                continue;
              delete details[row.auditid];
              rows.splice(i, 1);
              count++;
            }
            return count;
          }),
        );
        return { status: 200, body: { DeletedEntriesCount: deleted } };
      },
    },
    {
      name: 'DeleteAuditData',
      kind: 'action',
      binding: 'unbound',
      csdl: CSDL_DELETE_AUDIT,
      handle: async (c) => {
        requirePrivileges(api, c.user, [DELETE_AUDIT_PRIVILEGE], 'audit');
        const body = typeof c.body === 'string' ? JSON.parse(c.body || '{}') : (c.body ?? {});
        const end = Date.parse(body.EndDate);
        if (body.EndDate == null || !Number.isFinite(end))
          throw new DataError('EndDate is required and must be a date and time.', 400, 'InvalidRequest'); // native message text not known
        await api.change(() =>
          store.transact(
            () => {
              const rows = rowsOf(store),
                details = detailsOf(store);
              for (let i = rows.length - 1; i >= 0; i--) {
                if (!(Date.parse(rows[i].createdon) < end)) continue;
                delete details[rows[i].auditid];
                rows.splice(i, 1);
              }
            },
            { isolated: true },
          ),
        );
        return {
          status: 200,
          body: { '@odata.context': contextUrl(c.origin, c.version, 'Microsoft.Dynamics.CRM.DeleteAuditDataResponse') },
        };
      },
    },
    {
      name: 'GetAuditStorageDetails',
      kind: 'action',
      binding: 'unbound',
      csdl: CSDL_STORAGE,
      handle: async (c) => {
        requirePrivileges(api, c.user, READ_PRIVILEGES, 'audit');
        // Synthetic facts: the JSON length of each audit row, grouped by the table it audits.
        const sizes = new Map([['organization', 0]]);
        for (const row of rowsOf(store)) {
          const key = row.objecttypecode ?? 'organization';
          sizes.set(key, (sizes.get(key) ?? 0) + JSON.stringify(row).length);
        }
        const keys = [...sizes.keys()];
        // The answer is Completed at once: Mirage has no pending calculation. The Result wrapper follows the documented example.
        const details = {
          Count: keys.length,
          Keys: keys,
          Values: keys.map((key) => ({ SizeInBytes: sizes.get(key), ObjectTypeCode: 0 })),
        }; // ObjectTypeCode 0 is a placeholder
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(c.origin, c.version, 'Microsoft.Dynamics.CRM.GetAuditStorageDetailsResponse'),
            Result: { Status: 'Completed', AuditStorageDetails: details },
          },
        };
      },
    },
    {
      name: 'RetrieveAuditPartitionList',
      kind: 'function',
      binding: 'unbound',
      csdl: CSDL_PARTITIONS,
      handle: async (c) => {
        requirePrivileges(api, c.user, READ_PRIVILEGES, 'audit');
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(
              c.origin,
              c.version,
              'Microsoft.Dynamics.CRM.RetrieveAuditPartitionListResponse',
            ),
            AuditPartitionDetailCollection: [{ PartitionNumber: 1, StartDate: null, EndDate: null, Size: 0 }],
          },
        }; // one synthetic partition; its dates and size are placeholders
      },
    },
  ];
}

// Install and reset share the seed. Insert-only: an existing audit mapping or table is kept.
function seed(store) {
  store.state.mappings.audit ??= structuredClone(AUDIT_MAPPING);
  store.state.tables.audit ??= [];
}

// reset runs on every reseed (/_sim/ reset, state import) inside the change queue, so it writes through the store only.
// The user-access throttle is in-memory: a reset starts it afresh.
export function reset(api) {
  lastAccess.delete(api.store);
  return api.store.transact(() => seed(api.store));
}

export function install(api) {
  const { store } = api;
  seed(store);
  store.addCommittedEvents((events) => onCommitted(api, events));
  api.recordHooks.add('beforeWrite', beforeWrite);
  api.recordHooks.add('afterWrite', (c, mapping, info) => afterWrite(api, c, mapping, info));
  for (const op of operations(api)) api.registry.register(op);
}
