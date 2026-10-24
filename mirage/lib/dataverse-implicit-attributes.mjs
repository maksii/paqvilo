// Platform metadata companions inferred from declared column kinds. These are metadata-only facts:
// this helper does not introduce row values, persistence or permission bypasses.
import { standardFields } from './dataverse-standard.mjs';

const kind = field => String(field?.columnMetadata?.type ?? field?.dataverseType ?? '').toLowerCase();
const readOnly = (dataverseType, extra = {}) => ({ dataverseType, validForCreate: false, validForUpdate: false, validForRead: true, ...extra });
const shadow = (dataverseType, parent, extra = {}) => readOnly(dataverseType, {
  dataverseMetadata: { AttributeOf: parent, IsLogical: true, IsValidODataAttribute: false }, ...extra,
});
const regularCustom = source => !source.def && /^[a-z0-9]+_/.test(source.logical);

/** Explicit Solution/standard field facts always win over an inferred platform default. */
export function implicitAttributes(source, declared, { targetFields = standardFields } = {}) {
  const tableType = source.s?.tableType ?? source.m?.tableType ?? source.m?.dataverseMetadata?.TableType ?? source.def?.tableType;
  if (source.isVirtual || source.isVirtual == null && tableType === 'Virtual' || tableType === 'Elastic' || source.s?.isIntersect || source.m?.intersect) return declared;
  const generated = {};
  if (regularCustom(source)) Object.assign(generated, {
    createdonbehalfby: readOnly('lookup', { targets: ['systemuser'], schemaName: 'CreatedOnBehalfBy' }),
    modifiedonbehalfby: readOnly('lookup', { targets: ['systemuser'], schemaName: 'ModifiedOnBehalfBy' }),
    importsequencenumber: { dataverseType: 'int', validForCreate: true, validForUpdate: false, schemaName: 'ImportSequenceNumber' },
    overriddencreatedon: { dataverseType: 'datetime', validForCreate: true, validForUpdate: false, schemaName: 'OverriddenCreatedOn' },
    timezoneruleversionnumber: { dataverseType: 'int', validForCreate: true, validForUpdate: true, schemaName: 'TimeZoneRuleVersionNumber' },
    utcconversiontimezonecode: { dataverseType: 'int', validForCreate: true, validForUpdate: true, schemaName: 'UTCConversionTimeZoneCode' },
  });
  const columns = { ...generated, ...declared };
  for (const name of ['owninguser', 'owningteam']) if (columns[name])
    generated[name] = { dataverseMetadata: { IsLogical: true, AttributeOf: null } };
  if (Object.values(columns).some(field => kind(field) === 'money')) Object.assign(generated, {
    transactioncurrencyid: { dataverseType: 'lookup', targets: ['transactioncurrency'], validForCreate: true, validForUpdate: true, schemaName: 'TransactionCurrencyId' },
    exchangerate: readOnly('decimal', { precision: 12, schemaName: 'ExchangeRate' }),
  });
  for (const [name, field] of Object.entries({ ...generated, ...declared })) {
    const type = kind(field);
    if (['lookup', 'customer', 'owner'].includes(type)) {
      // These two logical ownership references have no platform name or phonetic-name companion.
      if (name === 'owninguser' || name === 'owningteam') continue;
      const targets = field.targets ?? field.lookupTargets ?? (type === 'owner' ? ['systemuser', 'team'] : type === 'customer' ? ['account', 'contact'] : []);
      generated[name + 'name'] = shadow('nvarchar', name, { maxLength: 100 });
      if (type === 'owner' || name === 'ownerid') generated[name + 'type'] = {
        dataverseType: 'entityname', validForCreate: true, validForUpdate: true,
        dataverseMetadata: { AttributeOf: name, IsLogical: false, IsValidODataAttribute: false },
      };
      // Phonetic companions require evidence on the target table; custom targets are not guessed.
      if (targets.some(target => Object.keys(targetFields(target) ?? {}).some(column => /^yomi(?:name|fullname)$/.test(column))))
        generated[name + 'yominame'] = shadow('nvarchar', name, { maxLength: 100 });
    } else if (['bit', 'boolean', 'picklist', 'multiselectpicklist', 'state', 'status'].includes(type)) {
      generated[name + 'name'] = shadow('virtual', name);
    } else if (type === 'file') {
      generated[name] = readOnly('file', { dataverseMetadata: { IsLogical: false, AttributeOf: null, IsValidODataAttribute: true } });
      generated[name + '_name'] = shadow('nvarchar', name, { maxLength: 200, dataverseMetadata: { AttributeOf: name, IsLogical: true, IsValidODataAttribute: true } });
    } else if (type === 'image') {
      generated[name] = { dataverseType: 'image', validForCreate: true, validForUpdate: true,
        dataverseMetadata: { AttributeOf: name + 'id', IsLogical: true, IsValidODataAttribute: true } };
      generated[name + 'id'] = readOnly('uniqueidentifier', { dataverseMetadata: { AttributeOf: null, IsLogical: false, IsValidODataAttribute: true } });
      generated[name + '_timestamp'] = shadow('bigint', name + 'id', { dataverseMetadata: { AttributeOf: name + 'id', IsLogical: true, IsValidODataAttribute: true } });
      generated[name + '_url'] = shadow('nvarchar', name + 'id', { maxLength: 200, dataverseMetadata: { AttributeOf: name + 'id', IsLogical: true, IsValidODataAttribute: true } });
    } else if (type === 'money' && !name.endsWith('_base')) {
      generated[name + '_base'] = readOnly('money', { precision: field.precision, dataverseMetadata: { IsLogical: false, AttributeOf: null, IsValidODataAttribute: true } });
    }
  }
  const fields = { ...generated };
  for (const [name, field] of Object.entries(declared)) {
    if (!generated[name]) { fields[name] = field; continue; }
    const facts = field.columnMetadata ?? {};
    const flags = Object.fromEntries(['validForCreate', 'validForUpdate', 'validForRead'].filter(key => Object.hasOwn(facts, key)).map(key => [key, facts[key]]));
    const metadata = Object.fromEntries([['attributeOf', 'AttributeOf'], ['isLogical', 'IsLogical'], ['isValidODataAttribute', 'IsValidODataAttribute']]
      .filter(([key]) => Object.hasOwn(facts, key)).map(([key, property]) => [property, facts[key]]));
    fields[name] = { ...generated[name], ...flags, ...field,
      dataverseMetadata: { ...generated[name].dataverseMetadata, ...metadata, ...field.dataverseMetadata } };
  }
  return fields;
}
