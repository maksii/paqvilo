// Simulated Dataverse duplicate detection: duplicate rules (duplicaterule and duplicaterulecondition
// tables), the create and update check gated by MSCRM.SuppressDuplicateDetection, and the
// PublishDuplicateRule, UnpublishDuplicateRule and RetrieveDuplicates operations. Invented schema only.
import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { pluralizeEntitySetName } from './solution-standard.mjs';

const PUBLISHED = 2; // statuscode Published; its statecode is Active (1)
// unverified: the limit of five published rules per table comes from the task brief, not from the docs read.
const MAX_PUBLISHED_PER_TABLE = 5;
const DUPLICATE_MESSAGE = 'A record was not created or updated because a duplicate of the current record already exists.';
const TEXT = 'nvarchar', INT = 'int', BOOL = 'bit', GUID = 'uniqueidentifier', LOOKUP = 'lookup';

const TABLES = {
  duplicaterule: {
    id: 'duplicateruleid',
    name: 'name',
    fields: { duplicateruleid: GUID, name: TEXT, baseentityname: TEXT, matchingentityname: TEXT, excludeinactiverecords: BOOL, iscasesensitive: BOOL, statecode: INT, statuscode: INT },
    relationships: { DuplicateRule_DuplicateRuleConditions: { entity: 'duplicaterulecondition', from: 'duplicateruleid', to: 'regardingobjectid', many: true } },
  },
  duplicaterulecondition: {
    id: 'duplicateruleconditionid',
    fields: { duplicateruleconditionid: GUID, baseattributename: TEXT, matchingattributename: TEXT, operatorcode: INT, operatorparam: INT, ignoreblankvalues: BOOL, regardingobjectid: LOOKUP },
  },
};

// OperatorCode 0-2 and their names. Same date and pick-list operators (3-6) are not simulated.
const OPERATORS = new Map([['0', 'exact'], ['exactmatch', 'exact'], ['1', 'first'], ['samefirst', 'first'], ['2', 'last'], ['samelast', 'last']]);

const valueOf = (v) => (v !== null && typeof v === 'object' ? v.id : v) ?? null;
const textOf = (v) => String(valueOf(v) ?? '');
const same = (a, b) => textOf(a).toLowerCase() === textOf(b).toLowerCase();
const isBlank = (v) => textOf(v) === '';

function mappingFor(logical, def) {
  return {
    logicalName: logical,
    entitySet: pluralizeEntitySetName(logical), // unverified: the Web API set name of duplicaterulecondition
    idColumn: def.id,
    ...(def.name ? { nameColumn: def.name } : {}),
    userConfigured: true,
    // Seeded for the Dataverse API only, like the security tables.
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

function operatorOf(code) {
  const op = OPERATORS.get(String(code).toLowerCase());
  if (!op) throw new DataError(`Duplicate rule operator ${code} is not simulated.`, 400, 'InvalidRequest');
  return op;
}

// Same first or last N characters. unverified: a value shorter than N never matches.
function compare(op, param, a, b, caseSensitive) {
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

// Conditions combine with AND. Blank values are ignored when the condition says so, and always for a single-condition rule.
function matchesRow(rule, conditions, base, row) {
  return conditions.every((cond) => {
    const a = base[cond.baseattributename], b = row[cond.matchingattributename];
    if (isBlank(a) || isBlank(b)) return !(conditions.length === 1 || cond.ignoreblankvalues === true) && isBlank(a) && isBlank(b);
    return compare(operatorOf(cond.operatorcode), cond.operatorparam, a, b, rule.iscasesensitive === true);
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
    && matchesRow(rule, conditions, base, row));
}

// Create and update are checked only when the request sends MSCRM.SuppressDuplicateDetection: false (the default suppresses it).
const detectionRequested = (c) => Object.entries(c.headers ?? {}).some(([name, value]) => name.toLowerCase() === 'mscrm.suppressduplicatedetection' && String(value).trim().toLowerCase() === 'false');

function beforeWrite(store, c, mapping, { operation, data, existing }) {
  if ((operation !== 'create' && operation !== 'update') || !detectionRequested(c)) return;
  const selfId = operation === 'update' ? existing?.[mapping.idColumn] : undefined;
  const base = { ...existing, ...data };
  const duplicate = publishedRules(store, (r) => same(r.baseentityname, mapping.logicalName))
    .some((rule) => duplicatesUnder(store, rule, base, selfId).length > 0);
  if (duplicate) throw new DataError(DUPLICATE_MESSAGE, 500, 'DuplicateDetected', { innerCode: '0x80040333' });
}

const publish = (store) => async (c) => {
  const rule = c.target.row;
  const others = publishedRules(store, (r) => same(r.baseentityname, rule.baseentityname) && !same(r.duplicateruleid, rule.duplicateruleid));
  if (others.length >= MAX_PUBLISHED_PER_TABLE) {
    // unverified: the error code and message for the sixth published rule.
    throw new DataError(`Table ${rule.baseentityname} already has ${MAX_PUBLISHED_PER_TABLE} published duplicate rules.`, 400, 'InvalidRequest');
  }
  store.updateRecord('duplicaterule', c.target.id, { statecode: 1, statuscode: PUBLISHED }, c.identity);
  // unverified: the real action returns an asyncoperation; this simulation completes synchronously.
  return { status: 200, body: { asyncoperationid: randomUUID() } };
};

const unpublish = (store) => async (c) => {
  store.updateRecord('duplicaterule', c.target.id, { statecode: 0, statuscode: 0 }, c.identity);
  return { status: 204 }; // unverified: return type of UnpublishDuplicateRule not read.
};

const retrieveDuplicates = (store) => async (c) => {
  const business = c.params.BusinessEntity ?? {};
  const baseEntity = business.LogicalName ?? business.logicalName; // unverified: crmbaseentity wire shape
  const matching = c.params.MatchingEntityName;
  if (!baseEntity) throw new DataError('BusinessEntity must name its logical name.', 400, 'InvalidRequest');
  const target = store.state.mappings[matching];
  if (!target) throw new DataError(`${matching} does not exist.`, 404, 'UnknownEntity');
  const attributes = business.Attributes ?? business.attributes ?? business; // unverified: attribute container shape
  const selfId = attributes[store.state.mappings[baseEntity]?.idColumn];
  const found = new Map();
  for (const rule of publishedRules(store, (r) => same(r.baseentityname, baseEntity) && same(r.matchingentityname, matching))) {
    for (const row of duplicatesUnder(store, rule, attributes, selfId)) found.set(textOf(row[target.idColumn]), row);
  }
  let rows = [...found.values()];
  const paging = c.params.PagingInfo;
  if (paging?.Count) {
    const page = paging.PageNumber ?? 1; // unverified: PagingCookie is not simulated.
    rows = rows.slice((page - 1) * paging.Count, page * paging.Count);
  }
  return {
    status: 200,
    body: { '@odata.context': `${c.origin}/api/data/${c.version}/$metadata#${target.entitySet}`, value: rows.map((row) => structuredClone(row)) }, // unverified: context URL form
  };
};

export function install(api) {
  const { store } = api;
  seedTables(store);
  api.registry.register({ name: 'PublishDuplicateRule', kind: 'action', binding: 'entity', entity: 'duplicaterule', handle: publish(store) });
  api.registry.register({ name: 'UnpublishDuplicateRule', kind: 'action', binding: 'entity', entity: 'duplicaterule', handle: unpublish(store) });
  api.registry.register({ name: 'RetrieveDuplicates', kind: 'function', binding: 'unbound', handle: retrieveDuplicates(store) });
  api.recordHooks.add('beforeWrite', (c, mapping, change) => beforeWrite(store, c, mapping, change));
}
