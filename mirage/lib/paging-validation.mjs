import { requiredArgument } from './required-argument.mjs';
/**
 * Bounded acceptance collector. Never treats a partial or repeated page as complete. `simplePaging`: a page that reports
 * more records without a paging cookie continues with the next page number alone, as Dataverse falls back to simple
 * paging for a query that does not support cookies (Learn fetchxml/page-results, "Queries that don't support paging
 * cookies"); a repeated cookie or primary key still throws.
 */
export async function collectFetchXmlPages(
  { readPage, idColumn, pageSize = 5000, maxPages = 100, simplePaging = false } = requiredArgument(
    'collectFetchXmlPages(options)',
    'an options object with readPage and idColumn',
  ),
) {
  const records = [],
    pages = [],
    ids = new Set(),
    cookies = new Set();
  let cookie = null;
  for (let page = 1; page <= maxPages; page++) {
    const result = await readPage({ page, cookie, pageSize });
    // Dataverse omits @Microsoft.Dynamics.CRM.morerecords (and the cookie) on
    // the final page (fetchxml/page-results), so an absent flag means false.
    if (result && result.more_records === undefined) result.more_records = false;
    appendPageRecords(result, pageSize, idColumn, ids, records);
    pages.push({
      page,
      count: result.entities.length,
      requestCookie: cookie,
      responseCookie: result.paging_cookie ?? null,
      moreRecords: result.more_records,
    });
    if (!result.more_records) return { records, pages, complete: true };
    cookie = simplePaging && !result.paging_cookie ? nextSimplePage(result) : continuationCookie(result, cookies);
  }
  throw new Error('FetchXML continuation exceeded the bounded page limit.');
}

function appendPageRecords(result, pageSize, idColumn, ids, records) {
  if (!Array.isArray(result?.entities) || typeof result.more_records !== 'boolean')
    throw new Error('FetchXML page requires entities and an explicit more-records boolean.');
  if (result.entities.length > pageSize) throw new Error('FetchXML page exceeds requested count.');
  for (const record of result.entities) {
    const id = record?.[idColumn];
    if (typeof id !== 'string' || !id) throw new Error('FetchXML page omits the requested primary identifier.');
    if (ids.has(id.toLowerCase())) throw new Error('FetchXML continuation repeats a primary identifier.');
    ids.add(id.toLowerCase());
    records.push(record);
  }
}

function nextSimplePage(result) {
  if (!result.entities.length) throw new Error('FetchXML continuation returned an empty page.');
  return null;
}

function continuationCookie(result, cookies) {
  if (!result.entities.length) throw new Error('FetchXML continuation returned an empty page.');
  const cookie = result.paging_cookie;
  if (typeof cookie !== 'string' || !cookie || cookies.has(cookie))
    throw new Error('FetchXML continuation cookie is missing or repeated.');
  cookies.add(cookie);
  return cookie;
}

export const escapeXmlAttribute = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
