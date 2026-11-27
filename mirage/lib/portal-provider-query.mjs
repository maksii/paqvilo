// The query a virtual table's provider receives for a portal read, as the platform translates it.
//
// Hosted session F1 (DATA-01d, two runs, Liquid {% fetchxml %}, the portal Web API's fetchXml and OData reads; the provider
// was a custom data provider plug-in that echoed the query it received): the portal's query reached the provider's
// RetrieveMultiple as a QueryExpression, run as the site's application user, with
//   - the authored columns followed by the primary key (OData: the $select columns, then the primary key),
//   - the authored conditions: one authored filter became the criteria itself, several stayed nested filters,
//   - the authored orders ($orderby asc/desc),
//   - no TopCount and a PageInfo of page 1 with the authored count, $top, or 5,000.
// The provider's rows then came back as the provider returned them (see data.mjs providerAnsweredQuery).
// The provider still receives the OData text ({ select, filter, orderby, top }, the documented request shape) next to
// `query`; `query` is null when the read has no QueryExpression form here (an aggregate, an alias, a construct the
// conversions do not model).
// Assumed, not captured: a scoped table permission's predicate is part of the translated query (the recorder saw it in
// the portal's queries of ordinary tables; the virtual table of the capture had a Global permission, which adds none).
// Mirage still applies that predicate to the provider's rows itself, so a provider that ignores it never widens a grant.
import { parseXmlDocument } from './fetchxml-engine.mjs';
import { convertSdkQuery } from './plugin-query-conversion.mjs';
import { authoredScalarODataFetch } from './odata-permission-query.mjs';
import { serializePermissionFetchXml } from './permission-query.mjs';

const PAGE_SIZE = 5000;

const text = (params, name) => {
  if (!params) return null;
  const value = params instanceof URLSearchParams ? params.get(name) : params[name];
  return value == null ? null : String(value);
};

/** The documented OData request shape: select, filter and orderby as text, top as a number; null when absent. */
export function providerODataRequest(params) {
  const top = text(params, '$top');
  return {
    select: text(params, '$select'),
    filter: text(params, '$filter'),
    orderby: text(params, '$orderby'),
    top: top == null ? null : Number(top),
  };
}

// The platform's QueryExpression shape of the converted query (see the header).
function normalizeQuery(query, idColumn) {
  if (!query.columnSet.allColumns && !query.columnSet.columns.includes(idColumn))
    query.columnSet.columns = [...query.columnSet.columns, idColumn];
  const criteria = query.criteria;
  if (
    !criteria.conditions.length &&
    criteria.filters.length === 1 &&
    !criteria.filters[0].anyAllFilterLinkEntity &&
    !criteria.filters[0].filterHint
  )
    query.criteria = criteria.filters[0];
  query.topCount = null;
  return query;
}

/** The QueryExpression the provider receives for a portal FetchXML read (`xml`: the permission-compiled query). */
export function providerFetchQuery(store, xml, mapping) {
  try {
    const fetch = parseXmlDocument(xml, { root: 'fetch' });
    const count = fetch.attrs.count == null ? PAGE_SIZE : Number(fetch.attrs.count) || PAGE_SIZE;
    fetch.attrs = { ...fetch.attrs, count: String(count), page: fetch.attrs.page ?? '1' };
    delete fetch.attrs.top;
    delete fetch.attrs.returntotalrecordcount;
    const { Query } = convertSdkQuery(store, 'FetchXmlToQueryExpression', {
      FetchXml: serializePermissionFetchXml(fetch),
    });
    return normalizeQuery(Query, mapping.idColumn);
  } catch {
    return null;
  }
}

/** The FetchXML form of a portal OData collection read ($select, $filter, $orderby; $top as the page count), or null. */
export function providerODataFetch(params, mapping) {
  const request = providerODataRequest(params);
  const authored = {};
  for (const [key, value] of [
    ['$select', request.select],
    ['$filter', request.filter],
    ['$orderby', request.orderby],
  ])
    if (value != null) authored[key] = value;
  try {
    const fetch = parseXmlDocument(authoredScalarODataFetch(mapping.logicalName, authored), { root: 'fetch' });
    if (request.top != null && Number.isSafeInteger(request.top) && request.top > 0)
      fetch.attrs.count = String(request.top);
    return serializePermissionFetchXml(fetch);
  } catch {
    return null;
  }
}
