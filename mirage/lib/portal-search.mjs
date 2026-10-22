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
// ponytail: matching is the dataverse-search.mjs token match (any query term, `term*` prefixes; score = matched terms), not
// Dataverse's relevance index: Lucene operators, fuzzy and proximity are ignored, and the Search/Query weights of the
// default search page stay contract (PORTAL_SEARCH_QUERY_WEIGHTS_IGNORED). `filter` supports `+column:value` and
// `-column:value` clauses only; anything else is refused (PORTAL_SEARCH_FILTER_UNSUPPORTED).
import { executeGridQuery } from "./native-services.mjs";
import { searchTokens } from "./dataverse-search.mjs";
import { organizationRecord } from "./organization-context.mjs";
import { siteSetting } from "./redirects.mjs";

export const DEFAULT_SEARCH_TABLES = Object.freeze([
  "knowledgearticle", "adx_blog", "adx_blogpost", "adx_blogpostcomment", "adx_communityforum", "adx_communityforumpost",
  "adx_communityforumthread", "adx_idea", "adx_ideacomment", "adx_ideaforum", "adx_webfile", "adx_webpage", "incident",
]);
const MARKER_EXCEPTIONS = { incident: "Case", knowledgearticle: "Knowledge Article" };
const KNOWLEDGE_PUBLISHED = 3; // unverified: knowledgearticle statecode Published (Learn knowledgearticle table reference state values)

const setting = (portal, name) => siteSetting(portal ?? {}, name) ?? null;
const flag = (value, fallback) => (value == null || value === "" ? fallback : /^(?:true|1)$/i.test(String(value).trim()));
const canonical = (value) => String(value ?? "").replace(/[{}]/g, "").toLowerCase();
const html = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const text = (value) => (value == null ? "" : typeof value === "object" ? String(value.name ?? value.label ?? value.Name ?? value.value ?? "") : String(value));
const searchError = (message, code) => Object.assign(new Error(message), { status: 501, code });

/** Query terms: plain tokens, with a trailing `*` kept as a prefix marker; operators and Lucene syntax are dropped. */
function queryTerms(query) {
  return String(query ?? "").split(/\s+/).flatMap((word) => {
    if (/^(?:AND|OR|NOT|&&|\|\|)$/.test(word)) return [];
    const prefix = /\*$/.test(word);
    const parts = searchTokens(word.replace(/^[+\-!]/, ""));
    return parts.map((part, index) => ({ term: part, prefix: prefix && index === parts.length - 1 }));
  });
}

/** `filter`: required (+) and prohibited (-) column equality clauses. */
function filterClauses(filter) {
  if (filter == null || String(filter).trim() === "") return [];
  return String(filter).trim().split(/\s+/).map((clause) => {
    const match = /^([+-]?)([A-Za-z_][\w.]*):("?)([^"\s]+)\3$/.exec(clause);
    if (!match) throw searchError(`The searchindex filter clause '${clause}' is not supported locally; only +column:value and -column:value are.`, "PORTAL_SEARCH_FILTER_UNSUPPORTED");
    return { required: match[1] !== "-", column: match[2].toLowerCase(), value: match[4].toLowerCase() };
  });
}

/** The tables the site indexes: a view named by Search/IndexQueryName, the default set or additional entities on. */
export function indexedSearchTables(portal, metadata) {
  const viewName = String(setting(portal, "Search/IndexQueryName") ?? "Portal Search").trim().toLowerCase();
  const additional = flag(setting(portal, "Search/EnableAdditionalEntities"), false);
  const tables = new Map();
  for (const view of metadata?.views ?? []) {
    if (String(view.name ?? "").trim().toLowerCase() !== viewName || !view.entity) continue;
    if (!additional && !DEFAULT_SEARCH_TABLES.includes(view.entity)) continue;
    if (!tables.has(view.entity)) tables.set(view.entity, view);
  }
  return tables;
}

function resultUrl(portal, logicalName, id) {
  const page = portal?.sitemarkers?.[MARKER_EXCEPTIONS[logicalName] ?? `${logicalName}_SearchResultPage`];
  if (!page?.url) return null;
  return `${page.url}${page.url.includes("?") ? "&" : "?"}id=${encodeURIComponent(id)}`;
}

function fragmentOf(values, terms) {
  const hit = values.find((value) => terms.some(({ term, prefix }) => searchTokens(value).some((token) => (prefix ? token.startsWith(term) : token === term))));
  if (!hit) return null;
  const words = new Set(terms.map(({ term }) => term));
  // Matches are found in the raw text and each segment is escaped on its own, so an entity is never split.
  return hit.slice(0, 200).split(/([\p{L}\p{N}]+)/u).map((segment, index) => (index % 2 && (words.has(segment.toLowerCase()) || terms.some(({ term, prefix }) => prefix && segment.toLowerCase().startsWith(term))) ? `<em>${html(segment)}</em>` : html(segment))).join("");
}

/**
 * Runs a portal search for `identity`: { approximate_total_hits, page, page_size, results }. Each result carries entity, fragment,
 * id, logical_name, number, score, title and url (the searchindex object). Unavailable search answers no results and a diagnostic.
 */
export async function portalSearch({ portal, store, readProvider, metadata, config, identity, query = "", filter = null, logicalNames = null, page = 1, pageSize = 10, diagnostic = () => {} }) {
  page = Math.max(1, Math.floor(Number(page)) || 1);
  pageSize = Math.max(1, Math.min(Math.floor(Number(pageSize)) || 10, 1000));
  const empty = { approximate_total_hits: 0, page, page_size: pageSize, results: [] };
  if (!flag(setting(portal, "Search/Enabled"), true)) {
    diagnostic({ code: "PORTAL_SEARCH_DISABLED", severity: "info", component: "searchindex", message: "Search/Enabled is false: global search returns no results." });
    return { ...empty, unavailable: "disabled" };
  }
  if (organizationRecord(store)?.isexternalsearchindexenabled === false) {
    diagnostic({ code: "PORTAL_SEARCH_UNAVAILABLE", severity: "warning", component: "searchindex", message: "Dataverse search is turned off for the organization (isexternalsearchindexenabled); Power Pages search needs it." });
    return { ...empty, unavailable: "dataverse-search-off" };
  }
  const tables = indexedSearchTables(portal, metadata);
  const wanted = logicalNames == null || logicalNames === "" ? null : new Set(String(logicalNames).split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (!tables.size) {
    diagnostic({ code: "PORTAL_SEARCH_UNAVAILABLE", severity: "warning", component: "searchindex", message: `No table has a '${setting(portal, "Search/IndexQueryName") ?? "Portal Search"}' view that the site indexes, so global search returns no results.` });
    return { ...empty, unavailable: "no-indexed-tables" };
  }
  const terms = queryTerms(query);
  const clauses = filterClauses(filter);
  const hits = [];
  for (const [logicalName, view] of tables) {
    if (wanted && !wanted.has(logicalName)) continue;
    const mapping = store.resolveMapping(logicalName);
    // The record id is read with the view's columns (a view's fetch need not select it). Knowledge articles are searchable only
    // when Published and not Internal, whatever the view selects (Learn power-pages search overview, "can't be modified"): the
    // store row decides, never a projected column. A row without isinternal reads as the platform default No.
    const eligible = logicalName === "knowledgearticle" ? `<filter type="and"><condition attribute="statecode" operator="eq" value="${KNOWLEDGE_PUBLISHED}"/><filter type="or"><condition attribute="isinternal" operator="eq" value="0"/><condition attribute="isinternal" operator="null"/></filter></filter>` : "";
    const fetchXml = String(view.fetchXml ?? "").replace(/(<entity\b[^>]*>)/i, `$1<attribute name="${mapping.idColumn}"/>${eligible}`);
    const model = { kind: "view", entity: logicalName, idColumn: mapping.idColumn, primaryName: mapping.nameColumn, views: [{ ...view, fetchXml }], settings: {}, pageSize: 5000, search: { enabled: false }, userFilters: {}, filter: {} };
    // Every page of the view query (the grid's own paging), so the total counts the whole table.
    const rows = [];
    let result;
    for (let page = 1; ; page++) {
      result = await executeGridQuery(model, { page, pageSize: 5000, allowLargePages: true, search: "", viewId: view.id }, { portal, store, readProvider, identity, metadata, config, secure: null });
      if (result.accessDenied) break;
      rows.push(...(result.rows ?? []));
      if (!result.moreRecords || !result.rows?.length) break;
    }
    if (result.accessDenied) continue;
    const columns = result.layout.Columns.filter((column) => column.Type === 0).map((column) => column.LogicalName);
    for (const row of rows) {
      if (!clauses.every(({ required, column, value }) => (text(row[column]).toLowerCase() === value) === required)) continue;
      const values = columns.map((column) => text(row[column])).filter(Boolean);
      const tokens = new Set(values.flatMap(searchTokens));
      const score = terms.filter(({ term, prefix }) => (prefix ? [...tokens].some((token) => token.startsWith(term)) : tokens.has(term))).length;
      if (terms.length && !score) continue;
      const id = canonical(row[mapping.idColumn]);
      hits.push({ entity: { ...row, logical_name: logicalName }, fragment: terms.length ? fragmentOf(values, terms) : null, id, logical_name: logicalName, score, title: text(row[columns[0]]), url: resultUrl(portal, logicalName, id) });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const results = hits.slice((page - 1) * pageSize, page * pageSize).map((hit, index) => ({ ...hit, number: (page - 1) * pageSize + index + 1 }));
  return { approximate_total_hits: hits.length, page, page_size: pageSize, results };
}

/**
 * The default search page (`/search/?q=`) when the export has no page of its own at that path: local, labelled markup over
 * portalSearch. Search/Query weights apply only to this page natively and stay contract.
 */
export async function renderPortalSearchPage({ portal, params, diagnostic = () => {}, ...context }) {
  if (setting(portal, "Search/Query")) diagnostic({ code: "PORTAL_SEARCH_QUERY_WEIGHTS_IGNORED", severity: "info", component: "search", message: "Search/Query adds Lucene weights and filters to the default search page; the local search ignores them." });
  const query = String(params.get("q") ?? params.get("query") ?? "");
  const found = await portalSearch({ ...context, portal, diagnostic, query, logicalNames: params.get("logicalNames") || null, page: params.get("page") ?? 1, pageSize: 10 });
  const items = found.results.map((result) => `<li data-logical-name="${html(result.logical_name)}">${result.url ? `<a href="${html(result.url)}">${html(result.title)}</a>` : html(result.title)}${result.fragment ? `<p>${result.fragment}</p>` : ""}</li>`).join("");
  const status = found.unavailable === "disabled" ? "Search is not enabled for this site." : `${found.approximate_total_hits} result(s)`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Search</title></head><body><main data-mirage-component="portal-search"><form method="get" action="/search/"><input type="search" name="q" value="${html(query)}" aria-label="Search"><button type="submit">Search</button></form><p role="status">${html(status)}</p><ol>${items}</ol></main></body></html>`;
}
