import { DataError } from './data-error.mjs';

/** Final SDK result values retain their wire type; source field metadata must
 * not reinterpret a plug-in's typed Entity attributes or formatted values. */
function soapSdkValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new DataError(
        'An untyped SOAP result number requires finite, exact numeric input.',
        501,
        'LocalSoapResultUnsupported',
      );
    return {
      type: Number.isInteger(value) ? (value >= -2147483648 && value <= 2147483647 ? 'int' : 'long') : 'double',
      value,
    };
  }
  const pairs = (entries = {}) => new Map(Object.entries(entries).map(([name, child]) => [name, soapSdkValue(child)]));
  const scalar = {
    Guid: 'guid',
    DateTime: 'dateTime',
    Money: 'Money',
    Decimal: 'decimal',
    Int64: 'long',
    Double: 'double',
    Bytes: 'base64',
    OptionSetValue: 'OptionSetValue',
  }[value.$type];
  if (scalar) return { type: scalar, value: value.value, ...(scalar === 'Money' ? { sdkExact: true } : {}) };
  switch (value.$type) {
    case 'PrimitiveArray':
      if (value.elementType === 'String') return { type: 'StringArray', values: value.values };
      break;
    case 'Entity':
      return {
        type: 'Entity',
        logicalName: value.logicalName,
        id: value.id,
        attributes: pairs(value.attributes),
        keyAttributes: pairs(value.keyAttributes),
        formattedValues: new Map(Object.entries(value.formattedValues ?? {})),
        rowVersion: value.rowVersion,
      };
    case 'EntityReference':
      return {
        type: 'EntityReference',
        logicalName: value.logicalName,
        id: value.id,
        name: value.name,
        keyAttributes: pairs(value.keyAttributes),
        rowVersion: value.rowVersion,
      };
    case 'EntityCollection':
      return {
        type: 'EntityCollection',
        entityName: value.entityName,
        entities: value.entities.map(soapSdkValue),
        moreRecords: value.moreRecords,
        pagingCookie: value.pagingCookie,
        totalRecordCount: value.totalRecordCount,
        totalRecordCountLimitExceeded: value.totalRecordCountLimitExceeded,
        minActiveRowVersion: value.minActiveRowVersion,
      };
    case 'AliasedValue':
      return {
        type: 'AliasedValue',
        entity: value.entityLogicalName,
        attribute: value.attributeLogicalName,
        value: soapSdkValue(value.value),
      };
    case 'EntityReferenceCollection':
      return { type: 'EntityReferenceCollection', values: value.values.map(soapSdkValue) };
    case 'OptionSetValueCollection':
      return { type: 'OptionSetValueCollection', values: value.values.map((item) => item?.value ?? item) };
    case 'ColumnSet':
      return { ...value, type: 'ColumnSet' };
    case 'Relationship':
      return { ...value, type: 'Relationship' };
    default:
      break;
  }
  throw new DataError(
    'The final SDK result has no qualified SOAP value contract: ' + value.$type,
    501,
    'LocalSoapResultUnsupported',
  );
}

export function soapSdkResults(values, aliases = []) {
  const result = new Map();
  for (const [name, value] of Object.entries(values)) {
    const alias = aliases.find(([source]) => source === name)?.[1] ?? name;
    if (result.has(alias) || (alias !== name && Object.hasOwn(values, alias)))
      throw new DataError(
        'Plug-in output contains conflicting context and SDK response result aliases.',
        501,
        'LocalPluginResponseUnsupported',
      );
    result.set(alias, soapSdkValue(value));
  }
  return result;
}
