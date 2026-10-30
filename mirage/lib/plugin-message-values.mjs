import { DataError } from './data-error.mjs';
import { recordToSdkEntity } from './plugin-clr.mjs';
import { sdkValueToRecord } from './local-organization-service.mjs';
import { isDeepStrictEqual } from 'node:util';
import { isExactNumeric } from './exact-numeric.mjs';
import { pluginValueSource, rememberPluginValue } from './plugin-value-provenance.mjs';

const names = [
  'Boolean',
  'DateTime',
  'Decimal',
  'Entity',
  'EntityCollection',
  'EntityReference',
  'Float',
  'Integer',
  'Money',
  'Picklist',
  'String',
  'StringArray',
  'Guid',
];
const logicalName = (spec, value) =>
  spec.logicalentityname ||
  value?.logicalName ||
  value?.logical_name ||
  String(value?.['@odata.type'] ?? '').replace(/^#?(?:Microsoft\.Dynamics\.CRM\.|mscrm\.)/, '');
const concurrencyValue = (value) => {
  if (![0, 1, 2].includes(value))
    throw new DataError('Unsupported SDK ConcurrencyBehavior value.', 501, 'LocalPluginSdkUnsupported');
  return value;
};

export function pluginMessageParameters(store, specs, values = {}) {
  const byName = new Map(specs.map((spec) => [spec.uniquename, spec]));
  const encode = (spec, value) => {
    if (isExactNumeric(value)) {
      const declared = names[Number(spec?.type)] ?? spec?.type;
      const type = declared === 'Float' ? 'Double' : (declared ?? value.numericType);
      if (!['Money', 'Decimal', 'Int64', 'Double'].includes(type))
        throw new DataError(
          'An exact numeric value requires a numeric SDK parameter.',
          501,
          'LocalPluginSdkUnsupported',
        );
      return { $type: type, value: value.value };
    }
    if (value == null || value?.$type) return structuredClone(value);
    const type = names[Number(spec?.type)] ?? spec?.type;
    if (type === 'ConcurrencyBehavior') return { $type: type, value: concurrencyValue(value) };
    if (['Guid', 'DateTime', 'Decimal', 'Money', 'Int64'].includes(type))
      return { $type: type, value: String(value?.value ?? value) };
    if (type === 'Float') return { $type: 'Double', value: String(value) };
    if (type === 'Picklist') return { $type: 'OptionSetValue', value };
    if (type === 'StringArray') return { $type: 'PrimitiveArray', elementType: 'String', values: [...value] };
    if (['PrimitiveArray', 'SdkArray', 'OptionSetValueCollection'].includes(type)) {
      if (!Array.isArray(value))
        throw new DataError('A typed SDK collection requires an array.', 501, 'LocalPluginSdkUnsupported');
      const elementType = type === 'OptionSetValueCollection' ? 'OptionSetValue' : spec.elementType;
      const element = {
        String: 'String',
        Int32: 'Integer',
        Boolean: 'Boolean',
        Int64: 'Int64',
        Decimal: 'Decimal',
        Double: 'Float',
        DateTime: 'DateTime',
        OptionSetValue: 'Picklist',
        Money: 'Money',
        Entity: 'Entity',
        EntityReference: 'EntityReference',
        EntityCollection: 'EntityCollection',
        QueryExpression: 'QueryExpression',
        'String[]': 'StringArray',
      }[elementType];
      if (!element) throw new DataError('Unsupported SDK collection element type.', 501, 'LocalPluginSdkUnsupported');
      return {
        $type: type,
        ...(type === 'OptionSetValueCollection' ? {} : { elementType }),
        values: value.map((item) => encode({ type: element }, item)),
      };
    }
    if (type === 'EntityCollection')
      return {
        $type: 'EntityCollection',
        entities: value.map((row) => encode({ ...spec, type: 'Entity' }, row)),
        moreRecords: false,
        totalRecordCount: -1,
        pagingCookie: null,
      };
    if (type === 'Entity' || type === 'EntityReference') {
      const entity = logicalName(spec, value);
      if (!entity)
        throw new DataError(
          'A custom API entity value requires its declared logical table.',
          501,
          'LocalPluginSdkUnsupported',
        );
      if (type === 'EntityReference')
        return {
          $type: 'EntityReference',
          logicalName: entity,
          id: value.id,
          name: value.name ?? null,
          ...(Object.hasOwn(value, 'rowVersion') ? { rowVersion: value.rowVersion } : {}),
          ...(value.keyAttributes
            ? {
                keyAttributes: Object.fromEntries(
                  Object.entries(value.keyAttributes).map(([name, item]) => [name, encode(undefined, item)]),
                ),
              }
            : {}),
        };
      const row = recordToSdkEntity(
        store,
        entity,
        Object.fromEntries(Object.entries(value).filter(([name]) => !name.includes('@'))),
      );
      row.attributes = Object.fromEntries(
        Object.entries(row.attributes).map(([name, item]) => [name, encode(undefined, item)]),
      );
      return row;
    }
    if (Array.isArray(value)) return value.map((item) => encode(undefined, item));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, encode(undefined, item)]));
    return value;
  };
  return {
    $type: 'ParameterCollection',
    values: Object.fromEntries(
      Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => [name, encode(byName.get(name), value)]),
    ),
  };
}

export function pluginMessageValues(parameters, store) {
  const decode = (value) => {
    if (value?.$type === 'ConcurrencyBehavior') return concurrencyValue(value.value);
    if (Array.isArray(value)) return value.map(decode);
    if (['PrimitiveArray', 'SdkArray'].includes(value?.$type))
      return rememberPluginValue(value.values.map(decode), value);
    if (value?.$type === 'EntityReference')
      return rememberPluginValue(
        {
          ...sdkValueToRecord(value),
          ...(Object.hasOwn(value, 'rowVersion') ? { rowVersion: value.rowVersion } : {}),
        },
        value,
      );
    if (value?.$type === 'EntityCollection') return rememberPluginValue(value.entities.map(decode), value);
    if (value?.$type === 'Entity') {
      const row = Object.fromEntries(
        Object.entries(value.attributes ?? {}).map(([name, item]) => [name, decode(item)]),
      );
      const primary = store?.resolveMapping(value.logicalName).idColumn;
      return rememberPluginValue(
        {
          '@odata.type': 'Microsoft.Dynamics.CRM.' + value.logicalName,
          ...row,
          ...(primary && value.id ? { [primary]: value.id } : {}),
        },
        value,
      );
    }
    if (value?.$type === 'AliasedValue') return decode(value.value);
    if (value && typeof value === 'object' && !value.$type)
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, decode(item)]));
    if (
      value?.$type &&
      ![
        'Guid',
        'DateTime',
        'Money',
        'Decimal',
        'Int64',
        'Double',
        'OptionSetValue',
        'OptionSetValueCollection',
        'EntityReference',
        'AliasedValue',
      ].includes(value.$type)
    )
      return structuredClone(value);
    return sdkValueToRecord(value);
  };
  return Object.fromEntries(Object.entries(parameters?.values ?? {}).map(([name, value]) => [name, decode(value)]));
}

/** A JavaScript observer must not erase SDK types of values it did not change. */
export function reconcilePluginMessageParameters(store, specs, previous, before, after) {
  const specByName = new Map(specs.map((spec) => [spec.uniquename, spec]));
  const types = {
    Guid: 'Guid',
    DateTime: 'DateTime',
    Money: 'Money',
    Decimal: 'Decimal',
    Int64: 'Int64',
    Double: 'Float',
    OptionSetValue: 'Picklist',
    Entity: 'Entity',
    EntityReference: 'EntityReference',
    EntityCollection: 'EntityCollection',
    PrimitiveArray: 'PrimitiveArray',
    SdkArray: 'SdkArray',
    OptionSetValueCollection: 'OptionSetValueCollection',
    ConcurrencyBehavior: 'ConcurrencyBehavior',
  };
  const decoded = (wire) => pluginMessageValues({ values: { value: wire } }, store).value;
  const encode = (spec, value) =>
    pluginMessageParameters(store, spec ? [{ ...spec, uniquename: 'value' }] : [], { value }).values.value;
  const inferred = (wire) =>
    types[wire?.$type]
      ? { type: types[wire.$type], logicalentityname: wire.logicalName, elementType: wire.elementType }
      : undefined;
  const identity = (wire) => (wire?.logicalName && wire?.id ? wire.logicalName + '\u0000' + wire.id : null);
  const fingerprint = (value) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  const ambiguous = () => {
    throw new DataError(
      'Changed duplicate SDK tuples require retained DTO provenance or an unambiguous source tuple.',
      501,
      'LocalPluginValueAmbiguous',
    );
  };
  const reconcileMap = (prior = {}, oldValues = {}, newValues = {}) =>
    Object.fromEntries(
      Object.entries(newValues)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => [name, reconcile(prior[name], oldValues?.[name], value)]),
    );
  const reconcileRows = (priorRows, oldRows, newRows, encodedRows) => {
    const consumed = new Set(),
      exact = new Map(),
      ids = new Map(),
      origins = new Map();
    const add = (map, key, index) => {
      const group = map.get(key) ?? { indices: [], cursor: 0, ambiguous: false };
      if (group.indices.length && !isDeepStrictEqual(priorRows[group.indices[0]], priorRows[index]))
        group.ambiguous = true;
      group.indices.push(index);
      map.set(key, group);
    };
    const remaining = (group) => {
      if (!group) return undefined;
      while (group.cursor < group.indices.length && consumed.has(group.indices[group.cursor])) group.cursor++;
      return group.indices[group.cursor];
    };
    priorRows.forEach((wire, index) => {
      add(exact, fingerprint(oldRows?.[index] ?? decoded(wire)), index);
      add(origins, fingerprint(wire), index);
      const id = identity(wire);
      if (id) add(ids, id, index);
    });
    return encodedRows.map((wire, index) => {
      const value = newRows[index],
        origin = pluginValueSource(value);
      if (['Entity', 'EntityReference'].includes(origin?.$type)) {
        const sourceIndex = remaining(origins.get(fingerprint(origin)));
        if (sourceIndex !== undefined) consumed.add(sourceIndex);
        return origin.$type === 'Entity'
          ? reconcileEntity(origin, decoded(origin), value, wire)
          : reconcile(origin, decoded(origin), value);
      }
      const group = exact.get(fingerprint(value));
      let sourceIndex = remaining(group);
      if (sourceIndex !== undefined) {
        if (group.ambiguous) ambiguous();
      } else {
        const matching = ids.get(identity(wire));
        sourceIndex = remaining(matching);
        if (
          sourceIndex !== undefined &&
          matching.indices.slice(matching.cursor + 1).some((candidate) => !consumed.has(candidate))
        )
          ambiguous();
      }
      if (sourceIndex === undefined) return wire;
      consumed.add(sourceIndex);
      return reconcile(priorRows[sourceIndex], oldRows?.[sourceIndex] ?? decoded(priorRows[sourceIndex]), value);
    });
  };
  const reconcileEntity = (prior, oldRow, newRow, encoded) => {
    const origin = pluginValueSource(newRow);
    if (origin?.$type === 'Entity') {
      prior = origin;
      oldRow = decoded(origin);
    }
    const result = { ...(prior?.$type === 'Entity' ? structuredClone(prior) : {}), ...encoded };
    if (prior?.$type === 'Entity') {
      // FormattedValues, KeyAttributes and RowVersion are independent SDK
      // properties, not derived from an unrelated Attribute edit.
      for (const name of ['formattedValues', 'keyAttributes', 'rowVersion']) {
        if (Object.hasOwn(prior, name)) result[name] = structuredClone(prior[name]);
      }
      result.attributes = reconcileMap(
        prior.attributes,
        oldRow,
        Object.fromEntries(Object.entries(newRow).filter(([name]) => !name.includes('@'))),
      );
      // New columns still use imported field metadata when no prior SDK type exists.
      for (const name of Object.keys(result.attributes))
        if (!Object.hasOwn(prior.attributes ?? {}, name)) result.attributes[name] = encoded.attributes[name];
    }
    const primary = store?.resolveMapping(result.logicalName).idColumn;
    if (
      primary &&
      prior?.$type === 'Entity' &&
      !Object.hasOwn(prior.attributes ?? {}, primary) &&
      isDeepStrictEqual(oldRow?.[primary], newRow?.[primary]) &&
      newRow?.[primary] === prior.id
    )
      delete result.attributes[primary];
    return result;
  };
  const reconcile = (prior, oldValue, newValue, spec) => {
    if (prior !== undefined && isDeepStrictEqual(oldValue, newValue)) return structuredClone(prior);
    // An alias projects its inner value to JavaScript, including values whose
    // native wire wrapper is retained. Editing that wrapper still edits Value.
    if (prior?.$type === 'AliasedValue' && newValue?.$type !== 'AliasedValue')
      return { ...structuredClone(prior), value: reconcile(prior.value, oldValue, newValue) };
    // Explicit native wire replacements retain their authored type/metadata.
    if (newValue?.$type && !isExactNumeric(newValue)) return structuredClone(newValue);
    const encoded = encode(spec ?? inferred(prior), newValue);
    if (encoded?.$type === 'Entity') return reconcileEntity(prior, oldValue, newValue, encoded);
    if (encoded?.$type === 'EntityReference' && prior?.$type === 'EntityReference') {
      const result = { ...structuredClone(prior), ...encoded };
      if (isDeepStrictEqual(oldValue?.name, newValue?.name)) result.name = prior.name;
      if (Object.hasOwn(oldValue ?? {}, 'rowVersion') && !Object.hasOwn(newValue ?? {}, 'rowVersion'))
        delete result.rowVersion;
      if (!newValue?.keyAttributes) delete result.keyAttributes;
      else result.keyAttributes = reconcileMap(prior.keyAttributes, oldValue?.keyAttributes, newValue.keyAttributes);
      return result;
    }
    if (encoded?.$type === 'EntityCollection' && prior?.$type === 'EntityCollection')
      return {
        ...structuredClone(prior),
        ...encoded,
        ...(Array.isArray(newValue) ? structuredClone(prior) : {}),
        entities: reconcileRows(prior.entities, oldValue, newValue, encoded.entities),
      };
    if (['PrimitiveArray', 'SdkArray'].includes(encoded?.$type) && prior?.$type === encoded.$type) {
      if (['Entity', 'EntityReference'].includes(encoded.elementType))
        return { ...encoded, values: reconcileRows(prior.values, oldValue, newValue, encoded.values) };
      return {
        ...encoded,
        values: encoded.values.map((wire, index) => {
          const origin = pluginValueSource(newValue[index]);
          const result = reconcile(
            origin ?? prior.values[index],
            origin ? decoded(origin) : oldValue?.[index],
            newValue[index],
            {
              type: {
                String: 'String',
                Int32: 'Integer',
                Boolean: 'Boolean',
                Int64: 'Int64',
                Decimal: 'Decimal',
                Double: 'Float',
                DateTime: 'DateTime',
                EntityReference: 'EntityReference',
                OptionSetValue: 'Picklist',
                Money: 'Money',
                EntityCollection: 'EntityCollection',
                'String[]': 'StringArray',
              }[encoded.elementType],
            },
          );
          return result === undefined ? wire : result;
        }),
      };
    }
    if (
      newValue &&
      typeof newValue === 'object' &&
      !Array.isArray(newValue) &&
      !newValue.$type &&
      !isExactNumeric(newValue) &&
      !encoded?.$type
    )
      return reconcileMap(prior, oldValue, newValue);
    return encoded;
  };
  return {
    $type: 'ParameterCollection',
    values: Object.fromEntries(
      Object.entries(after)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => [
          name,
          reconcile(previous?.values?.[name], before?.[name], value, specByName.get(name)),
        ]),
    ),
  };
}

export function pluginContextValues(context, store) {
  if (!context) return null;
  return Object.fromEntries(
    Object.entries(context.values ?? {}).map(([name, value]) => [
      name,
      value?.$type === 'ExecutionContext'
        ? pluginContextValues(value, store)
        : ['ParameterCollection', 'EntityImageCollection'].includes(value?.$type)
          ? pluginMessageValues(value, store)
          : pluginMessageValues({ values: { value } }, store).value,
    ]),
  );
}
