import { DataError } from './data-error.mjs';
import { compileOperator } from './dataverse-conditions.mjs';
import { fieldValue, parseXmlDocument } from './fetchxml-engine.mjs';

export const CUSTOM_ACCESS_ENABLED_STATE = 3;

const comparisons = new Set(['eq', 'ne', 'neq', 'gt', 'ge', 'lt', 'le']);
const lists = new Set(['in', 'not-in']);
const nullChecks = new Set(['null', 'not-null']);
const columnName = /^[a-z][a-z\d_]*$/i;
const invalid = (message) => new DataError(message, 400, 'InvalidCustomTablePermission');

function normalizeCondition(condition) {
  const { attribute, operator } = condition.attrs;
  if (!columnName.test(attribute ?? '') || !operator)
    throw invalid('A Custom Access condition requires a root attribute and operator.');
  if (
    Object.keys(condition.attrs).some(
      (key) => !['attribute', 'operator', 'value', 'uiname', 'uitype', 'uihidden'].includes(key),
    )
  )
    throw invalid('Custom Access supports root-column predicates without aliases or valueof.');
  if (
    condition.children.some(
      (value) => value.name !== 'value' || value.children.length || Object.keys(value.attrs).length,
    )
  )
    throw invalid('Custom Access condition operands must be literal values.');
  const hasLiteral = Object.hasOwn(condition.attrs, 'value');
  const count = Number(hasLiteral) + condition.children.length;
  if (
    (hasLiteral && condition.children.length) ||
    !(
      (comparisons.has(operator) && count === 1) ||
      (lists.has(operator) && count > 0) ||
      (nullChecks.has(operator) && !count)
    )
  )
    throw invalid('Custom Access supports comparison, list and null operators with their documented literal operands.');
  return {
    name: 'condition',
    attrs: { attribute: attribute.toLowerCase(), operator, ...(hasLiteral ? { value: condition.attrs.value } : {}) },
    children: condition.children,
    text: '',
  };
}

function normalizeFilter(filter) {
  const type = filter.attrs.type ?? 'and';
  if (
    !['and', 'or'].includes(type) ||
    !filter.children.length ||
    Object.keys(filter.attrs).some((key) => key !== 'type')
  )
    throw invalid('A Custom Access filter must contain and/or predicates without hints.');
  const children = filter.children.map((child) => {
    if (child.name === 'filter') return normalizeFilter(child);
    if (child.name === 'condition') return normalizeCondition(child);
    throw invalid('Custom Access filter joins and other non-root predicates are unsupported.');
  });
  return { name: 'filter', attrs: { type }, children, text: '' };
}

/** The documented custom scope consumes only the table's root filters. */
export function customTablePermissionFilter(source, table) {
  if (typeof source !== 'string' || source.length > 65_536)
    throw invalid('Custom Access requires a bounded permission FetchXML definition.');
  const fetch = parseXmlDocument(source, { root: 'fetch', maxDepth: 20 });
  const entities = fetch.children.filter((element) => element.name === 'entity');
  if (entities.length !== 1 || String(entities[0].attrs.name ?? '').toLowerCase() !== String(table).toLowerCase())
    throw invalid('Custom Access FetchXML must name the permission table as its single root.');
  const filters = entities[0].children.filter((element) => element.name === 'filter').map(normalizeFilter);
  if (!filters.length) throw invalid('Custom Access FetchXML must contain a root filter.');
  return { name: 'filter', attrs: { type: 'and' }, children: filters, text: '' };
}

/** Use the same typed literals and collation as authored FetchXML predicates. */
export function compileCustomTablePermission(filter, { table, definition, settings }) {
  const compile = (node) => {
    if (node.name === 'filter') {
      const tests = node.children.map(compile);
      return node.attrs.type === 'or'
        ? (row) => tests.some((test) => test(row))
        : (row) => tests.every((test) => test(row));
    }
    const { attribute, operator } = node.attrs;
    const field = definition(attribute);
    if (!field) throw invalid('Custom Access filter columns must be resolved from table metadata.');
    const values = Object.hasOwn(node.attrs, 'value') ? [node.attrs.value] : node.children.map((value) => value.text);
    const predicate = compileOperator(operator, {
      attribute: `${table}.${attribute}`,
      values,
      definition: field,
      settings,
    });
    return (row) => predicate(fieldValue(row, attribute));
  };
  return compile(filter);
}

export function customTablePermissionDefinition(mapping, attribute) {
  if (!mapping) return undefined;
  if (mapping.idColumn === attribute) return { dataverseType: 'uniqueidentifier' };
  for (const fields of [mapping.fields, mapping.fieldMetadata])
    if (fields && Object.hasOwn(fields, attribute)) return fields[attribute];
  return undefined;
}
