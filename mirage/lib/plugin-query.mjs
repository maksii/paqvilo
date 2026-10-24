import { DataError } from './data-error.mjs';
import { parseODataExpression } from './odata-query.mjs';
import { isExactNumeric, decimalParts } from './exact-numeric.mjs';
const fail = (message) => {
  throw new DataError(message, 501, 'LocalPluginQueryUnsupported');
};
const name = (value) => {
  if (typeof value !== 'string' || !/^[a-z][\w]*$/i.test(value))
    fail('SDK query projection requires logical column names.');
  return value;
};
/** Source-preserving subset for local OData reads. This is not a claim about
 * the portal's proprietary OData-to-Dataverse query conversion. */
export function odataToSdkQuery(entity, params = {}) {
  const p = params instanceof URLSearchParams ? Object.fromEntries(params) : params;
  for (const key of Object.keys(p))
    if (!['$select', '$filter', '$orderby', '$top'].includes(key))
      fail('SDK read observers do not support this OData option: ' + key);
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
  const column = (node) => {
    if (node?.type !== 'path' || node.segments.length !== 1)
      fail('SDK read observers require a direct attribute condition.');
    return name(node.segments[0]);
  };
  const filter = (node) => {
    if (['and', 'or'].includes(node.type))
      return {
        operatorName: node.type === 'and' ? 'And' : 'Or',
        conditions: [],
        filters: [filter(node.left), filter(node.right)],
      };
    if (node.type === 'compare')
      return {
        operatorName: 'And',
        filters: [],
        conditions: [
          {
            attributeName: column(node.left),
            operatorName:
              node.right?.value === null
                ? ({ eq: 'Null', ne: 'NotNull' }[node.op] ?? fail('Unsupported null comparison.'))
                : ({
                    eq: 'Equal',
                    ne: 'NotEqual',
                    gt: 'GreaterThan',
                    ge: 'GreaterEqual',
                    lt: 'LessThan',
                    le: 'LessEqual',
                  }[node.op] ?? fail('Unsupported comparison.')),
            values: node.right?.value === null ? [] : [literal(node.right)],
          },
        ],
      };
    fail('SDK read observer query conversion requires explicit support for ' + node.type + '.');
  };
  const top = p.$top === undefined ? null : Number(p.$top);
  if (top !== null && (!Number.isInteger(top) || top < 0)) fail('Invalid SDK query top count.');
  return {
    $type: 'QueryExpression',
    entityName: entity,
    columnSet: {
      allColumns: !p.$select,
      columns: p.$select
        ? String(p.$select)
            .split(',')
            .map((s) => name(s.trim()))
        : [],
    },
    criteria: p.$filter
      ? filter(parseODataExpression(p.$filter))
      : { operatorName: 'And', conditions: [], filters: [] },
    orders: p.$orderby
      ? String(p.$orderby)
          .split(',')
          .map((s) => {
            const match = /^\s*([\w]+)(?:\s+(asc|desc))?\s*$/i.exec(s);
            if (!match) fail('Unsupported SDK order expression.');
            return { attributeName: name(match[1]), descending: match[2]?.toLowerCase() === 'desc' };
          })
      : [],
    topCount: top,
    distinct: false,
    pageInfo: { count: 0, pageNumber: 0, pagingCookie: null },
  };
}
