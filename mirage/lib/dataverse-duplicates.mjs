// Simulated Dataverse duplicate detection: duplicate rules (duplicaterule and duplicaterulecondition
// tables), the create and update check gated by MSCRM.SuppressDuplicateDetection, and the
// PublishDuplicateRule, UnpublishDuplicateRule and RetrieveDuplicates operations. Invented schema only.
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError } from './data-error.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { uuidV5 } from './dataverse-security.mjs';
import { BULK_DUPLICATE_TYPE } from './dataverse-async.mjs';
import { childText, parseSolutionXml } from './solution-xml.mjs';
import { pluralizeEntitySetName } from './solution-standard.mjs';

const ACTIVE = 1; // statecode Active
const PUBLISHED = 2; // statuscode Published; its statecode is Active (1)
// unverified: the limit of five published rules per table comes from the task brief, not from the docs read.
const MAX_PUBLISHED_PER_TABLE = 5;
const DEFAULT_PAGE = 5000; // Default page size of paged queries (Page results using QueryExpression: 5,000 rows).
const DUPLICATE_MESSAGE = 'A record was not created or updated because a duplicate of the current record already exists.';
const TEXT = 'nvarchar', INT = 'int', BOOL = 'bit', GUID = 'uniqueidentifier', LOOKUP = 'lookup';

const TABLES = {
  duplicaterule: {
    id: 'duplicateruleid',
    name: 'name',
    fields: { duplicateruleid: GUID, name: TEXT, description: TEXT, baseentityname: TEXT, matchingentityname: TEXT, excludeinactiverecords: BOOL, iscasesensitive: BOOL, statecode: INT, statuscode: INT },
    relationships: { DuplicateRule_DuplicateRuleConditions: { entity: 'duplicaterulecondition', from: 'duplicateruleid', to: 'regardingobjectid', many: true } },
  },
  duplicaterulecondition: {
    id: 'duplicateruleconditionid',
    fields: { duplicateruleconditionid: GUID, baseattributename: TEXT, matchingattributename: TEXT, operatorcode: INT, operatorparam: INT, ignoreblankvalues: BOOL, regardingobjectid: LOOKUP },
  },
};

// OperatorCode (Duplicate Rule Condition table reference): 0 Exact Match, 1 Same First Characters, 2 Same Last Characters,
// 3 Same Date, 4 Same Date and Time, 5 Exact Match (Pick List Label), 6 Exact Match (Pick List Value).
// Keys are the codes and the option labels or schema names with spaces and punctuation removed, lower-cased.
const OPERATORS = new Map([
  ['0', 'exact'], ['exactmatch', 'exact'],
  ['1', 'first'], ['samefirst', 'first'], ['samefirstcharacters', 'first'],
  ['2', 'last'], ['samelast', 'last'], ['samelastcharacters', 'last'],
  ['3', 'date'], ['samedate', 'date'],
  ['4', 'datetime'], ['samedateandtime', 'datetime'],
  ['5', 'label'], ['exactmatchpicklistlabel', 'label'],
  ['6', 'value'], ['exactmatchpicklistvalue', 'value'],
]);

const valueOf = (v) => (v !== null && typeof v === 'object' ? v.id : v) ?? null;
const textOf = (v) => String(valueOf(v) ?? '');
const same = (a, b) => textOf(a).toLowerCase() === textOf(b).toLowerCase();
const isBlank = (v) => textOf(v) === '';
// Date and time values as epoch milliseconds, or null when the value is not a date.
// unverified: a date without a time zone is read as UTC by Date.parse.
const timeOf = (v) => {
  const t = v instanceof Date ? v.getTime() : Date.parse(textOf(v));
  return Number.isNaN(t) ? null : t;
};
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

function mappingFor(logical, def) {
  return {
    logicalName: logical,
    entitySet: pluralizeEntitySetName(logical), // unverified: the Web API set name of duplicaterulecondition
    idColumn: def.id,
    ...(def.name ? { nameColumn: def.name } : {}),
    userConfigured: true,
    // Seeded by the simulated Dataverse API, like the security tables.
    dataverseOnly: true,
    fields: Object.fromEntries(Object.entries(def.fields).map(([field, type]) => [field, { dataverseType: type }])),
    relationships: def.relationships ?? {},
  };
}

// Insert-only: a mapping that already exists and is not dataverseOnly is left alone.
function seedTables(store) {
  for (const [logical, def] of Object.entries(TABLES)) {
    store.state.mappings[logical] ??= mappingFor(logical, def);
    if (store.state.mappings[logical].dataverseOnly === true) store.state.tables[logical] ??= [];
  }
}

// A row as a normal read returns it: lookups as _<name>_value with their annotations, secured columns masked
// through api.fieldSecurity (the FLS extension) when it is installed.
function formatRow(api, user, mapping, row) {
  const visible = api.fieldSecurity?.mask ? (api.fieldSecurity.mask(user, mapping.logicalName, row) ?? {}) : row;
  const out = {};
  for (const [column, value] of Object.entries(visible)) {
    if (mapping.fields[column]?.dataverseType !== LOOKUP) {
      out[column] = structuredClone(value);
      continue;
    }
    const id = valueOf(value);
    out[`_${column}_value`] = id;
    if (id !== null) {
      out[`_${column}_value@Microsoft.Dynamics.CRM.lookuplogicalname`] = value.logical_name ?? null;
      out[`_${column}_value@Microsoft.Dynamics.CRM.associatednavigationproperty`] = column;
    }
  }
  return out;
}

function operatorOf(code) {
  const op = OPERATORS.get(String(code).toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (!op) throw new DataError(`Duplicate rule operator ${code} is not simulated.`, 400, 'InvalidRequest');
  return op;
}

// Same first or last N characters. unverified: a value shorter than N never matches.
function compare(op, param, a, b, caseSensitive) {
  if (op === 'value') return Number(valueOf(a)) === Number(valueOf(b));
  if (op === 'date' || op === 'datetime') {
    const x = timeOf(a), y = timeOf(b);
    if (x === null || y === null) return false;
    return op === 'datetime' ? x === y : dayOf(x) === dayOf(y);
  }
  let x = textOf(a), y = textOf(b);
  if (!caseSensitive) {
    x = x.toLowerCase();
    y = y.toLowerCase();
  }
  if (op === 'exact') return x === y;
  const n = Number(param);
  if (!(n >= 1)) throw new DataError('Same first and same last conditions need an operator parameter of at least 1.', 400, 'InvalidRequest');
  if (x.length < n || y.length < n) return false;
  return op === 'first' ? x.slice(0, n) === y.slice(0, n) : x.slice(-n) === y.slice(-n);
}

// Pick-list label of a value: the option label in the field's metadata (options: [{ value, label }]), else the value's text.
const labelOf = (mapping, column, value) => mapping?.fields?.[column]?.options?.find((o) => Number(o.value) === Number(valueOf(value)))?.label ?? textOf(value);

// Conditions combine with AND. Blank values are ignored when the condition says so, and always for a single-condition rule.
function matchesRow(store, rule, conditions, base, row) {
  return conditions.every((cond) => {
    const a = base[cond.baseattributename], b = row[cond.matchingattributename];
    if (isBlank(a) || isBlank(b)) return !(conditions.length === 1 || cond.ignoreblankvalues === true) && isBlank(a) && isBlank(b);
    const op = operatorOf(cond.operatorcode);
    if (op !== 'label') return compare(op, cond.operatorparam, a, b, rule.iscasesensitive === true);
    const left = labelOf(store.state.mappings[rule.baseentityname], cond.baseattributename, a);
    const right = labelOf(store.state.mappings[rule.matchingentityname], cond.matchingattributename, b);
    return compare('exact', null, left, right, rule.iscasesensitive === true);
  });
}

const publishedRules = (store, filter) => store.tableRows('duplicaterule').filter((r) => Number(r.statuscode) === PUBLISHED && filter(r));
const conditionsOf = (store, rule) => store.tableRows('duplicaterulecondition').filter((c) => same(c.regardingobjectid, rule.duplicateruleid));

// Rows of the rule's matching table that duplicate `base`. selfId excludes the record being written when the tables are the same.
function duplicatesUnder(store, rule, base, selfId) {
  const mapping = store.state.mappings[rule.matchingentityname];
  if (!mapping) return [];
  const conditions = conditionsOf(store, rule);
  if (conditions.length === 0) return []; // unverified: a rule without conditions matches nothing.
  const sameTable = same(mapping.logicalName, rule.baseentityname);
  return store.tableRows(mapping.logicalName).filter((row) => (!sameTable || !same(row[mapping.idColumn], selfId))
    && (rule.excludeinactiverecords !== true || Number(row.statecode ?? 0) === 0)
    && matchesRow(store, rule, conditions, base, row));
}

// Create and update are checked only when the request sends MSCRM.SuppressDuplicateDetection: false (the default suppresses it).
const detectionRequested = (c) => Object.entries(c.headers ?? {}).some(([name, value]) => name.toLowerCase() === 'mscrm.suppressduplicatedetection' && String(value).trim().toLowerCase() === 'false');

function beforeWrite(store, c, mapping, { operation, data, existing }) {
  if ((operation !== 'create' && operation !== 'update') || !detectionRequested(c)) return;
  // The organization's isduplicatedetectionenabled switches detection off for the whole organization (a missing row or flag leaves it on).
  const enabled = store.tableRows('organization')[0]?.isduplicatedetectionenabled;
  if (enabled === false || enabled === 0) return;
  const selfId = operation === 'update' ? existing?.[mapping.idColumn] : undefined;
  const base = { ...existing, ...data };
  const duplicate = publishedRules(store, (r) => same(r.baseentityname, mapping.logicalName))
    .some((rule) => duplicatesUnder(store, rule, base, selfId).length > 0);
  // 412 with the native inner code 0x80040333 (the mapping in dataverse-odata.mjs answers it with the same status).
  if (duplicate) throw new DataError(DUPLICATE_MESSAGE, 412, 'DuplicateDetected', { innerCode: '0x80040333' });
}

// Publish and unpublish run in one transaction with the privilege check: a refused call leaves the rule as it was.
const publish = (api) => async (c) => {
  const { store } = api;
  const rule = c.target.row;
  const jobId = await api.change(() => store.transact(() => {
    api.principals.authorize({ user: c.user, entity: 'duplicaterule', operation: 'write', row: rule });
    const others = publishedRules(store, (r) => same(r.baseentityname, rule.baseentityname) && !same(r.duplicateruleid, rule.duplicateruleid));
    if (others.length >= MAX_PUBLISHED_PER_TABLE) {
      // unverified: the error code and message for the sixth published rule.
      throw new DataError(`Table ${rule.baseentityname} already has ${MAX_PUBLISHED_PER_TABLE} published duplicate rules.`, 400, 'InvalidRequest');
    }
    store.updateRecord('duplicaterule', c.target.id, { statecode: 1, statuscode: PUBLISHED }, c.identity);
    return randomUUID(); // unverified: the simulation completes synchronously; the job id is not tracked.
  }));
  return { status: 200, body: { '@odata.context': contextUrl(c.origin, c.version, 'Microsoft.Dynamics.CRM.PublishDuplicateRuleResponse'), JobId: jobId } };
};

// Unbound: the rule is named by the DuplicateRuleId parameter (the request body of the action).
const unpublish = (api) => async (c) => {
  const { store } = api;
  const body = typeof c.body === 'string' ? JSON.parse(c.body || '{}') : (c.body ?? {});
  const id = body.DuplicateRuleId ?? c.params?.DuplicateRuleId;
  const rule = id == null ? undefined : store.tableRows('duplicaterule').find((r) => same(r.duplicateruleid, id));
  if (!rule) throw new DataError(`duplicaterule With Id = ${id} Does Not Exist`, 404, 'NotFound');
  await api.change(() => store.transact(() => {
    api.principals.authorize({ user: c.user, entity: 'duplicaterule', operation: 'write', row: rule });
    store.updateRecord('duplicaterule', rule.duplicateruleid, { statecode: 0, statuscode: 0 }, c.identity);
  }));
  return { status: 204 }; // unverified: return type of UnpublishDuplicateRule not read.
};

// PagingInfo (Web API complex type): Count and PageNumber page the result, and PagingCookie is an opaque offset.
// unverified: the Web API returns a bare collection, so no PagingCookie comes back; a cookie in the request is honoured.
function offsetOf(info, count) {
  if (!info.PagingCookie) return Math.max(0, ((Number(info.PageNumber) || 1) - 1) * count);
  try {
    const { offset } = JSON.parse(Buffer.from(String(info.PagingCookie), 'base64url').toString());
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch { /* reported below */ }
  throw new DataError('PagingCookie is not valid.', 400, 'InvalidRequest');
}

// Needs read on the matching table (and the record access it grants). Rows the caller cannot read are left out
// before paging, and each row is formatted as a normal read.
const retrieveDuplicates = (api) => async (c) => {
  const { store } = api;
  const business = c.params.BusinessEntity ?? {};
  const baseEntity = business.LogicalName ?? business.logicalName; // unverified: crmbaseentity wire shape
  const matching = c.params.MatchingEntityName;
  if (!baseEntity) throw new DataError('BusinessEntity must name its logical name.', 400, 'InvalidRequest');
  const target = store.state.mappings[matching];
  if (!target) throw new DataError(`${matching} does not exist.`, 404, 'UnknownEntity');
  api.principals.authorize({ user: c.user, entity: matching, operation: 'read', mapping: target });
  const readable = api.principals.readFilter({ user: c.user, entity: matching, mapping: target });
  const attributes = business.Attributes ?? business.attributes ?? business; // unverified: attribute container shape
  const selfId = attributes[store.state.mappings[baseEntity]?.idColumn];
  const found = new Map();
  for (const rule of publishedRules(store, (r) => same(r.baseentityname, baseEntity) && same(r.matchingentityname, matching))) {
    for (const row of duplicatesUnder(store, rule, attributes, selfId)) found.set(textOf(row[target.idColumn]), row);
  }
  let rows = [...found.values()].filter((row) => !readable || readable(row));
  const info = c.params.PagingInfo ?? {};
  const count = Number(info.Count) > 0 ? Number(info.Count) : DEFAULT_PAGE;
  const offset = offsetOf(info, count);
  rows = rows.slice(offset, offset + count);
  return {
    status: 200,
    body: { '@odata.context': contextUrl(c.origin, c.version, target.entitySet), value: rows.map((row) => formatRow(api, c.user, target, row)) }, // unverified: context URL form
  };
};

// BulkDetectDuplicates (Learn): an asynchronous system job over the published rules of a table, at most 5,000 duplicates.
// The job is a system job of dataverse-async (operationtype 8). Each detected pair writes one duplicaterecord row linked to the job.
// unverified: privilege (Learn names none), the Query wire shape, and whether both directions of a pair are written.
const MAX_BULK_DUPLICATES = 5000;
const ref = (logical, id) => ({ id, logical_name: logical, name: '' });
const bulkDetectDuplicates = (api) => async (c) => {
  const { store } = api;
  const body = typeof c.body === 'string' ? JSON.parse(c.body || '{}') : (c.body ?? {});
  const entity = body.Query?.EntityName ?? body.Query?.entityName;
  if (!entity) throw new DataError('Query must name the entity to check.', 400, 'InvalidRequest'); // unverified: message text
  const mapping = store.state.mappings[entity];
  if (!mapping) throw new DataError(`${entity} does not exist.`, 404, 'UnknownEntity');
  api.principals.authorize({ user: c.user, entity, operation: 'read', mapping });
  const jobId = await api.systemJob({ name: body.JobName || 'Bulk Duplicate Detection', operationtype: BULK_DUPLICATE_TYPE, callerId: c.caller.systemuserid }, async () => {
    const readable = api.principals.readFilter({ user: c.user, entity, mapping });
    const rules = publishedRules(store, (r) => same(r.baseentityname, entity));
    const pairs = [];
    scan: for (const row of store.tableRows(entity)) {
      if (readable && !readable(row)) continue;
      for (const rule of rules) {
        const matchId = store.state.mappings[rule.matchingentityname]?.idColumn; // no mapping: duplicatesUnder finds nothing
        for (const match of duplicatesUnder(store, rule, row, row[mapping.idColumn])) {
          pairs.push({ rule, base: textOf(row[mapping.idColumn]), dup: textOf(match[matchId]), matching: rule.matchingentityname });
          if (pairs.length >= MAX_BULK_DUPLICATES) break scan;
        }
      }
    }
    const now = new Date(api.clock ? api.clock() : Date.now()).toISOString();
    await api.change(() => store.transact(() => {
      const table = (store.state.tables.duplicaterecord ??= []);
      for (const { rule, base, dup, matching } of pairs) {
        store.insertRow('duplicaterecord', table, {
          duplicateid: uuidV5(jobId, `${base}|${dup}|${rule.duplicateruleid}`),
          asyncoperationid: ref('asyncoperation', jobId),
          baserecordid: ref(entity, base),
          baserecordidtypecode: entity,
          duplicaterecordid: ref(matching, dup),
          duplicaterecordidtypecode: matching,
          duplicateruleid: ref('duplicaterule', rule.duplicateruleid),
          createdon: now,
        });
      }
    }, { isolated: true }));
    const count = pairs.length;
    return `${count} duplicate records detected for ${entity}`;
  });
  return { status: 200, body: { '@odata.context': contextUrl(c.origin, c.version, 'Microsoft.Dynamics.CRM.BulkDetectDuplicatesResponse'), JobId: jobId } };
};

// CompoundUpdateDuplicateDetectionRule (Learn): one call updates a duplicaterule and its conditions. Only the known columns are
// written, and each condition named in ChildEntities must already exist. unverified: the 404 text for a missing condition, and
// the 204 answer (Learn names no return).
const compoundUpdateRule = (api) => async (c) => {
  const { store } = api;
  const body = typeof c.body === 'string' ? JSON.parse(c.body || '{}') : (c.body ?? {});
  const pick = (source, fields) => Object.fromEntries(Object.entries(source ?? {}).filter(([name]) => name in fields));
  const entity = body.Entity ?? {};
  const rule = store.tableRows('duplicaterule').find((r) => same(r.duplicateruleid, entity.duplicateruleid));
  if (!rule) throw new DataError(`duplicaterule With Id = ${entity.duplicateruleid} Does Not Exist`, 404, 'NotFound');
  const ruleValues = pick(entity, TABLES.duplicaterule.fields);
  delete ruleValues.duplicateruleid;
  const children = (Array.isArray(body.ChildEntities) ? body.ChildEntities : []).map((child) => ({ id: child.duplicateruleconditionid, values: pick(child, TABLES.duplicaterulecondition.fields) }));
  await api.change(() => store.transact(() => {
    api.principals.authorize({ user: c.user, entity: 'duplicaterule', operation: 'write', row: rule });
    store.updateRecord('duplicaterule', rule.duplicateruleid, ruleValues, c.identity);
    for (const child of children) {
      const condition = store.tableRows('duplicaterulecondition').find((r) => same(r.duplicateruleconditionid, child.id));
      if (!condition) throw new DataError(`duplicaterulecondition With Id = ${child.id} Does Not Exist`, 404, 'NotFound');
      const values = { ...child.values };
      delete values.duplicateruleconditionid;
      store.updateRecord('duplicaterulecondition', condition.duplicateruleconditionid, values, c.identity);
    }
  }, { isolated: true }));
  return { status: 204 };
};

// CSDL. PagingInfo (mscrm.PagingInfo) is emitted by dataverse-audit.mjs, with RetrieveRecordChangeHistory.
// unverified: PublishDuplicateRule's documented return is asyncoperation; the simulated body still carries JobId.
const CSDL_PUBLISH = `<Action Name="PublishDuplicateRule" IsBound="true">
  <Parameter Name="entity" Type="mscrm.duplicaterule" Nullable="false" />
  <ReturnType Type="mscrm.asyncoperation" Nullable="false" />
</Action>`;
const CSDL_UNPUBLISH = `<Action Name="UnpublishDuplicateRule">
  <Parameter Name="DuplicateRuleId" Type="Edm.Guid" Nullable="false" />
</Action>`;
const CSDL_RETRIEVE = `<Function Name="RetrieveDuplicates">
  <Parameter Name="BusinessEntity" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="MatchingEntityName" Type="Edm.String" Nullable="false" />
  <Parameter Name="PagingInfo" Type="mscrm.PagingInfo" />
  <ReturnType Type="Collection(mscrm.crmbaseentity)" Nullable="false" />
</Function>`;
const CSDL_BULK_DETECT = `<ComplexType Name="BulkDetectDuplicatesResponse"><Property Name="JobId" Type="Edm.Guid" /></ComplexType>
<Action Name="BulkDetectDuplicates">
  <Parameter Name="Query" Type="mscrm.QueryExpression" />
  <Parameter Name="JobName" Type="Edm.String" />
  <Parameter Name="SendEmailNotification" Type="Edm.Boolean" />
  <Parameter Name="TemplateId" Type="Edm.Guid" />
  <Parameter Name="ToRecipients" Type="Collection(mscrm.crmbaseentity)" />
  <Parameter Name="CCRecipients" Type="Collection(mscrm.crmbaseentity)" />
  <Parameter Name="RecurrencePattern" Type="Edm.String" />
  <Parameter Name="RecurrenceStartTime" Type="Edm.DateTimeOffset" />
  <ReturnType Type="mscrm.BulkDetectDuplicatesResponse" Nullable="false" />
</Action>`;
const CSDL_COMPOUND_UPDATE = `<Action Name="CompoundUpdateDuplicateDetectionRule">
  <Parameter Name="Entity" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="ChildEntities" Type="Collection(mscrm.crmbaseentity)" />
</Action>`;

// Solution duplicate rules: <folder>/<unique name>/duplicaterule.xml, one folder per rule as the export writes them.
// Columns are the rule's text children. statecode and statuscode are read when the file has them; without them a rule
// is published (unverified: the captured export carries no state). <duplicaterulecondition> children, when present,
// become condition rows (unverified shape: the captured export carries none).
const SOLUTION_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
export function parseDuplicateRuleXml(text) {
  const root = parseSolutionXml(text);
  const id = uuidV5(SOLUTION_NAMESPACE, `duplicaterule:${root.attrs.uniquename}`);
  const flag = (node, name) => ['1', 'true'].includes(childText(node, name));
  const number = (node, name) => (childText(node, name) ? Number(childText(node, name)) : undefined);
  const statecode = number(root, 'statecode') ?? ACTIVE;
  const rule = {
    duplicateruleid: id,
    name: childText(root, 'name') || root.attrs.uniquename,
    description: childText(root, 'description') || null,
    baseentityname: childText(root, 'baseentityname'),
    matchingentityname: childText(root, 'matchingentityname'),
    excludeinactiverecords: flag(root, 'excludeinactiverecords'),
    iscasesensitive: flag(root, 'iscasesensitive'),
    statecode,
    statuscode: number(root, 'statuscode') ?? (statecode === ACTIVE ? PUBLISHED : 1),
  };
  const conditions = root.children.filter((node) => node.name === 'duplicaterulecondition').map((node, index) => ({
    duplicateruleconditionid: uuidV5(SOLUTION_NAMESPACE, `duplicaterulecondition:${id}:${index}`),
    regardingobjectid: id,
    baseattributename: childText(node, 'baseattributename'),
    matchingattributename: childText(node, 'matchingattributename'),
    operatorcode: number(node, 'operatorcode') ?? 0,
    operatorparam: number(node, 'operatorparam') ?? null,
    ignoreblankvalues: flag(node, 'ignoreblankvalues'),
  }));
  return { duplicaterule: rule, duplicaterulecondition: conditions };
}

/** Reads a solution's duplicaterules folder (one folder per rule) into rows keyed by table. */
export async function readDuplicateRuleSolution(folder) {
  const rows = { duplicaterule: [], duplicaterulecondition: [] };
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(folder, entry.name, 'duplicaterule.xml'), 'utf8').catch(() => null);
    if (text === null) continue;
    const parsed = parseDuplicateRuleXml(text);
    rows.duplicaterule.push(parsed.duplicaterule);
    rows.duplicaterulecondition.push(...parsed.duplicaterulecondition);
  }
  return rows;
}

// reset runs on every reseed (/_sim/ reset, state import) inside the change queue, so it writes through the store only.
export function reset(api) {
  return api.store.transact(() => seedTables(api.store));
}

// Seeding is a store transaction through the change slot. The loader awaits the returned promise.
export function install(api) {
  const { store } = api;
  api.registry.register({ name: 'PublishDuplicateRule', kind: 'action', binding: 'entity', entity: 'duplicaterule', handle: publish(api), csdl: CSDL_PUBLISH });
  api.registry.register({ name: 'UnpublishDuplicateRule', kind: 'action', binding: 'unbound', handle: unpublish(api), csdl: CSDL_UNPUBLISH });
  api.registry.register({ name: 'RetrieveDuplicates', kind: 'function', binding: 'unbound', handle: retrieveDuplicates(api), csdl: CSDL_RETRIEVE });
  api.registry.register({ name: 'BulkDetectDuplicates', kind: 'action', binding: 'unbound', handle: bulkDetectDuplicates(api), csdl: CSDL_BULK_DETECT });
  api.registry.register({ name: 'CompoundUpdateDuplicateDetectionRule', kind: 'action', binding: 'unbound', handle: compoundUpdateRule(api), csdl: CSDL_COMPOUND_UPDATE });
  api.recordHooks.add('beforeWrite', (c, mapping, change) => beforeWrite(store, c, mapping, change));
  return api.change(() => reset(api));
}
