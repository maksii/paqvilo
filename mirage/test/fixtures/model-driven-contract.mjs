import { createFormClientRuntime } from '../../lib/model-driven/client-runtime.mjs';

// Invented schema and values for the finite native form probes. No export or reference identity is needed.
export const modelDrivenContractFields = [
  ['text', ['a@example.invalid', '', null], ['getMaxLength'], { type: 'text', format: 'email', maxLength: 200 }],
  ['memo', ['Invented\ntext', '', null], ['getMaxLength'], { type: 'textarea', maxLength: 5000 }],
  ['integer', [7, 0, -2, null], ['getMin', 'getMax', 'getPrecision'], { type: 'number', dataverseType: 'int', minValue: 0, maxValue: 10000 }],
  ['decimal', [1.25, 0, -2.5, null], ['getMin', 'getMax', 'getPrecision'], { type: 'number', dataverseType: 'decimal', minValue: 0, maxValue: 100, precision: 2 }],
  ['double', [1.25, 0, -2.5, null], ['getMin', 'getMax', 'getPrecision'], { type: 'number', dataverseType: 'double', minValue: 0, maxValue: 10000, precision: 3 }],
  ['money', [1.25, 0, -2.5, null], ['getMin', 'getMax', 'getPrecision'], { type: 'number', dataverseType: 'money', minValue: 0, maxValue: 1000000, precision: 2 }],
  ['boolean', [true, false, null], ['getOptions'], { type: 'boolean', options: [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }] }],
  ['choice', [198720000, 198720001, 100000000, null], ['getOptions'], { type: 'number' }],
  ['multi', [[198720000], [198720000, 198720001], [198720001, 198720000], [100000000], [198720001, 100000000], [], null], ['getOptions'], { type: 'multiselect' }],
  ['lookup', [null], [], { type: 'lookup', targets: ['x_contract'] }],
  ['date', [null], [], { type: 'date', format: 'date' }],
].map(([role, values, methods, field]) => ({
  role, name: 'x_' + role, values, field,
  metadata: ['getAttributeType', 'getFormat', 'getRequiredLevel', 'getSubmitMode', ...methods],
  ...(role === 'text' ? { changeEvents: true, submitModes: ['dirty', 'always', 'never'], requiredLevels: ['required', 'recommended', 'none'] } : {}),
}));

export function modelDrivenContractRuntime() {
  const options = ['Planned', 'In progress', 'Complete'].map((label, index) => ({ label, value: 198720000 + index }));
  const fields = Object.fromEntries(modelDrivenContractFields.map(({ name, role, field }) => [name, {
    name, ...field, ...(['choice', 'multi'].includes(role) ? { options } : {}),
  }]));
  const record = Object.fromEntries(Object.keys(fields).map(name => [name, null]));
  const required = new Map();
  return createFormClientRuntime({
    table: { entity: 'x_contract', fields }, form: { attributes: Object.keys(fields) }, record,
    read: name => record[name], write: (name, value) => { record[name] = value; },
    controlNames: name => name ? [name] : Object.keys(fields), controlField: name => name,
    required: (name, value) => value === undefined ? required.get(name) ?? 'none' : required.set(name, value),
  });
}
