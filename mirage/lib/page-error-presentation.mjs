import { randomUUID } from 'node:crypto';
import { effectiveSnippetRecords, portalField } from './importer.mjs';
import { siteSetting } from './redirects.mjs';

const TITLE = "We're sorry, but something went wrong (500)";
const HEADING =
  "We're sorry, but something went wrong. Please try again, and if this persists, contact the website administrator.";
const MITIGATION = 'Please review the error message and take appropriate action based on its details.';
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

/** .NET round-trip time ("2026-01-02T03:04:05.0060000+00:00"), as the server log entries carry it. */
const roundTrip = (time) => new Date(time).toISOString().replace(/Z$/, '0000+00:00');

/** The en-US general date and time of the error dialog ("1/2/2026 3:04:05 AM"), in UTC. */
function dialogTime(time) {
  const date = new Date(time);
  const hours = date.getUTCHours();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()} ${hours % 12 || 12}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${hours < 12 ? 'AM' : 'PM'}`;
}

/**
 * The server log entries the error page hands to the Power Pages DevTools extension (`updateDevToolRuntime`), as hosted
 * session F3 captured them for every 500, also for an anonymous visitor: RTSS09 when the HTTP/X-Content-Type-Options
 * site setting is not nosniff, RTDV01 for a Dataverse error, then RTGE01, whose message gains the exception message only
 * when custom errors are disabled (observed.customErrors). The native Dataverse request timings (RTPMDV) are not
 * produced: they describe the hosted service, not the site.
 */
function devToolServerLog({ error, observed, portal, requestPath = '/', now = Date.now() }) {
  const entry = (level, code, message, mitigation = MITIGATION) => ({
    Timestamp: roundTrip(now),
    PortalID: observed?.portalId ?? portal?.website?.id ?? '',
    Source: 'Server',
    Level: level,
    RequestPath: requestPath,
    MessageCode: code,
    Message: message,
    Mitigation: mitigation,
  });
  const entries = [];
  if (
    String(siteSetting(portal ?? {}, 'HTTP/X-Content-Type-Options') ?? '')
      .trim()
      .toLowerCase() !== 'nosniff'
  )
    entries.push(
      entry(
        'Warning',
        'RTSS09',
        'HTTP/X-Content-Type-Options site setting is missing or misconfigured.',
        'The recommendation is to configure it to nosniff. <a href="https://learn.microsoft.com/en-us/power-pages/configure/cors-support%20">Learn more</a>',
      ),
    );
  if (error?.dataverse) entries.push(entry('Error', 'RTDV01', `Error Message from Dataverse: ${error.message ?? ''}`));
  entries.push(
    entry('Error', 'RTGE01', `Error occurred : ${observed?.customErrors === 'disabled' ? (error?.message ?? '') : ''}`),
  );
  return entries;
}

// The log is JSON inside a script element: markup delimiters are written as JSON escapes.
const scriptJson = (value) =>
  JSON.stringify(value, null, 2).replace(
    /[<>&]/g,
    (c) => String.raw`\u${c.codePointAt(0).toString(16).padStart(4, '0')}`,
  );

/**
 * A site's selected, evidenced error page. Hosted session F3 (two runs): every server exception of a page request answers
 * this page, the generic title and dialog (heading, `Error ID # [<id>]`, the UTC time) after the server log script. An
 * exported `Portal Generic Error` snippet replaces the heading inside the same dialog: inferred, F3 had no such snippet
 * (an earlier site showed the snippet with its own error id and portal id lines). The hosted telemetry scripts,
 * stylesheet, request values and native identifiers are not replayed; the error id is a fresh local UUID.
 */
export function observedPageErrorResponse({
  method,
  error,
  observed,
  portal,
  languageId,
  requestPath = '/',
  now = Date.now(),
} = {}) {
  if (
    observed?.pageErrorPresentation !== 'generic-error' ||
    method !== 'GET' ||
    (error?.status ?? error?.statusCode) !== 500
  )
    return null;
  const id = randomUUID();
  const markup = errorSnippetMarkup(portal, languageId);
  const custom = Boolean(markup);
  const log = devToolServerLog({ error, observed, portal, requestPath, now });
  const script =
    "<script type = 'text/javascript'>\r\n\tdocument.addEventListener('contentSnippetLoaded', function() {\r\n\t\tdocument.dispatchEvent(new CustomEvent('updateDevToolRuntime',\r\n\t\t\t{\r\n\t\t\t\tdetail: " +
    scriptJson(log) +
    '\r\n\t\t\t}));\r\n\t});\r\n</script>';
  const heading = custom ? markup : `<h1>${escape(HEADING)}</h1>`;
  return {
    status: 500,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    custom,
    body: `<!doctype html><html><head><title>${escape(TITLE)}</title></head><body>${script}<div class='dialog' role='main'>${heading}<h1>Error ID # [${id}]</h1><p><small>${dialogTime(now)}&nbsp;UTC</small></p></div></body></html>`,
  };
}

/**
 * The platform's generic error document (500, text/html) with a fresh error id, as a portal API answers a request it refuses
 * before its action runs (hosted session F8: the cloud-flow API without its anti-forgery token or X-Requested-With, or with a
 * body that does not parse). Its title is the captured one; no script, request value or native identifier is replayed.
 */
export function platformErrorDocument() {
  return `<!doctype html><html><head><title>${escape(TITLE)}</title></head><body><h1>${escape(HEADING)}</h1><h1>Error ID: [${randomUUID()}]</h1></body></html>`;
}
