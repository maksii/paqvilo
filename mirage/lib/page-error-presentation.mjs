import { randomUUID } from 'node:crypto';
import { effectiveSnippetRecords, portalField } from './importer.mjs';

const TITLE = "We're sorry, but something went wrong (500)";
const HEADING =
  "We're sorry, but something went wrong. Please try again, and if this persists, contact the website administrator.";
const BOUNDARY = 'A potentially dangerous Request.QueryString value was detected from the client';
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );

/** Drop authored Liquid from a custom error snippet without invoking the renderer. */
function errorSnippetMarkup(portal, languageId) {
  if (!portal?.records) return '';
  const record = effectiveSnippetRecords(portal.records, languageId).resolve('Portal Generic Error');
  if (!record) return '';
  const source = portal.snippetTranslations?.[languageId]?.[record.name] ?? portal.snippets?.[record.name];
  if (!source?.trim()) return '';
  const opening = /\{\{|\{%/g;
  let result = '',
    from = 0;
  for (const match of source.matchAll(opening)) {
    if (match.index < from) continue;
    result += source.slice(from, match.index);
    const close = source.indexOf(match[0] === '{{' ? '}}' : '%}', match.index + 2);
    from = close < 0 ? source.length : close + 2;
  }
  result += source.slice(from);
  if (!result.trim()) return '';
  return Number(portalField(record, 'type')) === 756150001 ? result : `<p>${escape(result)}</p>`;
}

/**
 * A site's selected, evidenced error structure. No request values, native opaque
 * identifiers, scripts, stylesheet bytes or unobserved exceptions are replayed.
 * This deliberately does not claim complete hosted error-document parity.
 */
export function observedPageErrorResponse({ method, error, observed, portal, languageId, now = Date.now() } = {}) {
  if (
    observed?.pageErrorPresentation !== 'generic-error' ||
    method !== 'GET' ||
    error?.code !== 'PAGE_QUERY_REQUEST_VALIDATION' ||
    (error.status ?? error.statusCode) !== 500
  )
    return null;
  const id = randomUUID();
  const markup = errorSnippetMarkup(portal, languageId);
  const custom = Boolean(markup);
  const heading = markup || `<h1>${escape(HEADING)}</h1>`;
  const details = custom
    ? `<div>Date and time: ${new Date(now).toISOString()}</div><div>Portal ID: ${escape(portal.website?.id ?? '')}</div>`
    : `<div>${escape(BOUNDARY)}</div>`;
  return {
    status: 500,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    custom,
    body: `<!doctype html><html><head><title>${escape(TITLE)}</title></head><body>${heading}<h1>Error ID: [${id}]</h1>${details}</body></html>`,
  };
}
