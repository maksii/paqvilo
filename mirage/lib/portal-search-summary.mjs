// The Search Summary API (Learn power-pages/configure/search/generative-ai) with a local stand-in for the AI: a
// registered pack's portalSearchSummary provider writes the summary text. Hosted session F3 (summary-F3.md API-05d, runs a
// and b, anonymous and signed-in) fixes the HTTP contract this module reproduces:
// - POST /_api/search/v1.0/summary takes a form or JSON userQuery; /summarystream takes JSON UserQuery and answers
//   text/event-stream "data: <answer>" events, each a "Partial Message" piece of the summary.
// - The answer keys are Summary, SummaryTitle, SearchTitle, ErrorMessage, ResponseStatus { Code, Message }, Citations,
//   CitationTitleMapping and Chunks; a citation is [[n]](url) in the summary and Citations maps "[n]" to the url.
// - Nothing found: 200 with ErrorMessage and "No relevant chunks found in dataverse."; sources but no summary: 200 with
//   "No relevant responses were found."; no query: 500 with the same keys.
// - The sources are what the visitor's portal search finds (Learn: "The same content is used by both generative AI
//   search and keyword search"): web pages, cited by their page URL (the captured citations), and knowledge articles,
//   cited by the Knowledge Article page with the article id in `id` (Learn "Refine search source": the page must use
//   'id'). An article needs a knowledgearticle read permission, its content access level (portal-search.mjs) and read
//   access to its content column. The F3 site's search index listed no article (search.json q=pqf3: 28 web pages), so
//   the capture shows no article citation either way. A web page in a non-visible publishing state follows
//   observed.searchUnpublishedPages as the search results do. The request filters (X-Requested-With, token) are the
//   server's (server.mjs portalAiRequestRefused).
import { packHandlerAnswer } from './pack-handler-answer.mjs';
import { portalSearch } from './portal-search.mjs';
import { MAX_QUERY_LENGTH } from './portal-search-query.mjs';

export const PORTAL_SEARCH_SUMMARY = '/_api/search/v1.0/summary';
export const PORTAL_SEARCH_SUMMARY_STREAM = '/_api/search/v1.0/summarystream';
const PORTAL_SEARCH_SUMMARY_BODY_LIMIT = 16 * 1024;
const WEB_PAGE = 'adx_webpage';
const KNOWLEDGE = 'knowledgearticle';
const MAX_CITATIONS = 10;
const MAX_CONTENT_LENGTH = 4000;
const MAX_SUMMARY_LENGTH = 8000;
const SORRY = "I'm sorry, I'm unable to process your question. Can you rephrase or ask another question?";
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** One answer object with the captured keys and titles. */
const answer = (fields = {}) => ({
  Summary: null,
  SummaryTitle: 'Summarized by AI',
  SearchTitle: 'Other results',
  ErrorMessage: null,
  ResponseStatus: { Code: 200, Message: 'Success' },
  Citations: null,
  CitationTitleMapping: null,
  Chunks: null,
  ...fields,
});
const noChunks = () =>
  answer({ ErrorMessage: SORRY, ResponseStatus: { Code: 200, Message: 'No relevant chunks found in dataverse.' } });
const noResponse = () =>
  answer({ ErrorMessage: SORRY, ResponseStatus: { Code: 200, Message: 'No relevant responses were found.' } });
/** The 500 answer to a request without a query (captured for an empty body). */
export const unansweredSummary = () => answer({ ErrorMessage: SORRY, ResponseStatus: { Code: 500, Message: SORRY } });

// The userQuery (or summarystream UserQuery) values of a JSON object body: none or one string.
function jsonSummaryQueries(body) {
  let parsed;
  try {
    parsed = body.trim() ? JSON.parse(body) : {};
  } catch {
    throw fail('Search summary requires a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw fail('Search summary requires a JSON object.');
  const value = parsed.userQuery ?? parsed.UserQuery;
  if (value != null && typeof value !== 'string') throw fail('userQuery must be a string.');
  return value == null ? [] : [value];
}

/**
 * The visitor query of a summary request, or null when the request carries none (answered with unansweredSummary). Form
 * data names it userQuery; a JSON object userQuery or UserQuery (the summarystream body). Several values, a query over
 * the local length limit or another body type are refused with 400.
 */
export async function readSummaryQuery(req, rawBody) {
  const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  const body = (await rawBody(req, PORTAL_SEARCH_SUMMARY_BODY_LIMIT)).toString('utf8');
  let values;
  if (contentType === 'application/json') values = jsonSummaryQueries(body);
  else if (contentType === 'application/x-www-form-urlencoded' || !body)
    values = new URLSearchParams(body).getAll('userQuery');
  else throw fail('Search summary requires form data or a JSON object.');
  if (values.length > 1) throw fail('Search summary takes one userQuery.');
  const query = values[0]?.trim();
  if (!query) return null;
  if (query.length > MAX_QUERY_LENGTH)
    throw fail(`A search summary userQuery is at most ${MAX_QUERY_LENGTH} characters.`);
  return query;
}

const LIQUID_DELIMITERS = [
  ['{%', '%}'],
  ['{{', '}}'],
];
// The end of the Liquid tag or output that opens at `at` (after its nearest closing delimiter), or -1. `missing` holds
// the closing delimiters absent from the text after an earlier position, so later openings skip the search.
function liquidEnd(text, at, missing) {
  for (const [open, close] of LIQUID_DELIMITERS) {
    if (!text.startsWith(open, at) || missing.has(close)) continue;
    const end = text.indexOf(close, at + open.length);
    if (end !== -1) return end + close.length;
    missing.add(close);
  }
  return -1;
}
// Each Liquid tag ({% %}) and output ({{ }}) as a space, ended by its nearest closing delimiter; an opening that is never
// closed stays as text. A linear scan: each position is searched at most once per delimiter.
function withoutLiquid(text) {
  const missing = new Set();
  let result = '';
  let emitted = 0;
  let at = text.indexOf('{');
  while (at !== -1) {
    const end = liquidEnd(text, at, missing);
    if (end === -1) {
      at = text.indexOf('{', at + 1);
      continue;
    }
    result += `${text.slice(emitted, at)} `;
    emitted = end;
    at = text.indexOf('{', end);
  }
  return result + text.slice(emitted);
}
// Each markup tag (a < through the next >) as a space; a < with no > after it stays as text.
function withoutTags(text) {
  let result = '';
  let emitted = 0;
  let at = text.indexOf('<');
  while (at !== -1) {
    const end = text.indexOf('>', at + 1);
    if (end === -1) break;
    result += `${text.slice(emitted, at)} `;
    emitted = end + 1;
    at = text.indexOf('<', emitted);
  }
  return result + text.slice(emitted);
}

// The page copy as text: markup, Liquid tags and outputs removed, whitespace collapsed.
const pageText = (html) =>
  withoutTags(withoutLiquid(String(html ?? '')).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' '))
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// The citation URL when it is a same-origin page the visitor may open, else null. `found` marks a web page the search
// found (its publishing state follows observed.searchUnpublishedPages), not the page that shows an article.
function admittedCitation(url, origin, canReadPage, found = false) {
  const citation = URL.parse(url, origin);
  if (citation?.origin !== origin || citation.username || citation.password || citation.hash) return null;
  return canReadPage(citation, { found }) ? citation : null;
}

// A knowledge article source: its indexed content, readable content and title columns, and a citation page that names
// exactly this article and that the visitor may open.
function visibleArticle(hit, { origin, canReadColumn, canReadPage }) {
  const { id, title, url, grounding } = hit;
  if (!id || !url || typeof grounding?.content !== 'string' || !grounding.content.trim()) return null;
  if (!canReadColumn('content', id)) return null;
  const citation = admittedCitation(url, origin, canReadPage);
  const ids = citation?.searchParams.getAll('id') ?? [];
  if (ids.length !== 1 || ids[0] !== id) return null;
  return {
    id,
    title: canReadColumn(grounding.titleColumn, id) ? String(title || '').slice(0, 256) : '',
    content: grounding.content.slice(0, MAX_CONTENT_LENGTH),
    url: citation.href,
  };
}

function visibleSource(hit, { origin, portal, canReadPage }) {
  const page = (portal.pages ?? []).find((item) => String(item.id).toLowerCase() === hit.id);
  if (!page?.url) return null;
  const citation = admittedCitation(page.url, origin, canReadPage, true);
  if (!citation) return null;
  const content = pageText(page.html).slice(0, MAX_CONTENT_LENGTH);
  if (!content) return null;
  return { id: hit.id, title: String(page.title || hit.title || '').slice(0, 256), content, url: citation.href };
}

/**
 * The summary sources: up to ten web pages and knowledge articles the visitor's portal search finds (web page access
 * rules, the publishing-state rule, table permissions, content access levels and query matching apply), each readable
 * by the visitor at its own URL. Articles are searched only for a visitor with a knowledgearticle read permission.
 */
export async function searchSummarySources({ query, origin, canReadPage, ...context }) {
  const { store, portal, identity } = context;
  if (store.state.settings.permissionMode === 'permissive') return [];
  const articles = store.rules(KNOWLEDGE, 'read', identity).length > 0;
  const canReadColumn = (name, id) =>
    store.portalAuthorization?.canReadRawColumn(identity, KNOWLEDGE, name, id) !== false;
  const found = await portalSearch({
    ...context,
    query,
    logicalNames: articles ? `${WEB_PAGE},${KNOWLEDGE}` : WEB_PAGE,
    includeGrounding: articles,
    pageSize: MAX_CITATIONS,
  });
  return found.results
    .map((hit) =>
      hit.logical_name === KNOWLEDGE
        ? visibleArticle(hit, { origin, canReadColumn, canReadPage })
        : visibleSource(hit, { origin, portal, canReadPage }),
    )
    .filter(Boolean);
}

// The provider supplies plain summary text and source IDs. The runtime alone emits links.
export async function summarizeSearch(provider, query, sources) {
  if (!sources.length) return noChunks();
  const admitted = new Map(sources.map(({ url, id }) => [id, url]));
  let reply;
  try {
    reply = await packHandlerAnswer({ kind: 'portalSearchSummary', name: 'search summary', usable: () => true }, () =>
      provider({ query, sources: sources.map(({ id, title, content }) => ({ id, title, content })) }),
    );
  } catch (error) {
    if (error?.code === 'PackHandlerTimeout') throw error;
    throw fail('The local search summary provider failed.', 500);
  }
  const { summary, citationIds } = reply ?? {};
  if (
    typeof summary !== 'string' ||
    summary.length > MAX_SUMMARY_LENGTH ||
    !Array.isArray(citationIds) ||
    citationIds.length > admitted.size ||
    new Set(citationIds).size !== citationIds.length ||
    citationIds.some((id) => !admitted.has(id))
  )
    throw fail('The local search summary provider returned an invalid summary or citation ID.', 500);
  if (!summary.trim()) return noResponse();
  const pairs = citationIds.map((id, index) => [`[${index + 1}]`, admitted.get(id)]);
  const markers = pairs.map(([label, url]) => `[${label}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})`);
  // Quote HTML and brackets before concatenating the only recognised inline citation markers.
  const escaped = summary.replace(/[&<>[\]]/g, (char) => `&#${char.codePointAt(0)};`);
  const citations = pairs.length ? Object.fromEntries(pairs) : null;
  return answer({
    Summary: [escaped, markers.join('')].filter(Boolean).join(' '),
    Citations: citations,
    CitationTitleMapping: citations,
  });
}

// The word pieces of a summary: each word with the whitespace before it; whitespace after the last word is dropped.
function summaryPieces(summary) {
  const pieces = [];
  let start = 0;
  for (const word of summary.matchAll(/\S+/g)) {
    const end = word.index + word[0].length;
    pieces.push(summary.slice(start, end));
    start = end;
  }
  return pieces;
}

/**
 * The summarystream body of an answer: "data: <JSON>" events. A summary is sent in word pieces as "Partial Message"
 * events, the first carrying the titles; another answer is one event. Only the opening partial events were captured
 * (the capture was cut at 3,000 characters), so the stream ends after the last piece.
 */
export function summaryStreamEvents(value) {
  if (typeof value.Summary !== 'string' || !value.Summary) return `data: ${JSON.stringify(value)}\n\n`;
  const pieces = summaryPieces(value.Summary);
  return pieces
    .map((piece, index) =>
      JSON.stringify({
        ...answer({
          Summary: piece,
          ResponseStatus: { Code: 200, Message: 'Partial Message' },
        }),
        ...(index ? { SummaryTitle: null, SearchTitle: null } : {}),
      }),
    )
    .map((event) => `data: ${event}\n\n`)
    .join('');
}
