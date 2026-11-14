import { DataError } from './data-error.mjs';
import { foldText, fieldKind, parseDateValue, guidKey } from './dataverse-values.mjs';
import { decimalParts } from './exact-numeric.mjs';
import { readRecordValues } from './record-tables.mjs';

const scalar = (value) => (value && typeof value === 'object' ? (value.id ?? value.value ?? value) : value);
const field = (row, name) => {
  if (Object.hasOwn(row, name)) return row[name];
  if (name.startsWith('_') && name.endsWith('_value')) return scalar(row[name.slice(1, -6)]);
  return name.split('/').reduce((value, key) => value?.[key], row);
};

// Normalize known source types like key lookup; unknown columns keep the store's
// legacy scalar coercions. Exact integer/decimal digits never pass Number.
const dateScalar = (raw) => {
  const parsed = parseDateValue(raw);
  return parsed ? ['date', String(parsed.ms)] : undefined;
};
const numericScalar = (raw) => {
  const parts = decimalParts(typeof raw === 'boolean' ? Number(raw) : raw);
  return parts ? ['number', String(parts.coefficient), parts.scale] : undefined;
};
const doubleScalar = (raw) => {
  const number = Number(raw);
  return Number.isFinite(number) ? ['double', String(number)] : undefined;
};
const guidScalar = (raw) => {
  const guid = guidKey(raw);
  return guid ? ['guid', guid] : undefined;
};
const booleanScalar = (raw) => {
  if (typeof raw === 'boolean' || typeof raw === 'number') return ['boolean', Number(Boolean(raw))];
  const text = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return ['boolean', 1];
  if (['false', '0', 'no'].includes(text)) return ['boolean', 0];
  return undefined;
};
const knownScalar = (raw, kind) => {
  if (kind === 'datetime') return dateScalar(raw);
  if (['integer', 'decimal', 'money', 'number', 'choice'].includes(kind)) return numericScalar(raw);
  if (kind === 'double') return doubleScalar(raw);
  if (kind === 'guid' || kind === 'lookup') return guidScalar(raw);
  if (kind === 'boolean') return booleanScalar(raw);
  return undefined;
};

/* NOSONAR */ const alternateKeyScalar = (value, collation = 'CI_AI', kind) => {
  const raw = scalar(value);
  const known = knownScalar(raw, kind);
  if (known !== undefined) return known;
  return foldText(
    String(typeof scalar(value) === 'boolean' ? Number(scalar(value)) : scalar(value)).replace(
      /^([({])([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})([)}])$/i,
      (match, opening, valueText, closing) => {
        if ((opening === '{' && closing === '}') || (opening === '(' && closing === ')')) return valueText;
        return match;
      },
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
    for (const key of activeAlternateKeys(mapping)) assertTableKey(mapping, table, rows, key, collation);
  }
}

function assertTableKey(mapping, table, rows, key, collation) {
  const attributes = alternateKeyAttributes(key),
    keyOf = alternateKeyOf(attributes, collation, alternateKeyKinds(mapping, attributes)),
    seen = new Map();
  for (const row of readRecordValues(rows)) {
    const tuple = keyOf(row);
    if (tuple === null) continue;
    const identity = alternateKeyScalar(row[mapping.idColumn ?? `${table}id`], 'CI_AS');
    if (seen.has(tuple) && seen.get(tuple) !== identity)
      throw duplicateAlternateKey(key, attributes, alternateKeyValues(row, attributes));
    seen.set(tuple, identity);
  }
}
