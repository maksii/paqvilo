import { DataError } from './data-error.mjs';
import { parseXmlDocument } from './fetchxml-engine.mjs';
import { sdkValueToRecord as sdkRecordValue } from './local-organization-service.mjs';
import { isExactNumeric } from './exact-numeric.mjs';
const sdkValueToRecord = (value) => {
  const decoded = sdkRecordValue(value);
  return isExactNumeric(decoded) ? decoded.value : decoded;
};
const fail = (message) => {
  throw new DataError(message, 501, 'LocalPluginQueryUnsupported');
};
const name = (value) => {
  if (typeof value !== 'string' || !/^[a-z][\w]*$/i.test(value))
    fail('SDK query requires a logical field/table/alias name.');
  return value;
};
const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
const attrs = (value) =>
  Object.entries(value)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ' ' + k + '="' + escape(v) + '"')
    .join('');
const serialize = (node) =>
  '<' +
  node.name +
  attrs(node.attrs ?? {}) +
  '>' +
  escape(node.text ?? '') +
  (node.children ?? []).map(serialize).join('') +
  '</' +
  node.name +
  '>';
/** Preserve original QueryBase in the plugin context; this is an internal execution
 * adapter for the supported QE subset, not a native QueryExpression conversion. */
export function queryExpressionToFetch(query, store) {
  if (query.$type !== 'QueryExpression') fail('Linked SDK execution requires QueryExpression.');
  let count = 0;
  const columns = (c) =>
    c?.allColumns
      ? '<all-attributes />'
      : (c?.columns ?? []).map((column) => '<attribute name="' + name(column) + '" />').join('');
  const condition = (c) => {
    if (['Contains', 'DoesNotContain'].includes(c.operatorName))
      fail(
        'SDK full-text conditions require a source-qualified full-text execution adapter; wildcard LIKE is not equivalent.',
      );
    const ops = {
      Equal: 'eq',
      NotEqual: 'ne',
      GreaterThan: 'gt',
      GreaterEqual: 'ge',
      LessThan: 'lt',
      LessEqual: 'le',
      Null: 'null',
      NotNull: 'not-null',
      In: 'in',
      NotIn: 'not-in',
      Like: 'like',
      NotLike: 'not-like',
      BeginsWith: 'begins-with',
      EndsWith: 'ends-with',
    };
    const op = ops[c.operatorName];
    if (!op) fail('Unsupported SDK condition ' + c.operatorName);
    const values = (c.values ?? []).map(sdkValueToRecord);
    const start =
      '<condition' +
      attrs({ attribute: name(c.attributeName), operator: op, entityname: c.entityName ? name(c.entityName) : null });
    if (['null', 'not-null'].includes(op)) {
      if (values.length) fail('Null condition must not have values.');
      return start + ' />';
    }
    if (!['in', 'not-in'].includes(op)) {
      if (values.length !== 1 || (values[0] !== null && typeof values[0] === 'object'))
        fail('Unsupported SDK condition values.');
      return start + attrs({ value: values[0] }) + ' />';
    }
    if (!values.length || values.some((v) => v === null || typeof v === 'object'))
      fail('Unsupported SDK set condition values.');
    return start + '>' + values.map((v) => '<value>' + escape(v) + '</value>').join('') + '</condition>';
  };
  const filter = (f = {}, depth = 0) => {
    if (depth > 16) fail('SDK query filters exceed 16 levels.');
    const operator = f.operatorName ?? 'And';
    if (!['And', 'Or'].includes(operator)) fail('Unsupported SDK filter operator.');
    return (
      '<filter type="' +
      operator.toLowerCase() +
      '">' +
      (f.conditions ?? []).map(condition).join('') +
      (f.filters ?? []).map((child) => filter(child, depth + 1)).join('') +
      '</filter>'
    );
  };
  const orders = (list) =>
    (list ?? [])
      .map(
        (order) =>
          '<order' +
          attrs({ attribute: name(order.attributeName), descending: order.descending ? 'true' : 'false' }) +
          ' />',
      )
      .join('');
  const link = (value, parent, depth = 0) => {
    if (++count > 100 || depth > 16) fail('SDK query links exceed local bounds.');
    if (value.$type !== 'LinkEntity' || value.linkFromEntityName !== parent)
      fail(
        'SDK link parent table does not match the source tree: expected ' +
          parent +
          ', received ' +
          value.linkFromEntityName +
          ' (' +
          value.$type +
          ').',
      );
    const to = name(value.linkToEntityName);
    store.resolveMapping(to);
    const join = {
      Inner: 'inner',
      LeftOuter: 'outer',
      Exists: 'exists',
      In: 'in',
      Any: 'any',
      NotAny: 'not any',
      All: 'all',
      NotAll: 'not all',
      MatchFirstRowUsingCrossApply: 'matchfirstrowusingcrossapply',
    }[value.joinOperator ?? 'Inner'];
    if (!join) fail('Unsupported SDK join operator ' + value.joinOperator);
    return (
      '<link-entity' +
      attrs({
        name: to,
        from: name(value.linkToAttributeName),
        to: name(value.linkFromAttributeName),
        'link-type': join,
        alias: value.entityAlias ? name(value.entityAlias) : null,
      }) +
      '>' +
      columns(value.columns) +
      filter(value.linkCriteria) +
      orders(value.orders) +
      (value.linkEntities ?? []).map((child) => link(child, to, depth + 1)).join('') +
      '</link-entity>'
    );
  };
  const table = name(query.entityName),
    mapping = store.resolveMapping(table),
    page = query.pageInfo ?? {};
  if (
    query.topCount != null &&
    (page.count || page.pageNumber || page.pagingCookie || page.returnTotalRecordCount === true)
  )
    fail('SDK TopCount cannot be combined with paging or total count.');
  return (
    '<fetch' +
    attrs({
      distinct: query.distinct ? 'true' : null,
      top: query.topCount,
      count: page.count > 0 ? page.count : null,
      page: page.pageNumber > 0 ? page.pageNumber : null,
      'paging-cookie': page.pagingCookie,
      returntotalrecordcount: page.returnTotalRecordCount === true ? 'true' : null,
    }) +
    '><entity name="' +
    table +
    '">' +
    (query.columnSet?.allColumns
      ? columns(query.columnSet)
      : columns(query.columnSet) || '<attribute name="' + mapping.idColumn + '" />') +
    filter(query.criteria) +
    orders(query.orders) +
    (query.linkEntities ?? []).map((child) => link(child, table)).join('') +
    '</entity></fetch>'
  );
}
/** Identity is carried independently of projected Attributes. Internal primary-key
 * projection is removed from SDK Attributes and from the portal-shaped result. */
export function prepareFetchForSdk(xml, store) {
  const root = parseXmlDocument(xml),
    entity = root.children?.find((n) => n.name === 'entity');
  if (root.name !== 'fetch' || !entity) fail('FetchExpression root entity is missing.');
  const mapping = store.resolveMapping(entity.attrs.name),
    selected = entity.children.filter((n) => n.name === 'attribute'),
    all = entity.children.some((n) => n.name === 'all-attributes') || !selected.length;
  const hiddenId =
    root.attrs.aggregate !== 'true' &&
    root.attrs.distinct !== 'true' &&
    !all &&
    !selected.some((n) => n.attrs.name === mapping.idColumn && !n.attrs.alias);
  if (hiddenId) entity.children.push({ name: 'attribute', attrs: { name: mapping.idColumn }, children: [] });
  return { xml: hiddenId ? serialize(root) : xml, hiddenId, idColumn: mapping.idColumn };
}
export function fetchResultToSdkCollection(store, entity, answer, convert, { hiddenId = false, rootColumns } = {}) {
  const mapping = store.resolveMapping(entity),
    descriptions = answer.columns?.columns ?? [],
    byKey = new Map(descriptions.map((column) => [column.key, column]));
  const source = answer.executedXml ?? answer.xml,
    minActiveRequested = source && ['true', '1'].includes(parseXmlDocument(source).attrs['min-active-row-version']);
  if (minActiveRequested && answer.min_active_row_version == null)
    fail('Requested SDK minimum active row version requires a source-qualified Dataverse provider.');
  const entities = (answer.entities ?? []).map((row) => {
    const result = convert(store, entity, row, rootColumns ?? { allColumns: true });
    for (const [key, value] of Object.entries(row)) {
      const spec = byKey.get(key),
        alias = key.includes('.') ? key.slice(0, key.indexOf('.')) : null,
        logical = spec?.entity ?? answer.columns?.aliases?.[alias],
        attribute = spec?.attribute ?? (alias ? key.slice(key.indexOf('.') + 1) : null);
      if ((spec?.aliased || spec?.alias != null || alias) && logical && attribute) {
        if (value == null) {
          delete result.attributes[key];
          continue;
        }
        let typed;
        if (['count', 'countcolumn'].includes(spec?.aggregate)) {
          typed = Number(isExactNumeric(value) ? value.value : value);
          if (!Number.isInteger(typed) || typed < 0 || typed > 2147483647)
            fail('SDK Fetch aggregate count exceeds Int32 bounds.');
        } else {
          const converted = convert(store, logical, { [attribute]: value }, { allColumns: true });
          typed = converted.attributes[attribute];
          if (converted.formattedValues?.[attribute] !== undefined)
            (result.formattedValues ??= {})[key] = converted.formattedValues[attribute];
        }
        if (['count', 'countcolumn'].includes(spec?.aggregate)) (result.formattedValues ??= {})[key] = String(typed);
        result.attributes[key] = {
          $type: 'AliasedValue',
          entityLogicalName: logical,
          attributeLogicalName: attribute,
          value: typed,
        };
        if (spec?.groupby && typed?.$type === 'EntityReference' && typeof typed.name === 'string')
          result.attributes[`${key}_${attribute}name`] = {
            $type: 'AliasedValue',
            entityLogicalName: logical,
            attributeLogicalName: `${attribute}name`,
            value: typed.name,
          };
      }
    }
    if (hiddenId) delete result.attributes[mapping.idColumn];
    return result;
  });
  return {
    $type: 'EntityCollection',
    entities,
    entityName: answer.entity_name ?? mapping.logicalName,
    minActiveRowVersion: answer.min_active_row_version ?? '-1',
    moreRecords: Boolean(answer.more_records),
    pagingCookie: answer.paging_cookie ?? null,
    totalRecordCount: answer.total_record_count ?? -1,
    ...(answer.total_record_count_limit_exceeded === true ? { totalRecordCountLimitExceeded: true } : {}),
  };
}
