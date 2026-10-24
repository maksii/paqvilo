import { parseDataverseTop } from './dataverse-top.mjs';
// Read-only activitypointer view over the activity tables. A GET reads each activity table through api.records, so that
// table's privileges, ownership and sharing apply. Each row is projected onto the activitypointer columns with
// activitytypecode set to its source table, then filtered, ordered and paged with the store's own OData helpers.
// Every other verb is refused. The route answers before the records layer, which would authorize activitypointer itself.
// ponytail: every source row is collected before $filter and paging, so memory grows with the whole union; stream per source if that bites.
import { DataError } from './data-error.mjs';
import {
  contextUrl,
  decodeSkipToken,
  encodeSkipToken,
  parseDataverseRoute,
  skipTokenQueryValue,
} from './dataverse-odata.mjs';
import {
  compileODataPredicate,
  expressionPaths,
  parseODataExpression,
  parseOrderBy,
  parseSelect,
  sortRows,
} from './odata-query.mjs';
import { standardTableDef } from './dataverse-standard.mjs';

const LOGICAL = 'activitypointer';
const SET = 'activitypointers';
const PAGE_CAP = 5000;
const invalid = (message, innerCode = '0x80060888') => new DataError(message, 400, 'InvalidRequest', { innerCode });
// Native refusal text and inner code for a write to activitypointers are not known; this answer is a guess.
const readOnly = () =>
  new DataError(
    `${LOGICAL} is a read-only view of the activity tables; create, update and delete the activity itself instead.`,
    400,
    'InvalidRequest',
    {
      innerCode: '0x80040203',
    },
  );

const columns = new Set(Object.keys(standardTableDef(LOGICAL).attributes));
// A lookup travels as _name_value; the base name is the activitypointer column.
const baseName = (key) => /^_(.+)_value$/.exec(key)?.[1] ?? key;
const isActivity = (mapping) =>
  mapping.logicalName !== LOGICAL &&
  (mapping.idColumn === 'activityid' || standardTableDef(mapping.logicalName)?.isActivity === true);
const sourcesOf = (store) => Object.values(store.state.mappings ?? {}).filter(isActivity);

// Strips annotations and columns activitypointer does not have, and names the source table.
function projectRow(row, source) {
  const out = {};
  for (const [key, value] of Object.entries(row))
    if (!key.includes('@') && columns.has(baseName(key))) out[key] = value;
  out.activitytypecode = source.logicalName;
  return out;
}

// $select keeps the named columns and always the id; no $select (or *) keeps every activitypointer column.
function selectOf(text) {
  const names = parseSelect(text);
  if (names == null) return null;
  for (const name of names)
    if (!columns.has(baseName(name))) throw invalid(`'${name}' is not a valid property of ${LOGICAL}.`);
  return new Set([...names, 'activityid']);
}

function pick(row, select) {
  if (select == null) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => select.has(key) || select.has(baseName(key))));
}

const PAGE_PREFER = (c) => ({ ...c.prefer, annotations: null, maxPageSize: null, maxPageSizeInvalid: false });
// One read through records for one source table. A missing row is no answer (null); a denial (403) reaches the caller.
async function callSource(c, api, pathname, search = '', prefer = PAGE_PREFER(c)) {
  const url = new URL(c.url.href);
  url.pathname = pathname;
  url.search = search;
  try {
    return await api.records.handle({
      ...c,
      method: 'GET',
      route: parseDataverseRoute(url.pathname),
      url,
      prefer,
      body: undefined,
    });
  } catch (error) {
    if (error instanceof DataError && error.status === 404) return null;
    throw error;
  }
}

// Every row of one source table: its first page, then each @odata.nextLink records returns, so the union is complete past one page.
async function sourceRows(c, api, source) {
  const rows = [];
  let result = await callSource(c, api, `/api/data/${c.version}/${source.entitySet}`);
  while (result?.body?.value) {
    for (const row of result.body.value) rows.push(row);
    const next = result.body['@odata.nextLink'];
    if (!next) break;
    const url = new URL(next, c.url);
    result = await callSource(c, api, url.pathname, url.search);
  }
  return rows;
}

// The union rows that match $filter, in $orderby order (store order when there is none).
async function matchingRows(c, api) {
  const { store } = api;
  const mapping = store.state.mappings[LOGICAL];
  const params = c.url.searchParams;
  const aliases = Object.fromEntries([...params].filter(([name]) => name.startsWith('@')));
  const queryOptions = { dialect: 'dataverse', aliases };
  const ast = params.get('$filter') ? parseODataExpression(params.get('$filter'), queryOptions) : null;
  const order = parseOrderBy(params.get('$orderby'), queryOptions);
  for (const [head] of ast ? expressionPaths(ast) : [])
    if (head && !head.startsWith('@') && !columns.has(baseName(head)))
      throw invalid(`'${head}' is not a valid property of ${LOGICAL}.`);
  for (const spec of order)
    if (!columns.has(baseName(spec.path[0]))) throw invalid(`'${spec.path[0]}' is not a valid property of ${LOGICAL}.`);

  const rows = [];
  for (const source of sourcesOf(store))
    for (const row of await sourceRows(c, api, source)) rows.push(projectRow(row, source));
  const ctx = store.queryContext(c.identity, { dialect: 'dataverse' });
  const kept = ast ? rows.filter(compileODataPredicate(ast, mapping, ctx)) : rows;
  if (!order.length) return kept;
  return sortRows(kept, order, {
    mapping,
    valueOf: (row, path) => store.pathValue(ctx, mapping, row, path),
    definition: (path) => store.pathDefinition(ctx, mapping, path),
    lookupName: ctx.lookupName,
    collation: ctx.settings.collation,
  });
}

async function getCollection(c, api) {
  const params = c.url.searchParams;
  const rows = await matchingRows(c, api);
  const select = selectOf(params.get('$select'));
  const top = params.get('$top');
  parseDataverseTop(top, { occurrences: params.getAll('$top').length });
  const cap = top == null ? rows.length : Math.min(rows.length, Number(top));
  const pageSize = Math.min(c.prefer.maxPageSize ?? PAGE_CAP, PAGE_CAP);
  const skip = params.get('$skiptoken');
  let offset = 0;
  if (skip != null) {
    const token = decodeSkipToken(skip);
    if (!token) throw invalid('Malformed XML', '0x80040201');
    offset = (token.pageNumber - 1) * pageSize;
  }
  const end = Math.min(cap, offset + pageSize);
  const page = rows.slice(offset, end);
  const body = { '@odata.context': contextUrl(c.origin, c.version, SET) };
  if (params.get('$count') === 'true') body['@odata.count'] = rows.length;
  body.value = page.map((row) => pick(row, select));
  if (end < cap) {
    const token = encodeSkipToken({
      pageNumber: offset / pageSize + 2,
      lastId: page.at(-1).activityid,
      firstId: page[0].activityid,
      idColumn: 'activityid',
    });
    const query = new URLSearchParams(params);
    query.delete('$skiptoken');
    const text = query.toString().replace(/%24/g, '$');
    body['@odata.nextLink'] =
      `${c.origin}/api/data/${c.version}/${SET}?${text ? `${text}&` : ''}$skiptoken=${skipTokenQueryValue(decodeURIComponent(token))}`;
  }
  return { status: 200, body };
}

const missingRow = (id) =>
  new DataError(`${LOGICAL} With Id = ${id} Does Not Exist`, 404, 'NotFound', { id, innerCode: '0x80040217' });
const idInKey = (pathname) => /\(([^)]*)\)/.exec(pathname)?.[1];

// The activity row a key names, from whichever activity table holds it.
async function getEntity(c, api) {
  const keyPart = c.url.pathname.slice(c.url.pathname.indexOf('('));
  const select = selectOf(c.url.searchParams.get('$select'));
  for (const source of sourcesOf(api.store)) {
    const result = await callSource(c, api, `/api/data/${c.version}/${source.entitySet}${keyPart}`);
    if (!result?.body) continue;
    return {
      status: 200,
      body: {
        '@odata.context': contextUrl(c.origin, c.version, `${SET}/$entity`),
        ...pick(projectRow(result.body, source), select),
      },
    };
  }
  throw missingRow(idInKey(c.url.pathname));
}

// A by-id read the projection does not answer ($expand, a property, $value, a navigation): the source table that holds the id
// answers with the same path and query, and its @odata.context names activitypointers.
async function delegateById(c, api) {
  const keyPart = c.url.pathname.slice(c.url.pathname.indexOf('('));
  for (const source of sourcesOf(api.store)) {
    const result = await callSource(
      c,
      api,
      `/api/data/${c.version}/${source.entitySet}${keyPart}`,
      c.url.search,
      c.prefer,
    );
    if (!result) continue;
    const context = result.body?.['@odata.context'];
    if (typeof context === 'string') result.body['@odata.context'] = context.replace(`#${source.entitySet}`, `#${SET}`);
    return result;
  }
  throw missingRow(idInKey(c.url.pathname));
}

const DELEGATED = new Set(['property', 'value', 'member', 'navigationCount', 'ref', 'navigationRef']);
async function handle(c, api) {
  if (c.method !== 'GET') throw readOnly();
  // The view is read as the Activity privilege: a caller without it is refused once here, not dropped per source.
  api.principals.authorize({ user: c.user, entity: LOGICAL, operation: 'read' });
  const route = parseDataverseRoute(c.url.pathname);
  switch (route?.kind) {
    case 'collection':
      return getCollection(c, api);
    case 'entity':
      return c.url.searchParams.has('$expand') ? delegateById(c, api) : getEntity(c, api);
    case 'count':
      return { status: 200, body: String((await matchingRows(c, api)).length) };
    default:
      if (DELEGATED.has(route?.kind)) return delegateById(c, api);
      throw new DataError(
        `${SET} supports only the collection, a single row and $count on this view.`,
        501,
        'NotImplemented',
      );
  }
}

export function install(api) {
  api.addRoute(
    (path) => parseDataverseRoute(path)?.set === SET,
    (c) => handle(c, api),
  );
}

export const EXTENSION = { name: 'dataverse-activitypointer', install };
