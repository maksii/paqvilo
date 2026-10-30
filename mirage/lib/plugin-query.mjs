import { DataError } from './data-error.mjs';
import { parseODataExpression } from './odata-query.mjs';
import { isExactNumeric, decimalParts } from './exact-numeric.mjs';
const fail = (message) => {
  throw new DataError(message, 501, 'LocalPluginQueryUnsupported');
};
const name = (value) => {
  // A Web API lookup property (_x_value) names the SDK attribute x.
  const lookup = typeof value === 'string' && /^_([a-z]\w*)_value$/i.exec(value);
  if (lookup) return lookup[1];
  if (typeof value !== 'string' || !/^[a-z][\w]*$/i.test(value))
    fail('SDK query projection requires logical column names.');
  return value;
};
const inverseCrm = Object.fromEntries(
  [
    ['In', 'NotIn'],
    ['Between', 'NotBetween'],
    ['ContainValues', 'DoesNotContainValues'],
    ['EqualUserId', 'NotEqualUserId'],
    ['EqualBusinessId', 'NotEqualBusinessId'],
    ['Under', 'NotUnder'],
  ].flatMap(([left, right]) => [
    [left, right],
    [right, left],
  ]),
);
/** Source-preserving subset for local OData reads. This is not a claim about
 * the portal's proprietary OData-to-Dataverse query conversion. */
export function odataToSdkQuery(entity, params = {}, store) {
  const p = params instanceof URLSearchParams ? Object.fromEntries(params) : params;
  // Counts, expansion, aggregation and transport paging stay on the read route;
  // the typed query describes the root selection, rather than deleting those
  // independent options when an observer is installed.
  const literal = (node) => {
    if (node?.type !== 'literal') fail('SDK query condition must use a literal.');
    return isExactNumeric(node.value)
      ? { $type: decimalParts(node.value).scale ? 'Decimal' : 'Int64', value: node.value.value }
      : node.kind === 'guid'
        ? { $type: 'Guid', value: node.value }
        : node.kind === 'datetime'
          ? { $type: 'DateTime', value: node.value }
          : node.value;
  };
  const column = (node, variable = null) => {
    if (variable && node?.type === 'path' && node.segments[0] === variable)
      node = { ...node, segments: node.segments.slice(1) };
    if (node?.type !== 'path' || node.segments.length !== 1)
      fail('SDK read observers require a direct attribute condition.');
    return name(node.segments[0]);
  };
  const filter = (node, negate = false, logical = entity, variable = null) => {
    if (node.type === 'not') return filter(node.operand, !negate, logical, variable);
    if (node.type === 'literal' && (typeof node.value === 'boolean' || node.value === null)) {
      const passes = node.value !== null && node.value !== negate;
      return {
        operatorName: 'And',
        filters: [],
        conditions: passes
          ? []
          : [
              {
                attributeName: store?.resolveMapping(logical).idColumn ?? logical + 'id',
                operatorName: 'Null',
                values: [],
              },
            ],
      };
    }
    if (node.type === 'path')
      return filter(
        { type: 'compare', op: 'eq', left: node, right: { type: 'literal', kind: 'boolean', value: true } },
        negate,
        logical,
        variable,
      );
    if (node.type === 'compare' && node.left.type === 'literal' && node.right.type === 'path')
      return filter(
        {
          ...node,
          left: node.right,
          right: node.left,
          op: { eq: 'eq', ne: 'ne', lt: 'gt', le: 'ge', gt: 'lt', ge: 'le' }[node.op],
        },
        negate,
        logical,
        variable,
      );
    const operand =
      node.type === 'compare' || node.type === 'in'
        ? node.left
        : node.type === 'string'
          ? node.args[0]
          : node.type === 'crm'
            ? { type: 'path', segments: String(node.params.PropertyName?.value ?? '').split('/') }
            : null;
    const segments = variable && operand?.segments?.[0] === variable ? operand.segments.slice(1) : operand?.segments;
    if (segments?.length > 1) {
      if (!store) fail('SDK navigation filters require source relationship metadata.');
      const mapping = store.resolveMapping(logical),
        relation = store.relationshipsFor(mapping, { admin: true })[segments[0]];
      if (!relation || relation.many !== false || relation.intersect)
        fail('A scalar SDK navigation filter requires a source-defined lookup relationship.');
      const path = { type: 'path', segments: segments.slice(1) };
      const rewritten =
        node.type === 'compare' || node.type === 'in'
          ? { ...node, left: path }
          : node.type === 'string'
            ? { ...node, args: [path, ...node.args.slice(1)] }
            : {
                ...node,
                params: {
                  ...node.params,
                  PropertyName: { ...node.params.PropertyName, value: segments.slice(1).join('/') },
                },
              };
      const nullAlternative = node.type === 'compare' && node.right.kind === 'null' && (node.op === 'eq') !== negate;
      return {
        operatorName: 'And',
        conditions: [],
        filters: [],
        anyAllFilterLinkEntity: {
          $type: 'LinkEntity',
          linkFromEntityName: logical,
          linkToEntityName: relation.entity,
          linkFromAttributeName: relation.from,
          linkToAttributeName: relation.to,
          joinOperator: nullAlternative ? 'NotAny' : 'Any',
          columns: { allColumns: false, columns: [] },
          orders: [],
          linkEntities: [],
          linkCriteria: filter(rewritten, nullAlternative ? !negate : negate, relation.entity),
        },
      };
    }
    if (['and', 'or'].includes(node.type))
      return {
        operatorName: (node.type === 'and') !== negate ? 'And' : 'Or',
        conditions: [],
        filters: [filter(node.left, negate, logical, variable), filter(node.right, negate, logical, variable)],
      };
    if (node.type === 'lambda') {
      const path = variable && node.path[0] === variable ? node.path.slice(1) : node.path;
      if (!store || path.length !== 1) fail('SDK collection filters require one source-defined relationship.');
      const mapping = store.resolveMapping(logical);
      const relation = store.relationshipsFor(mapping, { admin: true })[path[0]];
      if (!relation || relation.many === false) fail('SDK collection filter requires a collection relationship.');
      const anti = (node.kind === 'all') !== negate;
      let body = node.body
        ? filter(node.body, negate, relation.entity, node.variable)
        : { operatorName: 'And', conditions: [], filters: [] };
      if (node.body && anti) {
        // A WHERE predicate selects only true, while OData lambdas retain
        // unknown: all(P) needs no child where P is not true; not any(P)
        // needs no child where P is not false. Complement the complete body
        // against this row's source key, preserving nested Kleene logic.
        const primary = store.resolveMapping(relation.entity).idColumn;
        body = {
          operatorName: 'And',
          conditions: [],
          filters: [],
          anyAllFilterLinkEntity: {
            $type: 'LinkEntity',
            linkFromEntityName: relation.entity,
            linkToEntityName: relation.entity,
            linkFromAttributeName: primary,
            linkToAttributeName: primary,
            joinOperator: 'NotAny',
            columns: { allColumns: false, columns: [] },
            orders: [],
            linkEntities: [],
            linkCriteria: body,
          },
        };
      }
      const root = {
        $type: 'LinkEntity',
        linkFromEntityName: logical,
        linkToEntityName: relation.intersect?.entity ?? relation.entity,
        linkFromAttributeName: relation.from,
        linkToAttributeName: relation.intersect?.from ?? relation.to,
        joinOperator: anti ? 'NotAny' : 'Any',
        columns: { allColumns: false, columns: [] },
        orders: [],
        linkCriteria: relation.intersect ? { operatorName: 'And', conditions: [], filters: [] } : body,
        linkEntities: relation.intersect
          ? [
              {
                $type: 'LinkEntity',
                linkFromEntityName: relation.intersect.entity,
                linkToEntityName: relation.entity,
                linkFromAttributeName: relation.intersect.to,
                linkToAttributeName: relation.to,
                joinOperator: 'Inner',
                columns: { allColumns: false, columns: [] },
                orders: [],
                linkCriteria: body,
                linkEntities: [],
              },
            ]
          : [],
      };
      return { operatorName: 'And', conditions: [], filters: [], anyAllFilterLinkEntity: root };
    }
    if (node.type === 'string') {
      const value = literal(node.args[1]);
      if (typeof value !== 'string') fail('SDK string filters require a string literal.');
      // SQL Like escaping preserves literal %, _ and [ characters in contains.
      const escaped = value.replaceAll('[', '[[]').replaceAll('%', '[%]').replaceAll('_', '[_]');
      const operatorName =
        node.name === 'contains'
          ? negate
            ? 'NotLike'
            : 'Like'
          : node.name === 'startswith'
            ? negate
              ? 'DoesNotBeginWith'
              : 'BeginsWith'
            : negate
              ? 'DoesNotEndWith'
              : 'EndsWith';
      return {
        operatorName: 'And',
        filters: [],
        conditions: [
          {
            attributeName: column(node.args[0], variable),
            operatorName,
            values: [node.name === 'contains' ? '%' + escaped + '%' : value],
          },
        ],
      };
    }
    if (node.type === 'in')
      return {
        operatorName: 'And',
        filters: [],
        conditions: [
          {
            attributeName: column(node.left, variable),
            operatorName: negate ? 'NotIn' : 'In',
            values: node.values.map(literal),
          },
        ],
      };
    if (node.type === 'crm') {
      const attributeName = column(
        { type: 'path', segments: String(node.params.PropertyName?.value ?? '').split('/') },
        variable,
      );
      const value = (key) => (node.params[key]?.type === 'array' ? node.params[key].values : node.params[key]?.value);
      const values =
        node.shape === 'list'
          ? value('PropertyValues')
          : node.shape === 'pair'
            ? [value('PropertyValue1'), value('PropertyValue2')]
            : node.shape === 'one'
              ? [value('PropertyValue')]
              : [];
      if (!Array.isArray(values)) fail('Dataverse condition values require a literal list.');
      const condition = { attributeName, operatorName: node.name, values };
      if (!negate) return { operatorName: 'And', filters: [], conditions: [condition] };
      // OData negation retains unknown/null operands. In particular the native
      // DoesNotContainValues operator alone also accepts an empty choices value.
      const conditions = [{ attributeName, operatorName: 'NotNull', values: [] }];
      if (inverseCrm[node.name])
        return {
          operatorName: 'And',
          filters: [],
          conditions: [...conditions, { ...condition, operatorName: inverseCrm[node.name] }],
        };
      if (!store) fail('Negating this Dataverse function requires its source primary-key binding.');
      const primary = store.resolveMapping(logical).idColumn;
      // Relative dates, fiscal periods and caller sets do not all have public
      // inverse SDK operators. An anti-semi join to this row's exact source key
      // complements the shared predicate without guessing clock/date bounds.
      return {
        operatorName: 'And',
        filters: [],
        conditions,
        anyAllFilterLinkEntity: {
          $type: 'LinkEntity',
          linkFromEntityName: logical,
          linkToEntityName: logical,
          linkFromAttributeName: primary,
          linkToAttributeName: primary,
          joinOperator: 'NotAny',
          columns: { allColumns: false, columns: [] },
          orders: [],
          linkEntities: [],
          linkCriteria: { operatorName: 'And', filters: [], conditions: [condition] },
        },
      };
    }
    if (node.type === 'compare')
      return {
        operatorName: 'And',
        filters: [],
        conditions: [
          {
            attributeName: column(node.left, variable),
            operatorName:
              node.right?.value === null
                ? ({ eq: negate ? 'NotNull' : 'Null', ne: negate ? 'Null' : 'NotNull' }[node.op] ??
                  fail('Unsupported null comparison.'))
                : ({
                    eq: negate ? 'NotEqual' : 'Equal',
                    ne: negate ? 'Equal' : 'NotEqual',
                    gt: negate ? 'LessEqual' : 'GreaterThan',
                    ge: negate ? 'LessThan' : 'GreaterEqual',
                    lt: negate ? 'GreaterEqual' : 'LessThan',
                    le: negate ? 'GreaterThan' : 'LessEqual',
                  }[node.op] ?? fail('Unsupported comparison.')),
            ...(node.right?.type === 'path' ? { compareColumns: true } : {}),
            values:
              node.right?.value === null
                ? []
                : [node.right?.type === 'path' ? column(node.right, variable) : literal(node.right)],
          },
        ],
      };
    fail('SDK read observer query conversion requires explicit support for ' + node.type + '.');
  };
  const top = p.$top === undefined ? null : Number(p.$top);
  if (top !== null && (!Number.isInteger(top) || top < 0)) fail('Invalid SDK query top count.');
  const orderLinks = [],
    orderPaths = new Map();
  const orderColumn = (text) => {
    const segments = text.split('/');
    if (segments.length === 1) return { attributeName: name(text) };
    if (!store) fail('SDK navigation order requires source relationship metadata.');
    let logical = entity,
      list = orderLinks,
      prefix = '',
      alias;
    for (const navigation of segments.slice(0, -1)) {
      prefix += '/' + navigation;
      let link = orderPaths.get(prefix);
      if (!link) {
        const relation = store.relationshipsFor(store.resolveMapping(logical), { admin: true })[navigation];
        if (!relation || relation.many !== false || relation.intersect)
          fail('SDK order requires a single-valued source lookup.');
        link = {
          $type: 'LinkEntity',
          linkFromEntityName: logical,
          linkToEntityName: relation.entity,
          linkFromAttributeName: relation.from,
          linkToAttributeName: relation.to,
          joinOperator: 'LeftOuter',
          entityAlias: 'observer_order_' + orderPaths.size,
          columns: { allColumns: false, columns: [] },
          linkCriteria: { operatorName: 'And', conditions: [], filters: [] },
          orders: [],
          linkEntities: [],
        };
        list.push(link);
        orderPaths.set(prefix, link);
      }
      logical = link.linkToEntityName;
      list = link.linkEntities;
      alias = link.entityAlias;
    }
    return { attributeName: name(segments.at(-1)), entityName: alias };
  };
  const orders = p.$orderby
    ? String(p.$orderby)
        .split(',')
        .map((text) => {
          const match = /^\s*([\w/]+)(?:\s+(asc|desc))?\s*$/i.exec(text);
          if (!match) fail('Unsupported SDK order expression.');
          return { ...orderColumn(match[1]), descending: match[2]?.toLowerCase() === 'desc' };
        })
    : [];
  const selected = p.$select
    ? String(p.$select)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
  const allColumns = !p.$select || selected.includes('*');
  return {
    $type: 'QueryExpression',
    entityName: entity,
    columnSet: {
      allColumns,
      columns: allColumns ? [] : selected.map(name),
    },
    criteria: p.$filter
      ? filter(
          parseODataExpression(p.$filter, {
            aliases: Object.fromEntries(Object.entries(p).filter(([key]) => key.startsWith('@'))),
          }),
        )
      : { operatorName: 'And', conditions: [], filters: [] },
    orders,
    topCount: top,
    distinct: false,
    linkEntities: orderLinks,
    pageInfo: { count: 0, pageNumber: 0, pagingCookie: null, returnTotalRecordCount: false },
  };
}

export function sameSdkQuery(left, right) {
  const falseDefaults = new Set([
    'noLock',
    'distinct',
    'isQuickFindFilter',
    'compareColumns',
    'descending',
    'returnTotalRecordCount',
    'allColumns',
  ]);
  const normalized = (value) => {
    if (Array.isArray(value)) return value.map(normalized);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, normalized(item)])
        .filter(
          ([key, item]) =>
            item != null &&
            !(key === '$type' && item === 'ColumnSet' && ('columns' in value || 'allColumns' in value)) &&
            !(falseDefaults.has(key) && item === false) &&
            !(['count', 'pageNumber'].includes(key) && item === 0) &&
            !(typeof item === 'object' && Object.keys(item).length === 0),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  };
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}
