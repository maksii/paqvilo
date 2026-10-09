import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const failure = message => Object.assign(new Error(message), { status: 400, code: 'InvalidPagingToken' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Simulator cursors bind query, persona and data; they never grant record access.
 * `revision` is the store's data revision (DataStore#dataRevision), which advances with
 * every committed change, so a request doesn't digest the whole state.
 */
export function prepareODataPage({ url, prefer = '', identity, revision, secret }) {
  if (revision == null) throw new TypeError('prepareODataPage requires the data revision');
  const params = new URLSearchParams(url.searchParams);
  if (params.has('$skip')) throw Object.assign(new Error('The portal Web API does not support $skip; follow @odata.nextLink.'), { status: 400, code: 'QueryParamNotSupported' });
  const preference = /(?:^|,)\s*odata\.maxpagesize\s*=\s*(\d+)\s*(?:,|$)/i.exec(prefer);
  const pageSize = preference ? Math.min(Number(preference[1]), 5000) : 5000;
  if (!pageSize || !Number.isSafeInteger(pageSize)) throw failure('Invalid odata.maxpagesize preference.');
  // Current Power Pages observations retain $top as the total result bound,
  // unlike the direct Dataverse Web API's documented preference precedence.
  const encoded = params.get('$skiptoken'); params.delete('$skiptoken');
  const query = digest({ path: url.pathname, params: [...params.entries()].sort((a, b) => a[0].localeCompare(b[0])) });
  const context = digest({ identity, revision: String(revision) });
  let offset = 0, size = pageSize;
  const sign = data => createHmac('sha256', secret).update(data).digest('base64url');
  if (encoded) {
    if (encoded.length > 2048) throw failure('Invalid paging token.');
    const [data, signature, extra] = encoded.split('.');
    if (!data || !signature || extra) throw failure('Invalid paging token.');
    const expected = Buffer.from(sign(data)), actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw failure('Invalid paging token.');
    let cursor; try { cursor = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { throw failure('Invalid paging token.'); }
    if (cursor.query !== query || cursor.context !== context || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isInteger(cursor.pageSize) || cursor.pageSize < 1 || cursor.pageSize > 5000 || (preference && cursor.pageSize !== pageSize)) throw failure('Paging query, identity or local data changed; restart the query.');
    offset = cursor.offset; size = cursor.pageSize;
  }
  return { params, offset, pageSize: size, preferenceApplied: preference ? `odata.maxpagesize=${size}` : null,
    nextLink(nextOffset) {
      const data = Buffer.from(JSON.stringify({ query, context, offset: nextOffset, pageSize: size })).toString('base64url');
      // Dataverse next links keep OData punctuation literal ($select=...&$skiptoken=...).
      const encode = value => encodeURIComponent(value).replace(/%(24|28|29|27|2C|3A|2F|40)/gi, (_all, hex) => String.fromCharCode(parseInt(hex, 16)));
      const search = [...params.entries(), ['$skiptoken', data + '.' + sign(data)]].map(([key, value]) => encode(key) + '=' + encode(value)).join('&');
      return url.origin + url.pathname + '?' + search;
    },
  };
}
