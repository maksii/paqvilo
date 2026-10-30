import { DataError } from './data-error.mjs';
import { parseXmlDocument, planFetch } from './fetchxml-engine.mjs';
import { queryExpressionToFetch } from './plugin-sdk-query.mjs';
import { fieldKind, GUID_PATTERN } from './dataverse-values.mjs';
import { CRM_FUNCTIONS } from './dataverse-conditions.mjs';

const fail = (message) => {
  throw new DataError(message, 501, 'LocalPluginQueryUnsupported');
};
const boolean = (value) => /^(?:true|1)$/i.test(String(value ?? '').trim());
const operators = {
  ...Object.fromEntries(
    Object.entries(CRM_FUNCTIONS)
      .filter(([, spec]) => spec.operator)
      .map(([name, spec]) => [spec.operator, name]),
  ),
  eq: 'Equal',
  ne: 'NotEqual',
  gt: 'GreaterThan',
  ge: 'GreaterEqual',
  lt: 'LessThan',
  le: 'LessEqual',
  null: 'Null',
  'not-null': 'NotNull',
  in: 'In',
  'not-in': 'NotIn',
  like: 'Like',
  'not-like': 'NotLike',
  'begins-with': 'BeginsWith',
  'not-begin-with': 'DoesNotBeginWith',
  'ends-with': 'EndsWith',
  'not-end-with': 'DoesNotEndWith',
};

export function convertSdkQuery(store, message, parameters) {
  if (message === 'QueryExpressionToFetchXml') {
    const allowed = new Set([
      '$type',
      'entityName',
      'columnSet',
      'criteria',
      'orders',
      'topCount',
      'distinct',
      'pageInfo',
      'linkEntities',
      'noLock',
      'queryHints',
      'dataSource',
    ]);
    if (!parameters.Query || Object.keys(parameters.Query).some((key) => !allowed.has(key)))
      fail('QueryExpression conversion contains an unsupported query property.');
    return { FetchXml: queryExpressionToFetch(parameters.Query, store) };
  }
  const fetch = parseXmlDocument(parameters.FetchXml);
  planFetch(fetch, { profile: 'sdk', limits: store.querySettings().fetchLimits });
  if (boolean(fetch.attrs.aggregate)) fail('Aggregate FetchXML conversion requires aggregate QueryExpression support.');
  const attributes = {
    fetch: [
      'version',
      'mapping',
      'distinct',
      'top',
      'count',
      'page',
      'paging-cookie',
      'returntotalrecordcount',
      'aggregate',
      'no-lock',
      'options',
      'datasource',
    ],
    entity: ['name'],
    'link-entity': ['name', 'from', 'to', 'link-type', 'alias', 'intersect'],
    attribute: ['name'],
    'all-attributes': [],
    filter: ['type', 'hint', 'isquickfindfields'],
    order: ['attribute', 'descending', 'entityname'],
    condition: ['attribute', 'operator', 'value', 'entityname'],
    value: [],
  };
  const validate = (node) => {
    if (!attributes[node.name] || Object.keys(node.attrs).some((key) => !attributes[node.name].includes(key)))
      fail('Unsupported FetchXML conversion element or attribute: ' + node.name);
    for (const child of node.children) validate(child);
  };
  validate(fetch);
  const aliases = new Map();
  const index = (node) => {
    if (['entity', 'link-entity'].includes(node.name)) {
      aliases.set(node.attrs.name, node.attrs.name);
      if (node.attrs.alias) aliases.set(node.attrs.alias, node.attrs.name);
    }
    for (const child of node.children) index(child);
  };
  index(fetch);
  const typedValue = (value, table, attribute, operator) => {
    const mapping = store.resolveMapping(table),
      definition = store.fieldDefinition(table, attribute);
    const kind = attribute === mapping.idColumn ? 'guid' : fieldKind(definition);
    if (
      kind === 'datetime' &&
      ['on', 'on-or-after', 'on-or-before'].includes(operator) &&
      /^\d{4}-\d\d-\d\d$/.test(value)
    )
      return value + 'T00:00:00+00:00';
    if (['guid', 'lookup'].includes(kind) && GUID_PATTERN.test(value)) return { $type: 'Guid', value };
    if (kind === 'boolean' && ['0', '1', 'false', 'true'].includes(value.toLowerCase()))
      return ['1', 'true'].includes(value.toLowerCase());
    if (['integer', 'choice', 'multichoice'].includes(kind) && /^-?\d+$/.test(value)) {
      if (String(definition?.dataverseType ?? definition?.type).toLowerCase() === 'bigint')
        return { $type: 'Int64', value };
      const number = Number(value);
      if (Number.isInteger(number) && number >= -2147483648 && number <= 2147483647) return number;
    }
    if (['decimal', 'money'].includes(kind) && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value))
      return { $type: 'Decimal', value };
    if (kind === 'double' && Number.isFinite(Number(value))) return { $type: 'Double', value };
    return value;
  };
  const filter = (node, logical) => ({
    operatorName: (node.attrs.type ?? 'and') === 'or' ? 'Or' : 'And',
    ...(node.attrs.hint ? { filterHint: node.attrs.hint } : {}),
    ...(boolean(node.attrs.isquickfindfields) ? { isQuickFindFilter: true } : {}),
    filters: [
      ...node.children.filter((child) => child.name === 'filter').map((child) => filter(child, logical)),
      ...node.children
        .filter((child) => child.name === 'link-entity')
        .map((child) => {
          if (!['any', 'not any', 'all', 'not all'].includes(child.attrs['link-type']))
            fail('A FetchXML filter link requires an Any/All condition conversion.');
          return { operatorName: 'And', conditions: [], filters: [], anyAllFilterLinkEntity: entity(child, logical) };
        }),
    ],
    conditions: node.children
      .filter((child) => child.name === 'condition')
      .map((condition) => {
        const operatorName = operators[condition.attrs.operator];
        if (!operatorName || condition.attrs.valueof)
          fail('Unsupported FetchXML condition conversion: ' + condition.attrs.operator);
        return {
          attributeName: condition.attrs.attribute,
          operatorName,
          ...(condition.attrs.entityname ? { entityName: condition.attrs.entityname } : {}),
          values: (Object.hasOwn(condition.attrs, 'value')
            ? [condition.attrs.value]
            : condition.children.filter((child) => child.name === 'value').map((child) => child.text)
          ).map((value) =>
            typedValue(
              value,
              aliases.get(condition.attrs.entityname) ?? logical,
              condition.attrs.attribute,
              condition.attrs.operator,
            ),
          ),
        };
      }),
  });
  const entity = (node, parent) => {
    const attrs = node.children.filter((child) => child.name === 'attribute');
    if (attrs.some((attribute) => attribute.attrs.alias || attribute.attrs.aggregate || attribute.attrs.groupby))
      fail('Aliased/aggregate FetchXML attributes need an explicit QueryExpression conversion adapter.');
    const result = {
      columnSet: {
        allColumns: (!parent && !attrs.length) || node.children.some((child) => child.name === 'all-attributes'),
        columns: attrs.map((attribute) => attribute.attrs.name),
      },
      criteria: {
        operatorName: 'And',
        conditions: [],
        filters: node.children
          .filter((child) => child.name === 'filter')
          .map((child) => filter(child, node.attrs.name)),
      },
      orders: node.children
        .filter((child) => child.name === 'order')
        .map((order) => ({
          attributeName: order.attrs.attribute,
          descending: boolean(order.attrs.descending),
          ...(order.attrs.entityname ? { entityName: order.attrs.entityname } : {}),
        })),
      linkEntities: node.children
        .filter((child) => child.name === 'link-entity')
        .map((link) => entity(link, node.attrs.name)),
    };
    if (!parent) return { $type: 'QueryExpression', entityName: node.attrs.name, ...result };
    const joinOperator = {
      inner: 'Inner',
      outer: 'LeftOuter',
      any: 'Any',
      'not any': 'NotAny',
      all: 'All',
      'not all': 'NotAll',
      exists: 'Exists',
      in: 'In',
      matchfirstrowusingcrossapply: 'MatchFirstRowUsingCrossApply',
    }[node.attrs['link-type'] ?? 'inner'];
    if (!joinOperator) fail('Unsupported FetchXML join conversion.');
    return {
      $type: 'LinkEntity',
      linkFromEntityName: parent,
      linkToEntityName: node.attrs.name,
      linkFromAttributeName: node.attrs.to,
      linkToAttributeName: node.attrs.from,
      joinOperator,
      entityAlias: node.attrs.alias ?? null,
      columns: result.columnSet,
      linkCriteria: result.criteria,
      orders: result.orders,
      linkEntities: result.linkEntities,
    };
  };
  const root = fetch.children.find((node) => node.name === 'entity');
  return {
    Query: {
      ...entity(root),
      distinct: boolean(fetch.attrs.distinct),
      noLock: boolean(fetch.attrs['no-lock']),
      queryHints: fetch.attrs.options ?? null,
      dataSource: fetch.attrs.datasource ?? null,
      topCount: fetch.attrs.top == null ? null : Number(fetch.attrs.top),
      pageInfo: {
        count: Number(fetch.attrs.count ?? 0),
        pageNumber: Number(fetch.attrs.page ?? 0),
        pagingCookie: fetch.attrs['paging-cookie'] ?? null,
        returnTotalRecordCount: boolean(fetch.attrs.returntotalrecordcount),
      },
    },
  };
}
