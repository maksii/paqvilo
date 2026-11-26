// Power Pages global search over local data (Learn: power-pages/configure/search/overview, .../search/additional-tables,
// liquid/dataverse-liquid-tags#searchindex, liquid/liquid-objects#searchindex):
// - Search/Enabled (default true) turns search off: no results, PORTAL_SEARCH_DISABLED.
// - A table is indexed when it has a view named by Search/IndexQueryName (default "Portal Search"); its columns are
//   the indexed columns and the first one is the result title. Tables outside the default set also need
//   Search/EnableAdditionalEntities. The view's own filters apply (the documented case exclusion lives there).
// - Knowledge articles are searchable only when published and not internal (not configurable).
// - Rows come from the view query that lists and entity views use (native-services executeGridQuery), so portal
//   table permissions filter results per visitor.
// - Result URLs come from the site marker `<logicalname>_SearchResultPage` (`Case` for incident, `Knowledge Article`
//   for knowledgearticle) with the record id in the `id` query parameter; without a marker the url is null.
// Matching uses the portal query subset in portal-search-query.mjs over readable rows. The local score reflects matched
// terms and explicit term boosts. It has no hosted index or Search/Query setting weights. `filter` supports `+column:value` and
// `-column:value` clauses only; anything else is refused (PORTAL_SEARCH_FILTER_UNSUPPORTED).
import { executeGridQuery } from './native-services.mjs';
import { organizationRecord } from './organization-context.mjs';
import { siteSetting } from './redirects.mjs';
import { resxCulture } from './liquid-resx.mjs';
import { compilePortalSearchQuery } from './portal-search-query.mjs';

const DEFAULT_SEARCH_TABLES = Object.freeze([
  'knowledgearticle',
  'adx_blog',
  'adx_blogpost',
  'adx_blogpostcomment',
  'adx_communityforum',
  'adx_communityforumpost',
  'adx_communityforumthread',
  'adx_idea',
  'adx_ideacomment',
  'adx_ideaforum',
  'adx_webfile',
  'adx_webpage',
  'incident',
]);
const MARKER_EXCEPTIONS = { incident: 'Case', knowledgearticle: 'Knowledge Article' };
const KNOWLEDGE_PUBLISHED = 3; // knowledgearticle statecode Published

const setting = (portal, name) => siteSetting(portal ?? {}, name) ?? null;
const flag = (value, fallback) =>
  value == null || value === '' ? fallback : /^(?:true|1)$/i.test(String(value).trim());
const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const html = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const text = (value) => {
  if (value == null) return '';
  if (typeof value === 'object') return String(value.name ?? value.label ?? value.Name ?? value.value ?? '');
  return String(value);
};
const searchError = (message, code) => Object.assign(new Error(message), { status: 501, code });

/** `filter`: required (+) and prohibited (-) column equality clauses. */
function filterClauses(filter) {
  if (filter == null || String(filter).trim() === '') return [];
  return String(filter)
    .trim()
    .split(/\s+/)
    .map((clause) => {
      const match = /^([+-]?)([A-Za-z_][\w.]*):("?)([^"\s]+)\3$/.exec(clause);
      if (!match)
        throw searchError(
          `The searchindex filter clause '${clause}' is not supported locally; only +column:value and -column:value are.`,
          'PORTAL_SEARCH_FILTER_UNSUPPORTED',
        );
      return { required: match[1] !== '-', column: match[2].toLowerCase(), value: match[4].toLowerCase() };
    });
}

/** The tables the site indexes: a view named by Search/IndexQueryName, the default set or additional entities on. */
function indexedSearchTables(portal, metadata) {
  const viewName = String(setting(portal, 'Search/IndexQueryName') ?? 'Portal Search')
    .trim()
    .toLowerCase();
  const additional = flag(setting(portal, 'Search/EnableAdditionalEntities'), false);
  const tables = new Map();
  for (const view of metadata?.views ?? []) {
    if (
      String(view.name ?? '')
        .trim()
        .toLowerCase() !== viewName ||
      !view.entity
    )
      continue;
    if (!additional && !DEFAULT_SEARCH_TABLES.includes(view.entity)) continue;
    if (!tables.has(view.entity)) tables.set(view.entity, view);
  }
  return tables;
}

function resultUrl(portal, logicalName, id) {
  const page = portal?.sitemarkers?.[MARKER_EXCEPTIONS[logicalName] ?? `${logicalName}_SearchResultPage`];
  if (!page?.url) return null;
  return `${page.url}${page.url.includes('?') ? '&' : '?'}id=${encodeURIComponent(id)}`;
}

function fragmentOf(values, search) {
  const hit = values.find((value) =>
    value
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.some(search.highlight),
  );
  if (!hit) return null;
  // Matches are found in the raw text and each segment is escaped on its own, so an entity is never split.
  return hit
    .slice(0, 200)
    .split(/([\p{L}\p{N}]+)/u)
    .map((segment, index) =>
      index % 2 && search.highlight(segment.toLowerCase()) ? `<em>${html(segment)}</em>` : html(segment),
    )
    .join('');
}

function searchRowHit(row, logicalName, mapping, columns, clauses, search, portal) {
  if (!clauses.every(({ required, column, value }) => (text(row[column]).toLowerCase() === value) === required))
    return null;
  const values = columns.map((column) => text(row[column])).filter(Boolean);
  const score = search.score(values);
  if (score === null) return null;
  const id = canonical(row[mapping.idColumn]);
  return {
    entity: { ...row, logical_name: logicalName },
    fragment: score ? fragmentOf(values, search) : null,
    id,
    logical_name: logicalName,
    score,
    title: text(row[columns[0]]),
    url: resultUrl(portal, logicalName, id),
  };
}

function searchViewModel(logicalName, view, mapping) {
  const eligible =
    logicalName === 'knowledgearticle'
      ? `<filter type="and"><condition attribute="statecode" operator="eq" value="${KNOWLEDGE_PUBLISHED}"/><filter type="or"><condition attribute="isinternal" operator="eq" value="0"/><condition attribute="isinternal" operator="null"/></filter></filter>`
      : '';
  const fetchXml = String(view.fetchXml ?? '').replace(
    /(<entity\b[^>]*>)/i,
    `$1<attribute name="${mapping.idColumn}"/>${eligible}`,
  );
  return {
    kind: 'view',
    entity: logicalName,
    idColumn: mapping.idColumn,
    primaryName: mapping.nameColumn,
    views: [{ ...view, fetchXml }],
    settings: {},
    pageSize: 5000,
    search: { enabled: false },
    userFilters: {},
    filter: {},
  };
}

function appendSearchViewHits(hits, rows, result, logicalName, mapping, clauses, { search, portal }) {
  const columns = result.layout.Columns.filter((column) => column.Type === 0).map((column) => column.LogicalName);
  for (const row of rows) {
    const hit = searchRowHit(row, logicalName, mapping, columns, clauses, search, portal);
    if (hit) hits.push(hit);
  }
}

function searchUnavailable(portal, store, empty, diagnostic) {
  if (!flag(setting(portal, 'Search/Enabled'), true)) {
    diagnostic({
      code: 'PORTAL_SEARCH_DISABLED',
      severity: 'info',
      component: 'searchindex',
      message: 'Search/Enabled is false: global search returns no results.',
    });
    return { ...empty, unavailable: 'disabled' };
  }
  if (organizationRecord(store)?.isexternalsearchindexenabled === false) {
    diagnostic({
      code: 'PORTAL_SEARCH_UNAVAILABLE',
      severity: 'warning',
      component: 'searchindex',
      message:
        'Dataverse search is turned off for the organization (isexternalsearchindexenabled); Power Pages search needs it.',
    });
    return { ...empty, unavailable: 'dataverse-search-off' };
  }
  return null;
}

function noIndexedSearchTables(portal, empty, diagnostic) {
  diagnostic({
    code: 'PORTAL_SEARCH_UNAVAILABLE',
    severity: 'warning',
    component: 'searchindex',
    message: `No table has a '${setting(portal, 'Search/IndexQueryName') ?? 'Portal Search'}' view that the site indexes, so global search returns no results.`,
  });
  return { ...empty, unavailable: 'no-indexed-tables' };
}

function recordTypeFacets(portal, hits) {
  const groups = new Map();
  for (const entry of String(setting(portal, 'Search/RecordTypeFacetsEntities') ?? '').split(';')) {
    const [label, list] = entry.split(':');
    if (!label?.trim() || !list) continue;
    const names = [
      ...new Set(
        list
          .toLowerCase()
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    ];
    const facet = { label: label.trim(), visibleNames: new Set(), count: 0 };
    for (const name of names) if (!groups.has(name)) groups.set(name, facet);
  }
  const available = new Set();
  for (const { logical_name: name } of hits) {
    if (!groups.has(name)) groups.set(name, { label: name, visibleNames: new Set(), count: 0 });
    const facet = groups.get(name);
    facet.count++;
    facet.visibleNames.add(name);
    available.add(facet);
  }
  return [...available]
    .map(({ label, visibleNames, count }) => ({ label, names: [...visibleNames].sort(), count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Runs a portal search for `identity`: { approximate_total_hits, page, page_size, results }. Each result carries entity, fragment,
 * id, logical_name, number, score, title and url (the searchindex object). Unavailable search answers no results and a diagnostic.
 */
/* NOSONAR: single-pass routine, splitting it would change shared state */ export async function portalSearch({
  portal,
  store,
  readProvider,
  metadata,
  config,
  identity,
  query = '',
  recoverQuerySyntax = false,
  filter = null,
  logicalNames = null,
  page = 1,
  pageSize = 10,
  includeRecordTypes = false,
  diagnostic = () => {},
}) {
  page = Math.max(1, Math.floor(Number(page)) || 1);
  pageSize = Math.max(1, Math.min(Math.floor(Number(pageSize)) || 10, 1000));
  const empty = { approximate_total_hits: 0, page, page_size: pageSize, results: [] };
  const unavailable = searchUnavailable(portal, store, empty, diagnostic);
  if (unavailable) return unavailable;
  const tables = indexedSearchTables(portal, metadata);
  const wanted =
    logicalNames == null || logicalNames === ''
      ? null
      : new Set(
          String(logicalNames)
            .split(',')
            .map((name) => name.trim().toLowerCase())
            .filter(Boolean),
        );
  if (!tables.size) return noIndexedSearchTables(portal, empty, diagnostic);
  const search = compilePortalSearchQuery(query, { recoverSyntax: recoverQuerySyntax });
  const clauses = filterClauses(filter);
  const hits = [];
  for (const [logicalName, view] of tables) {
    if (wanted && !wanted.has(logicalName) && !includeRecordTypes) continue;
    const mapping = store.resolveMapping(logicalName);
    // The record id is read with the view's columns (a view's fetch need not select it). Knowledge articles are searchable only
    // when Published and not Internal, whatever the view selects (Learn power-pages search overview, "can't be modified"): the
    // store row decides, never a projected column. A row without isinternal reads as the platform default No.
    const model = searchViewModel(logicalName, view, mapping);
    // Every page of the view query (the grid's own paging), so the total counts the whole table.
    const rows = [];
    let result;
    for (let page = 1; ; page++) {
      result = await executeGridQuery(
        model,
        { page, pageSize: 5000, allowLargePages: true, search: '', viewId: view.id },
        { portal, store, readProvider, identity, metadata, config, secure: null },
      );
      if (result.accessDenied) break;
      rows.push(...(result.rows ?? []));
      if (!result.moreRecords || !result.rows?.length) break;
    }
    if (result.accessDenied) continue;
    appendSearchViewHits(hits, rows, result, logicalName, mapping, clauses, { search, portal });
  }
  const visible = includeRecordTypes && wanted ? hits.filter((hit) => wanted.has(hit.logical_name)) : hits;
  visible.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const results = visible
    .slice((page - 1) * pageSize, page * pageSize)
    .map((hit, index) => ({ ...hit, number: (page - 1) * pageSize + index + 1 }));
  return {
    approximate_total_hits: visible.length,
    page,
    page_size: pageSize,
    results,
    ...(includeRecordTypes ? { record_types: recordTypeFacets(portal, hits) } : {}),
  };
}

function searchHref(action, query, logicalNames, page) {
  const params = new URLSearchParams({ q: query });
  if (page != null) params.set('page', page);
  if (logicalNames) params.set('logicalNames', logicalNames);
  return html(`${action}?${params}`);
}

function searchPagination({ found, query, logicalNames, action, culture }) {
  const pages = Math.ceil(found.approximate_total_hits / found.page_size);
  if (pages <= 1) return '';
  const link = (rel, page, label) =>
    `<a rel="${rel}" href="${searchHref(action, query, logicalNames, page)}">${html(label)}</a>`;
  const previous =
    found.page > 1
      ? link('prev', Math.min(found.page - 1, pages), culture?.Pagination_Previous_Page ?? 'Previous page')
      : '';
  const next = found.page < pages ? link('next', found.page + 1, culture?.Pagination_Next_Page ?? 'Next page') : '';
  return `<nav aria-label="${html(culture?.Search_DefaultText ?? 'Search results')}">${previous}${next}</nav>`;
}

function searchFacetNavigation({ found, query, logicalNames, action, culture }) {
  if (!found.record_types?.length) return '';
  const link = (title, names) =>
    `<li><a href="${searchHref(action, query, names)}"${names === logicalNames ? ' aria-current="true"' : ''}>${html(title)}</a></li>`;
  const items = found.record_types
    .map((facet) => link(`${facet.label} (${facet.count})`, facet.names.join(',')))
    .join('');
  return `<nav aria-label="${html(culture?.Facet_RecordType ?? 'Record Type')}"><ul>${link(culture?.Facet_All ?? 'All', null)}${items}</ul></nav>`;
}

/**
 * The default search page (`/search/?q=`) when the export has no page of its own at that path: local, labelled markup over
 * portalSearch. Search/Query weights apply only to this page natively and stay contract.
 */
export async function renderPortalSearchPage({
  portal,
  params,
  languageCode = 'en',
  action = '/search/',
  diagnostic = () => {},
  ...context
}) {
  if (setting(portal, 'Search/Query'))
    diagnostic({
      code: 'PORTAL_SEARCH_QUERY_WEIGHTS_IGNORED',
      severity: 'info',
      component: 'search',
      message:
        'Search/Query adds Lucene weights and filters to the default search page; the local search ignores them.',
    });
  const query = String(params.get('q') ?? params.get('query') ?? '');
  const logicalNames = params.get('logicalNames') || null;
  const found = await portalSearch({
    ...context,
    portal,
    diagnostic,
    query,
    logicalNames,
    page: params.get('page') ?? 1,
    pageSize: 10,
    includeRecordTypes: flag(setting(portal, 'Search/FacetedView'), true),
  });
  const items = found.results
    .map((result) => {
      const titleHtml = html(result.title);
      const linkHtml = result.url ? `<a href="${html(result.url)}">${titleHtml}</a>` : titleHtml;
      const fragmentHtml = result.fragment ? `<p>${result.fragment}</p>` : '';
      return `<li data-logical-name="${html(result.logical_name)}">${linkHtml}${fragmentHtml}</li>`;
    })
    .join('');
  const status =
    found.unavailable === 'disabled'
      ? 'Search is not enabled for this site.'
      : `${found.approximate_total_hits} result(s)`;
  const culture = resxCulture(languageCode);
  const label = html(culture?.Search_DefaultText ?? 'Search');
  const pagination = searchPagination({ found, query, logicalNames, action, culture });
  const facets = searchFacetNavigation({ found, query, logicalNames, action, culture });
  const type = logicalNames ? `<input type="hidden" name="logicalNames" value="${html(logicalNames)}">` : '';
  return `<!doctype html><html lang="${html(languageCode)}"><head><meta charset="utf-8"><title>${label}</title></head><body><main data-mirage-component="portal-search"><form method="get" action="${html(action)}"><input type="search" name="q" value="${html(query)}" aria-label="${label}">${type}<button type="submit">${label}</button></form>${facets}<p role="status">${html(status)}</p><ol>${items}</ol>${pagination}</main></body></html>`;
}
