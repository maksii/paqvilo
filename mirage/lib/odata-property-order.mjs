import { templateDataArray } from './error-template-data.mjs';

const propertyName = /^[a-z_][a-z0-9_]{0,127}$/i;
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
const annotationOrder = new Map([
  ['OData.Community.Display.V1.FormattedValue', 0],
  ['Microsoft.Dynamics.CRM.associatednavigationproperty', 1],
  ['Microsoft.Dynamics.CRM.lookuplogicalname', 2],
]);

/** A whole EntityType's structural property order is metadata, never field admission. */
export function validateODataPropertyOrder(value, label = 'odataPropertyOrder') {
  const order = templateDataArray(value, { maximum: 4096, label });
  const names = new Set();
  for (const name of order) {
    if (
      typeof name !== 'string' ||
      !propertyName.test(name) ||
      name.startsWith('__') ||
      reserved.has(name.toLowerCase())
    )
      throw Error(`${label} requires explicit structural property names`);
    if (names.has(name)) throw Error(`${label} contains a duplicate property`);
    names.add(name);
  }
  return order;
}

export function mappedODataPropertyOrder(mapping) {
  if (!mapping || typeof mapping !== 'object') return undefined;
  const property = Object.getOwnPropertyDescriptor(mapping, 'odataPropertyOrder');
  if (!property) return undefined;
  if (!('value' in property)) throw Error('odataPropertyOrder requires an own data property');
  return validateODataPropertyOrder(property.value);
}

/** Reorder existing property/annotation groups without reading or admitting any columns. */
export function orderODataProperties(value, order) {
  if (order === undefined || order === null) return value;
  const rank = new Map(validateODataPropertyOrder(order).map((name, index) => [name, index]));
  const groups = new Map();
  const entries = Object.entries(value).map(([key, item], index) => ({
    key,
    item,
    index,
    group: key.startsWith('@') ? key : key.split('@')[0],
    rank: key.startsWith('@') ? -1 : (rank.get(key.split('@')[0]) ?? Infinity),
  }));
  for (const entry of entries) if (!groups.has(entry.group)) groups.set(entry.group, entry.index);
  const bases = new Map(
    entries.filter((entry) => entry.key === entry.group).map((entry) => [entry.group, entry.index]),
  );
  const withinGroup = (entry) => {
    if (entry.key === entry.group) return 2;
    const suffix = entry.key.slice(entry.group.length + 1);
    if (annotationOrder.has(suffix)) return 1 + annotationOrder.get(suffix) / 10;
    if (suffix === 'odata.nextLink') return 3;
    // Unknown annotations retain their original order and side of the base.
    return entry.index < (bases.get(entry.group) ?? Infinity) ? 0 : 4;
  };
  entries.sort((a, b) =>
    a.rank === b.rank
      ? groups.get(a.group) - groups.get(b.group) || withinGroup(a) - withinGroup(b) || a.index - b.index
      : a.rank < b.rank
        ? -1
        : 1,
  );
  return Object.fromEntries(entries.map(({ key, item }) => [key, item]));
}
