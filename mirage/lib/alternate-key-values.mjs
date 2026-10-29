import { DataError } from './data-error.mjs';
import { foldText, fieldKind, parseDateValue, guidKey } from './dataverse-values.mjs';
import { decimalParts } from './exact-numeric.mjs';

const scalar = (value) => (value && typeof value === 'object' ? (value.id ?? value.value ?? value) : value);
const field = (row, name) =>
  Object.hasOwn(row, name)
    ? row[name]
    : name.startsWith('_') && name.endsWith('_value')
      ? scalar(row[name.slice(1, -6)])
      : name.split('/').reduce((value, key) => value?.[key], row);

// Normalize known source types like key lookup; unknown columns keep the store's
// legacy scalar coercions. Exact integer/decimal digits never pass Number.
const alternateKeyScalar = (value, collation = 'CI_AI', kind) => {
  const raw = scalar(value);
  if (kind === 'datetime') {
    const parsed = parseDateValue(raw);
    if (parsed) return ['date', String(parsed.ms)];
  } else if (['integer', 'decimal', 'money', 'number', 'choice'].includes(kind)) {
    const parts = decimalParts(typeof raw === 'boolean' ? Number(raw) : raw);
    if (parts) return ['number', String(parts.coefficient), parts.scale];
  } else if (kind === 'double') {
    const number = Number(raw);
    if (Number.isFinite(number)) return ['double', String(number)];
  } else if (kind === 'guid' || kind === 'lookup') {
    const guid = guidKey(raw);
    if (guid) return ['guid', guid];
  } else if (kind === 'boolean') {
    if (typeof raw === 'boolean' || typeof raw === 'number') return ['boolean', Number(Boolean(raw))];
    const text = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes'].includes(text)) return ['boolean', 1];
    if (['false', '0', 'no'].includes(text)) return ['boolean', 0];
  }
  return foldText(
    String(typeof scalar(value) === 'boolean' ? Number(scalar(value)) : scalar(value)).replace(
      /^(?:\{([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\}|\(([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\))$/i,
      (_match, braced, parenthesized) => braced ?? parenthesized,
    ),
    collation,
  );
};

export const activeAlternateKeys = (mapping) =>
  (mapping.alternateKeys ?? []).filter((key) => (key.indexStatus ?? 'Active') === 'Active');
export const alternateKeyAttributes = (key) => key.attributes ?? key.keyAttributes ?? [];
export const alternateKeyValues = (row, attributes) => attributes.map((name) => scalar(field(row, name)));
export const alternateKeyKinds = (mapping, attributes) =>
  Object.fromEntries(
    attributes.map((attribute) => {
      const name = /^_(.+)_value$/.exec(attribute)?.[1] ?? attribute;
      const find = (fields) =>
        fields && typeof fields === 'object'
          ? (fields[name] ?? fields[Object.keys(fields).find((key) => key.toLowerCase() === name.toLowerCase())])
          : undefined;
      return [attribute, fieldKind(find(mapping.fields) ?? find(mapping.fieldMetadata))];
    }),
  );
export const alternateKeyOf =
  (attributes, collation = 'CI_AI', kinds = {}) =>
  (row) => {
    const values = alternateKeyValues(row, attributes);
    return !values.length || values.some((value) => value == null || value === '')
      ? null
      : JSON.stringify(values.map((value, index) => alternateKeyScalar(value, collation, kinds[attributes[index]])));
  };
export const duplicateAlternateKey = (key, attributes, values) =>
  new DataError(
    `A record that has the attribute values ${values.join(', ')} already exists. The entity key ${key.name ?? attributes.join('_')} requires that this set of attributes contains unique values. Select unique values and try again.`,
    412,
    'DuplicateRecord',
    { innerCode: '0x80040237' },
  );

/** Linear offline preflight over the final additive rows, before a caller can save them. */
export function assertDatasetAlternateKeys(mappings, tables, selected, collation = 'CI_AI') {
  for (const table of selected) {
    const mapping = Object.hasOwn(mappings, table) ? mappings[table] : {};
    const rows = Object.hasOwn(tables, table) ? tables[table] : [];
    for (const key of activeAlternateKeys(mapping)) {
      const attributes = alternateKeyAttributes(key),
        keyOf = alternateKeyOf(attributes, collation, alternateKeyKinds(mapping, attributes)),
        seen = new Map();
      for (const row of rows) {
        const tuple = keyOf(row);
        if (tuple === null) continue;
        const identity = alternateKeyScalar(row[mapping.idColumn ?? `${table}id`], 'CI_AS');
        if (seen.has(tuple) && seen.get(tuple) !== identity)
          throw duplicateAlternateKey(key, attributes, alternateKeyValues(row, attributes));
        seen.set(tuple, identity);
      }
    }
  }
}
