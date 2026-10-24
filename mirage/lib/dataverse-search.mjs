import { organizationRecord } from './organization-context.mjs';
// Dataverse search over the rows the caller can read. Web API: searchquery, searchsuggest and searchautocomplete (actions),
// searchstatus and searchstatistics (functions). /api/search/v2.0 answers with the same bodies; /api/search/v1.0 query, suggest
// and autocomplete answer with the legacy shapes.
// Rows are read through api.records as the Web API list read, so the caller's table privilege and field security apply: a table
// the caller cannot read (403) or cannot see (404) contributes no rows.
// ponytail: matching is a token match over the indexed columns in this module, not Dataverse's index. No Lucene syntax, fuzzy
// matching, boosting or proximity; the score is the number of matched terms; facets are value facets only.
import { DataError } from './data-error.mjs';
import { contextUrl, parseDataverseRoute } from './dataverse-odata.mjs';
import { objectTypeCode } from './dataverse-metadata.mjs';
import { parseXmlDocument } from './fetchxml-engine.mjs';

const WEB_API = 'v9.2';
const QUICK_FIND = 4; // savedquery querytype of a Quick Find view
const DEFAULT_TABLES = ['account', 'contact']; // ponytail: the standard set indexed when no column is flagged; the rest comes from the data
const MAX_TERM = 100;
const DISABLED_CODE = '0x80048d0b';
const TOKEN = /[\p{L}\p{N}]+/gu;
const LEGACY = /^\/api\/search\/v(1\.0|2\.0)\/(query|suggest|autocomplete|status|statistics)\/?$/i;
const LEGACY_VERBS = { query: 'POST', suggest: 'POST', autocomplete: 'POST', status: 'GET', statistics: 'GET' };

// The inner error code of these request errors is a guess (only the message shape is documented).
const invalid = (message) => new DataError(message, 400, 'InvalidRequest', { innerCode: '0x80060888' });
const disabled = () =>
  new DataError('Dataverse Search feature is disabled for this organization.', 400, 'InvalidRequest', {
    innerCode: DISABLED_CODE,
  });
const unique = (list) => [...new Set(list)];
const isScalar = (value) => value != null && typeof value !== 'object';
const lowerKeys = (object) =>
  Object.fromEntries(Object.entries(object ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
const tokens = (text) => text.toLowerCase().match(TOKEN) ?? [];
const enabled = (api) => organizationRecord(api.store)?.isexternalsearchindexenabled !== false; // assumed: a row without the column is on

// A list argument: a JSON array string, a comma-separated string, or an array already parsed. null and "null" mean none.
function listOf(value, name) {
  if (value == null || value === '' || value === 'null') return null;
  if (Array.isArray(value)) return value;
  const text = String(value).trim();
  if (!text.startsWith('['))
    return text
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid(`${name} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw invalid(`${name} must be a list.`);
  return parsed;
}

// options is a serialized dictionary, for example "{'searchmode': 'all'}"; the single quotes are read as JSON quotes.
function optionsOf(value) {
  if (value == null || value === '' || value === 'null') return {};
  if (typeof value === 'object') return lowerKeys(value);
  try {
    return lowerKeys(JSON.parse(String(value).replace(/'/g, '"')));
  } catch {
    throw invalid('options is not valid JSON.');
  }
}

function bodyOf(c) {
  if (c.body && typeof c.body === 'object' && !Buffer.isBuffer(c.body)) return c.body;
  const text = typeof c.body === 'string' ? c.body : c.bodyBuffer?.length ? c.bodyBuffer.toString('utf8') : '';
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('Request body is not valid JSON.');
  }
}

function countOf(value, fallback, name) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw invalid(`${name} must be a non-negative integer.`); // native wording is a guess
  return n;
}

function searchOf(value, min) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw invalid('The search parameter is required.'); // native wording is a guess
  if (text.length > MAX_TERM)
    throw new DataError('Search Text Length Exceeded.', 400, 'InvalidRequest', { innerCode: '0x800401ff' }); // SearchTextLenExceeded
  if (text.length < min) throw invalid('The search parameter must be at least three characters.'); // native wording is a guess
  return text;
}

// The quick-find "Find by" columns: each like-condition whose value is the {0} placeholder.
function quickFindColumns(api, logical) {
  const columns = [];
  for (const view of api.schema?.()?.views ?? []) {
    if (view.entity !== logical || (view.queryType ?? view.querytype) !== QUICK_FIND) continue;
    for (const [tag] of String(view.fetchXml ?? '').matchAll(/<condition\b[^>]*>/gi)) {
      const attribute = /\battribute="([^"]+)"/i.exec(tag)?.[1];
      if (attribute && /\boperator="like"/i.test(tag) && /\bvalue="\{0\}"/.test(tag))
        columns.push(attribute.toLowerCase());
    }
  }
  return columns;
}

// The indexed tables: those with a Quick Find view or a column the Solution flags IsSearchable (fields[name].columnMetadata),
// plus the standard default set. Each one's columns are its primary name and those columns that exist on the table.
function indexedTables(api) {
  const out = [];
  for (const mapping of Object.values(api.store.state.mappings ?? {})) {
    const logical = mapping?.logicalName;
    if (!logical || !mapping.entitySet) continue;
    const fields = mapping.fields ?? {};
    const flagged = Object.entries(fields)
      .filter(([, field]) => field?.columnMetadata?.isSearchable === true)
      .map(([name]) => name);
    const columns = unique([...quickFindColumns(api, logical), ...flagged]).filter((name) => name in fields);
    if (!columns.length && !DEFAULT_TABLES.includes(logical)) continue;
    out.push({
      logical,
      mapping,
      primary: mapping.nameColumn ?? null,
      columns: unique([mapping.nameColumn, ...columns].filter(Boolean)),
    });
  }
  return out;
}

// The legacy filter is "table:filter" per table, separated by commas; a comma before "name:" starts the next table.
function legacyFilters(text) {
  const filters = new Map();
  if (!text) return filters;
  for (const part of String(text).split(/,\s*(?=[a-z_][a-z0-9_]*\s*:)/i)) {
    const at = part.indexOf(':');
    const name = part.slice(0, at).trim().toLowerCase();
    const filter = part.slice(at + 1).trim();
    if (name && filter) filters.set(name, filter);
  }
  return filters;
}

// The tables a request reads: the entities list or every indexed table. A Web API entity object with no SearchColumns is
// searched on its primary name only. A legacy table name, or no entities list, searches the indexed columns.
function targetsOf(api, entities, filters) {
  const indexed = indexedTables(api);
  if (!entities)
    return indexed.map((table) => ({
      ...table,
      select: [],
      searchColumns: table.columns,
      filter: filters.get(table.logical) ?? null,
    }));
  return entities.map((entry) => {
    const named = typeof entry === 'string';
    const e = named ? { name: entry } : lowerKeys(entry);
    const name = String(e.name ?? '').toLowerCase();
    const table = indexed.find((t) => t.logical === name);
    if (!table)
      throw new DataError(`Invalid Search Entity - ${e.name}.`, 400, 'InvalidRequest', { innerCode: '0x80060201' }); // InvalidSearchEntity
    const search = (listOf(e.searchcolumns, 'SearchColumns') ?? []).map((column) => String(column).toLowerCase());
    return {
      ...table,
      select: (listOf(e.selectcolumns, 'SelectColumns') ?? []).map((column) => String(column).toLowerCase()),
      searchColumns: search.length ? search : named ? table.columns : [table.primary].filter(Boolean),
      filter: e.filter ?? filters.get(name) ?? null,
    };
  });
}

const PAGE_PREFER = (prefer) => ({ ...prefer, annotations: null, maxPageSize: null, maxPageSizeInvalid: false });

// One read through the records layer, as a Web API list read. A 403 or 404 means the caller reads none of that table.
async function callRecords(api, c, pathname, search) {
  const url = new URL(c.url.href);
  url.pathname = pathname;
  url.search = search;
  try {
    return await api.records.handle({
      ...c,
      method: 'GET',
      route: parseDataverseRoute(pathname),
      url,
      prefer: PAGE_PREFER(c.prefer),
      body: undefined,
    });
  } catch (error) {
    if (error instanceof DataError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

// Every row of one table the caller can read, with the table's $filter and the request's top-level filter applied by the records layer.
// extra: the orderby and facet columns; those the table lacks are left out (a $select of an unknown column is a 400).
// Assumed: a top-level filter naming a column the table lacks fails the whole query (that table's 400 propagates) rather than
// being ignored for that table; the documentation does not say.
async function readRows(api, c, target, topFilter, extra = []) {
  const fields = target.mapping.fields ?? {};
  const select = unique(
    [
      target.mapping.idColumn,
      target.primary,
      ...target.searchColumns,
      ...target.select,
      ...extra.filter((name) => name in fields),
    ].filter(Boolean),
  );
  const filter = [target.filter, topFilter]
    .filter(Boolean)
    .map((text) => `(${text})`)
    .join(' and ');
  const params = new URLSearchParams({ $select: select.join(',') });
  if (filter) params.set('$filter', filter);
  const rows = [];
  let next = `/api/data/${c.version ?? WEB_API}/${target.mapping.entitySet}?${params}`;
  while (next) {
    const url = new URL(next, c.url);
    const result = await callRecords(api, c, url.pathname, url.search);
    if (!result) return rows;
    rows.push(...(result.body?.value ?? []));
    next = result.body?.['@odata.nextLink'] ?? null;
  }
  return rows;
}

// Simple query syntax: whitespace-separated terms, "quoted words" (each word is a term), a leading - excludes a term, and a
// trailing * matches a prefix. Suggest and autocomplete pass prefix: true so every term is a prefix (type-ahead).
function termsOf(search, { prefix = false } = {}) {
  const terms = [];
  for (const [, phrase, word] of search.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (phrase != null) {
      for (const text of tokens(phrase)) terms.push({ text, prefix, negated: false });
      continue;
    }
    const negated = word.startsWith('-');
    const body = negated ? word.slice(1) : word;
    for (const text of tokens(body)) terms.push({ text, prefix: prefix || body.endsWith('*'), negated });
  }
  return terms;
}

const hitsTerm = (term, token) => token === term.text || (term.prefix && token.startsWith(term.text));

// A row's match: its matched-term count and the highlighted columns, or null when the row does not match.
// any: at least one positive term matches. all: every positive term matches. A negated term that matches excludes the row.
function matchRow(row, columns, terms, mode) {
  const positives = terms.filter((term) => !term.negated);
  const negatives = terms.filter((term) => term.negated);
  const matched = new Set();
  const highlights = {};
  let excluded = false;
  for (const column of columns) {
    const value = row[column];
    if (!isScalar(value)) continue;
    let changed = false;
    const marked = String(value).replace(TOKEN, (word) => {
      const token = word.toLowerCase();
      if (negatives.some((term) => hitsTerm(term, token))) excluded = true;
      let hit = false;
      for (const term of positives) {
        if (hitsTerm(term, token)) {
          matched.add(term);
          hit = true;
        }
      }
      if (hit) changed = true;
      return hit ? `{crmhit}${word}{/crmhit}` : word;
    });
    if (changed) highlights[column] = [marked];
  }
  if (excluded) return null;
  if (positives.length && (mode === 'all' ? matched.size < positives.length : matched.size === 0)) return null;
  return { score: matched.size, highlights };
}

function hitOf(target, row, match) {
  const attributes = { '@search.objecttypecode': objectTypeCode(target.logical) };
  for (const name of unique([target.primary, ...target.select]))
    if (name && row[name] !== undefined) attributes[name] = row[name];
  // The documented query and SDK samples report ObjectTypeCode 0 beside @search.objecttypecode (the real code); kept as documented.
  return {
    Id: row[target.mapping.idColumn],
    EntityName: target.logical,
    ObjectTypeCode: 0,
    Attributes: attributes,
    Highlights: match.highlights,
    Score: match.score,
    row,
  };
}

// orderby clauses ("name asc|desc" or "@search.score desc"); the default is relevance, highest first. Nulls sort last.
function clausesOf(list) {
  const clauses = (list ?? []).map((item) => {
    const [key, direction] = String(item).trim().split(/\s+/);
    return { key: key.toLowerCase(), desc: /^desc$/i.test(direction ?? '') };
  });
  return clauses.length ? clauses : [{ key: '@search.score', desc: true }];
}

const valueOfHit = (hit, key) => (key === '@search.score' ? hit.Score : hit.row[key]);

function compareHits(a, b, clauses) {
  for (const { key, desc } of clauses) {
    const x = valueOfHit(a, key);
    const y = valueOfHit(b, key);
    if (x == null || y == null) {
      if ((x == null) !== (y == null)) return x == null ? 1 : -1;
      continue;
    }
    const order =
      typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x) < String(y)
          ? -1
          : String(x) > String(y)
            ? 1
            : 0;
    if (order) return desc ? -order : order;
  }
  return 0;
}

// Value facets over every match (before paging). The key is the spec's own head, for example "entityname" or "account:ownerid".
// ponytail: values and interval options are not modelled; sort is always by count, then value.
const facetField = (spec) => String(spec).split(',')[0].trim().split(/[:.]/).pop().toLowerCase();
function facetsOf(hits, specs) {
  const out = {};
  for (const spec of specs) {
    const [head, ...options] = String(spec)
      .split(',')
      .map((part) => part.trim());
    const field = facetField(spec);
    const limit = Number(/count:(\d+)/.exec(options.join(','))?.[1] ?? 10) || 10;
    const counts = new Map();
    for (const hit of hits) {
      const value = field === 'entityname' ? hit.EntityName : hit.row[field];
      if (!isScalar(value)) continue;
      const entry = counts.get(value) ?? { value, count: 0 };
      entry.count += 1;
      counts.set(value, entry);
    }
    out[head] = [...counts.values()]
      .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
      .slice(0, limit)
      .map(({ value, count }) => ({ count, from: null, to: null, type: 'value', value, optionalvalue: null }));
  }
  return out;
}

// The matches for a search request, in order, with the total, the facets and the requested page.
async function searchRows(api, c, body, legacy) {
  if (!enabled(api)) throw disabled();
  const search = searchOf(body.search, 1);
  const top = Math.min(countOf(body.top, 50, 'top'), 100); // assumed: a larger top is clamped to the documented maximum
  const skip = countOf(body.skip, 0, 'skip');
  const mode =
    String(legacy ? body.searchmode : (optionsOf(body.options).searchmode ?? 'any')).toLowerCase() === 'all'
      ? 'all'
      : 'any';
  const filters = legacy ? legacyFilters(body.filter) : new Map();
  const targets = targetsOf(api, listOf(body.entities, 'entities'), filters);
  const topFilter = legacy ? null : body.filter ? String(body.filter) : null;
  const terms = termsOf(search);
  const clauses = clausesOf(listOf(body.orderby, 'orderby'));
  const facetSpecs = listOf(body.facets, 'facets') ?? [];
  const extra = [...clauses.map((clause) => clause.key), ...facetSpecs.map(facetField)];
  const hits = [];
  for (const target of targets) {
    for (const row of await readRows(api, c, target, topFilter, extra)) {
      const match = matchRow(row, target.searchColumns, terms, mode);
      if (match) hits.push(hitOf(target, row, match));
    }
  }
  hits.sort((a, b) => compareHits(a, b, clauses));
  return { total: hits.length, facets: facetsOf(hits, facetSpecs), page: hits.slice(skip, skip + top) };
}

// Suggestions: the primary name only, every term a prefix, and the top results (default 5).
async function suggestRows(api, c, body, legacy) {
  if (!enabled(api)) throw disabled();
  const search = searchOf(body.search, 3);
  const top = countOf(body.top, 5, 'top');
  const filters = legacy ? legacyFilters(body.filter) : new Map();
  const targets = targetsOf(api, listOf(body.entities, 'entities'), filters).map((target) => ({
    ...target,
    searchColumns: [target.primary].filter(Boolean),
  }));
  const topFilter = legacy ? null : body.filter ? String(body.filter) : null;
  const terms = termsOf(search, { prefix: true });
  const clauses = clausesOf(listOf(body.orderby, 'orderby'));
  const extra = clauses.map((clause) => clause.key);
  const hits = [];
  for (const target of targets) {
    for (const row of await readRows(api, c, target, topFilter, extra)) {
      const match = matchRow(row, target.searchColumns, terms, 'any');
      if (!match) continue;
      const text = match.highlights[target.primary]?.[0] ?? String(row[target.primary]);
      const document = {
        '@search.objectid': row[target.mapping.idColumn],
        '@search.entityname': target.logical,
        '@search.objecttypecode': objectTypeCode(target.logical),
        [target.primary]: row[target.primary],
      };
      hits.push({ Text: text, Document: document, Score: match.score, row });
    }
  }
  hits.sort((a, b) => compareHits(a, b, clauses));
  return hits.slice(0, top);
}

// Autocomplete: the most frequent indexed word that starts with the last typed word, wrapped in {crmhit}. The word is lowercased,
// as the documented samples show it. null when no word matches is a guess (no empty value is documented).
async function completion(api, c, body, legacy) {
  if (!enabled(api)) throw disabled();
  const search = searchOf(body.search, 1);
  const prefix = tokens(search).at(-1) ?? '';
  const filters = legacy ? legacyFilters(body.filter) : new Map();
  const targets = targetsOf(api, listOf(body.entities, 'entities'), filters);
  const topFilter = legacy ? null : body.filter ? String(body.filter) : null;
  const counts = new Map();
  for (const target of targets) {
    for (const row of await readRows(api, c, target, topFilter)) {
      for (const column of target.searchColumns) {
        if (!isScalar(row[column])) continue;
        for (const token of tokens(String(row[column])))
          if (token.startsWith(prefix)) counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  const best = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))[0]?.[0];
  return best ? `{crmhit}${best}{/crmhit}` : null;
}

// Status: not provisioned when search is off (the documented response), else the indexed tables and their indexed columns.
// The lockbox and CMK values and the entity sync status text are the documented sample values.
function statusOf(api) {
  if (!enabled(api)) return { value: { status: 'notprovisioned', lockboxstatus: 'Unknown' } };
  return {
    value: {
      entitystatusresults: indexedTables(api).map((table) => ({
        entitylogicalname: table.logical,
        objecttypecode: objectTypeCode(table.logical),
        primarynamefield: table.primary,
        entitystatus: 'EntitySyncComplete',
        searchableindexedfieldinfomap: Object.fromEntries(
          table.columns.map((column) => [column, { indexfieldname: column }]),
        ),
      })),
      status: 'provisioned',
      lockboxstatus: 'Disabled',
      cmkstatus: 'Disabled',
    },
  };
}

// ponytail: the storage size is the indexed text, not Dataverse's index. Zeros when search is off are a guess.
function statisticsOf(api) {
  const tables = enabled(api) ? indexedTables(api) : [];
  let text = '';
  let documents = 0;
  for (const table of tables) {
    const rows = api.store.tableRows(table.logical);
    documents += rows.length;
    for (const row of rows)
      text +=
        table.columns
          .map((column) => row[column])
          .filter(isScalar)
          .join(' ') + '\n';
  }
  const bytes = Buffer.byteLength(text);
  return {
    value: { storagesizeinbytes: bytes, storagesizeinmb: Math.floor(bytes / 1048576), documentcount: documents },
  };
}

const publicHit = (hit) => ({
  Id: hit.Id,
  EntityName: hit.EntityName,
  ObjectTypeCode: hit.ObjectTypeCode,
  Attributes: hit.Attributes,
  Highlights: hit.Highlights,
  Score: hit.Score,
});
// The v1.0 result: the attributes flat, with the @search annotations beside them.
const legacyHit = (hit) => ({
  ...hit.Attributes,
  '@search.score': hit.Score,
  '@search.highlights': hit.Highlights,
  '@search.entityname': hit.EntityName,
  '@search.objectid': hit.Id,
});
const legacyFacets = (facets) =>
  Object.fromEntries(
    Object.entries(facets).map(([key, list]) => [
      key,
      list.map((entry) => ({ Type: 'Value', Value: entry.value, Count: entry.count })),
    ]),
  );

// The Web API response: the result serialised into the response string.
const wrapped = (c, name, inner) => ({
  status: 200,
  body: {
    '@odata.context': contextUrl(c.origin, c.version ?? WEB_API, `Microsoft.Dynamics.CRM.${name}Response`),
    response: JSON.stringify(inner),
  },
});

async function webQuery(api, c, body) {
  const result = await searchRows(api, c, body, false);
  return {
    Error: null,
    Value: result.page.map(publicHit),
    Facets: result.facets,
    QueryContext: null,
    Count: body.count === true || body.count === 'true' ? result.total : -1,
  };
}
async function legacyQuery(api, c, body) {
  const result = await searchRows(api, c, body, true);
  return {
    value: result.page.map(legacyHit),
    facets: legacyFacets(result.facets),
    totalrecordcount: body.returntotalrecordcount === true ? result.total : -1,
  };
}
async function webSuggest(api, c, body) {
  return {
    Error: null,
    Value: (await suggestRows(api, c, body, false)).map(({ Text, Document }) => ({ Text, Document })),
    QueryContext: null,
  };
}
async function legacySuggest(api, c, body) {
  return {
    value: (await suggestRows(api, c, body, true)).map(({ Text, Document }) => ({ text: Text, document: Document })),
  };
}
async function webAutocomplete(api, c, body) {
  return { Error: null, Value: await completion(api, c, body, false), QueryContext: null };
}
async function legacyAutocomplete(api, c, body) {
  return { value: await completion(api, c, body, true) };
}

// The legacy endpoints: v1.0 query, suggest and autocomplete with the legacy shapes, v2.0 with the Web API bodies.
// v1.0 status and statistics are not documented; they answer with the Web API bodies here.
async function legacyRoute(api, c) {
  const [, version, name] = LEGACY.exec(c.url.pathname);
  if (name.toLowerCase() === 'status') return wrapped(c, 'searchstatus', statusOf(api));
  if (name.toLowerCase() === 'statistics') return wrapped(c, 'searchstatistics', statisticsOf(api));
  const key = name.toLowerCase();
  const body = bodyOf(c);
  if (version === '2.0') {
    const web = { query: webQuery, suggest: webSuggest, autocomplete: webAutocomplete }[key];
    return wrapped(c, `search${key}`, await web(api, c, body));
  }
  const legacy = { query: legacyQuery, suggest: legacySuggest, autocomplete: legacyAutocomplete }[key];
  return { status: 200, body: await legacy(api, c, body) };
}

// CSDL. The parameter Nullable flags follow the documented parameter tables (Edm.String parameters are nullable there).
const CSDL = {
  searchquery: `<Action Name="searchquery">
  <Parameter Name="filter" Type="Edm.String" />
  <Parameter Name="options" Type="Edm.String" />
  <Parameter Name="propertybag" Type="Edm.String" />
  <Parameter Name="search" Type="Edm.String" Nullable="false" />
  <Parameter Name="count" Type="Edm.Boolean" />
  <Parameter Name="facets" Type="Edm.String" />
  <Parameter Name="semanticquery" Type="Edm.String" />
  <Parameter Name="top" Type="Edm.Int32" />
  <Parameter Name="skip" Type="Edm.Int32" />
  <Parameter Name="orderby" Type="Edm.String" />
  <Parameter Name="entities" Type="Edm.String" />
  <ReturnType Type="mscrm.searchqueryResponse" Nullable="false" />
</Action>
<ComplexType Name="searchqueryResponse">
  <Property Name="response" Type="Edm.String" />
</ComplexType>`,
  searchsuggest: `<Action Name="searchsuggest">
  <Parameter Name="entities" Type="Edm.String" />
  <Parameter Name="propertybag" Type="Edm.String" />
  <Parameter Name="fuzzy" Type="Edm.Boolean" />
  <Parameter Name="orderby" Type="Edm.String" />
  <Parameter Name="filter" Type="Edm.String" />
  <Parameter Name="search" Type="Edm.String" Nullable="false" />
  <Parameter Name="options" Type="Edm.String" />
  <Parameter Name="top" Type="Edm.Int32" />
  <ReturnType Type="mscrm.searchsuggestResponse" Nullable="false" />
</Action>
<ComplexType Name="searchsuggestResponse">
  <Property Name="response" Type="Edm.String" />
</ComplexType>`,
  searchautocomplete: `<Action Name="searchautocomplete">
  <Parameter Name="options" Type="Edm.String" />
  <Parameter Name="filter" Type="Edm.String" />
  <Parameter Name="entities" Type="Edm.String" />
  <Parameter Name="propertybag" Type="Edm.String" />
  <Parameter Name="fuzzy" Type="Edm.Boolean" />
  <Parameter Name="search" Type="Edm.String" Nullable="false" />
  <ReturnType Type="mscrm.searchautocompleteResponse" Nullable="false" />
</Action>
<ComplexType Name="searchautocompleteResponse">
  <Property Name="response" Type="Edm.String" />
</ComplexType>`,
  searchstatus: `<Function Name="searchstatus">
  <ReturnType Type="mscrm.searchstatusResponse" Nullable="false" />
</Function>
<ComplexType Name="searchstatusResponse">
  <Property Name="response" Type="Edm.String" />
</ComplexType>`,
  searchstatistics: `<Function Name="searchstatistics">
  <ReturnType Type="mscrm.searchstatisticsResponse" Nullable="false" />
</Function>
<ComplexType Name="searchstatisticsResponse">
  <Property Name="response" Type="Edm.String" />
</ComplexType>`,
  getsearchinformation: `<Function Name="GetSearchInformation">
  <Parameter Name="Fetchxml" Type="Edm.String" Nullable="false" Unicode="false" />
  <ReturnType Type="mscrm.GetSearchInformationResponse" Nullable="false" />
</Function>
<ComplexType Name="GetSearchInformationResponse">
  <Property Name="CanAllowLeadingWildCardSearch" Type="Edm.String" Unicode="false" />
  <Property Name="CanSupportedByRelevanceSearch" Type="Edm.String" Unicode="false" />
</ComplexType>`,
};

// GetSearchInformation(Fetchxml): the unbound function's complex response (not wrapped in a JSON string, unlike the search
// actions). Relevance search applies when search is on and every entity the FetchXML names is an indexed table.
// It is not documented: the "true"/"false" string format, the leading-wildcard source (always "false" here) and the refusal
// of a FetchXML with no entity are guesses.
function searchInformationOf(api, fetchXml) {
  let fetch;
  try {
    fetch = parseXmlDocument(String(fetchXml ?? ''), { root: 'fetch' });
  } catch {
    throw searchInformationInvalid();
  }
  const names = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.name === 'entity' || child.name === 'link-entity')
        names.push(String(child.attrs.name ?? '').toLowerCase());
      walk(child);
    }
  };
  walk(fetch);
  if (!names.length) throw searchInformationInvalid();
  const indexed = new Set(indexedTables(api).map((table) => table.logical));
  return {
    CanAllowLeadingWildCardSearch: 'false',
    CanSupportedByRelevanceSearch: String(enabled(api) && names.every((name) => indexed.has(name))),
  };
}
const searchInformationInvalid = () =>
  new DataError('The FetchXML is not valid.', 400, 'InvalidRequest', { innerCode: '0x80040203' }); // native wording is a guess

function install(api) {
  const { registry } = api;
  registry.register({
    name: 'searchquery',
    kind: 'action',
    binding: 'unbound',
    csdl: CSDL.searchquery,
    handle: async (c) => wrapped(c, 'searchquery', await webQuery(api, c, bodyOf(c))),
  });
  registry.register({
    name: 'searchsuggest',
    kind: 'action',
    binding: 'unbound',
    csdl: CSDL.searchsuggest,
    handle: async (c) => wrapped(c, 'searchsuggest', await webSuggest(api, c, bodyOf(c))),
  });
  registry.register({
    name: 'searchautocomplete',
    kind: 'action',
    binding: 'unbound',
    csdl: CSDL.searchautocomplete,
    handle: async (c) => wrapped(c, 'searchautocomplete', await webAutocomplete(api, c, bodyOf(c))),
  });
  registry.register({
    name: 'searchstatus',
    kind: 'function',
    binding: 'unbound',
    csdl: CSDL.searchstatus,
    handle: (c) => wrapped(c, 'searchstatus', statusOf(api)),
  });
  registry.register({
    name: 'searchstatistics',
    kind: 'function',
    binding: 'unbound',
    csdl: CSDL.searchstatistics,
    handle: (c) => wrapped(c, 'searchstatistics', statisticsOf(api)),
  });
  registry.register({
    name: 'GetSearchInformation',
    kind: 'function',
    binding: 'unbound',
    csdl: CSDL.getsearchinformation,
    handle: (c) => ({
      status: 200,
      body: {
        '@odata.context': contextUrl(
          c.origin,
          c.version ?? WEB_API,
          'Microsoft.Dynamics.CRM.GetSearchInformationResponse',
        ),
        ...searchInformationOf(api, c.params?.Fetchxml),
      },
    }),
  });
  api.addRoute(
    (path, method) => {
      const match = LEGACY.exec(path);
      return Boolean(match) && LEGACY_VERBS[match[2].toLowerCase()] === method;
    },
    (c) => legacyRoute(api, c),
  );
}

export const EXTENSION = { name: 'dataverse-search', install };
export { tokens as searchTokens };
