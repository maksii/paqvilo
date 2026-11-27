// Power Pages global search over local data (Learn: power-pages/configure/search/overview, .../search/additional-tables,
// liquid/dataverse-liquid-tags#searchindex, liquid/liquid-objects#searchindex):
// - Search/Enabled (default true) turns search off: no results, PORTAL_SEARCH_DISABLED.
// - A table is indexed when it has a view named by Search/IndexQueryName (default "Portal Search"); its columns are
//   the indexed columns and the first one is the result title. Tables outside the default set also need
//   Search/EnableAdditionalEntities. The view's own filters apply (the documented case exclusion lives there).
// - Knowledge articles are searchable only when published and not internal (not configurable). With
//   KnowledgeManagement/ContentAccessLevel/Enabled, an article must also share a content access level with the visitor
//   (content-access-levels.mjs); hidden articles count in no total, facet or summary source.
// - Rows come from the view query that lists and entity views use (native-services executeGridQuery), so portal
//   table permissions filter results per visitor.
// - Web pages are not governed by table permissions: a page result needs the visitor to pass the page's web page access
//   control rules (and its ancestors'), as a page request does (page-access.mjs); a row of no exported page is left out.
//   Hosted session F3 (summary-F3.md PAGE-04f) found web pages for anonymous visitors on a site with no adx_webpage
//   table permission.
// - A web page in a non-visible publishing state is left out for a visitor who cannot preview unpublished content. A
//   hosted site with Dataverse search lists such pages to every visitor, anonymous ones included (hosted session F3,
//   summary-F3.md PAGE-04f); observed.searchUnpublishedPages "listed" reproduces that, and the exclusion reports
//   PORTAL_SEARCH_UNPUBLISHED_PAGES_EXCLUDED.
// - Result URLs come from the site marker `<logicalname>_SearchResultPage` (`Case` for incident, `Knowledge Article`
//   for knowledgearticle) with the record id in the `id` query parameter; without a marker the url is null.
// - With Search/IndexNotesAttachments and KnowledgeManagement/DisplayNotes both true, the notes of the knowledge articles a
//   visitor may find are searched too (Learn .../search/file-attachment): only notes the secured annotation read returns,
//   that carry the KnowledgeManagement/NotesFilter prefix and pass the private-note rule (native-services portalNotes),
//   indexing the readable subject, note text, file name and text-typed bodies. Binary bodies are skipped
//   (PORTAL_SEARCH_ATTACHMENT_NOT_INDEXED). A note result has logical_name annotation and its article as `parent`.
// Matching uses the portal query subset in portal-search-query.mjs over readable rows. Results are ordered by the local
// relevance model (portal-search-rank.mjs: matched words, their frequency and proximity, column length and boosts); it
// has no hosted index, so its scores and the order of close results are local (PORTAL_SEARCH_RANKING_LOCAL). Search/Query
// applies only to the default search page: it decides membership and its clauses' weights and boosts add to the rank.
// `filter` supports `+column:value` and `-column:value` clauses only; anything else is refused
// (PORTAL_SEARCH_FILTER_UNSUPPORTED).
import { executeGridQuery, portalNotes } from './native-services.mjs';
import { isCloudAttachmentPlaceholder, notesFilter } from './form-service.mjs';
import { collectFetchXmlPages, escapeXmlAttribute } from './paging-validation.mjs';
import { organizationRecord } from './organization-context.mjs';
import { siteSetting } from './redirects.mjs';
import { resxCulture } from './liquid-resx.mjs';
import { compilePortalSearchQuery, compilePortalSearchTemplate } from './portal-search-query.mjs';
import { knowledgeArticleAccess } from './content-access-levels.mjs';
import { portalField } from './importer.mjs';
import { canPreviewUnpublished, pageAccess } from './page-access.mjs';

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

function searchRowHit(row, logicalName, mapping, columns, clauses, { search, template, portal }) {
  if (!clauses.every(({ required, column, value }) => (text(row[column]).toLowerCase() === value) === required))
    return null;
  const values = columns.map((column) => text(row[column])).filter(Boolean);
  const visitorScore = search.score(values);
  // Search/Query decides membership and ranks: its score includes the visitor query wherever the template says @Query.
  const score = template
    ? template.rank({ logicalName, columns: columns.map((column) => [column, text(row[column])]) })
    : visitorScore;
  if (score === null) return null;
  const id = canonical(row[mapping.idColumn]);
  return {
    entity: { ...row, logical_name: logicalName },
    fragment: visitorScore ? fragmentOf(values, search) : null,
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

function viewColumns(result) {
  return result.layout.Columns.filter((column) => column.Type === 0).map((column) => column.LogicalName);
}

function appendSearchViewHits(hits, rows, columns, logicalName, mapping, clauses, options) {
  for (const row of rows) {
    const hit = searchRowHit(row, logicalName, mapping, columns, clauses, options);
    if (!hit) continue;
    if (options.includeGrounding && logicalName === 'knowledgearticle' && columns.includes('content'))
      hit.grounding = { titleColumn: columns[0], content: row.content };
    hits.push(hit);
  }
}

// Knowledge article notes (Learn power-pages/configure/search/file-attachment). Text bodies are read up to this size.
const NOTE_TEXT_TYPE = /^(?:text\/[\w.+-]+|application\/(?:json|xml|[\w.-]+\+(?:json|xml)))$/i;
const MAX_NOTE_TEXT_BYTES = 1024 * 1024;
const NOTE_COLUMNS = ['title', 'subject', 'notetext', 'filename', 'content'];

const indexesKnowledgeNotes = (portal) =>
  flag(setting(portal, 'Search/IndexNotesAttachments'), false) &&
  flag(setting(portal, 'KnowledgeManagement/DisplayNotes'), false);

/** The notes of one article through the secured annotation read, bounded like the notes service. */
async function articleNoteRows(readProvider, identity, articleId, idColumn) {
  const key = escapeXmlAttribute(idColumn);
  const query = `<entity name="annotation"><all-attributes/><attribute name="${key}"/><filter type="and"><condition attribute="objectid" operator="eq" value="${escapeXmlAttribute(articleId)}"/></filter><order attribute="${key}"/></entity>`;
  const { records } = await collectFetchXmlPages({
    idColumn,
    maxPages: 4,
    readPage: async ({ page, cookie, pageSize }) => {
      const continuation = cookie ? ` paging-cookie="${escapeXmlAttribute(cookie)}"` : '';
      const result = await readProvider.fetchXml(
        `<fetch count="${pageSize}" page="${page}"${continuation}>${query}</fetch>`,
        identity,
      );
      return { ...result, entities: result.entities ?? result.value ?? [] };
    },
  });
  return records.filter((row) => {
    const type = row.objecttypecode?.value ?? row.objecttypecode ?? row.objectid?.logical_name;
    return !type || canonical(type) === 'knowledgearticle';
  });
}

async function noteBodyText(row, readable, attachmentBody, report) {
  if (!row.filename || !readable('documentbody')) return '';
  // A cloud attachment note (an Azure file Web API .azure.txt note, portal-file-api.mjs, or a form attachment stored in
  // cloud storage, form-service.mjs) holds a placeholder that names the file's storage key, not the file: its body is never
  // indexed. Its subject, note text and file name still are (Mirage-own; the platform's handling is not documented).
  if (String(row.filename).toLowerCase().endsWith('.azure.txt')) return '';
  const type = String(row.mimetype ?? '').trim();
  if (!NOTE_TEXT_TYPE.test(type)) {
    report.binary.add(type || 'unknown');
    return '';
  }
  // Without a body reader only an inline body is available; one kept in a storage provider is reported.
  if (!attachmentBody && row.documentbody == null) report.unavailable++;
  const body = attachmentBody ? await attachmentBody('annotation', row) : row.documentbody;
  if (body == null || body === '') return '';
  const encoded = String(body).slice(0, Math.ceil(MAX_NOTE_TEXT_BYTES / 3) * 4);
  const content = Buffer.from(encoded, 'base64').subarray(0, MAX_NOTE_TEXT_BYTES).toString('utf8');
  return isCloudAttachmentPlaceholder(content) ? '' : content;
}

function storedNotes(store, idColumn) {
  try {
    return new Map((store.tableRows?.('annotation') ?? []).map((row) => [canonical(row[idColumn]), row]));
  } catch {
    return new Map();
  }
}

/** The notes of one article that this visitor may see: the NotesFilter prefix and the private-note rule. */
async function visibleArticleNotes(article, mapping, prefix, context) {
  const rows = await articleNoteRows(context.readProvider, context.identity, article.id, mapping.idColumn);
  // The visibility decision reads the stored note (its prefix and private marker), never a masked projection.
  const stored = context.config?.mode === 'live' ? new Map() : storedNotes(context.store, mapping.idColumn);
  const visible = new Set(
    portalNotes(
      rows.map((row) => stored.get(canonical(row[mapping.idColumn])) ?? row),
      context.identity,
      prefix,
    ).map((row) => canonical(row[mapping.idColumn])),
  );
  return rows.filter((row) => visible.has(canonical(row[mapping.idColumn])));
}

/** A note's indexed columns: only those column security lets the visitor read. */
async function indexedNote(row, mapping, prefix, report, context) {
  const readable = (column) =>
    context.store.portalAuthorization?.canReadRawColumn?.(
      context.identity,
      'annotation',
      column,
      row[mapping.idColumn],
    ) !== false;
  const notetext = readable('notetext') ? text(row.notetext) : '';
  const indexed = {
    [mapping.idColumn]: row[mapping.idColumn],
    subject: readable('subject') ? text(row.subject) : '',
    notetext: notetext.startsWith(prefix) ? notetext.slice(prefix.length).trim() : notetext,
    filename: readable('filename') ? text(row.filename) : '',
    content: await noteBodyText(row, readable, context.attachmentBody, report),
  };
  indexed.title = indexed.filename || indexed.subject;
  return indexed;
}

/** Note results for the admitted articles; a note is found only through an article the visitor may find. */
async function appendKnowledgeNoteHits(hits, articles, clauses, context) {
  const mapping = context.store.resolveMapping('annotation');
  const prefix = notesFilter(context.portal);
  const report = { binary: new Set(), unavailable: 0 };
  let unread = 0;
  for (const article of articles) {
    let rows;
    try {
      rows = await visibleArticleNotes(article, mapping, prefix, context);
    } catch {
      unread++;
      continue;
    }
    for (const row of rows) {
      const indexed = await indexedNote(row, mapping, prefix, report, context);
      const hit = searchRowHit(indexed, 'annotation', mapping, NOTE_COLUMNS, clauses, context);
      if (!hit) continue;
      const { documentbody, ...entity } = row; // NOSONAR: the body is never part of the result object
      hit.entity = { ...entity, logical_name: 'annotation' };
      hit.url = indexed.filename ? `/_entity/annotation/${hit.id}/${context.portal?.website?.id ?? ''}` : article.url;
      hit.parent = { id: article.id, logical_name: 'knowledgearticle', title: article.title, url: article.url };
      hits.push(hit);
    }
  }
  if (report.binary.size)
    context.diagnostic({
      code: 'PORTAL_SEARCH_ATTACHMENT_NOT_INDEXED',
      severity: 'info',
      component: 'searchindex',
      message: `Knowledge article note bodies of type ${[...report.binary].sort().join(', ')} are not indexed: the local search reads text bodies only.`,
    });
  if (report.unavailable)
    context.diagnostic({
      code: 'PORTAL_SEARCH_ATTACHMENT_BODY_UNAVAILABLE',
      severity: 'info',
      component: 'searchindex',
      message: `${report.unavailable} knowledge article note body(ies) kept in a storage provider are not read by this search; their subject, note text and file name are searched.`,
    });
  if (unread)
    context.diagnostic({
      code: 'PORTAL_SEARCH_NOTES_UNREAD',
      severity: 'warning',
      component: 'searchindex',
      message: `The notes of ${unread} knowledge article(s) could not be read and are not searched.`,
    });
}

/** Search/EnableDataverseSearch false selects the deprecated Lucene .NET search and its fuzzy semantics. */
const legacyLuceneSearch = (portal) =>
  String(setting(portal, 'Search/EnableDataverseSearch')).trim().toLowerCase() === 'false';

function searchUnavailable(portal, store, config, empty, diagnostic) {
  if (!flag(setting(portal, 'Search/Enabled'), true)) {
    diagnostic({
      code: 'PORTAL_SEARCH_DISABLED',
      severity: 'info',
      component: 'searchindex',
      message: 'Search/Enabled is false: global search returns no results.',
    });
    return { ...empty, unavailable: 'disabled' };
  }
  // Older exports can explicitly select the deprecated Lucene mode. The local view scan can run without the Dataverse index.
  const legacyLocalSearch = config?.mode !== 'live' && config?.pageMode !== 'live' && legacyLuceneSearch(portal);
  if (!legacyLocalSearch && organizationRecord(store)?.isexternalsearchindexenabled === false) {
    diagnostic({
      code: 'PORTAL_SEARCH_UNAVAILABLE',
      severity: 'warning',
      component: 'searchindex',
      message: "The organization's Dataverse search index is disabled (isexternalsearchindexenabled).",
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
 * The ids of the web page rows in a non-visible publishing state, unless the visitor may preview unpublished content.
 * The exported page's own state decides (its default-language content page's state wins over the root's, as page access
 * reads it); a row of no exported page reads its publishing state column.
 */
function unpublishedWebPages(rows, idColumn, { portal, identity }) {
  const hidden = new Set(
    (portal?.publishingStates ?? []).filter((state) => !state.isVisible).map((state) => canonical(state.id)),
  );
  if (!hidden.size || canPreviewUnpublished(portal, identity)) return new Set();
  const pages = new Map((portal.pages ?? []).map((page) => [canonical(page.id), page]));
  const stateOf = (row) => {
    const page = pages.get(canonical(row[idColumn]));
    const value = page
      ? portalField(page.metadata ?? page, 'publishingstateid')
      : (row.adx_publishingstateid ?? row._adx_publishingstateid_value);
    return canonical(typeof value === 'object' && value ? (value.id ?? value.Id) : value);
  };
  return new Set(rows.filter((row) => hidden.has(stateOf(row))).map((row) => canonical(row[idColumn])));
}

/**
 * The web page rows this visitor may find: each page's access control rules decide (page-access.mjs pageAccess, the rule
 * that governs a page request). Security decision: unpublished pages stay out of results unless the site was observed
 * listing them (F3 PAGE-04f); then only their publishing state stops counting, never their access rules.
 */
function admitWebPages(rows, idColumn, context, legacyLucene, diagnostic) {
  const { portal, identity } = context;
  const listed = (context.config?.observed ?? portal?.observed)?.searchUnpublishedPages === 'listed';
  const hidden = listed ? new Set() : unpublishedWebPages(rows, idColumn, context);
  const rulesOf = listed
    ? { ...portal, publishingStates: (portal.publishingStates ?? []).map((state) => ({ ...state, isVisible: true })) }
    : portal;
  const pages = new Map((portal?.pages ?? []).map((page) => [canonical(page.id), page]));
  const now = context.store?.clock?.now?.() ?? Date.now();
  const readable = (row) => {
    const page = pages.get(canonical(row[idColumn]));
    return Boolean(page) && pageAccess(rulesOf, page, identity ?? {}, { now }).allowed;
  };
  const admitted = rows.filter((row) => !hidden.has(canonical(row[idColumn])) && readable(row));
  if (hidden.size && !legacyLucene)
    diagnostic({
      code: 'PORTAL_SEARCH_UNPUBLISHED_PAGES_EXCLUDED',
      severity: 'warning',
      component: 'searchindex',
      count: hidden.size,
      message: `${hidden.size} web page(s) in a non-visible publishing state are left out of these search results. A hosted Power Pages site with Dataverse search lists them, with their title and indexed text, to every visitor, anonymous ones included; Mirage keeps them out. Set observed.searchUnpublishedPages to listed, with evidence, to reproduce the hosted results.`,
    });
  return admitted;
}

/** Every page of the view query (the grid's own paging), so the total counts the whole table; null when access is denied. */
async function readSearchViewRows(model, view, context) {
  const rows = [];
  let result;
  for (let page = 1; ; page++) {
    result = await executeGridQuery(
      model,
      { page, pageSize: 5000, allowLargePages: true, search: '', viewId: view.id },
      { ...context, secure: null },
    );
    if (result.accessDenied) return null;
    rows.push(...(result.rows ?? []));
    if (!result.moreRecords || !result.rows?.length) return { rows, columns: viewColumns(result) };
  }
}

/** The compiled Search/Query template, or null; an invalid template is reported and the visitor query runs alone. */
function searchQueryTemplate(queryTemplate, search, legacyLucene, diagnostic) {
  if (queryTemplate == null || String(queryTemplate).trim() === '') return null;
  try {
    return compilePortalSearchTemplate(queryTemplate, search, { legacyLucene });
  } catch (error) {
    if (error.code !== 'PORTAL_SEARCH_QUERY_INVALID') throw error;
    diagnostic({
      code: 'PORTAL_SEARCH_QUERY_TEMPLATE_INVALID',
      severity: 'warning',
      component: 'search',
      message: `Search/Query is not a valid query (${error.message}); the default search page runs the visitor query alone.`,
    });
    return null;
  }
}

/**
 * Runs a portal search for `identity`: { approximate_total_hits, page, page_size, results }. Each result carries entity, fragment,
 * id, logical_name, number, score, title and url (the searchindex object); a knowledge article note also carries `parent`.
 * Unavailable search answers no results and a diagnostic. `queryTemplate` is the default search page's Search/Query.
 * `attachmentBody(logical, row)` reads a note body kept in a storage provider; without it only inline bodies are read.
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
  queryTemplate = null,
  filter = null,
  logicalNames = null,
  page = 1,
  pageSize = 10,
  includeRecordTypes = false,
  includeGrounding = false,
  attachmentBody = null,
  diagnostic = () => {},
}) {
  page = Math.max(1, Math.floor(Number(page)) || 1);
  pageSize = Math.max(1, Math.min(Math.floor(Number(pageSize)) || 10, 1000));
  const empty = { approximate_total_hits: 0, page, page_size: pageSize, results: [] };
  const unavailable = searchUnavailable(portal, store, config, empty, diagnostic);
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
  const legacyLucene = legacyLuceneSearch(portal);
  const search = compilePortalSearchQuery(query, { recoverSyntax: recoverQuerySyntax, legacyLucene });
  const template = searchQueryTemplate(queryTemplate, search, legacyLucene, diagnostic);
  const clauses = filterClauses(filter);
  const hits = [];
  const knowledgeAccess = tables.has('knowledgearticle')
    ? await knowledgeArticleAccess({ portal, store, identity, config, readProvider, diagnostic })
    : null;
  const notes = tables.has('knowledgearticle') && indexesKnowledgeNotes(portal);
  const context = { portal, store, readProvider, identity, metadata, config };
  const options = { search, template, portal, includeGrounding };
  for (const [logicalName, view] of tables) {
    const needed =
      !wanted || wanted.has(logicalName) || includeRecordTypes || (notes && logicalName === 'knowledgearticle');
    if (!needed) continue;
    const mapping = store.resolveMapping(logicalName);
    // The record id is read with the view's columns (a view's fetch need not select it). Knowledge articles are searchable only
    // when Published and not Internal, whatever the view selects (Learn power-pages search overview, "can't be modified"): the
    // store row decides, never a projected column. A row without isinternal reads as the platform default No.
    // Web page rows are read without table permissions; their page access rules admit them (admitWebPages).
    const readContext =
      logicalName === 'adx_webpage' ? { ...context, identity: { ...identity, admin: true } } : context;
    const read = await readSearchViewRows(searchViewModel(logicalName, view, mapping), view, readContext);
    if (!read) continue;
    let admitted =
      knowledgeAccess && logicalName === 'knowledgearticle'
        ? read.rows.filter((row) => knowledgeAccess.visible(row[mapping.idColumn]))
        : read.rows;
    if (logicalName === 'adx_webpage')
      admitted = admitWebPages(admitted, mapping.idColumn, context, legacyLucene, diagnostic);
    appendSearchViewHits(hits, admitted, read.columns, logicalName, mapping, clauses, options);
    if (notes && logicalName === 'knowledgearticle') {
      const articles = admitted.map((row) => {
        const id = canonical(row[mapping.idColumn]);
        return { id, title: text(row[read.columns[0]]), url: resultUrl(portal, logicalName, id) };
      });
      await appendKnowledgeNoteHits(hits, articles, clauses, { ...context, ...options, attachmentBody, diagnostic });
    }
  }
  const visible = wanted ? hits.filter((hit) => wanted.has(hit.logical_name)) : hits;
  // Hosted ties are ordered randomly (Learn power-apps/developer/data-platform/search/query, orderby); locally by title, id.
  visible.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  if (String(query).trim() && new Set(visible.map((hit) => hit.score)).size > 1)
    diagnostic({
      code: 'PORTAL_SEARCH_RANKING_LOCAL',
      severity: 'info',
      component: 'searchindex',
      message:
        'Search results are ordered by the local relevance model (matched words, frequency, proximity, column length, boosts and Search/Query weights); hosted Dataverse search scores and the order of close results can differ.',
    });
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
 * Search/Filters: "label:logical,names;..." options of the search page's filter drop-down. An option shows the plural
 * display name of its first table (the documented label), or its own label when the metadata has none.
 */
function searchFilterOptions(portal, metadata) {
  const options = [];
  for (const entry of String(setting(portal, 'Search/Filters') ?? '').split(';')) {
    const at = entry.indexOf(':');
    const label = entry.slice(0, at).trim();
    const names = [
      ...new Set(
        entry
          .slice(at + 1)
          .toLowerCase()
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    ];
    if (at < 0 || !label || !names.length) continue;
    options.push({ label: metadata?.entities?.[names[0]]?.collectionLabel || label, value: names.join(',') });
  }
  return options;
}

function searchFilterControl({ portal, metadata, logicalNames }) {
  const options = searchFilterOptions(portal, metadata);
  if (!options.length)
    return logicalNames ? `<input type="hidden" name="logicalNames" value="${html(logicalNames)}">` : '';
  const snippet = portal?.snippets?.['Search/Default/FilterText'];
  const all = typeof snippet === 'string' && snippet.trim() ? snippet.trim() : 'All';
  // A record-type value outside the options (a facet link) selects All, so a new query searches every table again.
  const current = options.some(({ value }) => value === logicalNames) ? logicalNames : '';
  const option = ({ label, value }) =>
    `<option value="${html(value)}"${value === current ? ' selected' : ''}>${html(label)}</option>`;
  return `<select name="logicalNames" aria-label="${html(all)}">${option({ label: all, value: '' })}${options.map(option).join('')}</select>`;
}

function searchResultItem(result, culture) {
  const titleHtml = html(result.title);
  const linkHtml = result.url ? `<a href="${html(result.url)}">${titleHtml}</a>` : titleHtml;
  const fragmentHtml = result.fragment ? `<p>${result.fragment}</p>` : '';
  const parent = result.parent;
  let parentHtml = '';
  if (parent) {
    const parentTitle = html(parent.title);
    const parentLink = parent.url ? `<a href="${html(parent.url)}">${parentTitle}</a>` : parentTitle;
    parentHtml = `<p>${html(culture?.Related_Article ?? 'Related article')}: ${parentLink}</p>`;
  }
  return `<li data-logical-name="${html(result.logical_name)}">${linkHtml}${fragmentHtml}${parentHtml}</li>`;
}

/**
 * The default search page (`/search/?q=`) when the export has no page of its own at that path: local, labelled markup over
 * portalSearch. Search/Query applies here only (not to the Liquid tag): it filters and its weights rank through the local
 * model. Search/Filters adds the logicalNames drop-down.
 */
export async function renderPortalSearchPage({
  portal,
  params,
  languageCode = 'en',
  action = '/search/',
  diagnostic = () => {},
  ...context
}) {
  const queryTemplate = setting(portal, 'Search/Query');
  if (queryTemplate)
    diagnostic({
      code: 'PORTAL_SEARCH_QUERY_WEIGHTS_LOCAL',
      severity: 'info',
      component: 'search',
      message:
        'Search/Query filters the default search page locally, and its weights and boosts rank it through the local relevance model; hosted scores are not reproduced.',
    });
  const query = String(params.get('q') ?? params.get('query') ?? '');
  const logicalNames = params.get('logicalNames') || null;
  const found = await portalSearch({
    ...context,
    portal,
    diagnostic,
    query,
    queryTemplate,
    logicalNames,
    page: params.get('page') ?? 1,
    pageSize: 10,
    includeRecordTypes: flag(setting(portal, 'Search/FacetedView'), true),
  });
  const culture = resxCulture(languageCode);
  const items = found.results.map((result) => searchResultItem(result, culture)).join('');
  const status =
    found.unavailable === 'disabled'
      ? 'Search is not enabled for this site.'
      : `${found.approximate_total_hits} result(s)`;
  const label = html(culture?.Search_DefaultText ?? 'Search');
  const pagination = searchPagination({ found, query, logicalNames, action, culture });
  const facets = searchFacetNavigation({ found, query, logicalNames, action, culture });
  const type = searchFilterControl({ portal, metadata: context.metadata, logicalNames });
  return `<!doctype html><html lang="${html(languageCode)}"><head><meta charset="utf-8"><title>${label}</title></head><body><main data-mirage-component="portal-search"><form method="get" action="${html(action)}"><input type="search" name="q" value="${html(query)}" aria-label="${label}">${type}<button type="submit">${label}</button></form>${facets}<p role="status">${html(status)}</p><ol>${items}</ol>${pagination}</main></body></html>`;
}
