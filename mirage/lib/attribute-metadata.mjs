// Platform AttributeMetadata (Microsoft.Xrm.Sdk.Metadata.*AttributeMetadata, DataContract JSON)
// built from the exported column facts (solution-schema `columnMetadata`). The native grid
// services echo it on every record attribute. Values the platform generates per environment
// (MetadataId, ColumnNumber, CreatedOn/ModifiedOn of the definition) are not in an export and
// are emitted as null.

const TYPES = {
  bit: [0, 'BooleanType'],
  boolean: [0, 'BooleanType'],
  customer: [1, 'CustomerType'],
  datetime: [2, 'DateTimeType'],
  decimal: [3, 'DecimalType'],
  float: [4, 'DoubleType'],
  double: [4, 'DoubleType'],
  int: [5, 'IntegerType'],
  integer: [5, 'IntegerType'],
  lookup: [6, 'LookupType'],
  memo: [7, 'MemoType'],
  ntext: [7, 'MemoType'],
  money: [8, 'MoneyType'],
  owner: [9, 'OwnerType'],
  partylist: [10, 'PartyListType'],
  picklist: [11, 'PicklistType'],
  state: [12, 'StateType'],
  status: [13, 'StatusType'],
  nvarchar: [14, 'StringType'],
  string: [14, 'StringType'],
  primarykey: [15, 'UniqueidentifierType'],
  uniqueidentifier: [15, 'UniqueidentifierType'],
  multiselectpicklist: [17, 'MultiSelectPicklistType'],
  bigint: [18, 'BigIntType'],
  entityname: [20, 'EntityNameType'],
};
const REQUIRED = { none: 0, systemrequired: 1, applicationrequired: 2, required: 2, recommended: 3 };
const IME = { auto: 0, inactive: 1, active: 2, disabled: 3 };
// StringFormat values; json/richtext follow the enum order (a guess).
const STRING_FORMATS = [
  'email',
  'text',
  'textarea',
  'url',
  'tickersymbol',
  'phoneticguide',
  'versionnumber',
  'phone',
  'json',
  'richtext',
];
const FORMAT_NAMES = {
  email: 'Email',
  text: 'Text',
  textarea: 'TextArea',
  url: 'Url',
  tickersymbol: 'TickerSymbol',
  phoneticguide: 'PhoneticGuide',
  versionnumber: 'VersionNumber',
  phone: 'Phone',
  json: 'Json',
  richtext: 'RichText',
};
const INTEGER_FORMATS = { none: 0, duration: 1, timezone: 2, language: 3, locale: 4 };
const OPTION_SET_TYPES = { picklist: 0, state: 1, status: 2, bit: 3, boolean: 3 };
// Column types that can be calculated (FormulaDefinition/SourceTypeMask, SourceType); others report SourceType null.
const CALCULABLE = new Set([
  'nvarchar',
  'string',
  'int',
  'integer',
  'decimal',
  'float',
  'double',
  'money',
  'datetime',
  'bit',
  'boolean',
  'picklist',
  'multiselectpicklist',
]);

const label = (text, lcid, system = false) => ({
  Label: text,
  LanguageCode: Number(lcid),
  IsManaged: system,
  MetadataId: null,
  HasChanged: null,
  ExtensionData: {},
});
function labelSet(labels, lcid = 1033, system = false) {
  const entries = Object.entries(labels ?? {}).filter(([code]) => /^\d+$/.test(code));
  const user = entries.find(([code]) => Number(code) === lcid) ?? entries[0];
  return {
    LocalizedLabels: entries.map(([code, text]) => label(text, code, system)),
    UserLocalizedLabel: user ? label(user[1], user[0], system) : null,
    ExtensionData: {},
  };
}
const managed = (value, canBeChanged, name) => ({
  Value: value,
  CanBeChanged: canBeChanged,
  ManagedPropertyLogicalName: name,
  ExtensionData: {},
});
const flag = (mask, name) => new RegExp(String.raw`(?:^|\|)${name}(?:\||$)`, 'i').test(mask ?? '');

function option(o, extra, { externalValue }, lcid, system = false) {
  return {
    ...extra,
    Value: o.value,
    Label: labelSet(o.labels, lcid, system),
    Description: labelSet(o.descriptionLabels, lcid, system),
    Color: o.color ?? null,
    IsManaged: system,
    ExternalValue: externalValue === null ? null : (o.externalValue ?? ''),
    ParentValues: null,
    Tag: null,
    MetadataId: null,
    HasChanged: null,
    ExtensionData: {},
  };
}

function optionSetMetadata(set, type, custom, lcid, system = false) {
  let defaultKind = 'picklist';
  if (type === 'bit') defaultKind = 'bit';
  else if (type === 'state' || type === 'status') defaultKind = type;
  const kind = set.type ?? defaultKind;
  const base = {
    Description: labelSet(set.descriptionLabels, lcid, system),
    DisplayName: labelSet(set.displayLabels, lcid, system),
    IsCustomOptionSet: custom,
    IsGlobal: Boolean(set.isGlobal),
    IsManaged: system,
    IsCustomizable: managed(set.isCustomizable ?? true, !system, 'iscustomizable'),
    Name: set.name ?? null,
    ExternalTypeName: null,
    OptionSetType: OPTION_SET_TYPES[kind] ?? 0,
    IntroducedVersion: set.introducedVersion ?? null,
    MetadataId: null,
    HasChanged: null,
    ExtensionData: {},
  };
  if (kind === 'bit') {
    const of = (value) => (set.options ?? []).find((o) => o.value === value);
    return {
      TrueOption: of(1) ? option(of(1), {}, {}, lcid, system) : null,
      FalseOption: of(0) ? option(of(0), {}, {}, lcid, system) : null,
      ...base,
    };
  }
  let options;
  if (kind === 'state') {
    options = (set.states ?? []).map((o) =>
      option(
        o,
        { DefaultStatus: o.defaultStatus ?? null, InvariantName: o.invariantName ?? null },
        { externalValue: null },
        lcid,
        system,
      ),
    );
  } else if (kind === 'status') {
    options = (set.statuses ?? []).map((o) =>
      option(o, { State: o.state ?? null, TransitionData: null }, { externalValue: null }, lcid, system),
    );
  } else {
    options = (set.options ?? []).map((o) => option(o, {}, {}, lcid, system));
  }
  return { Options: options, ParentOptionSetName: null, ...base };
}

function stringAttributeMetadata(metadata, facts, formula, ime, format) {
  const name = FORMAT_NAMES[format] ?? 'Text';
  return Object.assign(
    metadata,
    {
      Format: Math.max(0, STRING_FORMATS.indexOf(name.toLowerCase())),
      FormatName: { Value: name, ExtensionData: {} },
      ImeMode: ime,
      MaxLength: facts.maxLength ?? null,
      YomiOf: null,
      IsLocalizable: facts.isLocalizable ?? false,
      DatabaseLength: facts.databaseLength ?? null,
    },
    formula,
  );
}

function memoAttributeMetadata(metadata, facts, ime, format) {
  const name = FORMAT_NAMES[format] ?? 'TextArea';
  return Object.assign(metadata, {
    Format: Math.max(0, STRING_FORMATS.indexOf(name.toLowerCase())),
    FormatName: { Value: name, ExtensionData: {} },
    ImeMode: ime,
    MaxLength: facts.maxLength ?? null,
    IsLocalizable: facts.isLocalizable ?? false,
  });
}

function integerAttributeMetadata(metadata, formula, format, range) {
  return Object.assign(metadata, { Format: INTEGER_FORMATS[format] ?? 0, ...range }, formula);
}

function decimalAttributeMetadata(metadata, facts, formula, ime, range) {
  return Object.assign(metadata, { ...range, Precision: facts.precision ?? null, ImeMode: ime }, formula);
}

function moneyAttributeMetadata(metadata, facts, formula, ime, range) {
  return Object.assign(
    metadata,
    {
      ImeMode: ime,
      ...range,
      Precision: facts.precision ?? null,
      PrecisionSource: facts.precisionSource ?? null,
      CalculationOf: null,
      IsBaseCurrency: false,
    },
    formula,
  );
}

function dateAttributeMetadata(metadata, field, facts, formula, ime, format) {
  return Object.assign(
    metadata,
    {
      Format: /^date(only)?$/.test(format) ? 0 : 1,
      ImeMode: ime,
      DateTimeBehavior: { Value: field.dateTimeBehavior ?? 'UserLocal', ExtensionData: {} },
      // The managed property name is a guess; shared with dataverse-soap-contracts.mjs.
      CanChangeDateTimeBehavior: managed(
        facts.canChangeDateTimeBehavior ?? true,
        facts.canChangeDateTimeBehavior ?? true,
        'canmodifydatetimebehavior',
      ),
    },
    formula,
  );
}

function lookupAttributeMetadata(metadata, field) {
  return Object.assign(metadata, { Targets: field.targets ?? [], Format: 0 });
}

function booleanAttributeMetadata(metadata, facts, formula, custom, lcid, system) {
  const set = facts.optionSet ?? {};
  return Object.assign(
    metadata,
    {
      DefaultValue: facts.appDefaultValue === '1',
      OptionSet: optionSetMetadata(set, 'bit', custom || facts.customTable, lcid, system),
    },
    formula,
  );
}

function picklistAttributeMetadata(metadata, facts, formula, custom, lcid, system) {
  const value = Number(facts.appDefaultValue);
  return Object.assign(metadata, formula, {
    ParentPicklistLogicalName: null,
    ChildPicklistLogicalNames: null,
    DefaultFormValue: Number.isInteger(value) && value !== -1 && facts.appDefaultValue !== undefined ? value : null,
    OptionSet: facts.optionSet
      ? optionSetMetadata(facts.optionSet, 'picklist', custom || facts.customTable, lcid, system)
      : null,
  });
}

function stateAttributeMetadata(metadata, facts, type, custom, lcid, system) {
  return Object.assign(metadata, {
    DefaultFormValue: null,
    OptionSet: facts.optionSet
      ? optionSetMetadata(facts.optionSet, type, custom || facts.customTable, lcid, system)
      : null,
  });
}

/**
 * Full AttributeMetadata of one column, or null when the field carries no exported column
 * facts (callers then fall back to their compact shape).
 */
export function attributeMetadata(entity, attribute, field, { primaryName, lcid = 1033 } = {}) {
  const facts = field?.columnMetadata;
  if (!facts) return null;
  const type = String(facts.type ?? field.dataverseType ?? 'nvarchar').toLowerCase();
  const [attributeType, typeName] = TYPES[type] ?? TYPES.nvarchar;
  const mask = facts.displayMask;
  const custom = facts.isCustomField === true;
  // A system column of a system table lives in the platform's managed layer (IsManaged true with
  // managed labels, e.g. contact fullname/statecode); system columns of a table the unmanaged
  // solution created (statecode of a custom table) are unmanaged, like its custom columns.
  const system = !custom && facts.customTable === false;
  const isPrimaryName = attribute === primaryName || facts.isPrimaryName === true;
  const calculable = CALCULABLE.has(type);
  const audit = facts.isAuditEnabled ?? false;
  const metadata = {
    AttributeOf: facts.attributeOf ?? null,
    AttributeType: attributeType,
    AttributeTypeName: { Value: typeName, ExtensionData: {} },
    ColumnNumber: null,
    Description: labelSet(facts.descriptionLabels, lcid, system),
    DisplayName: labelSet(facts.labels, lcid, system),
    DeprecatedVersion: null,
    IntroducedVersion: facts.introducedVersion ?? null,
    EntityLogicalName: entity,
    // Exports omit CanModifyAuditSettings; infer the managed audit lock from column kind and auditing state.
    IsAuditEnabled: managed(audit, custom || audit, 'canmodifyauditsettings'),
    IsCustomAttribute: custom,
    IsPrimaryId: type === 'primarykey',
    IsValidODataAttribute: true,
    IsPrimaryName: isPrimaryName,
    IsValidForCreate: facts.validForCreate ?? true,
    IsValidForRead: facts.validForRead ?? true,
    IsValidForUpdate: facts.validForUpdate ?? true,
    CanBeSecuredForRead: custom && !isPrimaryName,
    CanBeSecuredForCreate: custom && !isPrimaryName,
    CanBeSecuredForUpdate: custom && !isPrimaryName,
    IsSecured: facts.isSecured ?? false,
    IsRetrievable: facts.isRetrievable ?? false,
    IsFilterable: facts.isFilterable ?? false,
    IsSearchable: facts.isSearchable ?? false,
    IsManaged: system,
    IsGlobalFilterEnabled: managed(
      facts.isGlobalFilterEnabled ?? false,
      facts.canModifyGlobalFilterSettings ?? true,
      'canmodifyglobalfiltersettings',
    ),
    IsSortableEnabled: managed(
      facts.isSortableEnabled ?? false,
      facts.canModifyIsSortableSettings ?? true,
      'canmodifyissortablesettings',
    ),
    LinkedAttributeId: null,
    LogicalName: attribute,
    // Managed-layer columns lock their managed properties and report an empty AutoNumberFormat and null
    // FormulaDefinition; unmanaged columns keep them changeable.
    IsCustomizable: managed(facts.isCustomizable ?? true, !system, 'iscustomizable'),
    IsRenameable: managed(facts.isRenameable ?? true, !system, 'isrenameable'),
    IsValidForAdvancedFind: managed(
      flag(mask, 'ValidForAdvancedFind'),
      facts.canModifySearchSettings ?? true,
      'canmodifysearchsettings',
    ),
    IsValidForForm: flag(mask, 'ValidForForm'),
    IsRequiredForForm: flag(mask, 'RequiredForForm'),
    IsValidForGrid: flag(mask, 'ValidForGrid'),
    // A primary key, and a managed-layer system-required column, cannot change its requirement level
    // (contactid and contact.statecode cannot; the statecode of a custom table can).
    RequiredLevel: managed(
      REQUIRED[facts.requiredLevel] ?? 0,
      facts.canModifyRequirementLevelSettings ??
        !(type === 'primarykey' || (system && facts.requiredLevel === 'systemrequired')),
      'canmodifyrequirementlevelsettings',
    ),
    CanModifyAdditionalSettings: managed(
      facts.canModifyAdditionalSettings ?? true,
      !system,
      'canmodifyadditionalsettings',
    ),
    SchemaName: facts.schemaName ?? attribute,
    ExternalName: null,
    IsLogical: facts.isLogical ?? false,
    IsDataSourceSecret: facts.isDataSourceSecret ?? false,
    InheritsFrom: null,
    CreatedOn: null,
    ModifiedOn: null,
    SourceType: calculable ? (facts.sourceType ?? 0) : null,
    AutoNumberFormat: facts.autoNumberFormat ?? (system ? '' : null),
    Settings: null,
    MetadataId: null,
    HasChanged: null,
    ExtensionData: {},
  };
  const formula = calculable
    ? { FormulaDefinition: system ? null : (facts.formulaDefinition ?? ''), SourceTypeMask: 0 }
    : {};
  const ime = IME[facts.imeMode] ?? 0;
  const format = String(facts.format ?? '').toLowerCase();
  const range = { MaxValue: facts.maxValue ?? null, MinValue: facts.minValue ?? null };
  switch (attributeType) {
    case 14:
      return stringAttributeMetadata(metadata, facts, formula, ime, format);
    case 7:
      return memoAttributeMetadata(metadata, facts, ime, format);
    case 5:
      return integerAttributeMetadata(metadata, formula, format, range);
    case 18:
      return Object.assign(metadata, range);
    case 3:
    case 4:
      return decimalAttributeMetadata(metadata, facts, formula, ime, range);
    case 8:
      return moneyAttributeMetadata(metadata, facts, formula, ime, range);
    case 2:
      return dateAttributeMetadata(metadata, field, facts, formula, ime, format);
    case 1:
    case 6:
    case 9:
      return lookupAttributeMetadata(metadata, field);
    case 0: {
      return booleanAttributeMetadata(metadata, facts, formula, custom, lcid, system);
    }
    case 11:
    case 17: {
      return picklistAttributeMetadata(metadata, facts, formula, custom, lcid, system);
    }
    case 12:
    case 13:
      return stateAttributeMetadata(metadata, facts, type, custom, lcid, system);
    default:
      return metadata;
  }
}
