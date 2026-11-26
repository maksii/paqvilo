import { packHandlerAnswer } from './pack-handler-answer.mjs';
import { portalSearch } from './portal-search.mjs';
import { MAX_QUERY_LENGTH } from './portal-search-query.mjs';

export const PORTAL_SEARCH_SUMMARY = '/_api/search/v1.0/summary';
const PORTAL_SEARCH_SUMMARY_BODY_LIMIT = 16 * 1024;
const KNOWLEDGE = 'knowledgearticle';
const MAX_CITATIONS = 10;
const MAX_CONTENT_LENGTH = 4000;
const MAX_SUMMARY_LENGTH = 8000;
const empty = () => ({ Summary: '', Citations: {} });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export async function readSummaryQuery(req, rawBody) {
  const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') throw fail('Search summary requires form data.');
  const body = await rawBody(req, PORTAL_SEARCH_SUMMARY_BODY_LIMIT);
  const values = new URLSearchParams(body.toString('utf8')).getAll('userQuery');
  const query = values[0]?.trim();
  if (values.length !== 1 || !query || query.length > MAX_QUERY_LENGTH)
    throw fail(`Search summary requires one userQuery of at most ${MAX_QUERY_LENGTH} characters.`);
  return query;
}

function visibleSource(hit, { origin, canReadColumn, canReadPage }) {
  const { id, title, url, grounding } = hit;
  if (!id || !url || typeof grounding?.content !== 'string' || !grounding.content.trim()) return null;
  if (!canReadColumn('content', id)) return null;
  const citation = URL.parse(url, origin);
  if (citation?.origin !== origin || citation.username || citation.password || citation.hash) return null;
  const ids = citation.searchParams.getAll('id');
  if (ids.length !== 1 || ids[0] !== id || !canReadPage(citation)) return null;
  return {
    id,
    title: canReadColumn(grounding.titleColumn, id) ? title.slice(0, 256) : '',
    content: grounding.content.slice(0, MAX_CONTENT_LENGTH),
    url: citation.href,
  };
}

export async function searchSummarySources({ query, origin, canReadPage, ...context }) {
  const { store, identity } = context;
  if (store.state.settings.permissionMode === 'permissive' || !store.rules(KNOWLEDGE, 'read', identity).length)
    return [];
  const canReadColumn = (name, id) =>
    store.portalAuthorization?.canReadRawColumn(identity, KNOWLEDGE, name, id) !== false;
  const found = await portalSearch({
    ...context,
    query,
    logicalNames: KNOWLEDGE,
    includeGrounding: true,
    pageSize: MAX_CITATIONS,
  });
  return found.results.map((hit) => visibleSource(hit, { origin, canReadColumn, canReadPage })).filter(Boolean);
}

// The provider supplies plain summary text and article IDs. The runtime alone emits links.
export async function summarizeSearch(provider, query, sources) {
  if (!sources.length) return empty();
  const admitted = new Map(sources.map(({ url, id }) => [id, url]));
  let answer;
  try {
    answer = await packHandlerAnswer({ kind: 'portalSearchSummary', name: 'search summary', usable: () => true }, () =>
      provider({ query, sources: sources.map(({ id, title, content }) => ({ id, title, content })) }),
    );
  } catch (error) {
    if (error?.code === 'PackHandlerTimeout') throw error;
    throw fail('The local search summary provider failed.', 500);
  }
  const { summary, citationIds } = answer ?? {};
  if (
    typeof summary !== 'string' ||
    summary.length > MAX_SUMMARY_LENGTH ||
    !Array.isArray(citationIds) ||
    citationIds.length > admitted.size ||
    new Set(citationIds).size !== citationIds.length ||
    citationIds.some((id) => !admitted.has(id))
  )
    throw fail('The local search summary provider returned an invalid summary or citation ID.', 500);
  if (!summary.trim()) return empty();
  const pairs = citationIds.map((id, index) => [`[${index + 1}]`, admitted.get(id)]);
  const markers = pairs.map(([label, url]) => `[${label}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})`);
  // Quote HTML and brackets before concatenating the only recognised inline citation markers.
  const escaped = summary.replace(/[&<>[\]]/g, (char) => `&#${char.codePointAt(0)};`);
  return { Summary: [escaped, ...markers].join(' '), Citations: Object.fromEntries(pairs) };
}
