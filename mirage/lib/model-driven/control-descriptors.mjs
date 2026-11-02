// Data-only capabilities shared by catalogue, HTTP validation and browser controls.
// Registering a renderer alone never makes a new control writable on the server.
const CONTROL_TYPES = Object.freeze(['text', 'textarea', 'number', 'boolean', 'date', 'lookup', 'json', 'multiselect']);
const dataverseTypes = new Set([
  'nvarchar',
  'ntext',
  'string',
  'memo',
  'bit',
  'boolean',
  'picklist',
  'multiselectpicklist',
  'state',
  'status',
  'int',
  'integer',
  'bigint',
  'decimal',
  'double',
  'float',
  'money',
  'datetime',
  'date',
  'lookup',
  'customer',
  'owner',
  'primarykey',
  'uniqueidentifier',
  'entityname',
  'json',
]);
export function controlDescriptor(field = {}) {
  const native = String(field.dataverseType).toLowerCase();
  let inferred;
  if (
    ['int', 'integer', 'bigint', 'decimal', 'double', 'float', 'money', 'picklist', 'state', 'status'].includes(native)
  )
    inferred = 'number';
  else if (['bit', 'boolean'].includes(native)) inferred = 'boolean';
  else if (['datetime', 'date'].includes(native)) inferred = 'date';
  else if (['lookup', 'owner', 'customer'].includes(native)) inferred = 'lookup';
  else if (['ntext', 'memo'].includes(native)) inferred = 'textarea';
  else if (native === 'json') inferred = 'json';
  else inferred = 'text';
  let type;
  if (field.dataverseType && !dataverseTypes.has(native)) type = 'unsupported';
  else if (native === 'multiselectpicklist') type = 'multiselect';
  else type = field.type ?? inferred;
  const supported = CONTROL_TYPES.includes(type);
  return {
    type,
    supported,
    create: supported && !field.isPrimaryId && field.validForCreate !== false,
    update: supported && !field.isPrimaryId && field.validForUpdate !== false,
  };
}
