// Data-only capabilities shared by catalogue, HTTP validation and browser controls.
// Registering a renderer alone never makes a new control writable on the server.
export const CONTROL_TYPES = Object.freeze(['text', 'textarea', 'number', 'boolean', 'date', 'lookup', 'json', 'multiselect']);
const dataverseTypes = new Set(['nvarchar', 'ntext', 'string', 'memo', 'bit', 'boolean', 'picklist', 'multiselectpicklist', 'state', 'status', 'int', 'integer', 'bigint', 'decimal', 'double', 'float', 'money', 'datetime', 'date', 'lookup', 'customer', 'owner', 'primarykey', 'uniqueidentifier', 'entityname', 'json']);
export function controlDescriptor(field = {}) {
  const type = field.dataverseType && !dataverseTypes.has(String(field.dataverseType).toLowerCase()) ? 'unsupported' : String(field.dataverseType).toLowerCase() === 'multiselectpicklist' ? 'multiselect' : field.type ?? 'text';
  const supported = CONTROL_TYPES.includes(type);
  return { type, supported, create: supported && !field.isPrimaryId && field.validForCreate !== false,
    update: supported && !field.isPrimaryId && field.validForUpdate !== false };
}
