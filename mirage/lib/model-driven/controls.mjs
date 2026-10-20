// Controls are registered by supported metadata type. Unknown controls are explicit
// read-only placeholders. Trusted Solution PCF bundles use a separate lifecycle.
import { renderLookup } from './lookup-control.mjs';
import { controlDescriptor } from './control-descriptors.mjs';
import { renderPcfControl } from './pcf-runtime.mjs';
import { renderChoice } from './choice-control.mjs';
import { renderDate } from './date-control.mjs';
import { renderDuration } from './duration-control.mjs';
const registry = new Map();
export const registerControl = (type, render) => registry.set(type, render);
export const hasControl = field => registry.has(controlDescriptor(field).type);
const input = (type, field, value) => {
  const control = document.createElement('input'); control.type = type;
  control.value = value ?? ''; control.placeholder = '---'; if (field.maxLength) control.maxLength = field.maxLength;
  if (field.minValue !== undefined) control.min = field.minValue;
  if (field.maxValue !== undefined) control.max = field.maxValue;
  return { element: control, read: () => control.value === '' ? null : control.value };
};
registerControl('text', (field, value) => input(field.format === 'email' ? 'email' : field.format === 'url' ? 'url' : field.format === 'phone' ? 'tel' : 'text', field, value));
registerControl('textarea', (field, value) => { const control = document.createElement('textarea'); control.rows = /source|copy|javascript|css/.test(field.name) ? 12 : 5; control.value = value ?? ''; if (field.maxLength) control.maxLength = field.maxLength; return { element: control, read: () => control.value || null }; });
registerControl('json', (field, value) => { const control = document.createElement('textarea'); control.rows = 5; control.value = value == null ? '' : JSON.stringify(value, null, 2); return { element: control, read: () => control.value.trim() ? JSON.parse(control.value) : null }; });
registerControl('number', (field, value) => {
  if (String(field.format).toLowerCase() === 'duration') return renderDuration(field, value);
  if (field.options?.length) {
    return renderChoice(field, value);
  }
  const control = input('number', field, value); control.element.step = /int|bigint/.test(field.dataverseType ?? '') ? '1' : 'any';
  return { element: control.element, read: () => control.element.value === '' ? null : Number(control.element.value) };
});
registerControl('boolean', (field, value) => {
  const choices = field.options?.length ? field.options.map(option => ({ ...option, value: Boolean(Number(option.value)) })) : [{ label: 'No', value: false }, { label: 'Yes', value: true }];
  return renderChoice(field, value == null ? null : value === true || value === 1 || value === 'true' || value === '1', { options: choices, allowEmpty: false });
});
registerControl('multiselect', (field, value) => renderChoice(field, value, { multiple: true }));
registerControl('date', renderDate);
registerControl('lookup', renderLookup);
export function renderControl(field, value, context = {}) {
  const renderer = registry.get(controlDescriptor(field).type);
  if (!controlDescriptor(field).supported || !renderer) { const element = document.createElement('p'); element.className = 'unsupported'; element.textContent = 'This control is not supported locally yet.'; return { element, read: () => value, supported: false }; }
  if (context.pcf) return renderPcfControl(field, value, context);
  const rendered = context.readOnlyText ? (() => {
    let raw = value; const display = () => raw == null ? '' : field.options?.find(option => String(option.value) === String(raw))?.label ?? String(raw);
    const control = input('text', field, display());
    return { element: control.element, read: () => raw, setValue(next) { raw = next; control.element.value = display(); }, setDisabled() { control.element.disabled = true; } };
  })() : renderer(field, value, context), primary = rendered.primary ?? rendered.element;
  primary.name = field.name; primary.id = `field-${field.name}`;
  primary.setAttribute('aria-label', field.label ?? field.name);
  primary.required = Boolean(field.required); primary.disabled = Boolean(context.disabled || context.readOnlyText);
  if (context.disabled) for (const control of rendered.element.querySelectorAll('button,input,select,textarea')) control.disabled = true;
  return { ...rendered, supported: true };
}
